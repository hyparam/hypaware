// @ts-check

// The client's cooperative work budget (LLP 0480#cooperative), ported from the
// server's createWorkBudget. The clock the budget reads is a fake the test
// moves by hand, so "the slice ran 8 ms" is a statement, not a race. The
// yield and the sleep run on node:test's mocked timers (which also cover
// node:timers/promises), so a wait that is still pending until the mocked
// clock reaches exactly N ms proves the budget asked for an N ms sleep. Abort
// promptness is the one wall-clock claim, bounded against a sleep two orders
// of magnitude longer than the bound.

/** @import { TestContext } from 'node:test' */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_DUTY,
  DEFAULT_SLICE_MS,
  DEFAULT_SLICE_ROWS,
  createWorkBudget,
} from '../../src/core/util/work_budget.js'

// Captured before any test mocks the timers: one real macrotask turn drains
// every microtask the budget's promise chain needs.
const realSetImmediate = globalThis.setImmediate
const realSetTimeout = globalThis.setTimeout
const flush = () => new Promise((resolve) => realSetImmediate(resolve))

/** A clock that moves only when told to, and counts its reads. */
function fakeClock() {
  const clock = { ms: 1_000, reads: 0, now: () => { clock.reads += 1; return clock.ms } }
  return clock
}

/** @param {TestContext} t */
function mockTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] })
  return t.mock.timers
}

/**
 * Track a wait's outcome without awaiting it.
 * @param {Promise<void> | undefined} wait
 */
function watch(wait) {
  assert.ok(wait instanceof Promise, 'expected a slice boundary')
  const state = { settled: false, /** @type {unknown} */ error: undefined }
  wait.then(() => { state.settled = true }, (err) => { state.settled = true; state.error = err })
  return state
}

/**
 * Assert that `wait` needs one mocked turn and then exactly `sleepMs` of
 * mocked time to resolve.
 *
 * @param {TestContext['mock']['timers']} timers
 * @param {Promise<void> | undefined} wait
 * @param {number} sleepMs
 */
async function assertYieldThenSleep(timers, wait, sleepMs) {
  const state = watch(wait)
  await flush()
  assert.equal(state.settled, false, 'waits for the event-loop turn')
  timers.tick(0)
  await flush()
  if (sleepMs > 0) {
    assert.equal(state.settled, false, 'sleeps after the turn')
    timers.tick(sleepMs - 0.01)
    await flush()
    assert.equal(state.settled, false, `still asleep just before ${sleepMs} ms`)
    timers.tick(0.01)
    await flush()
  }
  assert.equal(state.settled, true, `resolved at ${sleepMs} ms`)
  assert.equal(state.error, undefined)
}

test('defaults are the design values: 8 ms, 4,096 rows, duty 0.25', () => {
  assert.equal(DEFAULT_SLICE_MS, 8)
  assert.equal(DEFAULT_SLICE_ROWS, 4_096)
  assert.equal(DEFAULT_DUTY, 0.25)
  assert.equal(typeof createWorkBudget().tick, 'function')
})

test('inside a slice tick returns undefined, not a promise', () => {
  const clock = fakeClock()
  const budget = createWorkBudget({ sliceMs: 8, sliceRows: 100, now: clock.now })
  for (let i = 0; i < 99; i++) {
    clock.ms += 0.05
    assert.equal(budget.tick(1), undefined)
  }
})

test('the row that reaches sliceRows ends the slice; a zero-time slice only yields', async (t) => {
  const timers = mockTimers(t)
  const clock = fakeClock()
  const budget = createWorkBudget({ sliceMs: 8, sliceRows: 4, duty: 0.25, now: clock.now })
  assert.equal(budget.tick(1), undefined)
  assert.equal(budget.tick(1), undefined)
  assert.equal(budget.tick(1), undefined)
  await assertYieldThenSleep(timers, budget.tick(1), 0)
  assert.equal(budget.tick(3), undefined, 'the slice restarts after the yield')
  await assertYieldThenSleep(timers, budget.tick(1), 0)
})

