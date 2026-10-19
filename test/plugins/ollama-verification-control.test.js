// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { temporaryDirectory } from '../helpers/temp_dir.js'
import { isolatedClientEnv } from '../../hypaware-core/smoke/lib/isolation.js'
import { bootKernel } from '../../src/core/runtime/boot.js'
import { dispatch } from '../../src/core/cli/dispatch.js'
import { writePidFile } from '../../src/core/daemon/pid.js'
import { writeStatusFile } from '../../src/core/daemon/status.js'
import { aiGatewayTablePath, AI_GATEWAY_SCHEMA_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import { ollamaCaptureFromSnapshot } from '../../src/core/daemon/status.js'
import { mergeCaptureOutcomes } from '../../hypaware-core/plugins-workspace/ai-gateway/src/entrypoint_activity.js'
import { requestOllamaVerification, VERIFY_PATH } from '../../src/core/control/client_recording.js'
import { setGatewayProcessTransport, createCaptureSender, createCaptureReceiver } from '../../hypaware-core/plugins-workspace/ai-gateway/src/process_transport.js'
import { createStartSource } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'
import { createGatewayState, createAiGatewayApi } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createOllamaExchangeProjector } from '../../hypaware-core/plugins-workspace/ollama/src/projector.js'
import { ollamaNativeRoute } from '../../hypaware-core/plugins-workspace/ollama/src/setup.js'
import { awaitPersistedOllamaCheck } from '../../hypaware-core/plugins-workspace/ollama/src/verify.js'
/** @import { AddressInfo } from 'node:net' */

function deferred() {
  let resolve = () => {}
  const promise = new Promise(done => { resolve = () => done(undefined) })
  return { promise, resolve }
}
async function fixture(t, mode = 'inline', allowUnsupported = false) {
  const home = temporaryDirectory('hyp-ollama-settlement-')
  const env = { ...isolatedClientEnv(process.env, home), HYP_HOME: home, HYP_CONFIG: path.join(home, 'hypaware-config.json') }
  let inference = 0
  const upstream = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/version') return res.end('{"version":"fixture"}')
    if (req.url === '/api/tags') return res.end('{"models":[{"name":"tiny:local"}]}')
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    inference++
    if (req.url === '/api/generate') return res.end(JSON.stringify({ model: body.model, response: '', done: true, done_reason: 'load' }))
    if (!allowUnsupported) assert.equal(body.think, false)
    assert.equal(body.stream, false)
    res.end(JSON.stringify({ model: body.model, done: true, message: { role: 'assistant', content: 'OK' } }))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = /** @type {AddressInfo} */ (upstream.address())
  const config = { version: /** @type {const} */ (2), auto_update: false, plugins: [
    { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:0', upstreams: [{ name: 'ollama', base_url: `http://127.0.0.1:${address.port}` }] } },
    { name: '@hypaware/ollama' },
  ] }
  await fs.writeFile(env.HYP_CONFIG, JSON.stringify(config))
  const boot = await bootKernel({ hypHome: home, configPath: env.HYP_CONFIG, env })
  const kernel = boot.runtime
  const ctx = kernel.activationContexts.get('@hypaware/ai-gateway')
  assert.ok(ctx)
  const pid = { pid: process.pid, runId: 'fixture-live', startedAt: new Date().toISOString(), mode: /** @type {const} */ ('foreground') }
  writePidFile(path.join(home, 'hypaware'), pid)
  let processing
  let receiver
  let sender
  let processingTransport
  t.after(async () => {
    await processing?.stop()
    await kernel.sources.stop('ai-gateway')
    sender?.reset()
    setGatewayProcessTransport(undefined)
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(() => resolve(undefined)))
  })
  if (mode === 'split') {
    const child = /** @type {any} */ ({ connected: true, send(frame, callback) {
      receiver?.message(frame)
      callback?.(null)
    } })
    sender = createCaptureSender({ getChild: () => child, log: ctx.log })
    setGatewayProcessTransport({ role: 'gateway', ...sender })
  }
  await kernel.sources.start('ai-gateway', ctx)
  const details = /** @type {any} */ ((await kernel.sources.status('ai-gateway'))?.details)
  const root = `http://${details.host}:${details.port}`
  if (mode === 'split') {
    const state = createGatewayState()
    state.projectors.push({ ...createOllamaExchangeProjector(), _seq: 0 })
    createAiGatewayApi(state).registerUpstreamAlias('ollama-native', 'ollama', ollamaNativeRoute())
    processingTransport = { role: /** @type {const} */ ('processing'), generation: details.recording_generation,
      endpoint: { host: details.host, port: details.port },
      receive(onExchange, refreshRecording, settleVerification) {
        receiver = createCaptureReceiver({ onExchange, refreshRecording, settleVerification, send: frame => sender?.message(frame) })
        sender?.message({ type: 'gateway.capture_ready' })
        return () => receiver.close()
      },
    }
    setGatewayProcessTransport(processingTransport)
    processing = await createStartSource(state)(ctx)
    setGatewayProcessTransport(undefined)
  }
  const publish = async () => writeStatusFile(path.join(home, 'hypaware'), { ...pid, state: 'healthy', healthyAt: pid.startedAt, uptimeMs: Date.now() - Date.parse(pid.startedAt), sources: [{ name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: 'started', details: { ...(await kernel.sources.status('ai-gateway'))?.details, ...sender?.snapshot() } }], sinks: [] })
  await publish()
  const control = { endpoint: root, runId: pid.runId, generation: details.recording_generation }
  async function verify(argv = ['--model', 'tiny:local', '--json']) {
    let output = ''
    let error = ''
    const code = await dispatch(['ollama', 'verify', ...argv], { kernel, registry: /** @type {any} */ (kernel.commands), env,
      stdout: { write: value => { output += value } }, stderr: { write: value => { error += value } } })
    return { code, output, error }
  }
  return { home, env, kernel, ctx, root, control, publish, verify, pid, config, processing, processingTransport, inference: () => inference }
}

