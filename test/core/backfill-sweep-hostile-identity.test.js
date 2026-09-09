// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import { createBackfillRegistry } from '../../src/core/registry/backfills.js'
import { createBackfillSweepDriver } from '../../src/core/daemon/backfill_sweep.js'

// `name` and `plugin` are validated once, by `BackfillRegistry.register`, and
// the registry then stores the contribution by reference. Every later read is
// a plugin accessor running again, and the sweep reads them from places no
// guard covers: the comparator `list()` sorts with, the catch that reports an
// unreadable `sweep`, and the settlement handlers that run after `tick()` has
// already returned. That last one is the worst of the three - it runs on a
// promise `void` discarded, so a throw there is an unhandled rejection and
// Node's default takes the daemon process with it (#1509).

const OK = { ok: true, scanned: 0, rowsWritten: 0, skipped: 0 }
const REGISTRY_URL = new URL('../../src/core/registry/backfills.js', import.meta.url).href
const DRIVER_URL = new URL('../../src/core/daemon/backfill_sweep.js', import.meta.url).href

/**
 * A contribution whose `name` answers honestly until it is armed, and throws
 * from then on. The hostile answer has to start after registration, which
 * validates `name` several times - and that is the realistic shape anyway: a
 * plugin computing its identity from state that later goes bad.
 *
 * @param {{ name: string, plugin: string, sweep?: unknown, armOnSweepRead?: boolean }} fields
 * @returns {{ contribution: any, arm: () => void, disarm: () => void }}
 */
function armableName(fields) {
  let armed = false
  const arm = () => { armed = true }
  const disarm = () => { armed = false }
  const contribution = {
    get name() {
      if (armed) throw new TypeError('name is not readable')
      return fields.name
    },
    plugin: fields.plugin,
    datasets: ['ai_gateway_messages'],
    async *run() {},
  }
  if (fields.armOnSweepRead) {
    // One broken state, reflected by both accessors: reading `sweep` fails and
    // leaves `name` unreadable too. That is what puts the throw inside
    // `readSweepSchedule`'s catch rather than ahead of it. Defined rather than
    // spread in, because spreading an object reads its getters.
    Object.defineProperty(contribution, 'sweep', {
      get() { arm(); throw new TypeError('sweep is not readable') },
    })
  } else {
    contribution.sweep = fields.sweep
  }
  return { contribution, arm, disarm }
}

/** @returns {any} */
function readableSweep() {
  // `list()` orders by name, so this one sits behind the hostile one.
  return {
    name: 'z-readable',
    plugin: '@third-party/readable-sweep',
    datasets: ['ai_gateway_messages'],
    async *run() {},
    sweep: { cron: '*/5 * * * *' },
  }
}

/**
 * A driver over a real `BackfillRegistry`, so the registration path and the
 * `list()` the sweep iterates are both the shipped ones.
 *
 * @param {any[]} contributions
 * @param {(args: any) => Promise<any>} runBackfill
 */
function driverOver(contributions, runBackfill) {
  const backfills = createBackfillRegistry()
  for (const contribution of contributions) backfills.register(contribution)
  return createBackfillSweepDriver({
    backfills,
    backfillMaterializers: /** @type {any} */ ({ register() {}, get: () => undefined, list: () => [] }),
    env: /** @type {any} */ ({ HYP_HOME: '/nonexistent-home' }),
    storage: /** @type {any} */ ({ cacheRoot: '/nonexistent-cache' }),
    query: /** @type {any} */ ({ getDataset: () => undefined }),
    runBackfill: /** @type {any} */ (runBackfill),
  })
}

