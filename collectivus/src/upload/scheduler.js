/**
 * Daily UTC timer. Calls `tick` once at startup (for catch-up), then
 * once per UTC day at the configured HH:MM. The timer chain (not
 * setInterval) prevents drift, and clamps to setTimeout's 32-bit ceiling.
 *
 * If a tick reports `{ retry: true }` (or throws), the next firing is
 * brought forward to `retryDelayMs` from now instead of waiting for the
 * next daily slot — so a transient outage at 00:10 doesn't lose a day.
 */

const MAX_TIMEOUT = 2147483647 // ~24.8 days; setTimeout caps at int32 ms
const DEFAULT_RETRY_DELAY_MS = 15 * 60 * 1000

/**
 * @import { TickResult, SchedulerDeps } from '../types.js'
 */

/**
 * @param {object} options
 * @param {string} options.time "HH:MM" UTC
 * @param {() => Promise<void | TickResult>} options.tick
 * @param {(err: unknown) => void} [options.onError] called when tick rejects
 * @param {number} [options.retryDelayMs] fast-retry delay after a failed tick (default 15min)
 * @param {boolean} [options.skipInitialTick] when true, `start()` only schedules the next firing; the upload subsystem leaves this off so a missed daily run gets caught up immediately, but the self-update tick sets it so we don't try to `npm install -g` on every process launch
 * @param {SchedulerDeps} [deps]
 * @returns {{ start: () => Promise<void>, stop: () => Promise<void> }}
 */
export function createScheduler(options, deps = {}) {
  const now = deps.now ?? (() => new Date())
  const setT = deps.setTimeoutFn ?? setTimeout
  const clearT = deps.clearTimeoutFn ?? clearTimeout
  const onError = options.onError ?? defaultOnError
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const skipInitialTick = options.skipInitialTick === true

  const [hh, mm] = parseTime(options.time)

  /** @type {NodeJS.Timeout | number | undefined} */
  let handle
  let stopped = false
  let lastRetry = false
  /** @type {Promise<void>} */
  let chain = Promise.resolve()

  function runTick() {
    chain = chain.then(async () => {
      if (stopped) return
      try {
        const result = await options.tick()
        lastRetry = !!(result && result.retry)
      } catch (err) {
        onError(err)
        lastRetry = true
      }
    })
    return chain
  }

  function schedule() {
    if (stopped) return
    const dailyAt = nextFireAt(now(), hh, mm)
    let delay = dailyAt.getTime() - now().getTime()
    if (delay < 0) delay = 0
    if (lastRetry && retryDelayMs < delay) delay = retryDelayMs
    const capped = Math.min(delay, MAX_TIMEOUT)
    handle = setT(() => {
      handle = undefined
      if (stopped) return
      // If we capped the delay, just re-schedule without firing the tick.
      if (capped < delay) {
        schedule()
        return
      }
      runTick().then(() => schedule())
    }, capped)
  }

  return {
    async start() {
      stopped = false
      if (!skipInitialTick) await runTick()
      schedule()
    },
    async stop() {
      stopped = true
      if (handle !== undefined) {
        clearT(handle)
        handle = undefined
      }
      await chain
    },
  }
}

/**
 * Parse "HH:MM" into [hours, minutes]. Throws on malformed input.
 *
 * @param {string} time
 * @returns {[number, number]}
 */
export function parseTime(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) throw new Error(`invalid upload-time "${time}", expected HH:MM`)
  const hh = parseInt(match[1], 10)
  const mm = parseInt(match[2], 10)
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error(`invalid upload-time "${time}", out of range`)
  }
  return [hh, mm]
}

/**
 * Compute the next UTC fire time strictly after `from`.
 *
 * @param {Date} from
 * @param {number} hh
 * @param {number} mm
 * @returns {Date}
 */
export function nextFireAt(from, hh, mm) {
  const next = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
    hh, mm, 0, 0
  ))
  if (next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next
}

/**
 * @param {unknown} err
 * @returns {void}
 */
function defaultOnError(err) {
  const message = err instanceof Error ? err.stack ?? err.message : String(err)
  console.error(`[collectivus] upload tick failed: ${message}`)
}