// @ref LLP 0476#confirmation [tests]: provider completion becomes fresh committed-query proof through actual service storage without a sink
for (const mode of ['inline', 'split']) test('real explicit verification settles tiny fresh capture without a helpful sink: ' + mode, async t => {
  const f = await fixture(t, mode)
  const result = await f.verify()
  assert.equal(result.code, 0, result.error + result.output)
  const payload = JSON.parse(result.output)
  assert.equal(payload.status, 'persisted')
  assert.equal(payload.http_completed, true)
  assert.ok(payload.request_id)
  assert.equal(f.inference(), 1)
  assert.equal((await requestOllamaVerification({ endpoint: f.root, runId: f.pid.runId, deadline: Date.now() + 1000 })).generation, f.control.generation)
  assert.match(result.error, /shared current gateway spool/)
  assert.equal((await f.kernel.storage.pendingInfo(aiGatewayTablePath(f.kernel.storage))).pending, false)
})

test('normal and JSON failure outputs preserve settings and never infer with an unlisted model', async t => {
  const f = await fixture(t)
  const saved = await fs.readFile(f.env.HYP_CONFIG, 'utf8')
  const normal = await f.verify(['--model', 'missing:local'])
  assert.equal(normal.code, 1)
  assert.equal(normal.output, '')
  assert.match(normal.error, /model_not_listed/)
  assert.match(normal.error, /Next:/)
  const json = await f.verify(['--model', 'missing:local', '--json'])
  assert.equal(json.code, 1)
  assert.equal(JSON.parse(json.output).http_completed, false)
  assert.match(json.error, /fixed prompt/)
  assert.equal(f.inference(), 0)
  assert.equal(await fs.readFile(f.env.HYP_CONFIG, 'utf8'), saved)
})

