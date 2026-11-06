import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

/**
 * @import { RequestListener } from 'node:http'
 * @import { TestContext } from 'node:test' */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getEventListeners } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { IdentityClient } from '../../hypaware-core/plugins-workspace/central/src/identity_client.js'
import { createConfigPullLoop } from '../../hypaware-core/plugins-workspace/central/src/config_client.js'
import { createForwardSink } from '../../hypaware-core/plugins-workspace/central/src/sink.js'

/** @param {TestContext} t @param {RequestListener} handler */
async function serverFor(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function until(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return
    await delay(5)
  }
  assert.fail('loopback condition did not settle')
}

async function settledWithin(promise) {
  const result = await Promise.race([promise.then(() => 'resolved', () => 'rejected'), delay(150).then(() => 'pending')])
  assert.notEqual(result, 'pending', 'cancellation must settle actual owned transport')
  return result
}

function identity(t, url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-auth-lifetime-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const client = new IdentityClient({ centralUrl: url, persistedPath: path.join(dir, 'identity.json') })
  client.identity = { jwt: 'old', gateway_id: 'gw-test', expires_at: 0 }
  return client
}

// @ref LLP 0471#shared-auth [tests]: removable callers share one actual refresh and last cancellation owns settlement
for (const bodyStall of [false, true]) {
  test(`shared refresh releases last caller with stalled ${bodyStall ? 'body' : 'headers'}`, async t => {
    let requests = 0
    let closed = 0
    const url = await serverFor(t, (req, res) => {
      requests += 1
      res.on('close', () => { closed += 1 })
      if (bodyStall) { res.writeHead(200); res.write('{"jwt":') }
    })
    const client = identity(t, url)
    const a = new AbortController()
    const b = new AbortController()
    const pa = client.getCurrentJwt(a.signal)
    const pb = client.getCurrentJwt(b.signal)
    pa.catch(() => {})
    pb.catch(() => {})
    await until(() => requests === 1)
    a.abort(new Error('caller one stopped'))
    assert.equal(await settledWithin(pa), 'rejected')
    assert.equal(closed, 0, 'remaining caller owns refresh')
    b.abort(new Error('caller two stopped'))
    assert.equal(await settledWithin(pb), 'rejected')
    await until(() => closed === 1)
    assert.equal(requests, 1)
    assert.equal(client.identity?.jwt, 'old')
    assert.equal(fs.existsSync(client.persistedPath), false)
    assert.equal(getEventListeners(a.signal, 'abort').length, 0)
    assert.equal(getEventListeners(b.signal, 'abort').length, 0)
    assert.equal(client.refreshing, undefined)
  })
}

test('pre-aborted refresh starts no request', async t => {
  let requests = 0
  const url = await serverFor(t, (req, res) => { requests += 1; res.end('{}') })
  const client = identity(t, url)
  const controller = new AbortController()
  controller.abort(new Error('already stopped'))
  await assert.rejects(client.getCurrentJwt(controller.signal), /already stopped/)
  assert.equal(requests, 0)
})

function sinkFor(url, overrides = {}) {
  let watermarkWrites = 0
  const sink = createForwardSink(/** @type {any} */ ({
    config: { url },
    identityClient: { async getCurrentJwt() { return 'test-jwt' }, async refresh() {} },
    query: { getDataset(name) { return { name, sourceSignal: 'logs' } } },
    storage: {
      cacheRoot: '/cache', tableExists() { return true }, async flushTable() {},
      async *readRowsSince() { yield { row: { message: 'synthetic' }, after: { v: 1, seq: '1' } } },
    },
    watermarks: { keyFor() { return { dataset: 'logs', partitionKey: 'test' } }, async read() { return null }, async write() { watermarkWrites += 1 } },
    rollouts: {}, log: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  }))
  return { sink, get writes() { return watermarkWrites } }
}

