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
  const observedRepos = opts.observedRepos ?? (
    runtime.config.inventory === 'session_repos'
      ? await runtime.observedRepos.list()
      : undefined
  )
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
    runtime.log.info('github.capture_tick_completed', {
      mode: opts.mode,
      repos: result.repos,
      events: result.events,
      requests: result.requests,
      pending: result.pending,
      errors: result.errors.length,
    })
    return result
  } finally {
    writeCursors(runtime.stateDir, cursors)
  }
}
