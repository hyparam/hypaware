// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHook } from 'node:async_hooks'
import { setImmediate as turn } from 'node:timers/promises'
import { MeterProvider, metrics } from '../../src/core/observability/runtime.js'
import { resetKernelInstruments } from '../../src/core/observability/meter.js'
import { createSinkRegistry } from '../../src/core/registry/sinks.js'
import { writeFirstSyncHoldMarker } from '../../src/core/usage-policy/first_sync_hold.js'
import { createSinkDriver } from '../../src/core/sinks/driver.js'

async function stage(t) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sink-scheduling-'))
  const handles = []
  let active = 0
  let peak = 0
  let released = false
  const releases = []
  const calls = []
  function add(instanceName, blocked = true) {
    const handle = /** @type {any} */ ({
      instanceName, plugin: '@test/scheduling', kind: 'request', config: { schedule: '* * * * *' },
      sink: {
        async exportBatch(batch, options) {
          active++
          peak = Math.max(peak, active)
          calls.push({ instanceName, batch, options })
          try {
            if (blocked && !released) await new Promise(resolve => releases.push(resolve))
            options.onProgress?.({ rowsExported: calls.length })
            return { status: 'exported', partitionsExported: batch.partitions.length, bytesWritten: 10 }
          } finally { active-- }
        },
        async close() {},
      },
    })
    handles.push(handle)
    return handle
  }
  const drivers = []
  function driver(options = {}) {
    const d = createSinkDriver({
      sinkRegistry: /** @type {any} */ ({ listHandles: () => handles }),
      queryRegistry: /** @type {any} */ ({ listDatasets: () => [] }),
      storage: /** @type {any} */ ({ cacheRoot: stateRoot, tableExists: () => false }),
      stateRoot, ...options,
    })
    drivers.push(d)
    return d
  }
  t.after(async () => {
    released = true
    for (const d of drivers) d.stop?.()
    while (releases.length) releases.shift()()
    await Promise.all(drivers.map(d => d.drain?.()))
    await fs.rm(stateRoot, { recursive: true, force: true })
  })
  return { stateRoot, add, driver, calls, release: () => releases.shift()?.(), peak: () => peak, active: () => active }
}

async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await turn()
  assert.ok(predicate(), 'expected work did not start')
}

// @ref LLP 0471#instance-ownership [tests]: drivers sharing a handle acquire before any asynchronous preflight
test('concurrent awaited ticks sharing one handle never overlap', async t => {
  const s = await stage(t)
  s.add('central')
  const a = s.driver()
  const b = s.driver()
  const first = a.tick({ force: true })
  await until(() => s.calls.length === 1)
  const second = b.tick({ force: true })
  await turn()
  await turn()
  assert.equal(s.peak(), 1)
  s.release()
  await first
  await until(() => s.calls.length === 2)
  assert.equal(s.peak(), 1)
  s.release()
  assert.equal((await second).sinks[0].status, 'exported')
})