// @ref LLP 0471#chunk-lifetime [tests]: sink close aborts headers and response reads before releasing the chunk
for (const status of [undefined, 400, 202]) {
  test(`sink close settles stalled ${status === undefined ? 'headers' : `${status} response body`}`, async t => {
    let requests = 0
    let closed = 0
    const url = await serverFor(t, (req, res) => {
      requests += 1
      res.on('close', () => { closed += 1 })
      req.resume()
      if (status) { res.writeHead(status); res.write('synthetic diagnostic') }
    })
    const fixture = sinkFor(url)
    const { sink } = fixture
    const pending = sink.exportBatch(/** @type {any} */ ({ partitions: [{ dataset: 'logs', tablePath: '/cache/logs/test' }] }), /** @type {any} */ ({}))
    await until(() => requests === 1)
    await delay(10)
    await sink.close()
    assert.equal(await settledWithin(pending), 'resolved')
    const report = await pending
    assert.equal(report.status, status === 202 ? 'exported' : 'failed')
    await until(() => closed === 1)
    assert.equal(fixture.writes, status === 202 ? 1 : 0)
  })
}

// @ref LLP 0471#shared-auth [tests]: cancellation does not publish identity or strand a later acquisition
test('one cancelled lease preserves a live caller and later refresh succeeds', async t => {
  let requests = 0
  let reply
  const url = await serverFor(t, (req, res) => {
    requests += 1
    reply = () => res.end(JSON.stringify({ jwt: 'new-synthetic', expires_at: Math.floor(Date.now() / 1000) + 86400 * 10 }))
  })
  const client = identity(t, url)
  const a = new AbortController()
  const first = client.getCurrentJwt(a.signal)
  first.catch(() => {})
  const second = client.getCurrentJwt()
  await until(() => requests === 1)
  a.abort(new Error('one detached'))
  await assert.rejects(first, /one detached/)
  reply()
  assert.equal(await second, 'new-synthetic')
  assert.equal(JSON.parse(fs.readFileSync(client.persistedPath, 'utf8')).jwt, 'new-synthetic')
  assert.equal(await client.getCurrentJwt(), 'new-synthetic')
  assert.equal(requests, 1)
})

test('last cancellation refuses replacement until resource settles, then permits a fresh request', async t => {
  let requests = 0
  let success = false
  const url = await serverFor(t, (req, res) => {
    requests += 1
    if (success) res.end(JSON.stringify({ jwt: 'later', expires_at: Math.floor(Date.now() / 1000) + 86400 * 10 }))
  })
  const client = identity(t, url)
  const c = new AbortController()
  const pending = client.refresh(c.signal)
  pending.catch(() => {})
  await until(() => requests === 1)
  c.abort(new Error('last stopped'))
  await assert.rejects(client.refresh(), /closing/)
  await assert.rejects(pending)
  success = true
  await client.refresh()
  assert.equal(requests, 2)
  assert.equal(client.identity?.jwt, 'later')
})

// Uses native requests. Only the existing internal deadline timer is controlled;
// invoking it still must abort and settle real headers/body transport.
function deadlines(t) {
  const original = globalThis.setTimeout
  const pending = []
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    const timer = original(callback, ms, ...args)
    if (ms === 330_000) {
      let elapsed = 0
      const fire = () => { clearTimeout(timer); callback(...args) }
      fire.advance = ms => { elapsed += ms; if (elapsed >= 330_000) fire() }
      pending.push(fire)
    }
    return timer
  })
  return pending
}

