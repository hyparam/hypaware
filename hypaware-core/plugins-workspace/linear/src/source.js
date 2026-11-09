// @ts-check

import { requireLinearRuntime } from './runtime.js'
import { parseInterval } from './config.js'
import { runLinearCaptureTick } from './capture.js'

/** @import { StartedSource } from '../../../../hypaware-core/plugins-workspace/linear/src/types.js' */

/** @returns {Promise<StartedSource>} */
// @ref LLP 0592#capture [implements]: completion-relative scheduling, durable backlog and cancellable non-overlapping ticks
export async function startLinearSource() {
  const rt = requireLinearRuntime()
  const interval = parseInterval(rt.config.poll_interval) ?? 86400000
  let stopped = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  /** @type {Promise<void> | null} */
  let inflight = null
  /** @type {AbortController | null} */
  let cancel = null
  let lastError = ''
  let rowsWritten = 0
  /** @type {string | null} */
  let nextTickAt = null
  /** @type {string | null} */
  let lastSuccessAt = null

  function schedule(ms) {
    if (stopped || !rt.config.teams.length) return
    nextTickAt = new Date(Date.now() + ms).toISOString()
    timer = setTimeout(() => {
      timer = null
      nextTickAt = null
      inflight = tick()
    }, ms)
    timer.unref?.()
  }
  async function tick() {
    cancel = new AbortController()
    let pending = false
    try {
      const result = await runLinearCaptureTick(rt, { signal: cancel.signal })
      rowsWritten += result.events
      lastError = result.errors.join(', ')
      pending = result.pending
      if (!lastError && !result.cancelled) lastSuccessAt = new Date().toISOString()
    } catch {
      lastError = 'linear_capture_failed'
      rt.log.warn('linear.source_failed', { operation: 'linear.capture', error_kind: lastError })
    } finally {
      cancel = null
      inflight = null
      schedule(!lastError && pending ? Math.min(interval, 900000) : interval)
    }
  }
  schedule(Math.min(interval, 300000))
  return {
    async status() {
      return { state: 'ready', message: rt.config.teams.length ? `polling configured Linear teams every ${rt.config.poll_interval}` : 'Set linear.teams to enable capture',
        rowsWritten, ...(lastError ? { lastError } : {}),
        details: { cadence: rt.config.poll_interval, teams: rt.config.teams.length, in_flight: inflight !== null, next_tick_at: nextTickAt, last_success_at: lastSuccessAt } }
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      nextTickAt = null
      cancel?.abort()
      if (inflight) await inflight
    },
  }
}
