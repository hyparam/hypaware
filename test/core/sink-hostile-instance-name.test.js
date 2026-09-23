// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { createSinkRegistry } from '../../src/core/registry/sinks.js'
import { createActivationContext } from '../../src/core/runtime/activation.js'
import { pluginStateDir } from '../../src/core/runtime/paths.js'
import { createSinkDriver } from '../../src/core/sinks/driver.js'
import { createInstanceWatermarkStore } from '../../src/core/sinks/incremental.js'
import { previewPendingRows } from '../../src/core/sinks/pending.js'
import { runSync } from '../../src/core/commands/sync.js'
import { collectSinkSnapshots } from '../../src/core/daemon/runtime.js'
import { collectHypAwareStatus } from '../../src/core/daemon/status.js'
import { defaultConfigPath } from '../../src/core/config/schema.js'
import { writePidFile } from '../../src/core/daemon/pid.js'

/** @import { TestContext } from 'node:test' */
/** @import { ExtendedSinkHandle, ExtendedSinkRegistry } from '../../src/core/registry/types.js' */

// PR #1974 stopped `SinkRegistry.list()` sorting on `handle.instanceName`, so
// no listing runs an owner's accessor any more. The kernel's own consumers
// still dereferenced it in their loop bodies after the listing handed the
// handle back, and a handle is a live object its owner still holds through
// `ctx.sinks.get`: `hyp status` raised the owner's error out of
// `collectHypAwareStatus`, the daemon's per-tick `status.sinks` write raised it
// once a minute outside the tick's own `.catch`, and the sink driver raised it
// in the due check before any sink had exported (issue #1976).
//
// Two instances, named so the registry's sorted listing reaches the hostile one
// first: an escape there takes the honest neighbour's row and export with it.

const OWNER = '@fixture/sink-owner'
/** Retained rows every capable destination reports and replays. */
const HISTORY_ROWS = 3
const HOSTILE_INSTANCE = 'a-hostile'
const HEALTHY_INSTANCE = 'z-healthy'

/**
 * A request sink contribution plus the record of every batch its live `Sink`
 * was handed, so the driver's export is measured at the destination.
 */
function fixtureSink() {
  /** @type {Array<{ batchId: string }>} */
  const exports = []
  /**
   * The instance name each `--history` replay ran under, taken from the live
   * `Sink`'s own `SinkCreateContext`, so a history case can compare the plan
   * it printed against the destinations that actually received rows.
   *
   * @type {string[]}
   */
  const replays = []
  /**
   * The `SinkCreateContext` each instance was built with. `sinkCtx.name` and
   * `sinkCtx.paths` are what every shipped sink builds its export watermark
   * store from, so holding the context lets a case advance a watermark the way
   * an export does rather than by spelling the path out itself.
   *
   * @type {Map<string, any>}
   */
  const contexts = new Map()
  return {
    exports,
    replays,
    contexts,
    contribution: /** @type {any} */ ({
      name: 'central',
      plugin: OWNER,
      supports: [],
      async create(/** @type {any} */ sinkCtx) {
        contexts.set(sinkCtx.name, sinkCtx)
        return {
          /** @param {any} batch */
          async exportBatch(batch) {
            exports.push({ batchId: String(batch.batchId) })
            return { status: 'exported', partitionsExported: 0, bytesWritten: 0 }
          },
          // Declaring both is what makes an instance `capable` in
          // `hyp sync --history` (LLP 0345 #sink-capability).
          async previewSourceHistory() {
            return { rows: HISTORY_ROWS, withheldRows: 0 }
          },
          async replaySourceHistory() {
            replays.push(String(sinkCtx.name))
            return { status: 'exported', rowsReplayed: HISTORY_ROWS, bytesWritten: 0 }
          },
          async close() {},
        }
      },
    }),
  }
}

/**
 * A real sink registry with two instances materialized from config the way
 * `materializeSinks` does at boot, reached through the owning plugin's own
 * activation context so the handle the fixture rewrites is the object the
 * kernel is holding rather than one the test built.
 *
 * @param {(handle: ExtendedSinkHandle) => void} beHostile Applied to the
 *   instance that sorts first, after both are live.
 * @param {string} [stateDir] The plugin state directory every instance is
 *   created with, for the one case that advances a real watermark through it.
 * @param {{ property?: string, configFor?: (instanceName: string) => any }} [opts]
 *   `property` is the handle property `beHostile` redefines, checked after
 *   the fixture runs so a rewritten helper cannot quietly stage an honest
 *   handle. `configFor` is the config the kernel materializes each instance
 *   from, for the cases that turn on what that config says.
 */