for (const kind of ['auth', 'chunk', 'registration']) {
  test(`${kind} has one 330s elapsed deadline with real transport cancellation`, async t => {
    const timers = deadlines(t)
    let requests = 0
    let closed = 0
    const url = await serverFor(t, (req, res) => {
      requests += 1
      res.on('close', () => { closed += 1 })
      req.resume()
    })
    const client = identity(t, url)
    let operation
    let sink
    if (kind === 'auth') operation = client.refresh()
    else {
      const overrides = kind === 'registration' ? {
        query: { getDataset(name) { return { name: 'synthetic_events', sourceSignal: 'synthetic', schema: { columns: [] } } } },
        watermarks: { keyFor() { return { partitionKey: 'test' } }, async read() { return { continuation: { v: 1, seq: '0' }, exportedRowCount: 0 } } },
        rollouts: { async read() { return { partitions: ['test'] } } },
      } : {}
      sink = sinkFor(url, overrides).sink
      operation = sink.exportBatch(/** @type {any} */ ({ partitions: [{ dataset: kind === 'registration' ? 'synthetic_events' : 'logs', tablePath: '/cache/test' }] }), /** @type {any} */ ({}))
    }
    operation.catch(() => {})
    await until(() => requests === 1)
    assert.equal(timers.length, 1)
    timers[0].advance(329_999)
    let settled = false
    operation.then(() => { settled = true }, () => { settled = true })
    await delay(5)
    assert.equal(settled, false, 'deadline must not expire before 330s')
    timers[0].advance(1)
    await settledWithin(operation)
    await until(() => closed === 1)
    if (kind !== 'auth') assert.equal((await operation).status, 'failed')
    if (sink) await sink.close()
  })
}

for (const stopFirst of ['poll', 'export']) {
  test(`shared poll/export auth retains its remaining owner when ${stopFirst} stops first`, async t => {
    let requests = 0
    let closed = 0
    const url = await serverFor(t, (req, res) => {
      requests += 1
      res.on('close', () => { closed += 1 })
    })
    const client = identity(t, url)
    const { sink } = sinkFor(url, { identityClient: client })
    const loop = createConfigPullLoop(/** @type {any} */ ({
      centralUrl: url, identityClient: client,
      configControl: { runningEtag() {} },
      stopGraceSeconds: 0.01, log: { debug() {}, info() {}, warn() {}, error() {} },
    }))
    t.after(() => loop.stop())
    const exporting = sink.exportBatch(/** @type {any} */ ({ partitions: [{ dataset: 'logs', tablePath: '/cache/test' }] }), /** @type {any} */ ({}))
    loop.start()
    await until(() => requests === 1 && client.refreshing?.consumers.size === 2)
    if (stopFirst === 'poll') await loop.stop()
    else await sink.close()
    assert.equal(closed, 0)
    assert.equal(client.refreshing?.consumers.size, 1)
    if (stopFirst === 'poll') await sink.close()
    else await loop.stop()
    assert.equal((await exporting).status, 'failed')
    await until(() => closed === 1)
    assert.equal(requests, 1)
  })
}

test('oversized identity body is cancelled before publication', async t => {
  let closed = 0
  const url = await serverFor(t, (req, res) => {
    res.on('close', () => { closed += 1 })
    res.writeHead(200, { 'content-length': String(1024 * 1024 + 1) })
    res.write('{')
  })
  const client = identity(t, url)
  await assert.rejects(client.refresh(), /exceeds/)
  await until(() => closed === 1)
  assert.equal(client.identity?.jwt, 'old')
  assert.equal(fs.existsSync(client.persistedPath), false)
})

test('chunk retry shares one deadline and stable id/body across 401, 429 and 503', async t => {
  const timers = deadlines(t)
  const calls = []
  let refreshes = 0
  let waits = 0
  const url = await serverFor(t, async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push({ id: req.headers['x-hyp-batch-id'], body: Buffer.concat(chunks).toString() })
    const status = [401, 429, 503][calls.length - 1]
    if (status) { res.writeHead(status, { 'retry-after': '1' }); res.end() }
  })
  const { sink } = sinkFor(url, {
    identityClient: { async getCurrentJwt() { return 'synthetic' }, async refresh() { refreshes += 1 } },
    async sleepFn() { waits += 1 },
  })
  const pending = sink.exportBatch(/** @type {any} */ ({ partitions: [{ dataset: 'logs', tablePath: '/cache/test' }] }), /** @type {any} */ ({}))
  await until(() => calls.length === 4)
  assert.equal(timers.length, 1, 'retry must not restart the elapsed deadline')
  assert.equal(refreshes, 1)
  assert.equal(waits, 2)
  assert.equal(new Set(calls.map(c => c.id)).size, 1)
  assert.equal(new Set(calls.map(c => c.body)).size, 1)
  timers[0]()
  assert.equal((await pending).status, 'failed')
  await sink.close()
})

