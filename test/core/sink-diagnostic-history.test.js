// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSinkDriver } from '../../src/core/sinks/driver.js'
import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { createDiagnosticHistory } from '../../src/core/sinks/diagnostic_history.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'

async function stage(t, options = {}) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'sink-diagnostic-history-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const stateRoot = path.join(hypHome, 'hypaware')
  const dir = path.join(stateRoot, 'sinks', 'central', 'outbox')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2, plugins: [], sinks: { central: { writer: '@hypaware/central' } },
  }))
  let outcome = { status: 'failed', partitionsExported: 0, error: 'synthetic outage' }
  const handle = /** @type {any} */ ({
    instanceName: 'central', plugin: '@test/history', kind: 'request', config: {},
    sink: { exportBatch: async () => outcome },
  })
  const driver = createSinkDriver({
    sinkRegistry: /** @type {any} */ ({ listHandles: () => [handle] }),
    queryRegistry: /** @type {any} */ ({ listDatasets: () => [] }),
    storage: /** @type {any} */ ({ cacheRoot: path.join(stateRoot, 'cache') }),
    stateRoot, ...options,
  })
  t.after(async () => { driver.stop()
    await driver.drain() })
  async function snapshot(success) {
    await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
    await fs.writeFile(path.join(stateRoot, 'run', 'status.json'), JSON.stringify({
      sinks: [{ instance: 'central', ...(success === undefined ? {} : { lastSuccessAt: success }) }],
    }))
    return collectHypAwareStatus({
      env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
      platform: 'darwin', isLaunchAgentInstalled: () => false,
    })
  }
  return { hypHome, stateRoot, dir, driver, snapshot, succeed() { outcome = { status: 'exported', partitionsExported: 0, error: '' } } }
}

async function record(dir, instance, sequence, startedAt, recordedAt, tail = '') {
  const batchId = `${instance}-${startedAt}-${sequence}`
  const file = path.join(dir, `${batchId}.json`)
  await fs.writeFile(file, recordedAt === undefined ? '{}' : `{"batchId":${JSON.stringify(batchId)},"sinkInstance":${JSON.stringify(instance)},"recordedAt":${JSON.stringify(recordedAt)},"partitions":[${tail}]}`)
  return file
}

// @ref LLP 0471#diagnostic-history [tests]: finite history cannot acknowledge payload or impersonate recovery
test('more than 100 failures retain newest evidence and leave unrelated durable state intact', async t => {
  const s = await stage(t)
  const sentinels = ['cache/payload', 'sinks/central/watermarks/cursor', 'sinks/other/outbox/other.json', 'product-telemetry/outbox/payload']
  for (const rel of sentinels) {
    await fs.mkdir(path.dirname(path.join(s.stateRoot, rel)), { recursive: true })
    await fs.writeFile(path.join(s.stateRoot, rel), rel)
  }
  for (let i = 0; i < 112; i++) await s.driver.tick({ force: true })
  const files = await fs.readdir(s.dir)
  assert.equal(files.length, 100)
  assert.ok(files.some(f => f.endsWith('-112.json')), 'just-committed diagnostic survives')
  for (const rel of sentinels) assert.equal(await fs.readFile(path.join(s.stateRoot, rel), 'utf8'), rel)
  let report = await s.snapshot()
  assert.equal(report.recentErrorCount, 100)
  assert.ok(report.diagnostics.some(d => d.kind === 'sink_export_failing'))
  s.succeed()
  await s.driver.tick({ force: true })
  // Ensure the success is not in the future when the report is collected.
  await new Promise(resolve => setTimeout(resolve, 5))
  report = await s.snapshot(new Date().toISOString())
  assert.equal(report.recentErrorCount, 100, 'successful export retains history')
  assert.equal(report.diagnostics.some(d => d.kind === 'sink_export_failing'), false)
})

test('failure recorded after a success remains unresolved despite an older batch start', async t => {
  const s = await stage(t)
  const now = Date.now()
  await record(s.dir, 'central', 1, new Date(now - 60000).toISOString(), new Date(now - 1000).toISOString(), ' '.repeat(1024 * 1024))
  const report = await s.snapshot(new Date(now - 30000).toISOString())
  assert.ok(report.diagnostics.some(d => d.kind === 'sink_export_failing'))
  assert.equal(report.recentErrorCount, 1)
})