test('a name that stops being readable after the tick does not reject the discarded promise', async () => {
  /** @type {unknown[]} */
  const unhandled = []
  /** @param {unknown} reason */
  const onUnhandled = (reason) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    /** @type {(() => void) | undefined} */
    let release
    const hostile = armableName({
      name: 'a-hostile-identity',
      plugin: '@third-party/hostile-identity',
      sweep: { cron: '*/5 * * * *' },
    })
    const driver = driverOver(
      [hostile.contribution],
      () => new Promise((resolve) => { release = () => resolve(OK) })
    )

    const report = await driver.tick({ now: new Date('2026-09-09T10:05:00.000Z') })
    assert.deepEqual(report.fired, ['a-hostile-identity'])

    // The run is now in flight and the tick has returned. Everything from here
    // is the settlement handlers' path, which the loop's guards do not cover.
    await tickOver()
    hostile.arm()
    assert.equal(typeof release, 'function', 'the queued run never started')
    const releaseRun = /** @type {() => void} */ (release)
    releaseRun()
    await tickOver()

    assert.deepEqual(unhandled, [], 'the settlement handler rejected a promise nothing was attached to')

    // The handler did not merely avoid throwing, it finished: `inFlight` is
    // clear, so a later tick fires the provider again instead of logging
    // `already_running` at it for the daemon's life. The plugin recovers
    // first, because a provider the sweep cannot name is skipped anyway.
    hostile.disarm()
    const second = await driver.tick({ now: new Date('2026-09-09T10:10:00.000Z') })
    assert.deepEqual(second.fired, ['a-hostile-identity'])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a daemon whose provider name goes unreadable mid-run stays up', () => {
  // The consequence the assertion above stands in for. Node's default for an
  // unhandled rejection is to terminate, so before the fix this child exits
  // non-zero with ERR_UNHANDLED_REJECTION and prints nothing.
  const script = `
    import { createBackfillRegistry } from '${REGISTRY_URL}'
    import { createBackfillSweepDriver } from '${DRIVER_URL}'
    let armed = false
    let release
    const backfills = createBackfillRegistry()
    backfills.register({
      get name() {
        if (armed) throw new TypeError('name is not readable')
        return 'a-hostile-identity'
      },
      plugin: '@third-party/hostile-identity',
      datasets: ['ai_gateway_messages'],
      async *run() {},
      sweep: { cron: '*/5 * * * *' },
    })
    const driver = createBackfillSweepDriver({
      backfills,
      backfillMaterializers: { register() {}, get: () => undefined, list: () => [] },
      env: { HYP_HOME: '/nonexistent-home' },
      storage: { cacheRoot: '/nonexistent-cache' },
      query: { getDataset: () => undefined },
      runBackfill: () => new Promise((resolve) => { release = () => resolve({ ok: true, scanned: 0, rowsWritten: 0, skipped: 0 }) }),
    })
    await driver.tick({ now: new Date('2026-09-09T10:05:00.000Z') })
    await new Promise((r) => setTimeout(r, 0))
    armed = true
    release()
    await new Promise((r) => setTimeout(r, 50))
    process.stdout.write('DAEMON_STILL_UP')
  `
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  assert.equal(stdout, 'DAEMON_STILL_UP')
})

test('an unreadable name does not throw out of the comparator list() sorts with', async () => {
  /** @type {string[]} */
  const ran = []
  const hostile = armableName({
    name: 'a-hostile-identity',
    plugin: '@third-party/hostile-identity',
    sweep: { cron: '*/5 * * * *' },
  })
  const driver = driverOver(
    [hostile.contribution, readableSweep()],
    async (args) => { ran.push(args.provider); return OK }
  )
  hostile.arm()

  const report = await driver.tick({ now: new Date('2026-09-09T10:05:00.000Z') })

  assert.deepEqual(report.fired, ['z-readable'], 'one unreadable name cost the whole sweep evaluation')
  await tickOver()
  assert.deepEqual(ran, ['z-readable'])
})

test('the unreadable-sweep warning does not throw a second time reporting the first failure', async () => {
  /** @type {string[]} */
  const ran = []
  const hostile = armableName({
    name: 'a-hostile-identity',
    plugin: '@third-party/hostile-identity',
    armOnSweepRead: true,
  })
  const driver = driverOver(
    [hostile.contribution, readableSweep()],
    async (args) => { ran.push(args.provider); return OK }
  )

  const report = await driver.tick({ now: new Date('2026-09-09T10:05:00.000Z') })

  assert.deepEqual(report.fired, ['z-readable'])
  await tickOver()
  assert.deepEqual(ran, ['z-readable'])
})

test('the registry keys a contribution by the name it validated, not by a later read', () => {
  // What `list()`'s ordering now rests on. `register` used to read `name`
  // five times on the success path and key the Map from the fourth, so a
  // getter that answered once and then differently was validated under one
  // string and stored under another: `get()` could no longer address the
  // provider, and `list()` ordered it by the name nobody validated.
  const backfills = createBackfillRegistry()
  let reads = 0
  backfills.register({
    get name() { reads += 1; return reads === 1 ? 'a-honest' : 'z-mutated' },
    plugin: '@third-party/mutating-name',
    datasets: ['ai_gateway_messages'],
    async *run() {},
  })
  backfills.register(readableSweep())

  assert.equal(reads, 1, 'register read the plugin\'s `name` more than once')
  assert.notEqual(backfills.get('a-honest'), undefined, 'the validated name no longer addresses the provider')
  assert.equal(backfills.get('z-mutated'), undefined)
  assert.deepEqual(backfills.list().map((c) => (c === backfills.get('a-honest') ? 'a-honest' : 'z-readable')), ['a-honest', 'z-readable'])
})

