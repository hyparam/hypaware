// @ts-check

/** @import { StartedSource } from '../../hypaware-plugin-kernel-types.js' */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createGatewayState, createAiGatewayApi } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createStartSource } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'
import { createOllamaExchangeProjector } from '../../hypaware-core/plugins-workspace/ollama/src/projector.js'
import { createCaptureReceiver, createCaptureSender, setGatewayProcessTransport } from '../../hypaware-core/plugins-workspace/ai-gateway/src/process_transport.js'
import { ollamaNativeRoute } from '../../hypaware-core/plugins-workspace/ollama/src/setup.js'
import { createCodexExchangeProjector } from '../../hypaware-core/plugins-workspace/codex/src/exchange-projector.js'

const tick = () => new Promise(resolve => setTimeout(resolve, 20))
function deferred() {
  /** @type {() => void} */
  let resolve = () => {}
  const promise = /** @type {Promise<void>} */ (new Promise(done => { resolve = done }))
  return { promise, resolve }
}

async function fixture(mode = 'inline') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ollama-recording-'))
  const configPath = path.join(home, 'config.json')
  /** @param {unknown} entry */
  const policy = entry => fs.writeFile(configPath, JSON.stringify({ plugins: entry ? [entry] : [] }))
  await policy({ name: '@hypaware/ollama' })
  const arrived = deferred()
  const release = deferred()
  const server = http.createServer(async (req, res) => {
    req.resume()
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'other-client', choices: [{ message: { role: 'assistant', content: 'other answer' } }] }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(JSON.stringify({ model: 'fixture', message: { role: 'assistant', content: 'answer' }, done: false }) + '\n')
    arrived.resolve()
    await release.promise
    res.end(JSON.stringify({ model: 'fixture', message: { role: 'assistant', content: '' }, done: true }) + '\n')
  })
  await /** @type {Promise<void>} */ (new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined))))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const state = createGatewayState()
  const parseStarted = deferred()
  const parseRelease = deferred()
  let holdParse = false
  const projector = createOllamaExchangeProjector()
  state.projectors.push({ ...projector, _seq: 0, async project(input, context) {
    parseStarted.resolve()
    if (holdParse) await parseRelease.promise
    return projector.project(input, context)
  } })
  state.projectors.push({ ...createCodexExchangeProjector({ localOnlyListPath: path.join(home, 'local-only.jsonl') }), _seq: 1 })
  createAiGatewayApi(state).registerUpstreamAlias('ollama-native', 'ollama', ollamaNativeRoute())
  /** @type {Record<string, unknown>[]} */
  const rows = []
  const appendStarted = deferred()
  const appendRelease = deferred()
  let holdAppend = false
  /** @type {any} */
  const ctx = {
    config: { listen: '127.0.0.1:0', upstreams: [
      { name: 'ollama', provider: 'ollama', base_url: `http://127.0.0.1:${address.port}`, path_prefix: '/api/chat' },
      { name: 'openai', provider: 'openai', base_url: `http://127.0.0.1:${address.port}`, path_prefix: '/v1/chat/completions' },
    ] },
    env: { HOME: home, HYP_HOME: home, HYP_CONFIG: configPath },
    storage: {
      cacheTablePath: () => 'fixture',
      async appendRows(_path, _columns, batch) {
        appendStarted.resolve()
        if (holdAppend) await appendRelease.promise
        rows.push(...batch)
      },
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  }
  // Use the same config override the native boot resolver understands.
  ctx.env.HYP_CONFIG_PATH = configPath
  /** @type {ReturnType<typeof createCaptureReceiver> | undefined} */
  let receiver
  let queue = false
  /** @type {object[]} */
  const frames = []
  const child = /** @type {any} */ ({ connected: true, send(frame, callback) {
    if (queue && frame.type === 'gateway.capture') frames.push(frame)
    else receiver?.message(frame)
    callback(null)
  } })
  const sender = createCaptureSender({ getChild: () => child, log: ctx.log })
  if (mode === 'split') setGatewayProcessTransport({ role: 'gateway', ...sender })
  const source = await createStartSource(state)(ctx)
  const details = (await source.status?.())?.details
  assert.ok(details)
  /** @type {StartedSource | undefined} */
  let processing
  if (mode === 'split') {
    setGatewayProcessTransport({ role: 'processing', generation: /** @type {string} */ (details.recording_generation),
      endpoint: { host: /** @type {string} */ (details.host), port: /** @type {number} */ (details.port) },
      receive(onExchange, refreshRecording) {
        receiver = createCaptureReceiver({ onExchange, refreshRecording, send: frame => sender.message(frame) })
        sender.message({ type: 'gateway.capture_ready' })
        return () => receiver?.close() ?? Promise.resolve()
      },
    })
    processing = await createStartSource(state)(ctx)
    setGatewayProcessTransport(undefined)
  }
  const root = `http://${details.host}:${details.port}`
  /** @param {boolean} recording */
  const barrier = async recording => {
    await policy({ name: '@hypaware/ollama', recording })
    const response = await fetch(root + '/_hypaware/recording/ollama', { method: 'POST', body: JSON.stringify({ recording }) })
    return { status: response.status, body: await response.json() }
  }
  return {
    root, rows, source, processing, policy, home, configPath, ctx, arrived, release, appendStarted, appendRelease, barrier, parseStarted, parseRelease, sender,
    holdParse() { holdParse = true },
    queue() { queue = true },
    flush() { queue = false; for (const frame of frames.splice(0)) receiver?.message(frame) },
    holdAppend() { holdAppend = true },
    request: (route = '/ollama/api/chat') => fetch(root + route, { method: 'POST', body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'question' }] }) }).then(response => response.text()),
    async close() {
      release.resolve()
      appendRelease.resolve()
      parseRelease.resolve()
      await processing?.stop()
      sender.reset()
      setGatewayProcessTransport(undefined)
      await source.stop()
      await /** @type {Promise<void>} */ (new Promise(resolve => server.close(() => resolve(undefined))))
      await fs.rm(home, { recursive: true, force: true })
    },
  }
}

