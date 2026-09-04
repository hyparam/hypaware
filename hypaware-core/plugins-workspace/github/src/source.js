// @ts-check

import { parseInterval } from './config.js'
import { requireGithubRuntime } from './runtime.js'
import { runCaptureTick } from './tick.js'

// @ref LLP 0361#cadence [implements]: unfinished bounded work resumes without turning capture into a busy loop
export const BACKLOG_RETRY_MS = 15 * 60_000

/**
 * `startGithubSource` is the `SourceContribution.start` callback. Local
 * capture defaults to session repositories on a 24-hour cadence. The first
 * run waits at most five minutes, then each completed run schedules the next
 * one. Ticks never overlap and daemon restarts cannot defer work for a whole
 * interval.
 *
 * @import { SourceStatus, StartedSource } from './types.js'
 * @returns {Promise<StartedSource>}
 */
// @ref LLP 0360#cadence [implements]: short first delay and completion-relative scheduling prevent overlap and restart starvation
export async function startGithubSource() {
  const runtime = requireGithubRuntime()
  /** @type {ReturnType<typeof setTimeout> | null} */
  let handle = null
  /** @type {Promise<unknown> | null} */
  let inFlight = null
  /** @type {string | null} */
  let lastTickAt = null
  /** @type {string | null} */
  let lastSuccessAt = null
  /** @type {string | null} */
  let nextTickAt = null
  let lastRepoCount = 0
  let lastInventoryRepos = 0
  let rowsWritten = 0
  let backlogPending = false
  /** @type {string | undefined} */
  let lastError
  let generation = 0

  async function tick() {
    lastTickAt = new Date().toISOString()
    const started = Date.now()
    runtime.log.info('github.poll_tick_started', { operation: 'poll' })
    try {
      const result = await runCaptureTick(runtime, { mode: 'poll' })
      rowsWritten += result.events
      backlogPending = result.pending
      // What the last tick reached, not the inventory: an exhausted budget can
      // stop a tick partway through it (LLP 0361#budget). The inventory it was
      // drawn from is published beside it, so a low count reads as the budget
      // stopping early rather than as a shrunken inventory. The two being equal
      // does not mean the tick finished, though - `backlog_pending` says that.
      lastRepoCount = result.visited
      lastInventoryRepos = result.repos
      lastError = result.errors[0]?.error
      if (result.errors.length === 0) lastSuccessAt = new Date().toISOString()
      runtime.log.info('github.poll_tick_completed', {
        operation: 'poll',
        repos: result.repos,
        repos_visited: result.visited,
        events: result.events,
        errors: result.errors.length,
        requests: result.requests,
        pending: result.pending,
        duration_ms: Date.now() - started,
      })
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      runtime.log.error('github.poll_tick_failed', {
        operation: 'poll',
        error: lastError,
        error_kind: /** @type {any} */ (err)?.hypErrorKind ?? 'github_poll_failed',
        duration_ms: Date.now() - started,
      })
    }
  }

  /** @param {number} delayMs @param {number} ownGeneration */
  function schedule(delayMs, ownGeneration) {
    nextTickAt = new Date(Date.now() + delayMs).toISOString()
    handle = setTimeout(() => {
      handle = null
      nextTickAt = null
      inFlight = tick().finally(() => {
        inFlight = null
        if (generation === ownGeneration) schedule(nextDelayMs(), ownGeneration)
      })
    }, delayMs)
    if (typeof handle.unref === 'function') handle.unref()
  }

  function intervalMs() {
    return Math.max(1, parseInterval(runtime.config.poll_interval) ?? 86_400_000)
  }

  function nextDelayMs() {
    return nextCaptureDelay(intervalMs(), backlogPending)
  }

  function startTimer() {
    const ownGeneration = ++generation
    const delayMs = Math.min(intervalMs(), 5 * 60_000)
    if (inFlight) {
      inFlight.finally(() => {
        if (generation === ownGeneration) schedule(delayMs, ownGeneration)
      }).catch(() => {})
      return
    }
    schedule(delayMs, ownGeneration)
  }

  function stopTimer() {
    generation += 1
    if (handle) clearTimeout(handle)
    handle = null
    nextTickAt = null
  }

  startTimer()

  return {
    async status() {
      /** @type {SourceStatus} */
      const status = {
        state: 'ready',
        message: `polling ${runtime.config.inventory === 'all_visible' ? 'all visible' : 'session-observed'} GitHub repositories every ${runtime.config.poll_interval}`,
        details: {
          cadence: runtime.config.poll_interval,
          inventory: runtime.config.inventory,
          ignored_repos: runtime.config.ignore.length,
          last_tick_at: lastTickAt,
          last_success_at: lastSuccessAt,
          next_tick_at: nextTickAt,
          last_inventory_repos: lastInventoryRepos,
          last_repo_count: lastRepoCount,
          in_flight: inFlight !== null,
          backlog_pending: backlogPending,
        },
        rowsWritten,
      }
      if (lastError) status.lastError = lastError
      return status
    },
    async reload() {
      stopTimer()
      startTimer()
    },
    async stop() {
      stopTimer()
      if (inFlight) await inFlight.catch(() => {})
    },
  }
}

/** @param {number} intervalMs @param {boolean} pending */
export function nextCaptureDelay(intervalMs, pending) {
  return pending ? Math.min(intervalMs, BACKLOG_RETRY_MS) : intervalMs
}