test('a batch tick counts all its rows', async (t) => {
  const timers = mockTimers(t)
  const clock = fakeClock()
  const budget = createWorkBudget({ sliceRows: 10, now: clock.now })
  await assertYieldThenSleep(timers, budget.tick(10), 0)
})

test('time ends a slice, and duty 0.25 sleeps three times what the slice ran', async (t) => {
  const timers = mockTimers(t)
  const clock = fakeClock()
  const budget = createWorkBudget({ sliceMs: 8, sliceRows: 1_000_000, duty: 0.25, now: clock.now })
  clock.ms += 7.9
  assert.equal(budget.tick(1), undefined, 'just under sliceMs does not yield')
  clock.ms += 0.1
  await assertYieldThenSleep(timers, budget.tick(1), 24)
  assert.equal(budget.tick(1), undefined, 'the next slice starts after the sleep')
})

for (const [duty, ran, slept] of [[0.5, 10, 10], [0.1, 2, 18]]) {
  test(`duty ${duty} after a ${ran} ms slice sleeps ${slept} ms`, async (t) => {
    const timers = mockTimers(t)
    const clock = fakeClock()
    const budget = createWorkBudget({ sliceMs: 1, duty, now: clock.now })
    clock.ms += ran
    await assertYieldThenSleep(timers, budget.tick(1), slept)
  })
}

test('duty 1 is the no-sleep mode: it yields the turn and never sleeps', async (t) => {
  const timers = mockTimers(t)
  const clock = fakeClock()
  const budget = createWorkBudget({ sliceMs: 8, duty: 1, now: clock.now })
  clock.ms += 500
  await assertYieldThenSleep(timers, budget.tick(1), 0)
})

test('abort during the sleep throws the signal reason promptly, without busy waiting', async () => {
  const clock = fakeClock()
  const controller = new AbortController()
  const reason = new Error('shutting down')
  // 100 ms ran at duty 0.01 asks for a 9.9 s sleep.
  const budget = createWorkBudget({ sliceMs: 8, duty: 0.01, signal: controller.signal, now: clock.now })
  clock.ms += 100
  const wait = budget.tick(1)
  const started = performance.now()
  realSetTimeout(() => controller.abort(reason), 20)
  // Read once the sleep has begun: any clock read from here on would be spinning.
  await new Promise((resolve) => realSetTimeout(resolve, 10))
  const readsBeforeAbort = clock.reads
  await assert.rejects(/** @type {Promise<void>} */ (wait), (err) => err === reason)
  assert.ok(performance.now() - started < 1_000, 'did not wait out the 9.9 s sleep')
  assert.equal(clock.reads, readsBeforeAbort, 'the sleep did not read the clock')
})

test('an aborted signal does not interrupt a slice; the boundary throws its reason without a timer', async (t) => {
  const timers = mockTimers(t)
  const clock = fakeClock()
  const controller = new AbortController()
  const reason = new Error('stop')
  controller.abort(reason)
  const budget = createWorkBudget({ sliceMs: 8, sliceRows: 2, signal: controller.signal, now: clock.now })
  assert.equal(budget.tick(1), undefined)
  const state = watch(budget.tick(1))
  await flush()
  assert.equal(state.settled, true, 'rejected without any mocked time passing')
  assert.equal(state.error, reason)
  timers.tick(0)
})

test('abort while yielding the turn throws the signal reason', async () => {
  const clock = fakeClock()
  const controller = new AbortController()
  const reason = new Error('stop during yield')
  const budget = createWorkBudget({ sliceRows: 1, signal: controller.signal, now: clock.now })
  const wait = budget.tick(1)
  controller.abort(reason)
  await assert.rejects(/** @type {Promise<void>} */ (wait), (err) => err === reason)
})

test('invalid budgets fail at construction', () => {
  assert.throws(() => createWorkBudget({ sliceMs: 0 }), RangeError)
  assert.throws(() => createWorkBudget({ sliceRows: 0 }), RangeError)
  assert.throws(() => createWorkBudget({ duty: 0 }), RangeError)
  assert.throws(() => createWorkBudget({ duty: 1.5 }), RangeError)
  assert.throws(() => createWorkBudget({ duty: NaN }), RangeError)
})
