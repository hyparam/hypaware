// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { runDaemon } from '../../src/core/daemon/runtime.js'
import { readStatusFile, collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { writeLock } from '../../src/core/plugin_install/lock.js'
import { createSinkRegistry } from '../../src/core/registry/sinks.js'

function statusAt(stateRoot) {
  const status = readStatusFile(stateRoot)
  assert.ok(status, 'runtime status must exist')
  return status
}
function endpoint(server) {
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

const PLUGIN = '@third-party/sink-independence-fixture'
async function until(check) {
  for (let n = 0; n < 100; n += 1) {
    if (await check()) return
    await delay(20)
  }
  assert.fail('disposable runtime condition did not settle')
}
async function read(dir, name) { return fs.readFile(path.join(dir, name), 'utf8').catch(() => '') }
async function stage(t, url, { central = false, uncooperative = false, tickIntervalMs = 25, maintenance = false, beforeBoot = async (home) => {} } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sink-independent-'))
  const install = path.join(home, 'hypaware', 'plugins', PLUGIN)
  await fs.mkdir(install, { recursive: true })
  await fs.writeFile(path.join(install, 'hypaware.plugin.json'), JSON.stringify({
    schema_version: 1, name: PLUGIN, version: '0.1.0', hypaware_api: '^1.0.0', runtime: 'node', entrypoint: './index.js',
    provides: { capabilities: { 'hypaware.http-endpoint': '1.0.0' } },
    contributes: { sinks: [{ name: 'fixture', supports: [] }] },
  }))
  await fs.writeFile(path.join(install, 'index.js'), `
import fs from 'node:fs'
import { createForwardSink } from '${new URL('../../hypaware-core/plugins-workspace/central/src/sink.js', import.meta.url).href}'
import { createSinkWatermarkStore } from '${new URL('../../src/core/sinks/watermarks.js', import.meta.url).href}'
const home = ${JSON.stringify(home)}
const note = name => fs.appendFileSync(home + '/' + name, '1\\n')
export async function activate(ctx) {
  ctx.sinks.register({ name: 'fixture', plugin: '${PLUGIN}', supports: [], async create(sinkCtx) {
    const controller = new AbortController()
    const cacheRoot = home + '/central-cache'
    const partition = { dataset: 'logs', tablePath: cacheRoot + '/datasets/logs/all', partition: {} }
    // Real central transport and durable watermark store, with one synthetic cache row.
    const forward = ${central} && sinkCtx.name === 'a-central' ? createForwardSink({
      config: { url: ${JSON.stringify(url)} },
      identityClient: { async getCurrentJwt() { return 'synthetic' }, async refresh() {} },
      query: { getDataset() { return { name: 'logs', sourceSignal: 'logs' } } },
      storage: { cacheRoot, tableExists() { return true }, async flushTable() {}, async *readRowsSince(tablePath, opts) {
        if (opts.since?.seq !== '1') yield { row: { timestamp: '2026-10-07T00:00:00Z', body: 'synthetic' }, after: { v: 1, seq: '1' } }
      } },
      watermarks: createSinkWatermarkStore({ stateDir: home + '/central-state' }), log: sinkCtx.log,
    }) : null
    return {
      async exportBatch() {
        note(sinkCtx.name)
        if (sinkCtx.name === 'a-central' && ${uncooperative}) {
          while (fs.existsSync(home + '/hold-central')) await new Promise(r => setTimeout(r, 10))
        }
        if (forward) return forward.exportBatch({ partitions: [partition] })
        if (sinkCtx.name === 'a-central') {
          try { await fetch(${JSON.stringify(url)}, { signal: controller.signal }) }
          catch { return { status: 'failed', partitionsExported: 0, error: 'central transport unavailable' } }
        }
        while (fs.existsSync(home + '/hold-export')) await new Promise(r => setTimeout(r, 10))
        const status = fs.existsSync(home + '/partial') ? 'partial' : fs.existsSync(home + '/fail') ? 'failed' : 'exported'
        note('settled-' + sinkCtx.name)
        if (sinkCtx.name === 'z-local' && status === 'exported' && fs.existsSync(home + '/hold-next')) {
          fs.writeFileSync(home + '/local-completed-at', new Date().toISOString())
          fs.writeFileSync(home + '/hold-export', '1')
        }
        return { status, partitionsExported: status === 'exported' ? 1 : 0, error: status === 'exported' ? undefined : 'synthetic failure' }
      },
      async close() { controller.abort()
        note('close-' + sinkCtx.name)
        if (forward) await forward.close() },
    }
  } })
  ctx.backfills.register({ name: 'fixture', plugin: '${PLUGIN}', datasets: ['logs'], sweep: { cron: '* * * * *' }, async *run() { note('sweep') } })
  ctx.sources.register({ name: 'fixture', plugin: '${PLUGIN}', async start() { return {
    async status() {
      note('probe')
      while (fs.existsSync(home + '/hold-probe')) await new Promise(r => setTimeout(r, 10))
      return { state: 'ready', details: { probes: fs.readFileSync(home + '/probe', 'utf8').length } }
    },
    async stop() { while (fs.existsSync(home + '/hold-source-stop')) await new Promise(r => setTimeout(r, 10))
      note('source-stopped') },
  } } })
}
`)
  await writeLock(path.join(home, 'hypaware'), { schema_version: 1, plugins: {
    [PLUGIN]: { name: PLUGIN, version: '0.1.0', source: { kind: 'local-dir', raw: install, path: install }, install_dir: install, content_hash: 'a'.repeat(64), manifest_hash: 'b'.repeat(64), installed_at: '2026-10-07T00:00:00Z' },
  } })
  const configPath = defaultConfigPath(home)
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [{ name: PLUGIN, config: {} }], auto_update: false, query: { cache: { maintenance: { enabled: maintenance, interval_minutes: 0.005 } } }, sinks: {
    'a-central': { plugin: PLUGIN, config: { schedule: '* * * * *' } },
    'z-local': { plugin: PLUGIN, config: { schedule: '* * * * *' } },
  } }))
  let daemon
  t.after(async () => {
    for (const name of ['hold-probe', 'hold-export', 'hold-source-stop', 'hold-central']) await fs.rm(path.join(home, name), { force: true })
    if (daemon) await daemon.stop()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5 })
  })
  if (uncooperative) await fs.writeFile(path.join(home, 'hold-central'), '1')
  await beforeBoot(home)
  daemon = await runDaemon({ hypHome: home, configPath, env: { ...process.env, HYP_HOME: home }, runId: 'sink-independent', tickIntervalMs, installSignalHandlers: false })
  return { home, daemon, stateRoot: path.join(home, 'hypaware') }
}

