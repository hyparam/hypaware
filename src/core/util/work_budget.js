// @ts-check

// Called through the module object, not named bindings, so node:test's mock
// timers (which patch this object) can drive the yield and the sleep in tests.
import timersPromises from 'node:timers/promises'

/** Default slice length in milliseconds. */
export const DEFAULT_SLICE_MS = 8

/** Default row budget of one slice. */
export const DEFAULT_SLICE_ROWS = 4_096

/** Default share of wall time background work may run. */
export const DEFAULT_DUTY = 0.25

/**
 * A cooperative budget for long work that shares a process with latency-
 * sensitive work: an index build in the daemon beside capture and health
 * checks, or the same build on a command's cold path. The caller reports
 * progress with `tick(rows)` inside its inner loops; once the current slice
 * has run for `sliceMs` or covered `sliceRows` rows, `tick` hands back a
 * promise that first yields one event-loop turn (so pending I/O callbacks
 * and timers run) and then sleeps long enough that the work's active time
 * stays at `duty` of wall time: a slice that ran `elapsed` ms is followed by
 * `elapsed * (1 - duty) / duty` ms of sleep.
 *
 * `duty: 1` is the no-sleep mode for a command whose user is waiting: it
 * still yields a turn at every slice boundary, which is what lets the
 * command's own deadline timer and abort fire, but never sleeps.
 *
 * Inside a slice `tick` returns `undefined`, not a resolved promise, so a hot
 * loop pays one clock read and two additions per call and allocates nothing:
 *
 *   const wait = budget.tick(1)
 *   if (wait) await wait
 *
 * (`await budget.tick(n)` is also correct, at the cost of a microtask turn per
 * call.) The only allocations are at a slice boundary: the boundary's own
 * promise, the immediate and the sleep timer. The budget holds two numbers of
 * state and nothing that grows with rows, slices or uptime.
 *
 * Abort is observed at a slice boundary and during the sleep, and surfaces as
 * the signal's own reason (not the timers' generic `AbortError`), so a
 * shutdown that aborts with a typed reason sees that reason. Work between two
 * boundaries is not interrupted: a slice is short by construction, which is
 * what bounds how long shutdown waits.
 *
 * One budget serves one sequential worker. Ticking again before a returned
 * promise settles counts toward the next slice but does not add a second
 * sleep's worth of fairness.
 *
 * @ref LLP 0480#cooperative [implements]: slice by time or rows, yield a turn, then sleep to hold the duty cycle; the cold path runs without the sleep
 * @param {{ sliceMs?: number, sliceRows?: number, duty?: number, signal?: AbortSignal, now?: () => number }} [opts]
 *   `now` is a monotonic millisecond clock, `performance.now` unless a test supplies one
 * @returns {{ tick: (rows?: number) => Promise<void> | undefined }}
 */
export function createWorkBudget(opts = {}) {
  const sliceMs = opts.sliceMs ?? DEFAULT_SLICE_MS
  const sliceRows = opts.sliceRows ?? DEFAULT_SLICE_ROWS
  const duty = opts.duty ?? DEFAULT_DUTY
  const { signal } = opts
  const now = opts.now ?? (() => performance.now())
  if (!(sliceMs > 0)) throw new RangeError(`work budget sliceMs must be > 0, got ${sliceMs}`)
  if (!(sliceRows >= 1)) throw new RangeError(`work budget sliceRows must be >= 1, got ${sliceRows}`)
  if (!(duty > 0 && duty <= 1)) throw new RangeError(`work budget duty must be in (0, 1], got ${duty}`)

  let sliceStart = now()
  let rowsInSlice = 0

  /** @param {number} elapsed active time of the slice that just ended */
  async function rest(elapsed) {
    const sleepMs = elapsed * (1 - duty) / duty
    try {
      signal?.throwIfAborted()
      await timersPromises.setImmediate(undefined, { signal })
      if (sleepMs > 0) await timersPromises.setTimeout(sleepMs, undefined, { signal })
    } catch (err) {
      // The timers reject with their own AbortError; the caller asked for the
      // reason it aborted with.
      if (signal?.aborted) throw signal.reason
      throw err
    }
    sliceStart = now()
    rowsInSlice = 0
  }

  return {
    tick(rows = 1) {
      rowsInSlice += rows
      const elapsed = now() - sliceStart
      if (elapsed < sliceMs && rowsInSlice < sliceRows) return undefined
      return rest(elapsed)
    },
  }
}