// @ref LLP 0476#control [tests]: caller timeout and listener replacement cannot release actual storage ownership
for (const mode of ['inline', 'split']) test('timeout removes waiter, busy retries do not queue and reload retains real full-flush latch: ' + mode, async t => {
  const f = await fixture(t, mode)
  const entered = deferred()
  const release = deferred()
  t.after(release.resolve)
  let calls = 0
  const flush = f.kernel.storage.flushTable.bind(f.kernel.storage)
  f.kernel.storage.flushTable = async (...args) => {
    calls++
    entered.resolve()
    await release.promise
    return flush(...args)
  }
  const result = requestOllamaVerification({ ...f.control, operation: 'first', deadline: Date.now() + 150 })
  await entered.promise
  assert.equal((await result).reason, 'persistence_timeout')
  for (let i = 0; i < 8; i++) assert.equal((await requestOllamaVerification({ ...f.control, operation: 'retry-' + i, deadline: Date.now() + 1000 })).reason, 'settlement_busy')
  assert.equal(calls, 1)
  if (mode === 'inline') {
    await f.kernel.sources.reload('ai-gateway', f.ctx)
    const details = /** @type {any} */ ((await f.kernel.sources.status('ai-gateway'))?.details)
    f.control.endpoint = `http://${details.host}:${details.port}`
    f.control.generation = details.recording_generation
    assert.equal((await requestOllamaVerification({ ...f.control, operation: 'after-reload', deadline: Date.now() + 1000 })).reason, 'settlement_busy')
    assert.equal(calls, 1)
  } else {
    setGatewayProcessTransport(f.processingTransport)
    try { await f.processing.reload(f.ctx) } finally { setGatewayProcessTransport(undefined) }
    assert.equal((await requestOllamaVerification({ ...f.control, operation: 'after-processing-reload', deadline: Date.now() + 1000 })).reason, 'settlement_busy')
    assert.equal(calls, 1)
  }
  release.resolve()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await requestOllamaVerification({ ...f.control, operation: 'settled-retry', deadline: Date.now() + 2000 })).reason, 'settled')
  assert.equal(calls, 2)
})

test('serialized settlement handles provider HTTP before delayed append within one deadline', async t => {
  const f = await fixture(t)
  const entered = deferred()
  const release = deferred()
  t.after(release.resolve)
  const append = f.kernel.storage.appendRows.bind(f.kernel.storage)
  const appended = deferred()
  f.kernel.storage.appendRows = async (...args) => {
    entered.resolve()
    await release.promise
    await append(...args)
    appended.resolve()
  }
  const flush = f.kernel.storage.flushTable.bind(f.kernel.storage)
  let flushes = 0
  f.kernel.storage.flushTable = async (...args) => {
    if (++flushes === 2) {
      release.resolve()
      await appended.promise
    }
    return flush(...args)
  }
  const token = 'ollama-check-delayed'
  const from = new Date().toISOString()
  await fetch(f.root + '/ollama/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hyp-dev-run-id': token }, body: JSON.stringify({ model: 'tiny:local', messages: [{ role: 'user', content: 'check' }], think: false, stream: false }) })
  await entered.promise
  const args = { env: f.env, cacheRoot: f.kernel.cacheRoot, cwd: process.cwd(), token, model: 'tiny:local', from, to: new Date(Date.now() + 60000).toISOString(), control: f.control, timeoutMs: 4000 }
  const confirmation = awaitPersistedOllamaCheck(args)
  const result = await confirmation
  assert.equal(result.reason, 'persisted')
  assert.ok(result.reads !== undefined && result.reads > 1 && result.reads <= 6)
  assert.equal(f.inference(), 1)
})

test('delayed append outside deadline remains unconfirmed and live collector can finish', async t => {
  const f = await fixture(t)
  const entered = deferred()
  const release = deferred()
  t.after(release.resolve)
  const append = f.kernel.storage.appendRows.bind(f.kernel.storage)
  f.kernel.storage.appendRows = async (...args) => {
    entered.resolve()
    await release.promise
    return append(...args)
  }
  const token = 'ollama-check-timeout'
  const from = new Date().toISOString()
  await fetch(f.root + '/ollama/api/chat', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hyp-dev-run-id': token }, body: JSON.stringify({ model: 'tiny:local', messages: [{ role: 'user', content: 'check' }], think: false, stream: false }) })
  await entered.promise
  const args = { env: f.env, cacheRoot: f.kernel.cacheRoot, cwd: process.cwd(), token, model: 'tiny:local', from, to: new Date(Date.now() + 60000).toISOString(), control: f.control, timeoutMs: 600 }
  const result = await awaitPersistedOllamaCheck(args)
  assert.equal(result.reason, 'persistence_timeout')
  assert.equal(result.request_id, undefined)
  assert.ok(result.reads === undefined || result.reads <= 6)
  release.resolve()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await awaitPersistedOllamaCheck({ ...args, timeoutMs: 2000 })).reason, 'persisted')
  assert.equal(f.inference(), 1)
})

