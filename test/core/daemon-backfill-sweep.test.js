// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { createBackfillSweepDriver } from '../../src/core/daemon/backfill_sweep.js'

// Lane B's scheduling seam. The sweep is the only reason a transcript that
// never crossed the live gateway lands at all, and it runs inside the daemon's
// own tick loop, so the two things worth pinning are *which* contributions it
// fires (opt-in only, cron-due only) and that a failing run stays contained:
// an unhandled rejection here would take the daemon process down with it.
// @ref LLP 0172#lane-b-sweep [tests]: the due-check is `sweep`-gated and cron-gated, and the fired run never blocks or breaks the tick it rides
// @ref LLP 0171#requirements [tests]: R7's periodic sweep fires on the contribution's own configured schedule

/**
 * @param {Record<string, unknown>} [overrides]
 * @returns {any}
 */
function contribution(overrides = {}) {
  return {
    name: 'openclaw',
    plugin: '@hypaware/openclaw',
    datasets: ['ai_gateway_messages'],
    async *run() {},
    ...overrides,
  }
}

/**
 * A `BackfillRegistry` over a fixed contribution list: `list()` is the only
 * method the sweep driver calls, and the runner is faked, so nothing here
 * needs a real kernel.
 *
 * @param {any[]} contributions
 * @returns {any}
 */
function registry(contributions) {
  return {
    register() {},
    get: (name) => contributions.find((c) => c.name === name),
    list: () => contributions.slice(),
  }
}

/**
 * @param {{ contributions: any[], runBackfill: any, config?: any }} args
 */
function driverFor(args) {
  return createBackfillSweepDriver({
    backfills: registry(args.contributions),
    backfillMaterializers: /** @type {any} */ ({ register() {}, get: () => undefined, list: () => [] }),
    env: /** @type {any} */ ({ HYP_HOME: '/nonexistent-home' }),
    storage: /** @type {any} */ ({ cacheRoot: '/nonexistent-cache' }),
    config: args.config,
    runBackfill: args.runBackfill,
  })
}

/** @param {string} iso */
function at(iso) {
  return new Date(iso)
}

const OK = { ok: true, scanned: 0, rowsWritten: 0, skipped: 0 }