// @ref LLP 0471#daemon-work [tests]: unrelated export, sweep, source and heartbeat progress while a destination is stalled
// @ref LLP 0471#close-order [tests]: signal sinks before source shutdown can wait
test('blocked destination does not block local work or heartbeat, and stop signals before source wait', async t => {
  let requests = 0
  let closed = 0
  const server = http.createServer((req, res) => { requests += 1
    res.on('close', () => { closed += 1 }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections()
    server.close() })
  const { home, daemon, stateRoot } = await stage(t, endpoint(server), { central: true })
  await until(() => requests === 1)
  const before = statusAt(stateRoot).uptimeMs
  await until(async () => (await read(home, 'z-local')).length > 0 && (await read(home, 'sweep')).length > 0 && statusAt(stateRoot).uptimeMs > before)
  assert.equal(requests, 1, 'one owned blocked export')
  const probeBefore = (await read(home, 'probe')).length
  await until(async () => (await read(home, 'probe')).length > probeBefore)
  await fs.writeFile(path.join(home, 'hold-source-stop'), '1')
  await fs.writeFile(path.join(home, 'hold-probe'), '1')
  const probes = (await read(home, 'probe')).length
  await until(async () => (await read(home, 'probe')).length > probes)
  const stopping = daemon.stop()
  await until(() => closed === 1)
  assert.equal(statusAt(stateRoot).state, 'stopping')
  assert.equal(await read(home, 'source-stopped'), '')
  await fs.rm(path.join(home, 'hold-probe'))
  await fs.rm(path.join(home, 'hold-source-stop'))
  await stopping
  await delay(75)
  assert.equal(requests, 1, 'no rerun after stop')
})

// @ref LLP 0471#daemon-work [tests]: completion stamps are captured after successful durable work, and partial/failure never recover
test('delayed success uses completion time and ordinary logs show failure then full recovery', async t => {
  const server = http.createServer((req, res) => { res.writeHead(202)
    res.end() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections()
    server.close() })
  const { home, daemon, stateRoot } = await stage(t, endpoint(server))
  await fs.writeFile(path.join(home, 'fail'), '1')
  await until(async () => (await read(home, 'settled-z-local')).length > 0)
  await until(async () => (await read(path.join(stateRoot, 'logs'), 'daemon.log')).includes('daemon.sink_export_failed'))
  await fs.writeFile(path.join(home, 'partial'), '1')
  await fs.rm(path.join(home, 'fail'))
  const logBefore = await read(path.join(stateRoot, 'logs'), 'daemon.log')
  await delay(100)
  assert.equal((await read(path.join(stateRoot, 'logs'), 'daemon.log')).includes('daemon.sink_export_recovered'), false)
  await fs.writeFile(path.join(home, 'hold-export'), '1')
  await delay(50)
  const completionBoundary = new Date().toISOString()
  await fs.writeFile(path.join(home, 'hold-next'), '1')
  await fs.rm(path.join(home, 'partial'))
  await fs.rm(path.join(home, 'hold-export'))
  await until(() => statusAt(stateRoot).sinks.some(row => row.instance === 'z-local' && (row.lastSuccessAt ?? '') > completionBoundary))
  const completed = statusAt(stateRoot).sinks.find(row => row.instance === 'z-local')
  assert.ok(completed)
  assert.ok((completed.lastTickAt ?? '') < completionBoundary, 'the held run started before the completion boundary')
  assert.ok((completed.lastSuccessAt ?? '') >= await read(home, 'local-completed-at'), 'stamp follows actual export settlement')
  await fs.rm(path.join(home, 'hold-next'))
  await fs.rm(path.join(home, 'hold-export'))
  await daemon.stop()
  const logs = await read(path.join(stateRoot, 'logs'), 'daemon.log')
  assert.ok(logBefore.includes('daemon.sink_export_failed'))
  assert.ok(logs.includes('daemon.sink_export_recovered'))
})

// @ref LLP 0471#close-order [tests]: all owned closes begin before any settlement wait; concurrent callers do not double close
test('registry initiates every selected close, preserves owner scope and joins concurrent close', async t => {
  const registry = createSinkRegistry()
  const calls = []
  let release
  const held = new Promise(resolve => { release = resolve })
  t.after(() => release())
  for (const [name, owner] of [['a', 'one'], ['b', 'one'], ['c', 'two']]) {
    await registry.instantiate(/** @type {any} */ ({ kind: 'request', instanceName: name, plugin: { name: owner }, config: {}, paths: {}, log: {}, contribution: {
      name, plugin: owner, supports: [], async create() { return { async exportBatch() { return {} }, async close() { calls.push(name)
        if (name === 'a') await held } } },
    } }))
  }
  const first = registry.closeAll('one')
  const second = registry.closeAll('one')
  await delay(10)
  assert.deepEqual(calls, ['a', 'b'])
  assert.ok(registry.get('c'))
  release()
  await Promise.all([first, second])
  assert.equal(registry.get('a'), undefined)
  await registry.closeAll()
  assert.deepEqual(calls, ['a', 'b', 'c'])
})

// @ref LLP 0471#daemon-work [tests]: blocked source bookkeeping owns one pass despite many timer and completion requests
test('a held source probe coalesces bookkeeping while exports continue', async t => {
  const server = http.createServer((req, res) => { res.writeHead(202)
    res.end() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections()
    server.close() })
  const { home, daemon, stateRoot } = await stage(t, endpoint(server), { tickIntervalMs: 1 })
  await fs.writeFile(path.join(home, 'hold-probe'), '1')
  const before = (await read(home, 'probe')).length
  await until(async () => (await read(home, 'probe')).length > before)
  const held = (await read(home, 'probe')).length
  const exported = (await read(home, 'settled-z-local')).length
  const heartbeat = statusAt(stateRoot).uptimeMs
  await delay(120)
  assert.equal(statusAt(stateRoot).uptimeMs, heartbeat, 'no overlapping bookkeeping pass can persist around the held probe')
  assert.equal((await read(home, 'probe')).length, held, 'no second active bookkeeping pass')
  assert.ok((await read(home, 'settled-z-local')).length > exported, 'probe wait does not block destination work')
  await fs.rm(path.join(home, 'hold-probe'))
  await until(async () => (await read(home, 'probe')).length > held)
  await daemon.stop()
})

// @ref LLP 0471#close-order [tests]: a generic plugin that ignores close remains owned until its export settles
test('uncooperative generic export keeps shutdown pending without a false completed result', async t => {
  const server = http.createServer((req, res) => { res.writeHead(202)
    res.end() })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections()
    server.close() })
  const { home, daemon, stateRoot } = await stage(t, endpoint(server), { uncooperative: true })
  await until(async () => (await read(home, 'a-central')).length > 0 && (await read(home, 'settled-z-local')).length > 0)
  const attempts = (await read(home, 'a-central')).length
  let stopped = false
  const stopping = daemon.stop().then(() => { stopped = true })
  await until(async () => (await read(home, 'close-a-central')).length > 0 && (await read(home, 'close-z-local')).length > 0)
  await delay(50)
  assert.equal(stopped, false, 'close does not prove an uncooperative export has settled')
  assert.equal(statusAt(stateRoot).state, 'stopping')
  assert.equal(await read(home, 'settled-a-central'), '')
  await fs.rm(path.join(home, 'hold-central'))
  await stopping
  assert.equal(statusAt(stateRoot).sinks.find(row => row.instance === 'a-central')?.lastSuccessAt, undefined, 'cancelled shutdown work is not success')
  assert.equal((await read(home, 'a-central')).length, attempts, 'only one export started')
})