// @ref LLP 0475#t3 [tests]: actual raw/source/projector/append boundary, including old streams released after reattach
for (const mode of ['inline', 'split']) for (const reattach of [false, true]) test(`detach suppresses held native and legacy exchanges, mode=${mode}, reattach=${reattach}`, async () => {
  const f = await fixture(mode)
  try {
    const response = f.request()
    await f.arrived.promise
    assert.equal((await f.barrier(false)).status, 200)
    if (reattach) assert.equal((await f.barrier(true)).status, 200)
    f.release.resolve()
    assert.match(await response, /answer/)
    await tick()
    assert.equal(f.rows.length, 0)
    await f.request('/api/chat')
    await tick()
    assert.equal(f.rows.length, reattach ? 2 : 0)
  } finally { await f.close() }
})

for (const mode of ['inline', 'split']) test('successful off receipt waits for already admitted append, keeping historical rows: ' + mode, async () => {
  const f = await fixture(mode)
  try {
    f.holdAppend()
    f.release.resolve()
    await f.request()
    await f.appendStarted.promise
    let confirmed = false
    const off = f.barrier(false).then(value => { confirmed = true; return value })
    await tick()
    assert.equal(confirmed, false)
    f.appendRelease.resolve()
    assert.equal((await off).status, 200)
    assert.equal(f.rows.length, 2)
    await f.request()
    await tick()
    assert.equal(f.rows.length, 2)
  } finally { await f.close() }
})

for (const policy of [undefined, { name: '@hypaware/ollama', enabled: false }, { name: '@hypaware/ollama', recording: 'invalid' }]) test(`owner policy closes capture: ${JSON.stringify(policy)}`, async () => {
  const f = await fixture()
  try {
    await f.policy(policy)
    f.release.resolve()
    assert.match(await f.request(), /answer/)
    await tick()
    assert.equal(f.rows.length, 0)
  } finally { await f.close() }
})