test('local verification control rejects browser/rebinding, oversized, unknown and stale metadata', async t => {
  const f = await fixture(t)
  const body = { operation: 'test', runId: f.control.runId, generation: f.control.generation }
  for (const headers of [{ host: 'evil.invalid' }, { origin: 'http://localhost' }]) {
    const status = await new Promise(resolve => {
      const request = http.request(f.root + VERIFY_PATH, { method: 'POST', headers }, response => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
      })
      request.end(JSON.stringify(body))
    })
    assert.ok(status === 403 || status === 421)
  }
  assert.equal((await fetch(f.root + VERIFY_PATH, { method: 'POST', body: 'x'.repeat(257) })).status, 413)
  const chunkedStatus = await new Promise(resolve => {
    const request = http.request(f.root + VERIFY_PATH, { method: 'POST' }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    request.write('x'.repeat(257))
    request.end()
  })
  assert.equal(chunkedStatus, 413)
  assert.equal((await fetch(f.root + VERIFY_PATH, { method: 'POST', body: JSON.stringify({ ...body, sql: 'select 1' }) })).status, 400)
  assert.equal((await fetch(f.root + VERIFY_PATH, { method: 'POST', body: JSON.stringify({ ...body, runId: 'other' }) })).status, 409)
  assert.equal((await fetch(f.root + VERIFY_PATH + '?extra=1', { method: 'POST', body: JSON.stringify(body) })).status, 403)
  assert.equal(f.inference(), 0)
})

test('old listener refuses a replaced PID/run identity without admitting a flush', async t => {
  const f = await fixture(t)
  let flushes = 0
  const flush = f.kernel.storage.flushTable.bind(f.kernel.storage)
  f.kernel.storage.flushTable = async (...args) => {
    flushes++
    return flush(...args)
  }
  writePidFile(path.join(f.home, 'hypaware'), { ...f.pid, runId: 'replacement' })
  assert.equal((await requestOllamaVerification({ endpoint: f.root, runId: 'replacement', deadline: Date.now() + 1000 })).reason, 'processor_unavailable')
  assert.equal((await requestOllamaVerification({ ...f.control, operation: 'old', deadline: Date.now() + 1000 })).reason, 'processor_unavailable')
  assert.equal(flushes, 0)
})

async function filesystemSnapshot(root) {
  const { createHash } = await import('node:crypto')
  const entries = []
  async function walk(dir) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, name)
      const stat = await fs.lstat(file)
      entries.push({ name: path.relative(root, file), mode: stat.mode, size: stat.isFile() ? stat.size : null, mtimeMs: stat.mtimeMs,
        hash: stat.isFile() ? createHash('sha256').update(await fs.readFile(file)).digest('hex') : null })
      if (stat.isDirectory()) await walk(file)
    }
  }
  await walk(root)
  return entries
}

// @ref LLP 0476#confirmation [tests]: real legacy config/cache/catalog construction and killed reads cannot migrate or mutate storage
for (const stalled of [false, true]) test('migration-disabled real reader leaves legacy config/cache/directories unchanged, stalled=' + stalled, { skip: stalled && process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  assert.equal((await f.verify()).code, 0)
  // Ordinary boot migrated grep already; restore the actual old config shape
  // before the reader, which must not create another backup/lock/config write.
  await fs.writeFile(f.env.HYP_CONFIG, JSON.stringify(f.config))
  const env = { ...f.env }
  if (stalled) {
    const { execFileSync } = await import('node:child_process')
    const fifo = path.join(f.home, 'stalled-config.json')
    execFileSync('mkfifo', [fifo])
    env.HYP_CONFIG = fifo
  }
  const before = await filesystemSnapshot(f.home)
  const result = await awaitPersistedOllamaCheck({ env, cacheRoot: f.kernel.cacheRoot, cwd: process.cwd(), token: 'ollama-check-absent', model: 'tiny:local', from: f.pid.startedAt, to: new Date(Date.now() + 60000).toISOString(), timeoutMs: 500 })
  assert.equal(result.reason, 'persistence_timeout')
  assert.deepEqual(await filesystemSnapshot(f.home), before)
  assert.equal(process.getActiveResourcesInfo().filter(name => name === 'ProcessWrap').length, 0)
  assert.equal(JSON.parse(await fs.readFile(f.env.HYP_CONFIG, 'utf8')).plugins.some(p => p.name === '@hypaware/grep'), false)
})