async function stage(beHostile, stateDir = '/nowhere', opts = {}) {
  const property = opts.property ?? 'instanceName'
  const configFor = opts.configFor ?? (() => ({ schedule: '* * * * *', endpoint: 'https://central.example' }))
  const runtime = /** @type {any} */ ({
    sinks: createSinkRegistry(),
    sources: { register() {}, get() {}, list() { return [] } },
    capabilities: { provide() {}, require() {}, has() { return false }, list() { return [] } },
    activationContexts: new Map(),
  })
  const ctx = createActivationContext({
    runtime,
    plugin: /** @type {any} */ ({ name: OWNER, version: '1.0.0', manifest: { name: OWNER, permissions: [] }, rootDir: '/nowhere' }),
    paths: /** @type {any} */ ({ stateDir, cacheDir: '/nowhere', tmpDir: '/nowhere' }),
    config: {},
    env: {},
  })
  const registry = /** @type {ExtendedSinkRegistry} */ (runtime.sinks)
  const sink = fixtureSink()
  ctx.sinks.register(sink.contribution)
  for (const instanceName of [HEALTHY_INSTANCE, HOSTILE_INSTANCE]) {
    await registry.instantiate({
      kind: 'request',
      instanceName,
      contribution: sink.contribution,
      config: configFor(instanceName),
      plugin: /** @type {any} */ (ctx.plugin),
      paths: /** @type {any} */ (ctx.paths),
      log: /** @type {any} */ (ctx.log),
    })
  }
  // The owner's own handle comes back live through its facade, which is the
  // whole of what makes `instanceName` the owner's to rewrite.
  const owned = /** @type {ExtendedSinkHandle} */ (/** @type {any} */ (ctx.sinks.get(HOSTILE_INSTANCE)))
  assert.equal(owned, registry.get(HOSTILE_INSTANCE), 'the owner no longer holds the live handle')
  const honest = readProperty(owned, property)
  beHostile(owned)
  // Every case below turns on a live read answering something other than what
  // `instantiate` recorded, so a fixture that quietly stopped taking the
  // property over would stage an honest handle and pass.
  assert.notEqual(readProperty(owned, property), honest, 'the fixture stopped being hostile')
  return { registry, runtime, sink }
}

/**
 * What `handle[property]` answers right now, as a comparable string, with a
 * throw folded into the answer.
 *
 * @param {ExtendedSinkHandle} handle
 * @param {string} property
 * @returns {string}
 */
function readProperty(handle, property) {
  try {
    return JSON.stringify(/** @type {any} */ (handle)[property]) ?? 'undefined'
  } catch {
    return 'threw'
  }
}

/** @param {ExtendedSinkHandle} handle */
function throwingInstanceName(handle) {
  Object.defineProperty(handle, 'instanceName', {
    configurable: true,
    get() { throw new Error('boom from the owner') },
  })
}

/** @param {ExtendedSinkHandle} handle */
function nonStringInstanceName(handle) {
  Object.defineProperty(handle, 'instanceName', {
    configurable: true,
    get() { return 7 },
  })
}

/**
 * A HypAware home, with the two instances declared in config or with no sinks
 * section at all. The status collector builds its sink rows from the config
 * when there is one, layering each live handle's plugin and kind onto the row
 * it matches by name, and from the live handles alone when there is not, which
 * is the branch that names a row from what it read off the handle.
 *
 * @param {TestContext} t
 * @param {boolean} declareSinks
 */
async function makeHome(t, declareSinks) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hostile-instance-name-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const stateRoot = path.join(hypHome, 'hypaware')
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.writeFile(defaultConfigPath(hypHome), JSON.stringify({
    version: 2,
    plugins: [],
    ...(declareSinks
      ? {
        sinks: {
          [HOSTILE_INSTANCE]: { plugin: OWNER, schedule: '* * * * *' },
          [HEALTHY_INSTANCE]: { plugin: OWNER, schedule: '* * * * *' },
        },
      }
      : {}),
  }))
  writePidFile(stateRoot, /** @type {any} */ ({ pid: process.pid, runId: 'r', mode: 'foreground' }))
  return hypHome
}

/**
 * @param {string} hypHome
 * @param {unknown} sinks
 */
function collectOpts(hypHome, sinks) {
  return /** @type {any} */ ({
    env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: '' },
    platform: 'darwin',
    isLaunchAgentInstalled: () => false,
    runtime: /** @type {any} */ ({ sinks }),
  })
}

/**
 * @param {TestContext} t
 * @param {ExtendedSinkRegistry} registry
 */
async function driverOver(t, registry) {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hostile-instance-driver-'))
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }))
  return createSinkDriver({
    sinkRegistry: registry,
    queryRegistry: /** @type {any} */ ({ listDatasets: () => [] }),
    storage: /** @type {any} */ ({ cacheRoot: stateRoot, tableExists: () => false }),
    stateRoot,
  })
}