// @ref LLP 0471#manual-work [tests]: manual progress and receipt belong to the sole fresh rerun
test('scheduled firestorm coalesces with one awaited manual follow-up and refuses later callers', async t => {
  const measurements = []
  const provider = new MeterProvider({ resource: { attributes: {} }, exporters: [{ exportBatch(batch) { measurements.push(...batch) } }] })
  metrics.setGlobalMeterProvider(provider)
  resetKernelInstruments()
  const s = await stage(t)
  t.after(async () => {
    await provider.shutdown()
    resetKernelInstruments()
  })
  s.add('central')
  s.add('local', false)
  const completions = []
  const d = s.driver({ onComplete: completion => completions.push(completion) })
  assert.equal(d.dispatch(), undefined)
  await until(() => s.calls.length === 2)
  let promiseCount = 0
  const hook = createHook({ init(_id, type) { if (type === 'PROMISE') promiseCount++ } }).enable()
  try { for (let i = 0; i < 1000; i++) assert.equal(d.dispatch({ sinkInstance: 'central' }), undefined) }
  finally { hook.disable() }
  assert.equal(promiseCount, 0, 'busy scheduled fires must create no retained async work')
  const progress = []
  const pending = d.tick({ force: true, sinkInstance: 'central', onProgress: (...args) => progress.push(args) })
  for (let i = 0; i < 1000; i++) d.dispatch({ sinkInstance: 'central' })
  const busy = await d.tick({ force: true })
  assert.equal(busy.sinks[0].status, 'failed')
  assert.match(busy.sinks[0].error ?? '', /pending.*retry|retry.*pending/i)
  assert.equal(busy.sinks[1].instance, 'local')
  assert.equal(busy.sinks[1].status, 'exported')
  assert.deepEqual(progress, [])
  assert.equal(completions.length, 2, 'only actual local exports are reported')
  assert.equal(measurements.filter(m => m.name === 'hyp_sink_export_failures_total').length, 0)
  assert.equal(measurements.filter(m => m.name === 'hyp_sink_exports_total').length, 2)
  await assert.rejects(fs.access(path.join(s.stateRoot, 'sinks', 'central', 'outbox')), { code: 'ENOENT' })
  s.release()
  await until(() => s.calls.length === 4)
  assert.equal(progress[0][0], 'central')
  assert.equal(s.calls.filter(c => c.instanceName === 'central').length, 2)
  s.release()
  assert.equal((await pending).sinks[0].status, 'exported')
  await d.drain()
  assert.equal(completions.length, 4)
  assert.ok(completions.every(c => c.completedAt >= c.startedAt))
  assert.equal(s.active(), 0)
})

test('stop settles the pending manual receipt without progress or rerun and drains actual work', async t => {
  const s = await stage(t)
  s.add('central')
  const d = s.driver()
  d.dispatch()
  await until(() => s.calls.length === 1)
  const progress = []
  const pending = d.tick({ force: true, onProgress: (...args) => progress.push(args) })
  d.stop()
  assert.equal((await pending).sinks[0].status, 'failed')
  assert.deepEqual(progress, [])
  d.dispatch()
  let drained = false
  const drain = d.drain().then(() => { drained = true })
  await turn()
  assert.equal(drained, false, 'stop cannot fabricate settlement of an uncooperative export')
  s.release()
  await drain
  assert.equal(s.calls.length, 1)
})

// @ref LLP 0471#manual-work [tests]: the CLI owns one destination's progress at a time
test('manual destinations stay sequential and force/filter preserve their scope', async t => {
  const s = await stage(t)
  const first = s.add('first')
  const second = s.add('second')
  first.config.schedule = second.config.schedule = '0 0 1 1 *'
  const d = s.driver()
  const progress = []
  const tick = d.tick({ force: true, onProgress: name => progress.push(name) })
  await until(() => s.calls.length === 1)
  assert.deepEqual(progress, ['first'])
  s.release()
  await until(() => s.calls.length === 2)
  assert.equal(s.peak(), 1)
  s.release()
  assert.deepEqual((await tick).sinks.map(r => r.instance), ['first', 'second'])
  const filtered = d.tick({ force: true, sinkInstance: 'second' })
  await until(() => s.calls.length === 3)
  s.release()
  assert.deepEqual((await filtered).sinks.map(r => r.instance), ['second'])
})

test('rerun rechecks the hold and current cron without a false completion', async t => {
  const s = await stage(t)
  const handle = s.add('central')
  const completed = []
  const d = s.driver({ onComplete: c => completed.push(c) })
  d.dispatch()
  await until(() => s.calls.length === 1)
  d.dispatch()
  // The old fire was due. The current year is 2026, so February 31 cannot be due.
  handle.config.schedule = '* * 31 2 *'
  s.release()
  await d.drain()
  assert.equal(s.calls.length, 1)
  assert.equal(completed.length, 1)
  handle.config.schedule = '* * * * *'
  d.dispatch()
  await until(() => s.calls.length === 2)
  const pending = d.tick({ force: true })
  await writeFirstSyncHoldMarker({ stateDir: s.stateRoot, now: Date.now() })
  s.release()
  assert.deepEqual(await pending, { sinks: [], held: 'first_sync_hold' })
  await d.drain()
  assert.equal(s.calls.length, 2)
  assert.equal(completed.length, 2)
})