for (const reattach of [false, true]) test('detach during admitted flush cannot confirm current capture, reattach=' + reattach, async t => {
  const f = await fixture(t)
  const entered = deferred()
  const release = deferred()
  t.after(release.resolve)
  const flush = f.kernel.storage.flushTable.bind(f.kernel.storage)
  f.kernel.storage.flushTable = async (...args) => {
    entered.resolve()
    await release.promise
    return flush(...args)
  }
  const pending = f.verify()
  await entered.promise
  const off = /** @type {any} */ (structuredClone(f.config))
  off.plugins[1] = { name: '@hypaware/ollama', recording: false }
  await fs.writeFile(f.env.HYP_CONFIG, JSON.stringify(off))
  assert.equal((await fetch(f.root + '/_hypaware/recording/ollama', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"recording":false}' })).status, 200)
  if (reattach) {
    await fs.writeFile(f.env.HYP_CONFIG, JSON.stringify(f.config))
    assert.equal((await fetch(f.root + '/_hypaware/recording/ollama', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"recording":true}' })).status, 200)
  }
  release.resolve()
  const result = await pending
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.output).status, 'unconfirmed')
  assert.equal(JSON.parse(result.output).request_id, undefined)
  assert.equal(f.inference(), 1)
  assert.equal((await f.kernel.storage.pendingInfo(aiGatewayTablePath(f.kernel.storage))).pending, false)
})

test('lost and mismatched IPC acknowledgments cannot release or satisfy another operation', async () => {
  const frames = []
  let child = /** @type {any} */ ({ connected: true, send(frame, callback) {
    frames.push(frame)
    callback(null)
  } })
  const sender = createCaptureSender({ getChild: () => child, log: { warn() {} } })
  sender.message({ type: 'gateway.capture_ready' })
  const controller = new AbortController()
  const first = sender.settleVerification('generation:1', controller.signal)
  const one = frames.at(-1)
  assert.equal(await sender.settleVerification('generation:1', new AbortController().signal), 'settlement_busy')
  controller.abort()
  assert.equal(await first, 'processor_unavailable')
  const secondController = new AbortController()
  const second = sender.settleVerification('generation:1', secondController.signal)
  const two = frames.at(-1)
  sender.message({ type: 'gateway.verify_ack', id: one.id, generation: 'generation:1', reason: 'settled' })
  assert.equal(await sender.settleVerification('generation:1', new AbortController().signal), 'settlement_busy')
  sender.message({ type: 'gateway.verify_ack', id: two.id, generation: 'wrong', reason: 'settled' })
  assert.equal(await second, 'processor_unavailable')
  const old = sender.settleVerification('generation:1', new AbortController().signal)
  const three = frames.at(-1)
  child = { ...child }
  sender.message({ type: 'gateway.verify_ack', id: three.id, generation: 'generation:1', reason: 'settled' })
  assert.equal(await old, 'processor_unavailable')
  sender.reset()
})

test('absolute-form verification is rejected before upstream matching or capture', async t => {
  const f = await fixture(t)
  const status = await new Promise(resolve => {
    const request = http.request(f.root, { method: 'POST', path: f.root + VERIFY_PATH }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    request.end('{}')
  })
  assert.equal(status, 403)
  assert.equal(f.inference(), 0)
})

test('verification receipts reject overlong service identity and unexpected settlement values', async t => {
  const { createVerificationControlHandler } = await import('../../hypaware-core/plugins-workspace/ai-gateway/src/recording.js')
  let runId = 'x'.repeat(2000)
  const control = createVerificationControlHandler({ current: () => ({ runId, generation: 'one', recording: true }),
    settle: async () => ({ payload: 'x'.repeat(2000) }) })
  const server = http.createServer((req, res) => control.handle(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  t.after(async () => {
    control.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(() => resolve(undefined)))
  })
  const port = /** @type {AddressInfo} */ (server.address()).port
  const root = `http://127.0.0.1:${port}`
  const invalid = await fetch(root + VERIFY_PATH)
  const raw = await invalid.text()
  assert.equal(invalid.status, 503)
  assert.ok(Buffer.byteLength(raw) <= 1024)
  runId = 'valid'
  const result = await fetch(root + VERIFY_PATH, { method: 'POST', body: JSON.stringify({ runId, generation: 'one', operation: 'test' }) })
  const value = await result.text()
  assert.equal(result.status, 503)
  assert.ok(Buffer.byteLength(value) <= 1024)
  assert.equal(JSON.parse(value).reason, 'processor_unavailable')
})

test('real non-loopback peer cannot invoke verification even with loopback Host', async t => {
  const { networkInterfaces } = await import('node:os')
  const address = Object.values(networkInterfaces()).flat().find(item => item && item.family === 'IPv4' && !item.internal)?.address
  if (!address) {
    t.skip('no non-loopback interface')
    return
  }
  const { createVerificationControlHandler } = await import('../../hypaware-core/plugins-workspace/ai-gateway/src/recording.js')
  let operations = 0
  const control = createVerificationControlHandler({ current: () => ({ runId: 'test', generation: 'one', recording: true }), settle: async () => {
    operations++
    return 'settled'
  } })
  const server = http.createServer((req, res) => control.handle(req, res))
  await new Promise(resolve => server.listen(0, address, () => resolve(undefined)))
  t.after(async () => {
    control.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(() => resolve(undefined)))
  })
  const port = /** @type {AddressInfo} */ (server.address()).port
  const status = await new Promise(resolve => {
    const request = http.request(`http://${address}:${port}${VERIFY_PATH}`, { method: 'POST', headers: { host: '127.0.0.1:' + port } }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode))
    })
    request.end('{"runId":"test","generation":"one","operation":"test"}')
  })
  assert.equal(status, 403)
  assert.equal(operations, 0)
})