test('future recordedAt is not warning evidence and symlinks are not followed', async t => {
  const s = await stage(t)
  const now = Date.now()
  await record(s.dir, 'central', 1, new Date(now - 60000).toISOString(), new Date(now + 60000).toISOString())
  const outside = path.join(s.hypHome, 'outside.json')
  await fs.writeFile(outside, '{}')
  await fs.symlink(outside, path.join(s.dir, `central-${new Date(now - 30000).toISOString()}-2.json`))
  const report = await s.snapshot()
  assert.equal(report.diagnostics.some(d => d.kind === 'sink_export_failing'), false)
  assert.equal(report.recentErrorCount, 1, 'future ordinary file retains historical counting rule, symlink contributes nothing')
})

test('initial historical cleanup ranks recordedAt, preserves unknown names and protects fresh write', async t => {
  const s = await stage(t)
  const now = Date.now()
  const started = new Date(now - 2 * 86400000).toISOString()
  for (let i = 1; i <= 180; i++) await record(s.dir, 'central', i, started, new Date(now - i * 1000).toISOString())
  await fs.writeFile(path.join(s.dir, 'notes.json'), 'keep')
  await record(s.dir, 'other', 1, started, started)
  const symlink = path.join(s.dir, `central-${started}-999.json`)
  await fs.symlink(path.join(s.hypHome, 'missing'), symlink)
  await s.driver.tick({ force: true })
  const files = await fs.readdir(s.dir)
  assert.equal(files.length, 103)
  assert.ok(files.includes(`central-${started}-1.json`), 'metadata determines history rank, not sequence')
  assert.equal(files.includes(`central-${started}-180.json`), false)
  assert.equal(await fs.readFile(path.join(s.dir, 'notes.json'), 'utf8'), 'keep')
  assert.ok((await fs.lstat(symlink)).isSymbolicLink())
})

test('age beyond 24 hours and equal recordedAt do not clear a failure; malformed metadata falls back', async t => {
  const s = await stage(t)
  const old = new Date(Date.now() - 2 * 86400000).toISOString()
  await record(s.dir, 'central', 1, old, old)
  let report = await s.snapshot(old)
  assert.equal(report.recentErrorCount, 0)
  assert.ok(report.diagnostics.some(d => d.kind === 'sink_export_failing'))
  await fs.writeFile(path.join(s.dir, `central-${old}-1.json`), '{"recordedAt":"invalid","partitions":[')
  report = await s.snapshot('invalid')
  assert.ok(report.diagnostics.some(d => d.kind === 'sink_export_failing'))
})


test('failed atomic publication preserves older evidence and original export reason', async t => {
  const s = await stage(t)
  const now = new Date()
  const old = new Date(now.getTime() - 60000).toISOString()
  for (let i = 1; i <= 110; i++) await record(s.dir, 'central', i, old, old)
  // An existing directory makes the final rename fail without replacing old files.
  const target = path.join(s.dir, `central-${now.toISOString()}-1.json`)
  await fs.mkdir(target)
  const reports = await s.driver.tick({ force: true, now })
  assert.equal(reports.sinks[0].error, 'synthetic outage')
  assert.equal((await fs.readdir(s.dir)).length, 111, 'write failure never starts pruning')
  assert.ok((await fs.stat(target)).isDirectory())
  assert.equal((await fs.readdir(s.dir)).some(name => name.endsWith('.tmp')), false)
})