test('a name that reads as another provider does not steer that provider\'s sweep', async () => {
  // What the registry's key buys the sweep. The honest provider sweeps daily
  // at 03:00; the hostile one sweeps every five minutes and answers with the
  // honest one's registered name from its second read on. At 10:05 only the
  // hostile cron matches, so a run of `claude` here is one the hostile
  // contribution steered: on its cadence, under its `backfill.window_days`,
  // and holding `inFlight` on a name that is not its own, which is what would
  // then skip the real provider's own due tick as `already_running`.
  /** @type {string[]} */
  const ran = []
  let reads = 0
  const driver = driverOver(
    [
      {
        get name() { reads += 1; return reads === 1 ? 'a-hostile-identity' : 'claude' },
        plugin: '@third-party/hostile-identity',
        datasets: ['ai_gateway_messages'],
        async *run() {},
        sweep: { cron: '*/5 * * * *' },
      },
      {
        name: 'claude',
        plugin: '@hypaware/claude',
        datasets: ['ai_gateway_messages'],
        async *run() {},
        sweep: { cron: '0 3 * * *' },
      },
    ],
    async (args) => { ran.push(args.provider); return OK }
  )

  const report = await driver.tick({ now: new Date('2026-09-09T10:05:00.000Z') })
  await tickOver()

  assert.deepEqual(report.fired, [], 'the sweep fired a provider under a name it did not register')
  assert.deepEqual(ran, [], 'a plugin ran @hypaware/claude on a cadence claude never asked for')
})

test('a throw the driver cannot render does not escape the guard reporting it', async () => {
  // Each guard exists to contain a plugin throw, and the thrown value is the
  // last thing in the catch the plugin still owns. A null-prototype object has
  // no primitive conversion, so `String(err)` raises on it and reporting the
  // first failure becomes a second one - this time out of `tick()`, where it
  // is swallowed as `daemon.tick_failed` and costs every provider's sweep.
  /** @type {string[]} */
  const ran = []
  let armed = false
  const unreadableName = {
    get name() {
      if (armed) throw Object.create(null)
      return 'a-unreadable-name'
    },
    plugin: '@third-party/unrenderable',
    datasets: ['ai_gateway_messages'],
    async *run() {},
    sweep: { cron: '*/5 * * * *' },
  }
  const unreadableSweep = {
    name: 'b-unreadable-sweep',
    plugin: '@third-party/unrenderable',
    datasets: ['ai_gateway_messages'],
    async *run() {},
  }
  Object.defineProperty(unreadableSweep, 'sweep', {
    get() { throw Object.create(null) },
  })

  const driver = driverOver(
    [unreadableName, unreadableSweep, readableSweep()],
    async (args) => { ran.push(args.provider); return OK }
  )
  armed = true

  const report = await driver.tick({ now: new Date('2026-09-09T10:05:00.000Z') })
  await tickOver()

  assert.deepEqual(report.fired, ['z-readable'], 'an unrenderable throw cost the whole sweep evaluation')
  assert.deepEqual(ran, ['z-readable'])
})

test('a run rejecting with a value the driver cannot render leaves the daemon up', () => {
  // The same value on the settlement side, where there is no `tick()` left to
  // swallow it: `void` discarded that promise, so a throw out of `logFailed`
  // is an unhandled rejection and Node's default takes the process with it.
  const script = `
    import { createBackfillRegistry } from '${REGISTRY_URL}'
    import { createBackfillSweepDriver } from '${DRIVER_URL}'
    const backfills = createBackfillRegistry()
    backfills.register({
      name: 'a-unrenderable-throw',
      plugin: '@third-party/unrenderable',
      datasets: ['ai_gateway_messages'],
      async *run() {},
      sweep: { cron: '*/5 * * * *' },
    })
    const driver = createBackfillSweepDriver({
      backfills,
      backfillMaterializers: { register() {}, get: () => undefined, list: () => [] },
      env: { HYP_HOME: '/nonexistent-home' },
      storage: { cacheRoot: '/nonexistent-cache' },
      query: { getDataset: () => undefined },
      runBackfill: async () => { throw Object.create(null) },
    })
    await driver.tick({ now: new Date('2026-09-09T10:05:00.000Z') })
    await new Promise((r) => setTimeout(r, 50))
    process.stdout.write('DAEMON_STILL_UP')
  `
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  assert.equal(stdout, 'DAEMON_STILL_UP')
})

/** Let every already-queued microtask and immediate settle. */
function tickOver() {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}