// @ref LLP 0476#cohort [tests]: requested refresh keeps ordinary hooks and variable backlog cost, without an extra storage algorithm
test('representative backlog and hooks use the same full-flush work as direct baseline', async t => {
  if (!process.env.T4_FLUSH_SAMPLE) {
    const samples = []
    for (const rows of [2, 2000]) for (const requested of [false, true]) {
      const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-name-pattern=representative backlog', fileURLToPath(import.meta.url)], {
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, T4_FLUSH_SAMPLE: JSON.stringify({ rows, requested }) }, timeout: 15000, maxBuffer: 256 * 1024,
      })
      const sample = stdout.split('\n').find(line => line.includes('T4_FLUSH_COST '))
      assert.ok(sample)
      samples.push(JSON.parse(sample.slice(sample.indexOf('T4_FLUSH_COST ') + 14)))
    }
    console.log('T4_ISOLATED_FLUSH_COST ' + JSON.stringify(samples))
    return
  }
  const { performance } = await import('node:perf_hooks')
  const { rows, requested } = JSON.parse(process.env.T4_FLUSH_SAMPLE)
  const f = await fixture(t)
  const table = aiGatewayTablePath(f.kernel.storage)
  let hookRows = 0
  const dataset = f.kernel.query.getDataset('ai_gateway_messages')
  assert.ok(dataset?.settleBatch)
  const settle = dataset.settleBatch
  dataset.settleBatch = async (batch, context) => {
    hookRows += batch.length
    return settle(batch, context)
  }
  const at = new Date().toISOString()
  const batch = Array.from({ length: rows }, (_, i) => ({ gateway_id: 'fixture', schema_version: 7, date: at.slice(0, 10), request_id: 'backlog-' + i,
    session_id: 'backlog-' + i, message_id: 'backlog-' + i, part_id: 'backlog-' + i + '#0', part_index: 0, part_type: 'text', message_index: i,
    message_created_at: at, conversation_started_at: at, previous_message_id: '[]', role: 'user', provider: 'ollama', model: 'tiny:local',
    attributes: '{}', content: 'x'.repeat(4096), content_text: 'x'.repeat(4096) }))
  await f.kernel.storage.appendRows(table, [...AI_GATEWAY_SCHEMA_COLUMNS], batch)
  const pending = await f.kernel.storage.pendingInfo(table)
  const heapBefore = process.memoryUsage().heapUsed
  let peakHeap = heapBefore
  let peakRss = process.memoryUsage().rss
  const measure = setInterval(() => {
    const memory = process.memoryUsage()
    peakHeap = Math.max(peakHeap, memory.heapUsed)
    peakRss = Math.max(peakRss, memory.rss)
  }, 5)
  const cpuStart = process.cpuUsage()
  const started = performance.now()
  try {
    if (requested) assert.equal((await requestOllamaVerification({ ...f.control, operation: 'backlog', deadline: Date.now() + 10000 })).reason, 'settled')
    else await f.kernel.storage.flushTable(table, { force: true })
  } finally { clearInterval(measure) }
  const cpu = process.cpuUsage(cpuStart)
  console.log('T4_FLUSH_COST ' + JSON.stringify({ requested, rows, pendingBytes: pending.pendingBytes, hookRows,
    cpuMs: (cpu.user + cpu.system) / 1000, elapsedMs: performance.now() - started, heapBeforeBytes: heapBefore, peakHeapBytes: peakHeap, peakRssBytes: peakRss }))
  assert.equal(hookRows, rows)
  assert.equal((await f.kernel.storage.pendingInfo(table)).pending, false)
})

