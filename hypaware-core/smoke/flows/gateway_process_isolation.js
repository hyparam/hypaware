// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync as fsSyncExists } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

import { runGatewayDaemon } from '../../../src/core/daemon/gateway.js'
import { gatewaySourceDetails } from '../../../src/core/daemon/status.js'
import { writeLock } from '../../../src/core/plugin_install/lock.js'
import { dispatch } from '../../../src/core/cli/dispatch.js'
import { getLogger, installObservability } from '../../../src/core/observability/index.js'

/**
 * @import { AddressInfo } from 'node:net'
 * @import { AiGatewayCapability } from '../../../hypaware-plugin-kernel-types.js'
 */

const FIXTURE_PLUGIN = '@third-party/heap-fault-fixture'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** @param {() => boolean} condition @param {string} label */
async function until(condition, label) {
  const deadline = Date.now() + 30_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`gateway_process_isolation: timed out at ${label}`)
    await sleep(50)
  }
}

/**
 * The fault lives in a test plugin source, not a production crash switch.
 * Only the processor starts that source. The gateway has a normal-sized heap.
 * @ref LLP 0038#implemented-boundary [tests]: actual processing heap exhaustion leaves an active gateway stream and opt-out alive
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  const log = getLogger('smoke')
  const step = smoke_step => log.info('smoke.step', { dev_run_id: harness.devRunId, smoke_name: harness.smokeName, smoke_step })
  const trigger = path.join(harness.tmpDir, 'exhaust-heap')
  const installDir = path.join(harness.stateDir, 'plugins', FIXTURE_PLUGIN)
  await fs.mkdir(installDir, { recursive: true })
  await fs.writeFile(path.join(installDir, 'hypaware.plugin.json'), JSON.stringify({ schema_version: 1, name: FIXTURE_PLUGIN, version: '0.1.0', hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './index.js' }))
  await fs.writeFile(path.join(installDir, 'index.js'), `
import fs from 'node:fs'
export function activate(ctx) {
  ctx.sources.register({ name: 'heap-fault', plugin: '${FIXTURE_PLUGIN}', async start() {
    const timer = setInterval(() => {
      if (fs.existsSync(ctx.config.trigger + '.block')) {
        fs.unlinkSync(ctx.config.trigger + '.block')
        while (true) {}
      }
      if (!fs.existsSync(ctx.config.trigger)) return
      fs.unlinkSync(ctx.config.trigger)
      ctx.log.warn('smoke.processing_heap_exhaustion', { smoke_step: 'heap_overflow' })
      const retained = []
      while (true) retained.push(new Array(65536).fill(retained.length))
    }, 50)
    return { async stop() { clearInterval(timer) } }
  } })
}
`)
  await writeLock(harness.stateDir, { schema_version: 1, plugins: { [FIXTURE_PLUGIN]: { name: FIXTURE_PLUGIN, version: '0.1.0', source: { kind: 'local-dir', raw: installDir, path: installDir }, install_dir: installDir, content_hash: 'a'.repeat(64), manifest_hash: 'b'.repeat(64), installed_at: new Date().toISOString() } } })

  let upstreamChunks = 0
  const upstream = http.createServer((req, res) => {
    req.resume()
    if (req.url?.includes('stream=1')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const timer = setInterval(() => { res.write(`data: ${++upstreamChunks}\n\n`) }, 30)
      res.on('close', () => clearInterval(timer))
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'recovered-response', object: 'chat.completion', model: 'smoke', choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    }
  })
  step('upstream_start')
  await new Promise((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const upstreamPort = /** @type {AddressInfo} */ (upstream.address()).port
  const configPath = path.join(harness.hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({ version: 2, auto_update: false, query: { cache: { maintenance: { enabled: false } } }, plugins: [
    { name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:0', upstreams: [{ name: 'smoke-openai', base_url: `http://127.0.0.1:${upstreamPort}`, path_prefix: '/v1', provider: 'openai', priority: 100 }] } },
    { name: '@hypaware/codex', config: {} },
    { name: FIXTURE_PLUGIN, config: { trigger } },
  ] }))

  let handle
  let stream
  const abort = new AbortController()
  try {
    step('boot')
    handle = await runGatewayDaemon({ hypHome: harness.hypHome, configPath, env: { ...process.env, HOME: harness.tmpDir, HYP_HOME: harness.hypHome }, runId: harness.devRunId, tickIntervalMs: 100, processingExecArgv: ['--max-old-space-size=96'], installSignalHandlers: false })
    assert.ok(!handle.runtime.sources.get('heap-fault'), 'background plugin activated in gateway')
    assert.throws(() => handle.runtime.storage.readRows('forbidden'), /gateway process cannot access/)
    await until(() => handle.snapshot().processes?.processing.state === 'healthy', 'processor ready')
    const gatewayPid = handle.snapshot().pid
    const processorPid = handle.snapshot().processes.processing.pid
    const endpoint = gatewaySourceDetails(handle.snapshot().sources)
    assert.ok(endpoint)
    const base = `http://${endpoint.host}:${endpoint.port}`
    const ignoredId = 'isolation-ignored-session'
    const ignored = await fetch(`${base}/_hypaware/ignore/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: ignoredId }) })
    assert.equal(ignored.status, 200)

    step('stream_started')
    const response = await fetch(`${base}/v1/chat/completions?stream=1`, { method: 'POST', body: '{}', signal: abort.signal })
    assert.equal(response.status, 200)
    assert.ok(response.body)
    const body = response.body
    let received = 0
    let streamError
    stream = (async () => {
      try { for await (const chunk of body) received += chunk.byteLength }
      catch (error) { if (!abort.signal.aborted) streamError = error }
    })()
    await until(() => received > 0, 'first stream bytes')

    step('heap_overflow')
    await fs.writeFile(trigger, '')
    await until(() => handle.snapshot().processes?.processing.restarts > 0, 'processor heap exit')
    const atCrash = received
    await until(() => received > atCrash, 'stream continues after heap exit')
    assert.equal(handle.snapshot().pid, gatewayPid)
    assert.equal(streamError, undefined)
    await until(() => handle.snapshot().processes?.processing.state === 'healthy' && handle.snapshot().processes?.processing.pid !== processorPid, 'processor recovered')
    const gateway = /** @type {AiGatewayCapability} */ (handle.runtime.capabilities.require('smoke', 'hypaware.ai-gateway', '^2.0.0'))
    const ignoreStatus = await fetch(`${base}/_hypaware/ignore/session?session_id=${ignoredId}`)
    assert.equal(ignoreStatus.status, 200)
    assert.equal(/** @type {{ ignored: boolean }} */ (await ignoreStatus.json()).ignored, true)
    assert.equal(gateway.localEndpoint(), base)
    assert.ok(handle.snapshot().sources.find(s => s.name === 'ai-gateway').details.capture_dropped > 0)

    step('restart_blocked_processor')
    const recoveredPid = handle.snapshot().processes.processing.pid
    await fs.writeFile(trigger + '.block', '')
    await until(() => !fsSyncExists(trigger + '.block'), 'processor event loop blocked')
    const atBlock = received
    let restartError = ''
    const restartCode = await dispatch(['daemon', 'restart', '--processing'], { env: { ...process.env, HYP_HOME: harness.hypHome }, stdout: { write: () => true }, stderr: { write: value => { restartError += value; return true } } })
    assert.equal(restartCode, 0, restartError)
    await until(() => handle.snapshot().processes?.processing.state === 'healthy' && handle.snapshot().processes?.processing.pid !== recoveredPid, 'blocked processor replaced')
    assert.ok(received > atBlock)
    assert.equal(streamError, undefined)
    assert.equal(handle.snapshot().pid, gatewayPid)

    step('recording_recovered')
    const result = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hyp-dev-run-id': harness.devRunId, originator: 'codex-tui', 'x-codex-turn-metadata': JSON.stringify({ session_id: 'recovery-session', thread_id: 'recovery-thread', cwd: harness.tmpDir }) }, body: JSON.stringify({ model: 'smoke', messages: [{ role: 'user', content: 'hello' }], metadata: { session_id: 'recovery-session', cwd: harness.tmpDir } }) })
    assert.equal(result.status, 200)
    assert.ok((await result.text()).includes('recovered'))
    await until(() => handle.snapshot().sources.some(s => s.name === 'ai-gateway' && s.details.recent_entrypoints?.length > 0), 'recording committed to spool')
    abort.abort()
    await stream
    await handle.stop()

    step('verify_persistence')
    let output = ''
    let errors = ''
    const code = await dispatch(['query', 'sql', 'select content_text from ai_gateway_messages', '--refresh', 'always', '--format', 'json'], { env: { ...process.env, HOME: harness.tmpDir, HYP_HOME: harness.hypHome, HYP_CONFIG: configPath }, stdout: { write: value => { output += value; return true } }, stderr: { write: value => { errors += value; return true } } })
    assert.equal(code, 0, errors)
    assert.ok(JSON.parse(output).some(row => row.content_text === 'recovered'))
    step('complete')
    await obs.shutdown()
    const lifecycle = (await fs.readFile(path.join(harness.stateDir, 'logs', 'daemon.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(lifecycle.some(row => row.event === 'processing.exited' && row.signal === 'SIGABRT'), 'no actual heap-abort evidence')
    assert.ok(lifecycle.some(row => row.event === 'processing.exited' && row.signal === 'SIGKILL'), 'blocked processor was not forcibly replaced')
    assert.ok(lifecycle.filter(row => row.event === 'processing.spawned').length >= 2)
    const logs = await expect.logs()
    expect.that('isolation smoke emits completed step', logs, rows => JSON.stringify(rows).includes('recording_recovered'))
  } finally {
    abort.abort()
    await stream
    await handle?.stop()
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  }
}
