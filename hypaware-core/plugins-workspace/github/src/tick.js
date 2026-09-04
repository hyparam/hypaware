// @ts-check

import { captureRepos } from './capture.js'
import { readCursors, writeCursors } from './cursors.js'
import { GITHUB_EVENTS_COLUMNS, githubEventsTablePath } from './dataset.js'
import { getClient } from './runtime.js'

/**
 * Run one capture tick: read the per-repo cursors, capture every selected repo
 * (appending `github_events` rows through the kernel cache), then persist the
 * advanced cursors. Shared by the daemon poll source and the `sync`/`backfill`
 * commands - the only difference is `mode` (and the optional `only` filter).
 *
 * Cursors are persisted even when a repo errors mid-run, so progress is never
 * lost (the next tick resumes past what was captured).
 *
 * @import { GithubRuntime } from './types.js'
 *
 * @param {GithubRuntime} runtime
 * @param {{ mode: 'backfill' | 'poll', only?: string[], observedRepos?: string[] }} opts
 * @returns {Promise<{ repos: number, events: number, requests: number, pending: boolean, errors: Array<{ repo: string, error: string }> }>}
 */
export async function runCaptureTick(runtime, opts) {
  const cursors = readCursors(runtime.stateDir)
  const client = getClient(runtime)
  /** @type {string[] | undefined} */
  let observedRepos = opts.observedRepos
  if (observedRepos === undefined && runtime.config.inventory === 'session_repos') {
    try {
      observedRepos = await runtime.observedRepos.list()
    } catch (err) {
      // Escaping here aborts the whole tick, which is what the per-repo
      // isolation inside `captureRepos` exists to prevent, so report the
      // unresolved inventory as one more captured failure instead.
      const message = err instanceof Error ? err.message : String(err)
      const kind = /** @type {{ hypErrorKind?: string }} */ (err)?.hypErrorKind
      runtime.log.error('github.inventory_resolve_failed', {
        mode: 'session_repos',
        error: message,
        ...(kind ? { error_kind: kind } : {}),
      })
      // The failure itself is not backlog (LLP 0360#cadence: failures retry on
      // the ordinary cadence), but a tick that never resolved its inventory
      // retired none either. A flat `false` would clear the source's backlog
      // flag, sending saved continuations back to a full poll interval
      // (LLP 0361#budget), so read the answer off the state the failed read
      // left behind: an unfinished revalidation (its bounded slice runs inside
      // this same `list()`, so a throw leaves the pass still reported as
      // pending) and the durable per-repo cursors.
      const pending =
        runtime.observedRepos.revalidationPending?.() === true ||
        Object.values(cursors.repos).some((cursor) => Boolean(cursor?.work))
      return { repos: 0, events: 0, requests: 0, pending, errors: [{ repo: '(inventory)', error: message }] }
    }
  }
  // Incomplete inventory revalidation is bounded local work remaining, in
  // exactly the LLP 0361#budget sense capture's own `pending` carries, so it
  // rides the same backlog cadence instead of waiting a full poll interval to
  // finish contracting (or re-admitting) repositories.
  // @ref LLP 0367#bounded-revalidation [implements]: pending revalidation resumes on the backlog cadence
  const inventoryPending =
    opts.observedRepos === undefined &&
    runtime.config.inventory === 'session_repos' &&
    runtime.observedRepos.revalidationPending?.() === true
  const tablePath = githubEventsTablePath(runtime.storage)
  const columns = [...GITHUB_EVENTS_COLUMNS]

  /** @param {Record<string, unknown>[]} rows */
  async function append(rows) {
    if (rows.length === 0) return
    await runtime.storage.appendRows(tablePath, columns, rows)
  }

  try {
    const result = await captureRepos({
      client,
      config: runtime.config,
      cursors,
      append,
      log: runtime.log,
      mode: opts.mode,
      only: opts.only,
      observedRepos,
      requestLimit: runtime.captureRequestLimit,
    })
    const pending = result.pending || inventoryPending
    runtime.log.info('github.capture_tick_completed', {
      mode: opts.mode,
      repos: result.repos,
      events: result.events,
      requests: result.requests,
      pending,
      inventory_pending: inventoryPending,
      errors: result.errors.length,
    })
    return { ...result, pending }
  } finally {
    writeCursors(runtime.stateDir, cursors)
  }
}
