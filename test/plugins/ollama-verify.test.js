// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { persistedOllamaCheck, ollamaCheckSql } from '../../hypaware-core/plugins-workspace/ollama/src/verify.js'
import { ollamaCaptureFromSnapshot } from '../../src/core/daemon/status.js'

const token = 'ollama-check-0123456789abcdef'
const model = 'tiny:local'
const start = new Date().toISOString()
const pid = /** @type {any} */ ({ pid: process.pid, runId: 'current', startedAt: start, mode: 'foreground' })
const config = /** @type {any} */ ({ version: 2, plugins: [{ name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:18521', upstreams: [{ name: 'ollama', base_url: 'http://localhost:11434/service/' }] } }, { name: '@hypaware/ollama' }] })
function snapshot(outcomes = []) {
  return /** @type {any} */ ({ ...pid, state: 'healthy', healthyAt: start, uptimeMs: 0, sources: [{ name: 'ai-gateway', state: 'started', details: { host: '127.0.0.1', port: 24500, capture_ready: true, recording_enabled: true, projectors: ['ollama-native-chat'], upstream_aliases: [{ name: 'ollama-native', canonical: 'ollama', path_prefix: '/ollama', base_url: 'http://localhost:11434/service/' }], capture_outcomes: outcomes } }] })
}
function rows(id = 'exchange-current') {
  const base = { request_id: id, provider: 'ollama', model, attributes: { dev_run_id: token, gateway: { status_code: 200 } }, part_type: 'text', part_index: 0, message_created_at: start }
  return [{ ...base, role: 'user', message_index: 0, message_id: id + ':request:0', previous_message_id: [] }, { ...base, role: 'assistant', message_index: 1, message_id: id + ':response', previous_message_id: [id + ':request:0'] }]
}
// @ref LLP 0474#diagnostics [tests]: a fresh metadata correlation must identify the linked request and new assistant, never activity or prior successes
test('persisted check requires the current linked pair, provider, model and order', () => {
  assert.equal(persistedOllamaCheck(rows(), token, model, start), 'exchange-current')
  for (const bad of [[], [rows()[0]], [rows()[1]], rows().map(r => ({ ...r, model: 'other' })), rows().map(r => ({ ...r, provider: 'openai' })), rows().map(r => ({ ...r, attributes: { dev_run_id: 'old' } })), rows().map(r => ({ ...r, message_created_at: '2020-01-01T00:00:00Z' }))]) assert.equal(persistedOllamaCheck(bad, token, model, start), undefined)
  const mismatch = rows()
  mismatch[1].request_id = 'other'
  assert.equal(persistedOllamaCheck(mismatch, token, model, start), undefined)
  const reordered = rows()
  reordered[1].message_index = 0
  assert.equal(persistedOllamaCheck(reordered, token, model, start), undefined)
  const context = rows()
  context[1].message_id = 'exchange-current:request:1'
  assert.equal(persistedOllamaCheck(context, token, model, start), undefined)
  const link = rows()
  link[1].previous_message_id = ['old']
  assert.equal(persistedOllamaCheck(link, token, model, start), undefined)
})
test('check query has a fresh correlation, bounded dates and row limit', () => {
  const sql = ollamaCheckSql(token, start, new Date(Date.now() + 60000).toISOString())
  assert.match(sql, /json_extract\(attributes, '\$\.dev_run_id'\)/)
  assert.match(sql, /message_created_at >=/)
  assert.match(sql, /message_created_at <=/)
  assert.match(sql, /limit 3$/)
  assert.doesNotMatch(sql, /select \*/i)
})
test('capture readiness distinguishes actual fallback port, no traffic, controls and pending append', () => {
  const ready = ollamaCaptureFromSnapshot(config, snapshot(), pid)
  assert.equal(ready.state, 'ready')
  assert.equal(ready.captureRoot, 'http://127.0.0.1:24500/ollama')
  assert.equal(ready.configuredRoot, 'http://127.0.0.1:18521/ollama')
  assert.equal(ollamaCaptureFromSnapshot(config, snapshot([{ route: 'ollama-native', observed: 1, reason: 'load_unload', last_outcome: start }]), pid).state, 'ready')
  assert.equal(ollamaCaptureFromSnapshot(config, snapshot([{ route: 'ollama-native', observed: 1, last_observed: start }]), pid).state, 'observed')
})
test('append failure supersedes earlier success and detached/restarted stamps are history', () => {
  const outcome = { route: 'ollama-native', persisted: 1, last_persisted: new Date(Date.now() - 1000).toISOString(), last_failed: start, failed: 1, reason: 'append_failure', last_outcome: start }
  assert.equal(ollamaCaptureFromSnapshot(config, snapshot([outcome]), pid).state, 'failed')
  assert.equal(ollamaCaptureFromSnapshot(config, snapshot([outcome]), pid).reason, 'append_failure')
  const off = structuredClone(config)
  off.plugins[1].recording = false
  const detached = ollamaCaptureFromSnapshot(off, snapshot([outcome]), pid)
  assert.equal(detached.state, 'disabled')
  assert.equal(detached.historical, true)
  const stale = snapshot([outcome])
  stale.runId = 'prior'
  const restarted = ollamaCaptureFromSnapshot(config, stale, pid)
  assert.equal(restarted.state, 'unconfirmed')
  assert.equal(restarted.historical, true)
  assert.equal(ollamaCaptureFromSnapshot(config, snapshot(), pid).lastPersisted, null)
})
test('saved endpoint changes, absent processor and invalid snapshot cannot confirm capture', () => {
  const drift = structuredClone(config)
  drift.plugins[0].config.upstreams[0].base_url = 'http://localhost:11434/new/'
  assert.equal(ollamaCaptureFromSnapshot(drift, snapshot(), pid).state, 'unconfirmed')
  const unavailable = snapshot()
  unavailable.sources[0].details.capture_ready = false
  assert.equal(ollamaCaptureFromSnapshot(config, unavailable, pid).state, 'unconfirmed')
  assert.equal(ollamaCaptureFromSnapshot(config, undefined, null).state, 'unconfirmed')
})

test('actual normal/client status dispatch reads finite snapshots without starting a query or network probe', async t => {
  const { temporaryDirectory } = await import('../helpers/temp_dir.js')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const { isolatedClientEnv } = await import('../../hypaware-core/smoke/lib/isolation.js')
  const { createKernelRuntime } = await import('../../src/core/runtime/activation.js')
  const { dispatch } = await import('../../src/core/cli/dispatch.js')
  const home = temporaryDirectory('hyp-ollama-status-')
  const state = path.join(home, 'hypaware')
  await fs.mkdir(path.join(state, 'run'), { recursive: true })
  await fs.writeFile(path.join(home, 'hypaware-config.json'), JSON.stringify(config))
  const env = { ...isolatedClientEnv(process.env, home), HYP_HOME: home, HYP_CONFIG: '' }
  const kernel = createKernelRuntime({ cacheRoot: path.join(state, 'cache') })
  let queries = 0
  kernel.query.getDataset = () => { queries++
    throw new Error('status must not query') }
  async function statusCommand(argv) {
    let text = ''
    let errors = ''
    const code = await dispatch(argv, { kernel, env, stdout: { write: value => { text += value } }, stderr: { write: value => { errors += value } } })
    assert.equal(code, 0, errors)
    return text
  }
  await fs.writeFile(path.join(state, 'run/hypaware.pid'), JSON.stringify(pid))
  await fs.writeFile(path.join(state, 'run/status.json'), JSON.stringify(snapshot()))
  const normal = await statusCommand(['status'])
  assert.match(normal, /Ready; no conversation traffic/)
  assert.match(normal, /Live capture root: http:\/\/127.0.0.1:24500\/ollama/)
  const clients = JSON.parse(await statusCommand(['client', 'status', 'ollama', '--json']))
  assert.equal(clients.clients[0].capture.state, 'ready')
  assert.equal(clients.clients[0].capture.processorReady, true)
  const failure = { route: 'ollama-native', failed: 1, last_failed: start, reason: 'append_failure' }
  await fs.writeFile(path.join(state, 'run/status.json'), JSON.stringify(snapshot([failure])))
  const failedStatus = await statusCommand(['status'])
  assert.match(failedStatus, /^HypAware · Needs attention/)
  assert.match(failedStatus, /Capture failed[\s\S]*append_failure[\s\S]*Next:/)
  const recovered = { ...failure, last_failed: new Date(Date.parse(start) - 1000).toISOString(), last_persisted: start, persisted: 1 }
  await fs.writeFile(path.join(state, 'run/status.json'), JSON.stringify(snapshot([recovered])))
  const recoveredStatus = await statusCommand(['status'])
  assert.match(recoveredStatus, /Capture persisted[\s\S]*Earlier capture failure/)
  assert.doesNotMatch(recoveredStatus, /Ollama: Capture failed/)
  await fs.writeFile(path.join(state, 'run/status.json'), JSON.stringify(snapshot([failure])))
  const off = structuredClone(config)
  off.plugins[1].recording = false
  await fs.writeFile(path.join(home, 'hypaware-config.json'), JSON.stringify(off))
  assert.match(await statusCommand(['client', 'status', 'ollama']), /not recording[\s\S]*Historical failure/)
  assert.equal(queries, 0)
  assert.equal(kernel.query.listDatasets().length, 0)
})

test('real read-only query worker confirms exact stored pair and cannot pass poisoned old rows', async t => {
  const { temporaryDirectory } = await import('../helpers/temp_dir.js')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const { isolatedClientEnv } = await import('../../hypaware-core/smoke/lib/isolation.js')
  const { createKernelRuntime } = await import('../../src/core/runtime/activation.js')
  const { aiGatewayDatasetRegistration, AI_GATEWAY_SCHEMA_COLUMNS, aiGatewayTablePath } = await import('../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js')
  const { awaitPersistedOllamaCheck } = await import('../../hypaware-core/plugins-workspace/ollama/src/verify.js')
  const home = temporaryDirectory('hyp-ollama-query-worker-')
  const cacheRoot = path.join(home, 'hypaware', 'cache')
  const env = { ...isolatedClientEnv(process.env, home), HYP_HOME: home, HYP_CONFIG: '' }
  await fs.writeFile(path.join(home, 'hypaware-config.json'), JSON.stringify(config))
  const kernel = createKernelRuntime({ cacheRoot })
  kernel.query.registerDataset(aiGatewayDatasetRegistration())
  const table = aiGatewayTablePath(kernel.storage)
  const stored = rows().map(row => ({ ...row, gateway_id: 'test-gateway', schema_version: 7, date: start.slice(0, 10), session_id: row.request_id, conversation_started_at: start, part_id: row.message_id + '#0', attributes: JSON.stringify(row.attributes), previous_message_id: JSON.stringify(row.previous_message_id) }))
  await kernel.storage.appendRows(table, [...AI_GATEWAY_SCHEMA_COLUMNS], stored)
  await kernel.storage.flushTable(table, { force: true })
  const args = { env, cacheRoot, cwd: process.cwd(), token, model, from: start, to: new Date(Date.now() + 60000).toISOString(), timeoutMs: 2000 }
  const result = await awaitPersistedOllamaCheck(args)
  assert.equal(result.reason, 'persisted')
  assert.equal(result.request_id, 'exchange-current')
  assert.equal(result.reads, 1)
  const before = Date.now()
  const old = await awaitPersistedOllamaCheck({ ...args, token: 'ollama-check-fresh', timeoutMs: 500 })
  assert.equal(old.reason, 'persistence_timeout')
  assert.ok(Date.now() - before < 1500)
  assert.equal(old.request_id, undefined)
  // A fresh append stays spooled: read-only worker cannot settle/mutate it.
  const fresh = stored.map(row => ({ ...row, attributes: JSON.stringify({ dev_run_id: 'ollama-check-fresh', gateway: { status_code: 200 } }) }))
  await kernel.storage.appendRows(table, [...AI_GATEWAY_SCHEMA_COLUMNS], fresh)
  const pendingBefore = await kernel.storage.pendingInfo(table)
  assert.equal((await awaitPersistedOllamaCheck({ ...args, token: 'ollama-check-fresh', timeoutMs: 500 })).reason, 'persistence_timeout')
  const pendingAfter = await kernel.storage.pendingInfo(table)
  assert.equal(pendingAfter.pendingBytes, pendingBefore.pendingBytes)
  assert.equal(pendingAfter.pending, true)
  await kernel.storage.flushTable(table, { force: true })
  assert.equal((await awaitPersistedOllamaCheck({ ...args, token: 'ollama-check-fresh' })).reason, 'persisted')
  // The same committed pair stays hidden from an ordinary caller when its
  // provenance is local-only. Correlation never upgrades caller permission.
  const { writeLocalOnlyEntries } = await import('../../src/core/usage-policy/local_only.js')
  const privateDir = path.join(home, 'private')
  await fs.mkdir(privateDir)
  await writeLocalOnlyEntries({ stateDir: path.dirname(cacheRoot), entries: [{ dir: privateDir, class: 'local-only' }] })
  const hidden = stored.map(row => ({ ...row, cwd: privateDir, attributes: JSON.stringify({ dev_run_id: 'ollama-check-hidden', gateway: { status_code: 200 } }) }))
  await kernel.storage.appendRows(table, [...AI_GATEWAY_SCHEMA_COLUMNS], hidden)
  await kernel.storage.flushTable(table, { force: true })
  const withheld = await awaitPersistedOllamaCheck({ ...args, token: 'ollama-check-hidden', timeoutMs: 500 })
  assert.equal(withheld.reason, 'persistence_timeout')
  assert.equal(withheld.request_id, undefined)
  assert.equal((await awaitPersistedOllamaCheck({ ...args, cwd: privateDir, token: 'ollama-check-hidden' })).reason, 'persisted')
})

test('real worker deadline includes a stalled config read before query startup and reaps it', { skip: process.platform === 'win32' }, async t => {
  const { temporaryDirectory } = await import('../helpers/temp_dir.js')
  const { execFileSync } = await import('node:child_process')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const { isolatedClientEnv } = await import('../../hypaware-core/smoke/lib/isolation.js')
  const { awaitPersistedOllamaCheck } = await import('../../hypaware-core/plugins-workspace/ollama/src/verify.js')
  const home = temporaryDirectory('hyp-ollama-worker-deadline-')
  const fifo = path.join(home, 'config.json')
  execFileSync('mkfifo', [fifo])
  const env = { ...isolatedClientEnv(process.env, home), HYP_HOME: home, HYP_CONFIG: fifo }
  for (let i = 0; i < 2; i++) {
    const before = Date.now()
    const result = await awaitPersistedOllamaCheck({ env, cacheRoot: path.join(home, 'hypaware/cache'), cwd: process.cwd(), token, model, from: start, to: new Date(Date.now() + 60000).toISOString(), timeoutMs: 500 })
    assert.equal(result.reason, 'persistence_timeout')
    assert.ok(Date.now() - before < 1500)
    assert.equal(await fs.stat(path.join(home, 'hypaware/cache')).then(() => true, () => false), false)
    assert.equal(process.getActiveResourcesInfo().filter(name => name === 'ProcessWrap').length, 0)
  }
})

test('actual registered verification command rejects missing model, recording off and unconfirmed route before inference', async t => {
  const { temporaryDirectory } = await import('../helpers/temp_dir.js')
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const { isolatedClientEnv } = await import('../../hypaware-core/smoke/lib/isolation.js')
  const { bootKernel } = await import('../../src/core/runtime/boot.js')
  const { dispatch } = await import('../../src/core/cli/dispatch.js')
  const home = temporaryDirectory('hyp-ollama-verify-preflight-')
  const configPath = path.join(home, 'hypaware-config.json')
  const saved = structuredClone(config)
  saved.auto_update = false
  saved.plugins[1].recording = false
  await fs.writeFile(configPath, JSON.stringify(saved))
  const env = { ...isolatedClientEnv(process.env, home), HYP_HOME: home, HYP_CONFIG: configPath }
  const boot = await bootKernel({ hypHome: home, configPath, env })
  assert.equal(boot.activations.find(a => a.plugin.name === '@hypaware/ollama')?.ok, true)
  let networkCalls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    networkCalls++
    throw new Error('preflight must not make network calls')
  })
  async function check(argv) {
    let output = ''
    let error = ''
    const code = await dispatch(['ollama', 'verify', ...argv], { kernel: boot.runtime, registry: /** @type {any} */ (boot.runtime.commands), env, stdout: { write: value => { output += value } }, stderr: { write: value => { error += value } } })
    return { code, output, error }
  }
  const invalid = await check(['--json'])
  assert.equal(invalid.code, 2)
  assert.match(invalid.error, /Usage: hyp ollama verify --model/)
  const off = await check(['--model', model, '--json'])
  assert.equal(off.code, 1)
  assert.equal(JSON.parse(off.output).reason, 'recording_disabled')
  assert.match(off.error, /fixed prompt[\s\S]*Configured sinks may export/)
  saved.plugins[1].recording = true
  await fs.writeFile(configPath, JSON.stringify(saved))
  const unavailable = await check(['--model', model, '--json'])
  assert.equal(unavailable.code, 1)
  assert.equal(JSON.parse(unavailable.output).reason, 'route_unconfirmed')
  assert.equal(JSON.parse(unavailable.output).http_completed, false)
  assert.equal(networkCalls, 0)
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).plugins[1].recording, true)
})
