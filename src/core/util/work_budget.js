// @ts-check

// Called through the module object, not named bindings, so node:test's mock
// timers (which patch this object) can drive the yield and the sleep in tests.
import timersPromises from 'node:timers/promises'

/** Default slice length in milliseconds of process CPU. */
export const DEFAULT_SLICE_MS = 8

/** Default row budget of one slice. */
export const DEFAULT_SLICE_ROWS = 4_096

/** Default share of one core the work may use, counting the whole process (LLP 0485#decision). */
export const DEFAULT_DUTY = 0.2

/** The longest single sleep, so a busy process slows background work without stalling it. */
export const MAX_SLEEP_MS = 2_000

/**
 * Process CPU (user plus system, every thread) in milliseconds.
 *
 * @returns {number}
 */
export function processCpuMs() {
  const used = process.cpuUsage()
  return (used.user + used.system) / 1000
}

/**
 * A cooperative budget for long work that shares a process with latency-
 * sensitive work: an index build in the daemon beside capture and health
 * checks, or the same build on a command's cold path. The caller reports
 * progress with `tick(rows)` inside its inner loops; once the current slice
 * has used `sliceMs` of process CPU or covered `sliceRows` rows, `tick` hands
 * back a promise that first yields one event-loop turn (so pending I/O
 * callbacks and timers run) and then sleeps long enough that the process's
 * CPU stays at `duty` of a core: `cpu * (1 - duty) / duty` ms, at most
 * `MAX_SLEEP_MS`.
 *
 * The clock is process CPU, not elapsed time, because what the budget limits
 * is whole-process CPU: decompression and hashing in the thread pool and
 * garbage collection run beside the main thread, and on an elapsed-time clock
 * they let a 0.25 duty use up to 2.5 times that. Every millisecond of process
 * CPU is charged to exactly one sleep, including what the process spends
 * while the work sleeps (thread-pool work finishing, foreground requests), so
 * without the cap the process's CPU per wall second stays at most
 * `duty / (1 - duty)`: 0.25 at the default 0.2. Foreground work therefore
 * slows background work; the cap bounds by how much. A slice still ends only
 * after its own `sliceMs` of CPU since it woke (or its rows), so each wake
 * does real work.
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
 * promise, the immediate and the sleep timer. The budget holds three numbers
 * of state and nothing that grows with rows, slices or uptime.
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
 * @ref LLP 0480#cooperative [implements]: slice, yield a turn, then sleep to hold the duty cycle; the cold path runs without the sleep
 * @ref LLP 0485#decision [implements]: the clock is whole-process CPU, every CPU millisecond is charged once, sleeps are capped at 2 s, duty 0.2
 * @param {{ sliceMs?: number, sliceRows?: number, duty?: number, signal?: AbortSignal, cpuNow?: () => number }} [opts]
 *   `cpuNow` is a monotonic process-CPU clock in milliseconds, `processCpuMs` unless a test supplies one
 * @returns {{ tick: (rows?: number) => Promise<void> | undefined }}
 */
export function createWorkBudget(opts = {}) {
  const sliceMs = opts.sliceMs ?? DEFAULT_SLICE_MS
  const sliceRows = opts.sliceRows ?? DEFAULT_SLICE_ROWS
  const duty = opts.duty ?? DEFAULT_DUTY
  const { signal } = opts
  const cpuNow = opts.cpuNow ?? processCpuMs
  if (!(sliceMs > 0)) throw new RangeError(`work budget sliceMs must be > 0, got ${sliceMs}`)
  if (!(sliceRows >= 1)) throw new RangeError(`work budget sliceRows must be >= 1, got ${sliceRows}`)
  if (!(duty > 0 && duty <= 1)) throw new RangeError(`work budget duty must be in (0, 1], got ${duty}`)

  // CPU charged to the next sleep is counted from the last boundary, so what
  // the process uses during a sleep is charged too; the slice itself is
  // measured from its wake.
  let chargedFrom = cpuNow()
  let sliceStart = chargedFrom
  let rowsInSlice = 0

  /** @param {number} used process CPU since the last boundary */
  async function rest(used) {
    const sleepMs = Math.min(MAX_SLEEP_MS, used * (1 - duty) / duty)
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
    sliceStart = cpuNow()
    rowsInSlice = 0
  }

  return {
    tick(rows = 1) {
      rowsInSlice += rows
      const now = cpuNow()
      if (now - sliceStart < sliceMs && rowsInSlice < sliceRows) return undefined
      const used = now - chargedFrom
      chargedFrom = now
      return rest(used)
    },
  }
}