test('tick fires only the sweep-bearing contributions that are cron-due', async () => {
  /** @type {any[]} */
  const calls = []
  const driver = driverFor({
    contributions: [
      // Opted in, due every five minutes.
      contribution({ name: 'openclaw', sweep: { cron: '*/5 * * * *' } }),
      // Opted in, but only on the hour: not due at :05.
      contribution({ name: 'hourly', plugin: '@hypaware/hourly', sweep: { cron: '0 * * * *' } }),
      // Never opted in: the absent-by-default case every provider is in today.
      contribution({ name: 'claude', plugin: '@hypaware/claude' }),
    ],
    runBackfill: async (args) => { calls.push(args); return OK },
  })

  const report = await driver.tick({ now: at('2026-08-01T10:05:00.000Z') })

  assert.deepEqual(report.fired, ['openclaw'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'openclaw')
  assert.equal(calls[0].dryRun, false)
  assert.equal(calls[0].devRunId, `sweep-openclaw-${at('2026-08-01T10:05:00.000Z').getTime()}`)
})

test('tick fires nothing when no contribution is due, and both when both are', async () => {
  /** @type {string[]} */
  const fired = []
  const driver = driverFor({
    contributions: [
      contribution({ name: 'openclaw', sweep: { cron: '*/5 * * * *' } }),
      contribution({ name: 'hourly', plugin: '@hypaware/hourly', sweep: { cron: '0 * * * *' } }),
    ],
    runBackfill: async (args) => { fired.push(args.provider); return OK },
  })

  // :07 is neither a five-minute boundary nor the top of the hour.
  assert.deepEqual((await driver.tick({ now: at('2026-08-01T10:07:00.000Z') })).fired, [])
  assert.deepEqual(fired, [])

  // :00 satisfies both schedules.
  assert.deepEqual((await driver.tick({ now: at('2026-08-01T11:00:00.000Z') })).fired, ['openclaw', 'hourly'])
  assert.deepEqual(fired, ['openclaw', 'hourly'])
})

test('the fired run gets the narrowed runner context, built from the daemon runtime fields', async () => {
  /** @type {any} */
  let seen = null
  const contributions = [contribution({ sweep: { cron: '* * * * *' } })]
  const config = { version: 2, plugins: [{ name: '@hypaware/openclaw', config: {} }] }
  const backfills = registry(contributions)
  const backfillMaterializers = /** @type {any} */ ({ register() {}, get: () => undefined, list: () => [] })
  const env = /** @type {any} */ ({ HYP_HOME: '/nonexistent-home' })
  const storage = /** @type {any} */ ({ cacheRoot: '/nonexistent-cache' })
  const driver = createBackfillSweepDriver({
    backfills,
    backfillMaterializers,
    env,
    storage,
    config: /** @type {any} */ (config),
    runBackfill: async (args) => { seen = args.ctx; return OK },
  })

  await driver.tick({ now: at('2026-08-01T10:00:00.000Z') })

  assert.equal(seen.env, env)
  assert.equal(seen.storage, storage)
  assert.equal(seen.config, config)
  assert.equal(seen.backfills, backfills)
  assert.equal(seen.backfillMaterializers, backfillMaterializers)
})

test('a rejected sweep run neither throws out of tick nor becomes an unhandled rejection', async () => {
  /** @type {unknown[]} */
  const unhandled = []
  /** @param {unknown} reason */
  const onUnhandled = (reason) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const driver = driverFor({
      contributions: [
        contribution({ name: 'openclaw', sweep: { cron: '* * * * *' } }),
        contribution({ name: 'codex', plugin: '@hypaware/codex', sweep: { cron: '* * * * *' } }),
      ],
      runBackfill: async (args) => {
        if (args.provider === 'openclaw') throw new Error('cache is unwritable')
        return OK
      },
    })

    // The rejection is raised by the fired run, not by the due-check, so the
    // tick itself resolves normally and the *later* provider still fires: one
    // broken run does not cancel the rest of the sweep.
    const report = await driver.tick({ now: at('2026-08-01T10:00:00.000Z') })
    assert.deepEqual(report.fired, ['openclaw', 'codex'])

    // Two macrotask turns: enough for the rejected promise's handler to run,
    // and for Node to have reported it had there been none.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(unhandled, [], 'the fired run left an unhandled rejection')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('tick does not block on a run that never settles', async () => {
  let settle = () => {}
  const pending = new Promise((resolve) => { settle = () => resolve(OK) })
  const driver = driverFor({
    contributions: [contribution({ sweep: { cron: '* * * * *' } })],
    runBackfill: () => /** @type {any} */ (pending),
  })

  // If `tick` awaited the run, this would hang until the test timed out.
  const report = await driver.tick({ now: at('2026-08-01T10:00:00.000Z') })
  assert.deepEqual(report.fired, ['openclaw'])
  settle()
  await pending
})

test('a malformed sweep cron is skipped, not thrown, and later providers still fire', async () => {
  /** @type {string[]} */
  const fired = []
  const driver = driverFor({
    contributions: [
      contribution({ name: 'broken', plugin: '@hypaware/broken', sweep: { cron: 'not a cron' } }),
      contribution({ name: 'openclaw', sweep: { cron: '* * * * *' } }),
    ],
    runBackfill: async (args) => { fired.push(args.provider); return OK },
  })

  const report = await driver.tick({ now: at('2026-08-01T10:00:00.000Z') })
  assert.deepEqual(report.fired, ['openclaw'])
  assert.deepEqual(fired, ['openclaw'])
})

test('createBackfillSweepDriver refuses to build without the registries it fires through', () => {
  const ok = {
    backfills: registry([]),
    backfillMaterializers: /** @type {any} */ ({ register() {}, get: () => undefined, list: () => [] }),
    env: /** @type {any} */ ({}),
    storage: /** @type {any} */ ({ cacheRoot: '/nonexistent-cache' }),
  }
  assert.throws(
    () => createBackfillSweepDriver(/** @type {any} */ ({ ...ok, backfills: undefined })),
    /backfills required/
  )
  assert.throws(
    () => createBackfillSweepDriver(/** @type {any} */ ({ ...ok, backfillMaterializers: undefined })),
    /backfillMaterializers required/
  )
  assert.throws(
    () => createBackfillSweepDriver(/** @type {any} */ ({ ...ok, storage: undefined })),
    /storage required/
  )
})
