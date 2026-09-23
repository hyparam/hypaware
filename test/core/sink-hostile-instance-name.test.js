// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { createSinkRegistry } from '../../src/core/registry/sinks.js'
import { createActivationContext } from '../../src/core/runtime/activation.js'
import { createSinkDriver } from '../../src/core/sinks/driver.js'
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
const HOSTILE_INSTANCE = 'a-hostile'
const HEALTHY_INSTANCE = 'z-healthy'

/**
 * A request sink contribution plus the record of every batch its live `Sink`
 * was handed, so the driver's export is measured at the destination.
 */
function fixtureSink() {
  /** @type {Array<{ batchId: string }>} */
  const exports = []
  return {
    exports,
    contribution: /** @type {any} */ ({
      name: 'central',
      plugin: OWNER,
      supports: [],
      async create() {
        return {
          /** @param {any} batch */
          async exportBatch(batch) {
            exports.push({ batchId: String(batch.batchId) })
            return { status: 'exported', partitionsExported: 0, bytesWritten: 0 }
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
 */
async function stage(beHostile) {
  const runtime = /** @type {any} */ ({
    sinks: createSinkRegistry(),
    sources: { register() {}, get() {}, list() { return [] } },
    capabilities: { provide() {}, require() {}, has() { return false }, list() { return [] } },
    activationContexts: new Map(),
  })
  const ctx = createActivationContext({
    runtime,
    plugin: /** @type {any} */ ({ name: OWNER, version: '1.0.0', manifest: { name: OWNER, permissions: [] }, rootDir: '/nowhere' }),
    paths: /** @type {any} */ ({ stateDir: '/nowhere', cacheDir: '/nowhere', tmpDir: '/nowhere' }),
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
      config: { schedule: '* * * * *', endpoint: 'https://central.example' },
      plugin: /** @type {any} */ (ctx.plugin),
      paths: /** @type {any} */ (ctx.paths),
      log: /** @type {any} */ (ctx.log),
    })
  }
  // The owner's own handle comes back live through its facade, which is the
  // whole of what makes `instanceName` the owner's to rewrite.
  const owned = /** @type {ExtendedSinkHandle} */ (/** @type {any} */ (ctx.sinks.get(HOSTILE_INSTANCE)))
  assert.equal(owned, registry.get(HOSTILE_INSTANCE), 'the owner no longer holds the live handle')
  beHostile(owned)
  assert.ok(
    typeof Object.getOwnPropertyDescriptor(owned, 'instanceName')?.get === 'function',
    'the fixture stopped being hostile'
  )
  return { registry, runtime, sink }
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

// The two tests below carry an accepted name all the way to the driver, and
// `lying` is the only variant that gets there: past the gate the plan renderer
// pads `dest.instance`, which is still the display lane's own read of the live
// property, so a non-string name ends the run there whether or not the gate let
// it through (it already does on a plain `hyp sync`). Only the selection is
// fixed, so the selection is all these assert.

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