test('sink close stops an upload whose receiver never reads it', async t => {
  let arrived = false
  let closed = false
  let drain
  const url = await serverFor(t, (req, res) => {
    arrived = true
    drain = () => req.resume()
    res.on('close', () => { closed = true })
    // Deliberately do not consume the request or send response headers.
  })
  const { sink } = sinkFor(url, {
    storage: {
      cacheRoot: '/cache', tableExists() { return true }, async flushTable() {},
      async *readRowsSince() {
        for (let i = 0; i < 5; i += 1) yield { row: { content_text: 'synthetic'.repeat(100_000) }, after: { v: 1, seq: String(i + 1) } }
      },
    },
  })
  const pending = sink.exportBatch(/** @type {any} */ ({ partitions: [{ dataset: 'logs', tablePath: '/cache/test' }] }), /** @type {any} */ ({}))
  await until(() => arrived)
  await sink.close()
  assert.equal((await pending).status, 'failed')
  // The peer must drain bytes already in its TCP receive buffer to observe EOF.
  // It stayed unread while the actual client upload was cancelled and settled.
  drain()
  await until(() => closed)
})

test('chunked oversized error body is released and cannot enter diagnostics', async t => {
  let closed = false
  const url = await serverFor(t, (req, res) => {
    req.resume()
    res.on('close', () => { closed = true })
    res.writeHead(400)
    res.write('PRIVATE_SYNTHETIC_BODY'.repeat(70_000))
  })
  const { sink } = sinkFor(url)
  const report = await sink.exportBatch(/** @type {any} */ ({ partitions: [{ dataset: 'logs', tablePath: '/cache/test' }] }), /** @type {any} */ ({}))
  assert.equal(report.status, 'failed')
  assert.match(report.error ?? '', /HTTP 400/)
  assert.ok(!report.error?.includes('PRIVATE_SYNTHETIC_BODY'))
  assert.ok((report.error?.length ?? 0) <= 200)
  await until(() => closed)
  await sink.close()
})

test('replay close waits for actual aborted transport cleanup', async t => {
  let arrived = false
  const url = await serverFor(t, (req, res) => { arrived = true; req.resume() })
  let release
  const cleanup = new Promise(resolve => { release = resolve })
  t.after(() => release())
  let settling = false
  const { sink } = sinkFor(url, {
    query: { getDataset(name) { return {
      name, sourceSignal: 'proxy',
      async discoverPartitions() { return [{ dataset: name, partition: { source: 'claude' }, tablePath: '/cache/test' }] },
    } } },
    storage: {
      cacheRoot: '/cache', tableExists() { return true }, async flushTable() {},
      async *readRowsSince() { yield { row: { client_name: 'claude', content_text: 'synthetic' }, after: { v: 1, seq: '1' } } },
    },
    async fetchFn(url, init) {
      try { return await fetch(url, init) } catch (err) {
        // Real native fetch has aborted. Hold only the test wrapper's cleanup
        // to establish that close awaits the owned operation's settlement.
        settling = true
        await cleanup
        throw err
      }
    },
  })
  assert.ok(sink.replaySourceHistory)
  const replay = sink.replaySourceHistory({ source: 'claude' })
  await until(() => arrived)
  let done = false
  const closing = sink.close().then(() => { done = true })
  await until(() => settling)
  assert.equal(done, false)
  release()
  await closing
  assert.equal((await replay).status, 'failed')
})