for (const [label, beHostile] of [
  ['throwing', throwingInstanceName],
  ['non-string', nonStringInstanceName],
]) {
  test(`hyp status reports every sink with a ${label} instanceName accessor on a live handle`, async (t) => {
    const configured = await makeHome(t, true)
    const live = await makeHome(t, false)
    const staged = await stage(/** @type {any} */ (beHostile))
    const rows = [
      { instance: HOSTILE_INSTANCE, plugin: OWNER, kind: 'request' },
      { instance: HEALTHY_INSTANCE, plugin: OWNER, kind: 'request' },
    ]

    const report = await collectHypAwareStatus(collectOpts(configured, staged.registry))
    assert.deepEqual(
      report.sinks.map((s) => ({ instance: s.instance, plugin: s.plugin, kind: s.kind })),
      rows,
      'a configured sink lost the row, or the live plugin and kind, the running install has for it'
    )

    // No config section, so every field of every row is what the walk read off
    // the live handles: the instance each is named by is the registry's key.
    const fromHandles = await collectHypAwareStatus(collectOpts(live, staged.registry))
    assert.deepEqual(
      fromHandles.sinks.map((s) => ({ instance: s.instance, plugin: s.plugin, kind: s.kind })),
      rows,
      'a live sink row is named by something other than the name the registry keyed it under'
    )
  })

  test(`the daemon tick snapshots every live sink with a ${label} instanceName accessor on a live handle`, async () => {
    const staged = await stage(/** @type {any} */ (beHostile))
    /** @type {Map<string, any>} */
    const sinkSnapshots = new Map()

    const snapshots = collectSinkSnapshots({ runtime: staged.runtime, sinkSnapshots })

    assert.deepEqual(
      snapshots.map((s) => ({ instance: s.instance, plugin: s.plugin, kind: s.kind })),
      [
        { instance: HOSTILE_INSTANCE, plugin: OWNER, kind: 'request' },
        { instance: HEALTHY_INSTANCE, plugin: OWNER, kind: 'request' },
      ],
      'the per-tick status.sinks write lost a live instance'
    )
    // The map the daemon carries between ticks is keyed the same way, so a
    // second tick updates the row it wrote rather than adding a nameless one.
    collectSinkSnapshots({ runtime: staged.runtime, sinkSnapshots })
    assert.deepEqual(
      Array.from(sinkSnapshots.keys()).sort(),
      [HOSTILE_INSTANCE, HEALTHY_INSTANCE],
      'the tick-to-tick snapshot map grew a row under a name the registry never keyed'
    )
  })

  test(`a driver tick exports every due sink with a ${label} instanceName accessor on a live handle`, async (t) => {
    const staged = await stage(/** @type {any} */ (beHostile))
    const driver = await driverOver(t, staged.registry)
    /** @type {string[]} */
    const progress = []

    const report = await driver.tick({
      force: true,
      now: new Date('2026-09-22T00:00:00.000Z'),
      onProgress: (/** @type {string} */ instance) => progress.push(instance),
    })

    assert.deepEqual(
      report.sinks.map((s) => [s.instance, s.status]),
      [[HOSTILE_INSTANCE, 'exported'], [HEALTHY_INSTANCE, 'exported']],
      'a sink behind the hostile one never exported'
    )
    assert.deepEqual(progress, [HOSTILE_INSTANCE, HEALTHY_INSTANCE], 'progress named an instance the registry never keyed')
    assert.deepEqual(
      staged.sink.exports.map((e) => e.batchId.split('-2026-')[0]),
      [HOSTILE_INSTANCE, HEALTHY_INSTANCE],
      'a batch id named the instance something other than the registry\'s key'
    )
  })

  test(`a driver tick selecting one instance still matches the registry's key with a ${label} accessor`, async (t) => {
    const staged = await stage(/** @type {any} */ (beHostile))
    const driver = await driverOver(t, staged.registry)

    const report = await driver.tick({
      force: true,
      now: new Date('2026-09-22T00:00:00.000Z'),
      sinkInstance: HOSTILE_INSTANCE,
    })

    assert.deepEqual(
      report.sinks.map((s) => s.instance),
      [HOSTILE_INSTANCE],
      '`hyp sync <instance>` no longer selects the instance by the name the registry keyed it under'
    )
  })
}

// `hyp sync [instance]` is the other half of the same key: it filters the live
// handles for the user-typed positional, then hands that same string to the
// driver, which matches it against the registry's record. Selecting by one key
// and driving by another gates an instance the driver would drive, offers the
// refusal a name the driver will not match, or throws out of the filter before
// the driver's guarded read (issue #2066).
//
// `lying` is the variant the other two cannot show: a rename to another plain
// string crashes nothing and reads as honest everywhere, so it isolates the
// divergence from the accessor's rudeness.

const LIE = 'm-lie'

/** @param {ExtendedSinkHandle} handle */
function lyingInstanceName(handle) {
  Object.defineProperty(handle, 'instanceName', {
    configurable: true,
    get() { return LIE },
  })
}

function captureStream() {
  let text = ''
  return {
    isTTY: false,
    write(/** @type {string} */ chunk) { text += String(chunk); return true },
    get text() { return text },
  }
}

/**
 * A run context for `hyp sync` over the staged registry. The storage has no
 * `readRowsSince`, so the pending preview reports every destination as
 * `unknown` rather than reaching the cache, and `--yes` answers the send
 * confirmation without a terminal.
 *
 * @param {TestContext} t
 * @param {ExtendedSinkRegistry} registry
 */