for (const mode of ['inline', 'split']) test('parsing old generation cannot append after attach: ' + mode, async () => {
  const f = await fixture(mode)
  try {
    f.holdParse()
    f.release.resolve()
    await f.request()
    await f.parseStarted.promise
    assert.equal((await f.barrier(false)).status, 200)
    assert.equal((await f.barrier(true)).status, 200)
    f.parseRelease.resolve()
    await tick()
    assert.equal(f.rows.length, 0)
    await f.request()
    await tick()
    assert.equal(f.rows.length, 2)
  } finally { await f.close() }
})

test('queued raw frames from old generation cannot append after attach', async () => {
  const f = await fixture('split')
  try {
    f.queue()
    f.release.resolve()
    await f.request()
    assert.equal((await f.barrier(false)).status, 200)
    assert.equal((await f.barrier(true)).status, 200)
    f.flush()
    await tick()
    assert.equal(f.rows.length, 0)
    await f.request()
    await tick()
    assert.equal(f.rows.length, 2)
  } finally { await f.close() }
})

for (const mode of ['inline', 'split']) test('Ollama stop leaves simultaneous other-client capture working: ' + mode, async () => {
  const f = await fixture(mode)
  try {
    const held = f.request()
    await f.arrived.promise
    assert.equal((await f.barrier(false)).status, 200)
    const other = await fetch(f.root + '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'other question' }] }) })
    assert.match(await other.text(), /other answer/)
    f.release.resolve()
    assert.match(await held, /answer/)
    await tick()
    assert.equal(f.rows.length, 2)
    assert.ok(f.rows.every(row => row.provider === 'openai'))
  } finally { await f.close() }
})

test('repeated detach and source reload preserve off; raw disk enable alone does not resume', async () => {
  const f = await fixture()
  try {
    f.release.resolve()
    assert.equal((await f.barrier(false)).status, 200)
    assert.equal((await f.barrier(false)).status, 200)
    await f.source.reload?.(f.ctx)
    let status = await f.source.status?.()
    const root = `http://${status?.details?.host}:${status?.details?.port}`
    const request = () => fetch(root + '/api/chat', { method: 'POST', body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'q' }] }) }).then(response => response.text())
    assert.match(await request(), /answer/)
    await tick()
    assert.equal(f.rows.length, 0)
    await f.policy({ name: '@hypaware/ollama' })
    assert.match(await request(), /answer/)
    await tick()
    assert.equal(f.rows.length, 0)
    assert.equal((await fetch(root + '/_hypaware/recording/ollama', { method: 'POST', body: '{"recording":true}' })).status, 200)
    await request()
    await tick()
    assert.equal(f.rows.length, 2)
    status = await f.source.status?.()
    assert.equal(status?.details?.recording_appends, 0)
  } finally { await f.close() }
})

for (const mode of ['inline', 'split']) test('concurrent policy edit refuses barrier receipt and closes capture: ' + mode, async () => {
  const f = await fixture(mode)
  try {
    f.holdAppend()
    f.release.resolve()
    await f.request()
    await f.appendStarted.promise
    const off = f.barrier(false)
    await tick()
    await f.policy({ name: '@hypaware/ollama', recording: true })
    f.appendRelease.resolve()
    assert.equal((await off).status, 503)
    await f.request()
    await tick()
    assert.equal(f.rows.length, 2, 'only previously admitted append may settle')
    assert.equal(f.sender.snapshot().recording_waiters, 0)
  } finally { await f.close() }
})

test('missing or malformed owner file forwards without capturing', async () => {
  const f = await fixture()
  try {
    f.release.resolve()
    await fs.writeFile(f.configPath, '{')
    assert.match(await f.request(), /answer/)
    await fs.unlink(f.configPath)
    assert.match(await f.request('/api/chat'), /answer/)
    await tick()
    assert.equal(f.rows.length, 0)
  } finally { await f.close() }
})