test('drain waits for a manual receipt queued behind another driver', async t => {
  const s = await stage(t)
  s.add('central')
  const a = s.driver()
  const b = s.driver()
  a.dispatch()
  await until(() => s.calls.length === 1)
  const receipt = b.tick({ force: true })
  let drained = false
  const drain = b.drain().then(() => { drained = true })
  await turn()
  assert.equal(drained, false)
  s.release()
  await until(() => s.calls.length === 2)
  assert.equal(drained, false)
  s.release()
  await receipt
  await drain
})

test('stop during discovery never starts export after close begins', async t => {
  const s = await stage(t)
  s.add('central', false)
  let release
  let discovering = false
  const discovery = new Promise(resolve => { release = resolve })
  t.after(() => release([]))
  const d = s.driver({ queryRegistry: { listDatasets: () => [{ name: 'rows', async discoverPartitions() { discovering = true; return discovery } }] } })
  d.dispatch()
  await until(() => discovering)
  d.stop()
  release([])
  await d.drain()
  assert.equal(s.calls.length, 0)
})

test('preflight and progress exceptions release ownership; failed/partial summaries stay scalar', async t => {
  const s = await stage(t)
  const h = s.add('central', false)
  const completed = []
  const d = s.driver({ onComplete: c => {
    completed.push(c)
    throw new Error('host callback')
  } })
  h.config.schedule = 'invalid'
  await assert.rejects(d.tick(), /cron/i)
  h.config.schedule = '* * * * *'
  await assert.rejects(d.tick({ onProgress() { throw new Error('progress start') } }), /progress start/)
  h.sink.exportBatch = async () => ({ status: 'partial', partitionsExported: 0, retryPartitions: [{ dataset: 'large', tablePath: 'opaque' }], error: 'partial' })
  const partial = await d.tick({ force: true })
  assert.equal(partial.sinks[0].status, 'partial')
  assert.deepEqual(Object.keys(completed[0].report).sort(), ['bytesWritten', 'error', 'instance', 'partitionsExported', 'status'])
  h.sink.exportBatch = async () => { throw new Error('transport failed') }
  assert.equal((await d.tick()).sinks[0].status, 'failed')
  assert.equal(completed.length, 2)
})

test('registry owner close clears pending work and old completion cannot reach a replacement', async t => {
  const s = await stage(t)
  const old = s.add('central')
  const local = s.add('local', false)
  const registry = createSinkRegistry()
  async function install(name, sink, owner) {
    const contribution = { name: 'sink-' + name, plugin: owner, supports: [], async create() { return sink } }
    registry.register(contribution)
    return registry.instantiate(/** @type {any} */ ({ kind: 'request', instanceName: name, contribution, config: { schedule: '* * * * *' }, plugin: { name: owner, version: '1.0.0' }, paths: { rootDir: s.stateRoot, stateDir: s.stateRoot, cacheDir: s.stateRoot, tempDir: s.stateRoot }, log: { info() {}, warn() {}, error() {}, debug() {} } }))
  }
  await install('central', old.sink, '@test/old')
  await install('local', local.sink, '@test/local')
  const completions = []
  const d = s.driver({ sinkRegistry: registry, onComplete: c => completions.push(c) })
  d.dispatch({ sinkInstance: 'central' })
  await until(() => s.calls.length === 1)
  const pending = d.tick({ force: true, sinkInstance: 'central' })
  await registry.closeAll('@test/old')
  assert.equal((await pending).sinks[0].status, 'failed')
  assert.ok(registry.get('local'), 'other owner remains live')
  await install('central', local.sink, '@test/new')
  d.dispatch()
  await until(() => s.calls.length === 3)
  s.release()
  await d.drain()
  assert.equal(completions.length, 2, 'only replacement and local lifetimes report')
})