async function syncCtx(t, registry) {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hostile-instance-sync-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  await fs.mkdir(path.join(hypHome, 'hypaware'), { recursive: true })
  const stderr = captureStream()
  const ctx = /** @type {any} */ ({
    stdout: captureStream(),
    stderr,
    env: { HYP_HOME: hypHome, HYP_CONFIG: '' },
    cwd: '/home/u',
    config: { version: 2 },
    query: { listDatasets: () => [] },
    storage: { cacheRoot: path.join(hypHome, 'cache'), tableExists: () => false },
    sinks: registry,
  })
  return { ctx, stderr }
}

for (const [label, beHostile] of [
  ['throwing', throwingInstanceName],
  ['non-string', nonStringInstanceName],
  ['lying', lyingInstanceName],
]) {
  test(`hyp sync's refusal offers the names the driver matches with a ${label} instanceName accessor`, async (t) => {
    const staged = await stage(/** @type {any} */ (beHostile))
    const { ctx, stderr } = await syncCtx(t, staged.registry)

    const code = await runSync(['no-such-sink'], ctx)

    assert.equal(code, 1)
    assert.match(stderr.text, /no sink named 'no-such-sink' was instantiated/)
    assert.match(
      stderr.text,
      new RegExp(`^ {2}available: ${HOSTILE_INSTANCE}, ${HEALTHY_INSTANCE}$`, 'm'),
      'the refusal offered a name `hyp sync <name>` and the driver would not both accept'
    )
    assert.deepEqual(staged.sink.exports, [], 'a refused name must not export')
  })
}

// The two tests below carry an accepted name all the way to the driver.
// `lying` is the variant they need: the selection and the display lane now
// answer to the same key, so what is left to isolate is a rename that crashes
// nothing and reads as honest everywhere. The display lane's own cases are at
// the end of this file.

test('hyp sync <instance> drives the sink the driver matches with a lying instanceName accessor', async (t) => {
  const staged = await stage(lyingInstanceName)
  const { ctx, stderr } = await syncCtx(t, staged.registry)

  const code = await runSync([HOSTILE_INSTANCE, '--yes'], ctx)

  assert.equal(code, 0)
  assert.doesNotMatch(stderr.text, /no sink named/, 'the registry key the driver matches was gated at the command')
  // `<instance>-<iso>-<seq>`, so the name the driver stamped a batch with is
  // everything before the timestamp.
  assert.deepEqual(
    staged.sink.exports.map((e) => e.batchId.replace(/-\d{4}-\d\d-\d\dT.*$/, '')),
    [HOSTILE_INSTANCE],
    'the instance the command selected is not the one the driver drove'
  )
})

test('hyp sync refuses a name only the owner\'s accessor answers to', async (t) => {
  const staged = await stage(lyingInstanceName)
  const { ctx, stderr } = await syncCtx(t, staged.registry)

  // The complement of the test above, and the one that shows why a silent
  // divergence is worse than a loud one: selecting on the owner's name let the
  // command accept a string `driver.tick` matches against nothing, so it
  // confirmed a send, ticked, exported nothing and exited 0.
  const code = await runSync([LIE, '--yes'], ctx)

  assert.equal(code, 1)
  assert.match(stderr.text, new RegExp(`no sink named '${LIE}' was instantiated`))
  assert.deepEqual(staged.sink.exports, [], 'a name the driver cannot match confirmed a send and exported nothing')
})

// The consent preview is the third reader of this key, and the one where the
// divergence costs the most: `hyp sync` prints what would leave *before* it
// asks, so a wrong number is a consent given to something other than what was
// shown. The preview read `handle.instanceName` while every shipped sink
// advances its export store under `sinkCtx.name`, so a rename sent the reader
// to `<plugin>/sink-instances/m-lie` while the writer kept advancing
// `<plugin>/sink-instances/a-hostile`: no cursor where the preview looked, so
// a caught-up destination discloses the whole retained history as pending
// (issue #2089).
//
// `lying` is the variant this pins. A truthy non-string name reached the same
// wrong number before the fix (`7` resolved `sink-instances/7` and counted the
// whole history), and the same read corrects it. A throwing accessor used not
// to reach `countForHandle` at all, because the result map was keyed off the
// live property and the call rejected before the count; the case below pins
// that (issue #2092).

/** Rows in the fixture partition, all of them already exported. */
const CACHED_ROWS = 12

/**
 * A cache holding {@link CACHED_ROWS} rows in one partition, plus the state
 * root the preview derives its watermark directory from. The preview resolves
 * `<stateRoot>/plugins/<plugin>`, so staging the instances with that same path
 * as their `paths.stateDir` is what puts the fixture's export store and the
 * preview's reader on one join.
 *
 * @param {TestContext} t
 */
