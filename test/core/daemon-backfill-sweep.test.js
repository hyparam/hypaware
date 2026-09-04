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
 * @param {{ contributions: any[], runBackfill: any, config?: any, runTimeoutMs?: number }} args
 */
function driverFor(args) {
  return createBackfillSweepDriver({
    backfills: registry(args.contributions),
    backfillMaterializers: /** @type {any} */ ({ register() {}, get: () => undefined, list: () => [] }),
    env: /** @type {any} */ ({ HYP_HOME: '/nonexistent-home' }),
    storage: /** @type {any} */ ({ cacheRoot: '/nonexistent-cache' }),
    query: /** @type {any} */ ({ getDataset: () => undefined }),
    config: args.config,
    runBackfill: args.runBackfill,
    runTimeoutMs: args.runTimeoutMs,
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
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.deepEqual(fired, ['openclaw', 'hourly'])
})

// @ref LLP 0359#serialized-providers [tests]: providers due on the same tick
// are queued in registry order, never run concurrently through shared
// materializer and spool state.
test('providers due together run serially without blocking the tick', async () => {
  /** @type {string[]} */
  const started = []
  let releaseFirst = () => {}
  const firstPending = new Promise((resolve) => { releaseFirst = () => resolve(OK) })
  const driver = driverFor({
    contributions: [
      contribution({ name: 'openclaw', sweep: { cron: '*/5 * * * *' } }),
      contribution({ name: 'claude', plugin: '@hypaware/claude', sweep: { cron: '*/5 * * * *' } }),
    ],
    runBackfill: async (args) => {
      started.push(args.provider)
      if (args.provider === 'openclaw') return firstPending
      return OK
    },
  })

  const report = await driver.tick({ now: at('2026-08-01T10:05:00.000Z') })
  assert.deepEqual(report.fired, ['openclaw', 'claude'])
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.deepEqual(started, ['openclaw'])

  releaseFirst()
  await firstPending
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.deepEqual(started, ['openclaw', 'claude'])
})

// The run budget the two abandonment regressions below drive the driver with,
// and a wait comfortably past it. Both are wide enough that a GC pause or a
// busy shared runner cannot decide an assertion: these tests are about the
// driver's handoff, not about how promptly this host gets to a timer. A budget
// of a few milliseconds would let the timers phase beat the `setImmediate`
// that proves the queue was still serial, and fail a correct driver.
const BUDGET_MS = 100
const PAST_BUDGET_MS = 400

// The queue is what makes one provider's hang everybody's hang: `runProvider`
// is plugin code reading a user's transcript tree, so a stalled network mount or
// a wedged storage read gives it neither settlement, and an unbounded wait on
// the head of the chain never starts anything behind it again. A daemon restart
// was the only recovery.
// @ref LLP 0372#bounded-handoff [tests]: a run that never settles hands the
// queue on at its bound, and the providers behind it still sweep
test('a run that never settles hands the queue on so the providers behind it still run', async () => {
  /** @type {string[]} */
  const started = []
  const driver = driverFor({
    contributions: [
      contribution({ name: 'openclaw', sweep: { cron: '* * * * *' } }),
      contribution({ name: 'claude', plugin: '@hypaware/claude', sweep: { cron: '* * * * *' } }),
    ],
    runTimeoutMs: BUDGET_MS,
    runBackfill: (args) => {
      started.push(args.provider)
      // Never settles, either way: the pathological external hang.
      if (args.provider === 'openclaw') return /** @type {any} */ (new Promise(() => {}))
      return /** @type {any} */ (Promise.resolve(OK))
    },
  })

  const report = await driver.tick({ now: at('2026-08-01T10:00:00.000Z') })
  assert.deepEqual(report.fired, ['openclaw', 'claude'])

  await new Promise((resolve) => { setImmediate(resolve) })
  assert.deepEqual(started, ['openclaw'], 'the queue is still serial while the head is inside its budget')

  await new Promise((resolve) => setTimeout(resolve, PAST_BUDGET_MS))
  assert.deepEqual(started, ['openclaw', 'claude'], 'the hung run never released the queue')
})

// The other half of the bound: handing the queue on is not the same as
// forgetting the run. It cannot be cancelled, so re-firing it would put a
// second pass on the datasets and the mid-flush spool the first one may still
// be writing.
// @ref LLP 0372#bounded-handoff [tests]: an abandoned provider stays in flight
// and is skipped, while a provider due later still fires
test('an abandoned run keeps its own in-flight guard while later providers still fire', async () => {
  /** @type {string[]} */
  const started = []
  const driver = driverFor({
    contributions: [
      contribution({ name: 'openclaw', sweep: { cron: '* * * * *' } }),
      contribution({ name: 'hourly', plugin: '@hypaware/hourly', sweep: { cron: '0 * * * *' } }),
    ],
    runTimeoutMs: BUDGET_MS,
    runBackfill: (args) => {
      started.push(args.provider)
      if (args.provider === 'openclaw') return /** @type {any} */ (new Promise(() => {}))
      return /** @type {any} */ (Promise.resolve(OK))
    },
  })

  // :01 is not the top of the hour, so only the every-minute provider fires.
  assert.deepEqual((await driver.tick({ now: at('2026-08-01T10:01:00.000Z') })).fired, ['openclaw'])
  await new Promise((resolve) => setTimeout(resolve, PAST_BUDGET_MS))

  // The hung provider is still its own run's owner: skipped, never doubled.
  assert.deepEqual((await driver.tick({ now: at('2026-08-01T10:02:00.000Z') })).fired, [])

  // A different provider coming due later is not held by it.
  assert.deepEqual((await driver.tick({ now: at('2026-08-01T11:00:00.000Z') })).fired, ['hourly'])
  await new Promise((resolve) => setTimeout(resolve, PAST_BUDGET_MS))
  assert.deepEqual(started, ['openclaw', 'hourly'])
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
  const query = /** @type {any} */ ({ getDataset: () => undefined })
  const driver = createBackfillSweepDriver({
    backfills,
    backfillMaterializers,
    env,
    storage,
    query,
    config: /** @type {any} */ (config),
    runBackfill: async (args) => { seen = args.ctx; return OK },
  })

  await driver.tick({ now: at('2026-08-01T10:00:00.000Z') })

  assert.equal(seen.env, env)
  assert.equal(seen.storage, storage)
  assert.equal(seen.query, query)
  assert.equal(seen.config, config)
  assert.equal(seen.backfills, backfills)
  assert.equal(seen.backfillMaterializers, backfillMaterializers)
})

// @ref LLP 0359#sweep-context [tests]: scheduled imports carry the effective
// retention window and identify themselves to providers.
test('scheduled runs receive plugin window_days and the sweep marker', async () => {
  /** @type {any} */
  let seen = null
  const config = {
    version: 2,
    query: { cache: { retention: { default_days: 90 } } },
    plugins: [{ name: '@hypaware/claude', config: { backfill: { window_days: 14 } } }],
  }
  const driver = driverFor({
    contributions: [contribution({ name: 'claude', plugin: '@hypaware/claude', sweep: { cron: '* * * * *' } })],
    config,
    runBackfill: async (args) => { seen = args; return OK },
  })

  await driver.tick({ now: at('2026-08-01T10:00:00.000Z') })
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.equal(seen.retentionDays, 14)
  assert.equal(seen.sweep, true)
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

// The companion to the test above: not blocking on a run is exactly what lets a
// pass that outruns its own cron interval be due again while it is still going,
// and a second concurrent run would land on the same datasets and the same
// mid-flush spool. Neither `runBackfillProvider` nor `runProvider` locks, so the
// driver has to.
// @ref LLP 0172#lane-b-sweep [tests]: two runs of one provider never overlap;
// a due-but-running provider is skipped, and the next idle tick picks it up
test('a second tick fires nothing while the first run is still in flight', async () => {
  /** @type {string[]} */
  const started = []
  let settle = () => {}
  const pending = new Promise((resolve) => { settle = () => resolve(OK) })
  const driver = driverFor({
    contributions: [contribution({ sweep: { cron: '* * * * *' } })],
    runBackfill: (args) => {
      started.push(args.provider)
      return /** @type {any} */ (pending)
    },
  })

  const first = await driver.tick({ now: at('2026-08-01T10:00:00.000Z') })
  assert.deepEqual(first.fired, ['openclaw'])

  const second = await driver.tick({ now: at('2026-08-01T10:01:00.000Z') })
  assert.deepEqual(second.fired, [])
  assert.deepEqual(started, ['openclaw'])

  // Skipped for that tick only: once the run settles, the next due tick fires.
  settle()
  await pending
  await new Promise((resolve) => { setImmediate(resolve) })
  const third = await driver.tick({ now: at('2026-08-01T10:02:00.000Z') })
  assert.deepEqual(third.fired, ['openclaw'])
  assert.deepEqual(started, ['openclaw', 'openclaw'])
})

// A run that rejects has to clear the guard too, or one failure wedges the
// provider's sweep for the life of the daemon.
// @ref LLP 0172#lane-b-sweep [tests]: the in-flight entry clears on both
// settlements, not just the resolving one
test('a rejected run clears the in-flight guard so the next due tick still fires', async () => {
  /** @type {string[]} */
  const started = []
  let reject = () => {}
  const pending = new Promise((_resolve, rej) => { reject = () => rej(new Error('boom')) })
  const driver = driverFor({
    contributions: [contribution({ sweep: { cron: '* * * * *' } })],
    runBackfill: (args) => {
      started.push(args.provider)
      return /** @type {any} */ (pending)
    },
  })

  assert.deepEqual((await driver.tick({ now: at('2026-08-01T10:00:00.000Z') })).fired, ['openclaw'])
  reject()
  await pending.catch(() => {})
  // One turn for the driver's own rejection handler to run before the retick.
  await new Promise((resolve) => { setImmediate(resolve) })

  assert.deepEqual((await driver.tick({ now: at('2026-08-01T10:01:00.000Z') })).fired, ['openclaw'])
  assert.deepEqual(started, ['openclaw', 'openclaw'])
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
    query: /** @type {any} */ ({ getDataset: () => undefined }),
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
  assert.throws(
    () => createBackfillSweepDriver(/** @type {any} */ ({ ...ok, query: undefined })),
    /query required/
  )
})