// @ref LLP 0471#close-order [tests]: reentrant shutdown observes the already-owned close, and a rejected close cannot skip neighbours
test('registry close ownership is established before plugin code reenters', async () => {
  const registry = createSinkRegistry()
  const calls = []
  let reentered = Promise.resolve()
  for (const name of ['a', 'b']) {
    await registry.instantiate(/** @type {any} */ ({ kind: 'request', instanceName: name, plugin: { name: 'fixture' }, config: {}, paths: {}, log: {}, contribution: {
      name, plugin: 'fixture', supports: [], async create() { return { async exportBatch() { return {} }, close() {
        calls.push(name)
        if (name === 'a' && calls.length === 1) reentered = registry.closeAll()
        if (name === 'b') throw new Error('synthetic close failure')
      } } },
    } }))
  }
  await registry.closeAll()
  await reentered
  assert.deepEqual(calls, ['a', 'b'])
  assert.deepEqual(registry.list(), [])
})


// @ref LLP 0471#diagnostic-history [tests]: ordinary daemon logs cleanup separately and retries on its existing maintenance cadence
test('disposable runtime retries denied diagnostic cleanup without changing export recovery', async t => {
  const unlink = fs.unlink
  let denied = true
  let outbox = ''
  fs.unlink = async target => {
    if (denied && outbox && String(target).startsWith(outbox) && String(target).endsWith('.json')) {
      throw Object.assign(new Error('synthetic cleanup refusal'), { code: 'EACCES' })
    }
    return unlink(target)
  }
  t.after(() => { fs.unlink = unlink })
  const server = http.createServer((req, res) => { res.end('ok') })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections()
    server.close() })
  const { home, stateRoot } = await stage(t, endpoint(server), { maintenance: true, beforeBoot: async home => {
    outbox = path.join(home, 'hypaware', 'sinks', 'z-local', 'outbox')
    await fs.mkdir(outbox, { recursive: true })
    const at = new Date(Date.now() - 60000).toISOString()
    for (let i = 1; i <= 120; i++) await fs.writeFile(path.join(outbox, `z-local-${at}-${i}.json`), '{}')
    await fs.writeFile(path.join(home, 'fail'), '1')
  } })
  const logs = async () => (await read(path.join(stateRoot, 'logs'), 'daemon.log')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  await until(async () => (await logs()).some(row => row.event === 'daemon.sink_outbox_cleanup_failed'))
  const cleanup = (await logs()).find(row => row.event === 'daemon.sink_outbox_cleanup_failed')
  assert.equal(cleanup.error_kind, 'EACCES')
  assert.equal(cleanup.hyp_sink_instance, 'z-local')
  assert.ok((await fs.readdir(outbox)).length > 100, 'denied cleanup honestly exceeds cap')
  denied = false
  await until(async () => (await fs.readdir(outbox)).length === 100)
  assert.equal(statusAt(stateRoot).sinks.find(sink => sink.instance === 'z-local')?.lastSuccessAt, undefined)
  await fs.rm(path.join(home, 'fail'))
  await until(() => Boolean(statusAt(stateRoot).sinks.find(sink => sink.instance === 'z-local')?.lastSuccessAt))
  const report = await collectHypAwareStatus({ env: { ...process.env, HYP_HOME: home, HYP_CONFIG: '' }, platform: 'darwin', isLaunchAgentInstalled: () => false })
  assert.equal(report.diagnostics.some(d => d.kind === 'sink_export_failing' && d.message.startsWith('z-local:')), false)
  assert.ok(report.recentErrorCount >= 100, 'recovery does not erase retained evidence')
  assert.ok((await logs()).some(row => row.event === 'daemon.sink_export_recovered' && row.hyp_sink_instance === 'z-local'))
})