// @ref LLP 0474#diagnostics [tests]: benign provider control is not recovery from a capture failure in either heap
for (const mode of ['inline', 'split']) test('source failure reason survives load control until fresh persistence or a new failure: ' + mode, async t => {
  const f = await fixture(t, mode, true)
  async function summary() {
    const gateway = await f.kernel.sources.status('ai-gateway')
    assert.ok(gateway?.details)
    const recorded = mode === 'split' ? await f.processing.status() : gateway
    assert.ok(recorded?.details)
    const outcomes = mergeCaptureOutcomes(recorded.details.capture_outcomes, gateway.details.capture_outcomes)
    const snapshot = { ...f.pid, state: /** @type {const} */ ('healthy'), healthyAt: f.pid.startedAt, uptimeMs: Date.now() - Date.parse(f.pid.startedAt), sinks: [], sources: [{ name: 'ai-gateway', plugin: '@hypaware/ai-gateway', state: /** @type {const} */ ('started'), details: { ...gateway.details, capture_outcomes: outcomes, capture_ready: true } }] }
    const entry = /** @type {any} */ (outcomes.find(entry => entry.route === 'ollama-native'))
    assert.ok(entry)
    return { status: ollamaCaptureFromSnapshot(f.config, snapshot, f.pid), entry }
  }
  async function request(route, body) {
    const response = await fetch(f.root + '/ollama/api/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    await response.text()
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  await request('chat', { model: 'tiny:local', messages: [{ role: 'user', content: 'unsupported' }], think: true, stream: false })
  const failed = await summary()
  assert.equal(failed.status.reason, 'unsupported_shape')
  assert.equal(failed.status.state, 'failed')
  for (let i = 0; i < 3; i++) await request('generate', { model: 'tiny:local', prompt: '', stream: false })
  const benign = await summary()
  assert.equal(benign.status.state, 'failed')
  assert.equal(benign.status.reason, 'unsupported_shape')
  assert.equal(benign.status.next, failed.status.next)
  assert.equal(benign.entry.last_failed, failed.entry.last_failed)
  assert.equal(benign.entry.failed_id, failed.entry.failed_id)
  assert.equal(benign.entry.last_outcome, failed.entry.last_outcome)
  assert.equal(benign.entry.reasons.load_unload, 3)
  assert.equal(benign.entry.persisted, 0)
  const result = await f.verify()
  assert.equal(result.code, 0, result.error + result.output)
  const recovered = await summary()
  assert.equal(recovered.status.state, 'persisted')
  assert.equal(recovered.status.reason, null)
  assert.equal(recovered.entry.reason, 'text')
  assert.ok(recovered.entry.last_persisted > failed.entry.last_failed)
  await request('chat', { messages: [{ role: 'user', content: 'invalid model' }], stream: false })
  const newer = await summary()
  assert.equal(newer.status.state, 'failed')
  assert.equal(newer.status.reason, 'invalid_request')
  assert.ok(newer.entry.last_failed > recovered.entry.last_persisted)
  assert.notEqual(newer.entry.failed_id, failed.entry.failed_id)
})