async function previewFixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-hostile-instance-preview-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const stateRoot = path.join(home, 'hypaware')
  const cacheRoot = path.join(home, 'cache')
  const tablePath = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
  const storage = /** @type {any} */ ({
    cacheRoot,
    tableExists: (/** @type {string} */ p) => p === tablePath,
    hasPendingSync: () => false,
    async *readRowsSince(/** @type {string} */ p, /** @type {any} */ opts = {}) {
      if (p !== tablePath) return
      const since = opts.since ? Number(opts.since.seq) : 0
      for (let seq = 1; seq <= CACHED_ROWS; seq++) {
        if (seq <= since) continue
        yield { row: { id: seq }, after: { v: 1, seq: String(seq) } }
      }
    },
  })
  const query = /** @type {any} */ ({
    listDatasets: () => [{
      name: 'ai_gateway_messages',
      discoverPartitions: () => [
        { dataset: 'ai_gateway_messages', partition: { source: 'claude' }, tablePath },
      ],
    }],
  })
  return { stateRoot, cacheRoot, tablePath, storage, query }
}

// @ref LLP 0040#watermark-contract [tests]: the preview reads the same per-(sink instance, partition) watermark the export advances, so the two must name the instance identically
test('the sync preview counts from the watermark the export advanced, with a lying instanceName accessor', async (t) => {
  const fixture = await previewFixture(t)
  const staged = await stage(lyingInstanceName, pluginStateDir(fixture.stateRoot, OWNER))

  // The destination is caught up, said the way a sink says it: its own
  // `SinkCreateContext`, through the kernel helper every shipped sink calls.
  const sinkCtx = staged.sink.contexts.get(HOSTILE_INSTANCE)
  const watermarks = createInstanceWatermarkStore({ paths: sinkCtx.paths, instanceName: sinkCtx.name })
  await watermarks.write(watermarks.keyFor(fixture.cacheRoot, fixture.tablePath), {
    continuation: { v: 1, seq: String(CACHED_ROWS) },
    exportedRowCount: CACHED_ROWS,
  })

  const volumes = await previewPendingRows({
    handles: [/** @type {any} */ (staged.registry.get(HOSTILE_INSTANCE))],
    query: fixture.query,
    storage: fixture.storage,
    stateRoot: fixture.stateRoot,
  })

  // Taken by position, not by name: under test here is the number the prompt
  // discloses, not the key it is filed under. Both keys are the registry's
  // record now, the map's (issue #2092) and the plan's own display lane
  // (issue #2087), and the cases at the end of this file pin each.
  assert.equal(volumes.size, 1)
  const volume = /** @type {any} */ ([...volumes.values()][0])
  assert.deepEqual(
    { status: volume.status, rows: volume.rows, resume: volume.resume.kind },
    { status: 'counted', rows: 0, resume: 'since' },
    'the consent prompt counted against a watermark directory the export never advances'
  )
})

// The same seam, one rule further in. `previewPendingRows` documents a
// never-rejects contract in its own header (rule 3): the plan is the consent
// surface, so a preview that cannot run discloses `unknown` rather than taking
// the prompt down with it. Keying the result map off the live property broke
// that: the loop body's read was swallowed by the function's own outer `try`,
// and the `catch` re-read the same property, so the recovery path that exists
// to produce `unknown` was itself what raised and the call rejected before a
// row was read (issue #2092). Keyed off the kernel's record the registry
// knows this instance's name, so the destination is counted and disclosed
// under it; `nonString` is the other half, where `7` keyed a
// `Map<string, PendingVolume>` under a number no caller can look up.
for (const [label, beHostile] of [
  ['throwing', throwingInstanceName],
  ['nonString', nonStringInstanceName],
]) {
  test(`the sync preview resolves and discloses every destination with a ${label} instanceName accessor`, async (t) => {
    const fixture = await previewFixture(t)
    const staged = await stage(/** @type {any} */ (beHostile), pluginStateDir(fixture.stateRoot, OWNER))

    // The honest neighbour is caught up, said the way a sink says it, so a
    // false zero on its line is distinguishable from a true one.
    const healthyCtx = staged.sink.contexts.get(HEALTHY_INSTANCE)
    const healthyMarks = createInstanceWatermarkStore({ paths: healthyCtx.paths, instanceName: healthyCtx.name })
    await healthyMarks.write(healthyMarks.keyFor(fixture.cacheRoot, fixture.tablePath), {
      continuation: { v: 1, seq: String(CACHED_ROWS) },
      exportedRowCount: CACHED_ROWS,
    })

    const volumes = await previewPendingRows({
      handles: [
        /** @type {any} */ (staged.registry.get(HOSTILE_INSTANCE)),
        /** @type {any} */ (staged.registry.get(HEALTHY_INSTANCE)),
      ],
      query: fixture.query,
      storage: fixture.storage,
      stateRoot: fixture.stateRoot,
    })

    // One entry per handle, each filed under the name the registry keyed the
    // handle under rather than whatever the owner's accessor answers.
    assert.deepEqual([...volumes.keys()], [HOSTILE_INSTANCE, HEALTHY_INSTANCE])

    const hostile = /** @type {any} */ (volumes.get(HOSTILE_INSTANCE))
    const healthy = /** @type {any} */ (volumes.get(HEALTHY_INSTANCE))
    // Nothing has ever been exported to the hostile destination, so its whole
    // retained history is pending. A destination missing from the map, or
    // standing at `0 pending`, understates the egress on the one line consent
    // is given from.
    assert.deepEqual(
      { status: hostile.status, rows: hostile.rows, resume: hostile.resume.kind },
      { status: 'counted', rows: CACHED_ROWS, resume: 'beginning' },
      'the hostile destination was not disclosed with the history it would forward'
    )
    assert.deepEqual(
      { status: healthy.status, rows: healthy.rows, resume: healthy.resume.kind },
      { status: 'counted', rows: 0, resume: 'since' },
      'the honest neighbour lost its own count to its neighbour'
    )
    // The preview is a read: resolving instead of rejecting buys no export.
    assert.deepEqual(staged.sink.exports, [], 'the consent preview exported')
  })
}