test('cleanup failure keeps new evidence, defers scans, and retries through explicit maintenance', async t => {
  const failures = []
  const s = await stage(t, { onDiagnosticCleanupFailure: (instance, code) => failures.push({ instance, code }) })
  const old = new Date(Date.now() - 60000).toISOString()
  for (let i = 1; i <= 110; i++) await record(s.dir, 'central', i, old, old)
  const unlink = fs.unlink
  const opendir = fs.opendir
  let scans = 0
  let deny = true
  fs.opendir = async (...args) => {
    if (args[0] === s.dir) scans++
    return opendir(...args)
  }
  fs.unlink = async target => {
    if (deny && String(target).startsWith(s.dir)) throw Object.assign(new Error('synthetic cleanup refusal'), { code: 'EACCES' })
    return unlink(target)
  }
  t.after(() => { fs.unlink = unlink
    fs.opendir = opendir })
  let reports = await s.driver.tick({ force: true })
  assert.equal(reports.sinks[0].error, 'synthetic outage')
  assert.deepEqual(failures, [{ instance: 'central', code: 'EACCES' }])
  const scanned = scans
  for (let i = 0; i < 3; i++) reports = await s.driver.tick({ force: true })
  assert.equal(scans, scanned, 'persistent export failures cannot repeatedly scan old history')
  const files = await fs.readdir(s.dir)
  assert.equal(files.length, 114, 'failed cleanup can temporarily exceed the cap')
  assert.ok(files.some(name => name.endsWith('-4.json') && name.includes(new Date().toISOString().slice(0, 10))))
  deny = false
  await s.driver.maintainDiagnostics()
  assert.equal((await fs.readdir(s.dir)).length, 100)
  const repairedScans = scans
  await s.driver.tick({ force: true })
  await s.driver.maintainDiagnostics()
  assert.equal(scans, repairedScans, 'settled history uses cached bounded selection')
  assert.equal(failures.length, 1)
})

test('large history streams once, honors legacy/tie rank and serializes maintenance with publication', async t => {
  const s = await stage(t)
  const old = new Date(Date.now() - 60000).toISOString()
  for (let i = 1; i <= 2500; i++) await record(s.dir, 'central', i, old, i % 2 ? undefined : 'invalid')
  // Unknown entries do not occupy diagnostic slots or authorize deletion.
  for (let i = 0; i < 300; i++) await fs.writeFile(path.join(s.dir, `keep-${i}`), '')
  const opendir = fs.opendir
  let scans = 0
  fs.opendir = async (...args) => {
    if (args[0] === s.dir) scans++
    return opendir(...args)
  }
  t.after(() => { fs.opendir = opendir })
  const errors = []
  const history = createDiagnosticHistory(s.dir, 'central', code => errors.push(code))
  await history.maintain()
  assert.equal((await fs.readdir(s.dir)).length, 400)
  assert.ok(await fs.stat(path.join(s.dir, `central-${old}-2500.json`)))
  await assert.rejects(fs.stat(path.join(s.dir, `central-${old}-2400.json`)), { code: 'ENOENT' })
  assert.equal(scans, 2, 'one selection pass and one deletion pass')
  for (let i = 1; i <= 12; i++) {
    // A deliberately older fresh record still survives its own pruning.
    const started = new Date(Date.now() - 2 * 86400000).toISOString()
    const name = `central-${started}-${i}.json`
    await Promise.all([
      history.publish(name, async () => { await record(s.dir, 'central', i, started, started) }),
      history.maintain(), history.maintain(),
    ])
    assert.ok(await fs.stat(path.join(s.dir, name)))
    assert.equal((await fs.readdir(s.dir)).length, 400)
  }
  assert.equal(scans, 2, 'ordinary new failures never rescan old/unknown entries')
  assert.deepEqual(errors, [])
})


test('a colliding symlink prevents publication and preserves its target and history', async t => {
  const s = await stage(t)
  const now = new Date()
  const old = new Date(now.getTime() - 60000).toISOString()
  for (let i = 1; i <= 110; i++) await record(s.dir, 'central', i, old, old)
  const outside = path.join(s.hypHome, 'outside')
  await fs.writeFile(outside, 'private sentinel')
  const target = path.join(s.dir, `central-${now.toISOString()}-1.json`)
  await fs.symlink(outside, target)
  const result = await s.driver.tick({ force: true, now })
  assert.equal(result.sinks[0].error, 'synthetic outage')
  assert.ok((await fs.lstat(target)).isSymbolicLink())
  assert.equal(await fs.readFile(outside, 'utf8'), 'private sentinel')
  assert.equal((await fs.readdir(s.dir)).length, 111)
})