for (const mode of ['inline', 'split']) test('disconnect releases one bounded barrier waiter and shutdown refuses pending receipt: ' + mode, async () => {
  const f = await fixture(mode)
  try {
    f.holdAppend()
    f.release.resolve()
    await f.request()
    await f.appendStarted.promise
    await f.policy({ name: '@hypaware/ollama', recording: false })
    const controller = new AbortController()
    const lost = fetch(f.root + '/_hypaware/recording/ollama', { method: 'POST', body: '{"recording":false}', signal: controller.signal }).catch(() => undefined)
    await tick()
    const busy = await fetch(f.root + '/_hypaware/recording/ollama', { method: 'POST', body: '{"recording":false}' })
    assert.equal(busy.status, 409)
    await busy.text()
    assert.ok(f.sender.snapshot().recording_waiters <= 1)
    controller.abort()
    await lost
    await tick()
    assert.equal(f.sender.snapshot().recording_waiters, 0)
    const pending = fetch(f.root + '/_hypaware/recording/ollama', { method: 'POST', body: '{"recording":false}' }).then(async response => { await response.text(); return response.status })
    await tick()
    const stopped = f.source.stop()
    assert.equal(await pending, 503)
    f.appendRelease.resolve()
    await stopped
    assert.equal(f.sender.snapshot().recording_waiters, 0)
  } finally { await f.close() }
})

test('control body and method are bounded before attempting refresh', async () => {
  const f = await fixture()
  try {
    for (const [body, status] of /** @type {[string, number][]} */ ([['x'.repeat(257), 413], ['{"recording":false,"extra":true}', 400], ['{}', 400]])) {
      const response = await fetch(f.root + '/_hypaware/recording/ollama', { method: 'POST', body })
      assert.equal(response.status, status)
      await response.text()
    }
    const response = await fetch(f.root + '/_hypaware/recording/ollama')
    assert.equal(response.status, 405)
    await response.text()
    assert.equal((await f.barrier(false)).status, 200)
  } finally { await f.close() }
})

for (const mode of ['inline', 'split']) test('active capture ceiling stays bounded and off traffic keeps forwarding: ' + mode, async () => {
  const f = await fixture(mode)
  try {
    const responses = await Promise.all(Array.from({ length: 33 }, () => fetch(f.root + '/ollama/api/chat', { method: 'POST', body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'q' }] }) })))
    const status = await f.source.status?.()
    const entries = /** @type {any[]} */ (status?.details?.capture_outcomes)
    assert.ok(entries.some(entry => entry.reasons.capture_limit >= 1))
    assert.ok(f.sender.snapshot().capture_active <= 32)
    assert.equal((await f.barrier(false)).status, 200)
    assert.equal(f.sender.snapshot().capture_active, 0)
    f.release.resolve()
    assert.ok((await Promise.all(responses.map(response => response.text()))).every(body => body.includes('answer')))
    await tick()
    assert.equal(f.rows.length, 0)
    assert.equal((await f.barrier(true)).status, 200)
    await f.request()
    await tick()
    assert.equal(f.rows.length, 2)
  } finally { await f.close() }
})

test('real append-drain deadline refuses success and releases waiter before a later retry', async () => {
  const f = await fixture('split')
  try {
    f.holdAppend()
    f.release.resolve()
    await f.request()
    await f.appendStarted.promise
    const at = Date.now()
    assert.equal((await f.barrier(false)).status, 503)
    assert.ok(Date.now() - at >= 9900)
    assert.ok(Date.now() - at < 12_000)
    assert.equal(f.sender.snapshot().recording_waiters, 0)
    f.appendRelease.resolve()
    await tick()
    assert.equal(f.rows.length, 2)
    assert.equal((await f.barrier(false)).status, 200)
    await f.request()
    await tick()
    assert.equal(f.rows.length, 2)
    const status = await f.processing?.status?.()
    assert.equal(status?.details?.recording_appends, 0)
  } finally { await f.close() }
})

for (const mode of ['inline', 'split']) test('one append stamps exactly one persisted semantic outcome: ' + mode, async () => {
  const f = await fixture(mode)
  try {
    f.release.resolve()
    await f.request()
    await tick()
    const status = await (f.processing ?? f.source).status?.()
    const entry = /** @type {any[]} */ (status?.details?.capture_outcomes).find(entry => entry.route === 'ollama-native')
    assert.equal(entry.observed, 1)
    assert.equal(entry.persisted, 1)
    assert.equal(entry.reasons.text, 1)
    assert.equal(entry.failed, 0)
    assert.match(entry.persisted_id, /^[a-f0-9]{32}$/)
  } finally { await f.close() }
})