// The display lane is the other half of the same key, and the half a consent
// prompt cannot afford to get wrong: `hyp sync` prints the destinations and
// asks before it sends, so the name beside "what would leave" has to be the
// name that will receive it. `describeDestination` read the live property, so
// both renderers padded `dest.instance` off whatever the owner's accessor
// answered. A non-string one ended the command at `dest.instance.padEnd is not
// a function` before a character of the plan printed, on a plain `hyp sync` and
// on `hyp sync <registry-key>` alike; a lying one printed a name no receipt
// line and no `hyp sync <name>` would ever answer to (issue #2087).
//
// All three variants reach these renderers. The ordinary lane counts pending
// rows first, and `previewPendingRows` used to re-dereference the live
// property inside the `catch` that exists to recover from it, so a throwing
// accessor ended that lane ahead of the renderers; keyed off the registry's
// record it resolves and the plan prints (issue #2092). That is also what puts
// the volume line back under a renamed destination: the preview files its
// counts under the same key `renderPlan` looks them up by, so a lying
// accessor no longer separates the number from the line it belongs to.

/** The plan's destination names, in the order it printed them. */
function planInstances(/** @type {string} */ stdout) {
  return stdout
    .split('\n')
    .map((line) => /^ {2}(\S+) {2}\S/.exec(line)?.[1])
    .filter((name) => name === HOSTILE_INSTANCE || name === HEALTHY_INSTANCE || name === LIE)
}

for (const [label, beHostile] of [
  ['throwing', throwingInstanceName],
  ['non-string', nonStringInstanceName],
  ['lying', lyingInstanceName],
]) {
  test(`hyp sync renders a plan naming the registry's keys with a ${label} instanceName accessor`, async (t) => {
    const staged = await stage(/** @type {any} */ (beHostile))
    const { ctx } = await syncCtx(t, staged.registry)

    const code = await runSync(['--yes'], ctx)

    assert.equal(code, 0)
    // The whole point of the prompt: the destinations it named are the
    // destinations the driver then handed batches to, in that order.
    assert.deepEqual(
      planInstances(ctx.stdout.text),
      [HOSTILE_INSTANCE, HEALTHY_INSTANCE],
      'the plan named a destination by something other than the key the driver matches'
    )
    assert.deepEqual(
      staged.sink.exports.map((e) => e.batchId.replace(/-\d{4}-\d\d-\d\dT.*$/, '')),
      planInstances(ctx.stdout.text),
      'the destinations that received data are not the ones the plan showed'
    )
    assert.doesNotMatch(ctx.stdout.text, new RegExp(LIE), 'the plan offered a name only the owner answers to')
  })

  test(`hyp sync <instance> renders a plan naming the registry's key with a ${label} instanceName accessor`, async (t) => {
    const staged = await stage(/** @type {any} */ (beHostile))
    const { ctx, stderr } = await syncCtx(t, staged.registry)

    const code = await runSync([HOSTILE_INSTANCE, '--yes'], ctx)

    assert.equal(code, 0)
    assert.doesNotMatch(stderr.text, /no sink named/, 'the registry key the driver matches was gated at the command')
    assert.deepEqual(
      planInstances(ctx.stdout.text),
      [HOSTILE_INSTANCE],
      'a scoped plan named the one destination by something other than the driver\'s key'
    )
    assert.deepEqual(
      staged.sink.exports.map((e) => e.batchId.replace(/-\d{4}-\d\d-\d\dT.*$/, '')),
      [HOSTILE_INSTANCE],
      'a scoped run sent to a destination the plan did not show'
    )
  })
}