// @ref LLP 0471#daemon-work [tests]: restart retains unresolved transition evidence, while only later full own-instance completion logs recovery
test('persisted failure logs one recovery after restart and full completion', async t => {
  const server = http.createServer((req, res) => res.end('ok'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections()
    server.close() })
  const { home, daemon, stateRoot } = await stage(t, endpoint(server), {
    beforeBoot: home => fs.writeFile(path.join(home, 'fail'), '1'),
  })
  const logs = async () => (await read(path.join(stateRoot, 'logs'), 'daemon.log')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  const report = () => collectHypAwareStatus({ env: { ...process.env, HYP_HOME: home, HYP_CONFIG: '' }, platform: 'darwin', isLaunchAgentInstalled: () => false })
  const warning = async () => (await report()).diagnostics.some(d => d.kind === 'sink_export_failing' && d.message.startsWith('z-local:'))
  await until(warning)
  await fs.writeFile(path.join(home, 'partial'), '1')
  await fs.rm(path.join(home, 'fail'))
  const settlements = (await read(home, 'settled-z-local')).length
  await until(async () => (await read(home, 'settled-z-local')).length > settlements)
  assert.equal(await warning(), true, 'partial work cannot recover')
  assert.equal((await logs()).filter(row => row.event === 'daemon.sink_export_recovered').length, 0)
  await daemon.stop()
  await fs.writeFile(path.join(home, 'hold-export'), '1')
  const options = { hypHome: home, configPath: defaultConfigPath(home), env: { ...process.env, HYP_HOME: home }, tickIntervalMs: 25, installSignalHandlers: false }
  const restarted = await runDaemon(options)
  t.after(async () => { await fs.rm(path.join(home, 'hold-export'), { force: true })
    await restarted.stop() })
  assert.equal(await warning(), true, 'boot cannot clear persisted evidence')
  await delay(50)
  await fs.rm(path.join(home, 'partial'))
  const boundary = new Date().toISOString()
  await fs.rm(path.join(home, 'hold-export'))
  await until(() => (statusAt(stateRoot).sinks.find(s => s.instance === 'z-local')?.lastSuccessAt ?? '') > boundary)
  await until(async () => !await warning())
  await restarted.stop()
  const recovered = (await logs()).filter(row => row.event === 'daemon.sink_export_recovered' && row.hyp_sink_instance === 'z-local')
  assert.equal(recovered.length, 1, 'first later full completion logs recovery of persisted failure exactly once')
  await fs.writeFile(path.join(home, 'hold-export'), '1')
  const again = await runDaemon(options)
  t.after(async () => { await fs.rm(path.join(home, 'hold-export'), { force: true })
    await again.stop() })
  assert.equal(await warning(), false, 'recovered stamps survive next boot')
  await fs.rm(path.join(home, 'hold-export'))
  const next = (await read(home, 'settled-z-local')).length
  await until(async () => (await read(home, 'settled-z-local')).length > next)
  await again.stop()
  assert.equal((await logs()).filter(row => row.event === 'daemon.sink_export_recovered' && row.hyp_sink_instance === 'z-local').length, 1, 'already recovered history cannot emit duplicate recovery')
})
