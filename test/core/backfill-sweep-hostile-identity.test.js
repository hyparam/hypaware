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

/** Let every already-queued microtask and immediate settle. */
function tickOver() {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}