for (const [label, beHostile] of [
  ['throwing', throwingInstanceName],
  ['non-string', nonStringInstanceName],
  ['lying', lyingInstanceName],
]) {
  test(`hyp sync --history renders a plan naming the registry's keys with a ${label} instanceName accessor`, async (t) => {
    const staged = await stage(/** @type {any} */ (beHostile))
    const { ctx, stderr } = await syncCtx(t, staged.registry)

    const code = await runSync(['--history', 'claude', '--yes'], ctx)

    assert.equal(code, 0, stderr.text)
    assert.deepEqual(
      planInstances(ctx.stdout.text),
      [HOSTILE_INSTANCE, HEALTHY_INSTANCE],
      'the history plan named a destination by something other than the registry\'s key'
    )
    // `previews.get(destination.instance)` is the join the renderer makes
    // between the plan's rows and the counts under them: keyed apart, it reads
    // `undefined.rows` or silently drops the row to "not replayed".
    assert.equal(
      (ctx.stdout.text.match(new RegExp(`${HISTORY_ROWS} rows retained and eligible`, 'g')) ?? []).length,
      2,
      'a destination lost the row count printed under it'
    )
    assert.doesNotMatch(ctx.stdout.text, /not replayed/, 'a capable destination was reported as unsupported')
    assert.deepEqual(
      staged.sink.replays,
      planInstances(ctx.stdout.text),
      'the destinations that replayed history are not the ones the plan showed'
    )
  })
}

// `offMachine` is the last field of a plan row that was still read off the
// live handle, and it is not a label: it *selects*. On a machine with any
// genuinely off-machine destination the plan keeps only the rows that are not
// `offMachine === false`, which is how the accompanying file copy stays out of
// an upload plan (LLP 0396 #combined-selection). `describeDestination`
// classified a destination by reading `handle.config`, a live property its
// owner still holds through `ctx.sinks.get`, so an owner answering `{ dir }`
// for an instance the kernel materialized from `url: https://exfil.example`
// took that destination out of the plan, the counts, the progress display and
// the receipts while the driver went on exporting to it, exit 0 - a
// destination removed from everything the user is shown while data still goes
// there, which is the failure the prompt exists to prevent (issue #2095).
//
// `text` comes off the same read, so the row that *is* shown can also name the
// wrong destination: both halves are pinned below.

/** The directory a hostile owner claims for an instance configured with a URL. */
const CLAIMED_DIR = '/Users/u/Exports'

/**
 * The kernel's config for each instance: both destinations are off-machine,
 * so the filter is live and dropping the hostile row is a real disappearance
 * rather than the whole plan staying unfiltered.
 *
 * @param {string} instanceName
 */
function offMachineConfig(instanceName) {
  return {
    schedule: '* * * * *',
    url: instanceName === HOSTILE_INSTANCE ? 'https://exfil.example' : 'https://central.example',
  }
}

/** @param {ExtendedSinkHandle} handle */
function localClaimingConfigAccessor(handle) {
  Object.defineProperty(handle, 'config', {
    configurable: true,
    get() { return { schedule: '* * * * *', dir: CLAIMED_DIR } },
  })
}

/** @param {ExtendedSinkHandle} handle */
function localClaimingConfigInPlace(handle) {
  const config = /** @type {any} */ (handle.config)
  delete config.url
  config.dir = CLAIMED_DIR
}

for (const [label, beHostile] of [
  ['accessor', localClaimingConfigAccessor],
  ['in-place rewrite', localClaimingConfigInPlace],
]) {
  test(`hyp sync plans every off-machine destination with a ${label} config claiming a local directory`, async (t) => {
    const staged = await stage(/** @type {any} */ (beHostile), '/nowhere', { property: 'config', configFor: offMachineConfig })
    const { ctx } = await syncCtx(t, staged.registry)

    const code = await runSync(['--yes'], ctx)

    assert.equal(code, 0)
    assert.deepEqual(
      planInstances(ctx.stdout.text),
      [HOSTILE_INSTANCE, HEALTHY_INSTANCE],
      'a destination its owner described as local was dropped from the plan the user consents to'
    )
    // The acceptance condition, stated as the set it is: what the plan showed
    // is what received data.
    assert.deepEqual(
      staged.sink.exports.map((e) => e.batchId.replace(/-\d{4}-\d\d-\d\dT.*$/, '')),
      planInstances(ctx.stdout.text),
      'the destinations that received data are not the ones the plan showed'
    )
    // `text` has the same provenance: a row that is shown has to name the
    // destination the instance was materialized to reach.
    assert.match(
      ctx.stdout.text,
      /exfil\.example/,
      'the shown row named a destination the instance is not configured to reach'
    )
    assert.doesNotMatch(
      ctx.stdout.text,
      new RegExp(CLAIMED_DIR),
      'the plan named the directory the owner claims instead of the configured server'
    )
  })
}

// One route to that disappearance needs no handle at all. The kernel's
// record is `{ ...config }`, an ordinary `Object.prototype`-inheriting
// object, so `Object.prototype.dir`, set by any in-process plugin, turned
// every destination carrying neither `url` nor `dir` into `offMachine: false`
// and `displayedDestinations` dropped it, while the driver went on exporting
// to it, exit 0 (issue #2098). The class is shipped: `@hypaware/s3`
// configures an instance on `bucket`/`region`, so an S3 destination beside
// any `url` destination is exactly this machine.

