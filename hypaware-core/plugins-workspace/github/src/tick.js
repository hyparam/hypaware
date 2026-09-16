// @ts-check

import { authorizeBackfill, captureRepos } from './capture.js'
import { authorizedImports, readCursors, writeCursors } from './cursors.js'
import { DATASET_NAME, GITHUB_EVENTS_COLUMNS, githubEventsTablePath } from './dataset.js'
import { getClient } from './runtime.js'

/**
 * The `repo` slot a projection failure occupies in a tick's error list. Not a
 * repository, so a caller reading that list for a capture verdict can tell the
 * two apart.
 */
export const GRAPH_ERROR_REPO = '(graph)'

/**
 * The `repo` slot a cursor-persistence failure occupies in a tick's error list.
 * Like {@link GRAPH_ERROR_REPO}, not a repository, so the counts a tick did
 * produce can be reported beside the write that failed to record them.
 */
export const CURSOR_ERROR_REPO = '(cursors)'

/**
 * Run one capture tick: read the per-repo cursors, capture every selected repo
 * (appending `github_events` rows through the kernel cache), then persist the
 * advanced cursors, then project GitHub rows. Shared by the daemon poll source
 * and the `sync`/`backfill` commands; only `mode` and the optional `only` differ.
 *
 * Cursors are persisted even when a repo errors mid-run, so progress is never
 * lost (the next tick resumes past what was captured), and a failure of that
 * closing write is reported on `errors` under {@link CURSOR_ERROR_REPO} rather
 * than thrown over the counts the tick already produced.
 *
 * @import { GithubRuntime } from './types.js'
 *
 * @param {GithubRuntime} runtime
 * @param {{ mode: 'backfill' | 'poll', only?: string[], observedRepos?: string[] }} opts
 * @returns {Promise<{ repos: number, visited: number, events: number, requests: number, pending: boolean, errors: Array<{ repo: string, error: string }> }>}
 */
export async function runCaptureTick(runtime, opts) {
  const result = await captureTick(runtime, opts)
  // @ref LLP 0392#retry [implements]: first tick catches up durable rows; failed projections remain due even on an idle tick
  if (runtime.projectionNeeded !== false) {
    const started = Date.now()
    runtime.log.info('github.projection_started', { operation: 'graph.project', source_dataset: DATASET_NAME })
    try {
      const projected = await runtime.graph.project(DATASET_NAME)
      runtime.projectionNeeded = false
      runtime.log.info('github.projection_completed', {
        operation: 'graph.project',
        source_dataset: DATASET_NAME,
        nodes_written: projected.nodesWritten,
        edges_written: projected.edgesWritten,
        duration_ms: Date.now() - started,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      runtime.log.error('github.projection_failed', {
        operation: 'graph.project',
        source_dataset: DATASET_NAME,
        error_kind: /** @type {{ hypErrorKind?: string }} */ (err)?.hypErrorKind ?? 'github_projection_failed',
        error,
        duration_ms: Date.now() - started,
      })
      result.errors.push({ repo: GRAPH_ERROR_REPO, error })
    }
  }
  return result
}

/**
 * @param {GithubRuntime} runtime
 * @param {{ mode: 'backfill' | 'poll', only?: string[], observedRepos?: string[] }} opts
 */
async function captureTick(runtime, opts) {
  const cursors = readCursors(runtime.stateDir)
  // The imports this tick starts from: one it gains over the requests that
  // follow is another process's, and the closing write must adopt it.
  let knownImports = authorizedImports(cursors)
  // @ref LLP 0409#one-time-imports [implements]: durable authorization precedes network work, even for repos the budget cannot visit yet
  if (opts.mode === 'backfill' && opts.only?.length) {
    authorizeBackfill(cursors, opts.only, runtime.config)
    await writeCursors(runtime.stateDir, cursors, knownImports)
    knownImports = authorizedImports(cursors)
  }
  const client = getClient(runtime)
  /** @type {string[] | undefined} */
  let observedRepos = opts.observedRepos
  if (opts.mode === 'backfill' && opts.only?.length) observedRepos = []
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
      // (LLP 0361#budget), so read the answer off the persisted state this
      // failed read left untouched: a revalidation an earlier tick started,
      // and the cursors of the repositories the last derived inventory
      // still selects.
      // Scope matters because nothing prunes the cursor sidecar
      // (LLP 0360#cursoring): a repository since ignored or gone from the
      // session evidence keeps its continuation forever, and counting it
      // reports backlog no tick can ever retire.
      // An empty inventory therefore reports no backlog, and deliberately so:
      // with no repository a later tick could select, a saved continuation is
      // not work this source can retire. Falling back to the whole sidecar
      // when the inventory reads empty would restore exactly that pin.
      const ignored = new Set(runtime.config.ignore.map((repo) => repo.toLowerCase()))
      const pending =
        runtime.observedRepos.revalidationPending?.() === true ||
        (runtime.observedRepos.lastKnown?.() ?? []).some(
          (repo) => !ignored.has(repo) && cursors.repos[repo]?.work !== undefined,
        )
      return { repos: 0, visited: 0, events: 0, requests: 0, pending, errors: [{ repo: '(inventory)', error: message }] }
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
    runtime.projectionNeeded = true
  }

  /**
   * Commit the advanced cursors, reporting a failure rather than throwing it.
   * The failure is real - the next tick re-reads the stale sidecar and
   * re-fetches what this one captured - but throwing it from the closing write
   * discards the counts the tick already produced: `source.js` never adds the
   * events to `rowsWritten` and the commands print none of them. So it joins
   * the tick's error list under a slot no repository can occupy, the way an
   * unresolved inventory and a failed projection already do, and a caller's
   * verdict still turns on a non-empty list.
   *
   * @returns {Promise<string | undefined>} the failure, when the write failed
   */
  async function persistCursors() {
    try {
      await writeCursors(runtime.stateDir, cursors, knownImports)
      return undefined
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      runtime.log.error('github.cursor_write_failed', {
        mode: opts.mode,
        error,
        error_kind: /** @type {{ hypErrorKind?: string }} */ (err)?.hypErrorKind ?? 'github_cursor_write_failed',
      })
      return error
    }
  }

  let result
  try {
    result = await captureRepos({
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
  } catch (err) {
    // The tick ended with no result to carry a report, so still commit whatever
    // per-repo progress it did advance, but never let that write's own failure
    // stand in for the error that actually ended the tick.
    await persistCursors()
    throw err
  }
  const pending = result.pending || inventoryPending
  const cursorError = await persistCursors()
  if (cursorError !== undefined) result.errors.push({ repo: CURSOR_ERROR_REPO, error: cursorError })
  runtime.log.info('github.capture_tick_completed', {
    mode: opts.mode,
    repos: result.repos,
    repos_visited: result.visited,
    events: result.events,
    requests: result.requests,
    pending,
    inventory_pending: inventoryPending,
    errors: result.errors.length,
  })
  return { ...result, pending }
}