test('healthy multi-chunk export receives a fresh deadline per logical chunk', async t => {
  const timers = deadlines(t)
  let posts = 0
  const url = await serverFor(t, async (req, res) => {
    for await (const chunk of req) { /* consume actual upload */ }
    posts += 1
    res.writeHead(202)
    res.end()
  })
  const { sink } = sinkFor(url, {
    storage: {
      cacheRoot: '/cache', tableExists() { return true }, async flushTable() {},
      async *readRowsSince() {
        for (let i = 0; i < 5001; i += 1) yield { row: { i }, after: { v: 1, seq: String(i + 1) } }
      },
    },
  })
  const result = await sink.exportBatch(/** @type {any} */ ({ partitions: [{ dataset: 'logs', tablePath: '/cache/test' }] }), /** @type {any} */ ({}))
  assert.equal(result.status, 'exported')
  assert.equal(posts, 2)
  assert.equal(timers.length, 2)
  await sink.close()
})

test('close interrupts real loopback backpressure sleep and clears its deadline', async t => {
  const timers = deadlines(t)
  let backpressure = false
  let requests = 0
  const url = await serverFor(t, (req, res) => {
    requests += 1
    req.resume()
    res.writeHead(503, { 'retry-after': '30' })
    res.end()
  })
  const { sink } = sinkFor(url, {
    log: { debug(message) { if (message === 'central.forward.backpressure') backpressure = true }, info() {}, warn() {}, error() {} },
  })
  const pending = sink.exportBatch(/** @type {any} */ ({ partitions: [{ dataset: 'logs', tablePath: '/cache/test' }] }), /** @type {any} */ ({}))
  await until(() => backpressure)
  await delay(5)
  await sink.close()
  assert.equal((await pending).status, 'failed')
  assert.equal(requests, 1)
  assert.equal(timers.length, 1)
})

test('shared refresh failure does not retain a private transport message', async t => {
  const client = identity(t, 'http://synthetic.invalid')
  client.fetchFn = async () => { throw new Error('PRIVATE_SYNTHETIC_JWT'.repeat(100_000)) }
  await assert.rejects(client.refresh(), err => {
    assert.ok(err instanceof Error)
    assert.ok(err.message.length <= 200)
    assert.ok(!err.message.includes('PRIVATE_SYNTHETIC_JWT'))
    return true
  })
  assert.equal(client.refreshing, undefined)
})

test('activated central wrapper aborts export before waiting for config pull grace', async t => {
  const { activate } = await import('../../hypaware-core/plugins-workspace/central/index.js')
  const arrivals = []
  const closures = []
  const url = await serverFor(t, (req, res) => {
    req.resume()
    if (req.url === '/v1/identity/bootstrap') {
      res.end(JSON.stringify({ jwt: `e30.${Buffer.from(JSON.stringify({ sub: 'gw-test' })).toString('base64url')}.synthetic`, expires_at: Math.floor(Date.now() / 1000) + 86400 * 10 }))
      return
    }
    arrivals.push(req.url)
    res.on('close', () => { closures.push(req.url) })
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-central-close-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let contribution
  const log = { debug() {}, info() {}, warn() {}, error() {} }
  await activate(/** @type {any} */ ({
    query: { listDatasets() { return [] }, getDataset(name) { return { name, sourceSignal: 'logs' } } },
    storage: {
      cacheRoot: path.join(dir, 'cache'), tableExists() { return true }, async flushTable() {},
      async *readRowsSince() { yield { row: { message: 'synthetic' }, after: { v: 1, seq: '1' } } },
    },
    configControl: { runningEtag() {}, confirmPoll() {} },
    sinks: { register(value) { contribution = value } },
  }))
  const sink = await contribution.create({
    name: 'central-test', config: { url, identity: { bootstrap_token: 'synthetic' } },
    paths: { stateDir: dir }, log,
  })
  t.after(() => sink.close())
  const exporting = sink.exportBatch({ partitions: [{ dataset: 'logs', tablePath: path.join(dir, 'cache/logs/test') }] }, {})
  await until(() => arrivals.includes('/v1/config') && arrivals.includes('/v1/ingest/logs'))
  const closing = sink.close()
  await until(() => closures.includes('/v1/ingest/logs'))
  assert.equal(closures.includes('/v1/config'), false, 'export abort cannot wait behind config grace')
  await closing
  assert.equal((await exporting).status, 'failed')
  await until(() => closures.includes('/v1/config'))
})