/**
 * The hostile instance's config carries neither `url` nor `dir`, the shape
 * `@hypaware/s3` validates; the neighbour is genuinely off-machine, so the
 * filter is live and dropping the hostile row is a real disappearance.
 *
 * @param {string} instanceName
 */
function nullClassConfig(instanceName) {
  return instanceName === HOSTILE_INSTANCE
    ? { schedule: '* * * * *', bucket: 'b', region: 'us-east-1' }
    : { schedule: '* * * * *', url: 'https://central.example' }
}

/** @param {ExtendedSinkHandle} _handle */
function pollutePrototypeDir(_handle) {
  // Set after both instances are live, the way an in-process plugin reaches
  // it: nothing is written to the handle or to the kernel's record.
  Object.defineProperty(Object.prototype, 'dir', { configurable: true, value: CLAIMED_DIR })
}

test('hyp sync plans a destination that carries no url or dir with Object.prototype.dir set', async (t) => {
  try {
    const staged = await stage(pollutePrototypeDir, '/nowhere', { property: 'dir', configFor: nullClassConfig })
    const { ctx } = await syncCtx(t, staged.registry)

    const code = await runSync(['--yes'], ctx)

    assert.equal(code, 0)
    assert.deepEqual(
      planInstances(ctx.stdout.text),
      [HOSTILE_INSTANCE, HEALTHY_INSTANCE],
      'a destination classified local by an inherited `dir` was dropped from the plan the user consents to'
    )
    // The acceptance condition, stated as the set it is: what the plan showed
    // is what received data.
    assert.deepEqual(
      staged.sink.exports.map((e) => e.batchId.replace(/-\d{4}-\d\d-\d\dT.*$/, '')),
      planInstances(ctx.stdout.text),
      'the destinations that received data are not the ones the plan showed'
    )
    assert.doesNotMatch(
      ctx.stdout.text,
      new RegExp(CLAIMED_DIR),
      'the plan named a directory no destination is configured to write to'
    )
  } finally {
    // A leaked prototype property poisons every later test in this process.
    delete (/** @type {any} */ (Object.prototype).dir)
  }
})

// `url` is guarded for the same reason and costs something different. What
// an inherited `url` takes from the machine below is not a row but a name:
// every local destination classified `offMachine: true`, so the filter kept
// them all and the plan named a server none of them reaches - and
// `describeScope` feeds that same text to the "Send now to" prompt. That is
// the misnaming half of #2095, reached through the prototype chain.
//
// It is not the only half. #2098 recorded `url` as fail-safe because the
// pollution only ever produces `offMachine: true`, but a destination
// carrying an own non-`http` `url` beside its `dir` keeps classifying
// `false` while a sibling flips to `true`, which arms the filter that was
// inert and drops it. One guard closes both, so this case pins the shape a
// bundled plugin actually configures.

/** The local directory each destination is genuinely configured to write to. */
const CONFIGURED_DIR = '/var/backups/hyp'

/**
 * Both destinations are local directories, the shape `@hypaware/local-fs`
 * validates, so nothing is genuinely off-machine and the plan is unfiltered:
 * what an inherited `url` costs here is a row naming the wrong destination
 * rather than a dropped row.
 *
 * @param {string} instanceName
 */
function localDirConfig(instanceName) {
  return { schedule: '* * * * *', dir: `${CONFIGURED_DIR}/${instanceName}` }
}

/** @param {ExtendedSinkHandle} _handle */
function pollutePrototypeUrl(_handle) {
  Object.defineProperty(Object.prototype, 'url', { configurable: true, value: 'https://exfil.example' })
}

test('hyp sync plans local destinations by their directories with Object.prototype.url set', async (t) => {
  try {
    const staged = await stage(pollutePrototypeUrl, '/nowhere', { property: 'url', configFor: localDirConfig })
    const { ctx } = await syncCtx(t, staged.registry)

    const code = await runSync(['--yes'], ctx)

    assert.equal(code, 0)
    assert.deepEqual(
      planInstances(ctx.stdout.text),
      [HOSTILE_INSTANCE, HEALTHY_INSTANCE],
      'a local destination was dropped from the plan the user consents to'
    )
    assert.deepEqual(
      staged.sink.exports.map((e) => e.batchId.replace(/-\d{4}-\d\d-\d\dT.*$/, '')),
      planInstances(ctx.stdout.text),
      'the destinations that received data are not the ones the plan showed'
    )
    assert.doesNotMatch(
      ctx.stdout.text,
      /exfil\.example/,
      'the plan named a server no destination is configured to reach'
    )
    assert.match(
      ctx.stdout.text,
      new RegExp(`${CONFIGURED_DIR}/${HOSTILE_INSTANCE}`),
      'the plan stopped naming the directory the destination writes to'
    )
  } finally {
    // A leaked prototype property poisons every later test in this process.
    delete (/** @type {any} */ (Object.prototype).url)
  }
})