test('coalesced scheduled rerun discovers fresh partitions and time exactly once', async t => {
  const s = await stage(t)
  s.add('central')
  let discoveries = 0
  const d = s.driver({ queryRegistry: { listDatasets: () => [{ name: 'rows', async discoverPartitions() { return [{ dataset: 'rows', label: String(++discoveries) }] } }] } })
  d.dispatch({ now: new Date('2000-01-01T00:00:00Z') })
  await until(() => s.calls.length === 1)
  for (let i = 0; i < 1000; i++) d.dispatch({ now: new Date('2000-01-01T00:00:00Z') })
  assert.equal(discoveries, 1)
  s.release()
  await until(() => s.calls.length === 2)
  assert.equal(s.calls[1].batch.partitions[0].label, '2')
  assert.match(s.calls[0].batch.batchId, /2000-01-01/)
  assert.doesNotMatch(s.calls[1].batch.batchId, /2000-01-01/)
  s.release()
  await d.drain()
  assert.equal(discoveries, 2, 'completion alone cannot request another run')
})

test('manual tick retains driver-wide hold reporting even with no selected handle', async t => {
  const s = await stage(t)
  const d = s.driver()
  await writeFirstSyncHoldMarker({ stateDir: s.stateRoot, now: Date.now() })
  assert.deepEqual(await d.tick(), { sinks: [], held: 'first_sync_hold' })
  s.add('local', false)
  assert.deepEqual(await d.tick({ sinkInstance: 'missing', force: true }), { sinks: [], held: 'first_sync_hold' })
})

// @ref LLP 0471#instance-ownership [tests]: busy scheduled requests retain the requesting driver's fresh discovery and completion host
test('shared scheduled rerun switches driver context without allocating per-fire promises', async t => {
  const s = await stage(t)
  s.add('central')
  const discoveries = []
  const completions = []
  const make = owner => s.driver({
    queryRegistry: { listDatasets() { discoveries.push(owner)
      return [] } },
    onComplete() { completions.push(owner) },
  })
  const manual = make('manual')
  const daemon = make('daemon')
  const first = manual.tick({ force: true })
  await until(() => s.calls.length === 1)
  let promises = 0
  const hook = createHook({ init(id, type) { if (type === 'PROMISE') promises++ } })
  hook.enable()
  try { for (let i = 0; i < 1000; i++) daemon.dispatch() }
  finally { hook.disable() }
  assert.equal(promises, 0)
  s.release()
  await first
  await until(() => s.calls.length === 2)
  assert.deepEqual(discoveries, ['manual', 'daemon'])
  for (let i = 0; i < 1000; i++) { daemon.dispatch()
    manual.dispatch() }
  s.release()
  await until(() => s.calls.length === 3)
  assert.deepEqual(discoveries, ['manual', 'daemon', 'manual'])
  s.release()
  await Promise.all([manual.drain(), daemon.drain()])
  assert.deepEqual(completions, ['manual', 'daemon', 'manual'])
  assert.equal(s.calls.length, 3)
  const explicit = make('explicit')
  const progress = []
  const running = manual.tick({ force: true })
  await until(() => s.calls.length === 4)
  daemon.dispatch()
  const pending = explicit.tick({ force: true, onProgress: instance => progress.push(instance) })
  for (let i = 0; i < 1000; i++) daemon.dispatch()
  assert.deepEqual(progress, [], 'queued manual progress starts only with its own forced run')
  s.release()
  await running
  await until(() => s.calls.length === 5)
  assert.deepEqual(discoveries, ['manual', 'daemon', 'manual', 'manual', 'explicit'])
  assert.deepEqual(progress, ['central'])
  s.release()
  await pending
  await Promise.all([manual.drain(), daemon.drain(), explicit.drain()])
  assert.deepEqual(completions, ['manual', 'daemon', 'manual', 'manual', 'explicit'])
  assert.equal(s.calls.length, 5, 'manual receipt consumes the one scheduled rerun opportunity')
  assert.equal(s.peak(), 1)
})
