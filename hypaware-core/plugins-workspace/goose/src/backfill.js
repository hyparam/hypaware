// @ts-check

/**
 * `@hypaware/goose` backfill provider: imports local Goose history into
 * `ai_gateway_messages` from Goose's own `sessions.db` (LLP 0570).
 *
 * It reuses the T3 reader and projector, so backfilled and polled rows
 * converge for the same session (`client_name = 'goose'`). One item per
 * session keeps the whole-session invariant: `message_id` identity is always
 * computed from a session's full row set, and each item reconciles the
 * session's scope, so a re-run replaces rather than appends.
 *
 * @ref LLP 0570#backfill [implements]: scope is the non-hidden sessions whose
 *   `updated_at` falls in the window, or every non-hidden session when unset.
 *
 * @import { AiGatewayProjectedExchange, BackfillContribution, BackfillItem, BackfillRunContext, JsonObject } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 * @import { GooseRunnerHolder, GooseSessionRow, GooseWatermarkState } from './types.js'
 */

import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { isPartitionMutationBusy } from '../../../../src/core/util/mutation_guard.js'
import { readBackfillPolicy } from '../../../../src/core/config/backfill_policy.js'
import { refreshSessionIgnores, sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import {
  AI_GATEWAY_MESSAGES_DATASET,
  errMessage,
  filterByWindow,
  projectedExchangeItem,
  resolveWindow,
} from '../../../../src/core/backfill/scan_util.js'
import { GooseSessionsDbError } from './errors.js'
import { GOOSE_CLIENT_NAME, gooseReconcileScope, gooseScopeId, gooseTimestampToIso, projectGooseSession } from './projector.js'
import { openGooseSessionsDb } from './sessions_db.js'
import { isExcluded } from './source.js'
import { capGooseWatermarkSessions, readGooseWatermark, writeGooseWatermark } from './watermark.js'

const PLUGIN_NAME = '@hypaware/goose'
const COMPONENT = 'plugin.goose.backfill'

/**
 * How often the scheduled sweep runs. A code constant, not a key
 * (LLP 0570#config): an in-place edit or a bare truncation the poll cannot
 * see arrives within one interval.
 */
export const GOOSE_SWEEP_CRON = '*/15 * * * *'

/**
 * How long a run waits for a session another writer holds before it gives
 * the session up, as hermes does. A session still busy after the last
 * attempt fails the run once the rest of the import has finished.
 */
export const SCOPE_BUSY_ATTEMPTS = 50
export const SCOPE_BUSY_DELAY_MS = 100

/**
 * Build the goose backfill provider. `holder` is shared with the poll
 * source, so a sweep updates the same in-memory watermark the poll reads
 * instead of racing it through the sidecar.
 *
 * @param {{
 *   sessionsDbPath: string,
 *   stateDir: string,
 *   config?: JsonObject,
 *   ignoredSessions?: Set<string>,
 *   resolver?: UsagePolicyResolver,
 *   localOnlyListPath?: string,
 *   holder?: GooseRunnerHolder,
 * }} opts
 * @returns {BackfillContribution}
 */
export function createGooseBackfillProvider(opts) {
  const policy = readBackfillPolicy({ name: PLUGIN_NAME, config: opts.config })
  return {
    name: GOOSE_CLIENT_NAME,
    plugin: PLUGIN_NAME,
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import local Goose sessions into ai_gateway_messages',
    // @ref LLP 0359#sweep-context [constrained-by]: the sweep runs inside the
    // same window as the join-time import, and not at all when `on_join` is off.
    ...(policy.onJoin !== false ? { sweep: { cron: GOOSE_SWEEP_CRON } } : {}),
    async *run(ctx) {
      // One resolver per run (LLP 0050), so its per-cwd cache lives as long
      // as the scan and a changed `.hypignore` is read on the next run.
      const resolver = opts.resolver ?? createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })
      yield* runGooseBackfill(ctx, opts, resolver)
    },
  }
}

/**
 * @param {BackfillRunContext} ctx
 * @param {Parameters<typeof createGooseBackfillProvider>[0]} opts
 * @param {UsagePolicyResolver} resolver
 * @returns {AsyncGenerator<BackfillItem>}
 */
async function* runGooseBackfill(ctx, opts, resolver) {
  const log = ctx.log
  const window = resolveWindow(ctx)
  // Only a real sweep reads and settles the watermark; the join-time import
  // and a dry run project every session in scope.
  const sweeping = Boolean(ctx.sweep) && !ctx.dryRun

  // @ref LLP 0570#privacy [implements]: refreshed at the start of each run; a
  // load error fails the run closed before anything is projected.
  try { refreshSessionIgnores(opts.ignoredSessions) } catch { /* recorded as loadError */ }
  if (sessionIgnoreLoadError(opts.ignoredSessions)) {
    throw Object.assign(new Error('Goose session exclusions are unreadable'), { error_kind: 'session_ignore_load_failed' })
  }

  log.info('goose.backfill.scan_started', {
    component: COMPONENT,
    operation: 'backfill.scan',
    sweep: sweeping,
    ...(window.sinceMs !== undefined ? { since: new Date(window.sinceMs).toISOString() } : {}),
    ...(window.untilMs !== undefined ? { until: new Date(window.untilMs).toISOString() } : {}),
    status: 'ok',
  })

  // A running poll owns the live path, which a config reload may have moved
  // since activation; the sweep reads the database the poll's watermark names.
  const runner = opts.holder?.runner
  const sessionsDbPath = runner?.sessionsDbPath ?? opts.sessionsDbPath

  let db
  try {
    db = await openGooseSessionsDb(sessionsDbPath)
  } catch (err) {
    if (err instanceof GooseSessionsDbError && err.code === 'missing') {
      // No Goose installation on this machine is nothing to import yet.
      log.info('goose.backfill.no_store', { component: COMPONENT, operation: 'backfill.scan', status: 'skipped' })
      return
    }
    log.warn('goose.backfill.open_failed', {
      component: COMPONENT,
      operation: 'backfill.scan',
      status: 'error',
      error_kind: err instanceof GooseSessionsDbError ? err.code : 'unknown',
      error: errMessage(err),
    })
    throw err
  }

  /** @type {GooseWatermarkState | null} */
  // Shared with the poll when one runs, so both settle one in-memory copy.
  const watermark = !sweeping
    ? null
    : runner
      ? (runner.watermark ?? (runner.watermark = readGooseWatermark(runner.stateDir ?? opts.stateDir)))
      : readGooseWatermark(opts.stateDir)
  let sessionsSeen = 0
  let sessionsSkippedWindow = 0
  let sessionsExcluded = 0
  let sessionsUnchanged = 0
  let sessionsSkipped = 0
  let sessionsSkippedPolicy = 0
  let sessionsBusy = 0
  let sessionsProjected = 0
  let entriesPruned = 0
  let completed = false

  try {
    const sessions = await db.listSessions()
    sessionsSeen = sessions.length
    /** @type {Array<{ session: GooseSessionRow, timestampMs?: number }>} */
    const keyed = sessions.map(session => ({ session, timestampMs: updatedAtMs(session) }))
    const windowed = filterByWindow(keyed, window)
    sessionsSkippedWindow = sessions.length - windowed.length

    for (const { session: listed } of windowed) {
      if (ctx.signal?.aborted) break
      if (isExcluded(opts.ignoredSessions, listed.id)) {
        // Not projected, and its watermark entry does not advance, so the
        // next sweep after `session unignore` recovers a change made meanwhile.
        sessionsExcluded += 1
        continue
      }

      // @ref LLP 0449#read-commit-guard [implements]: the session is re-read
      // under its scope guard, held across the yield so the runner commits
      // this exact view before another writer reads a newer one.
      const release = ctx.dryRun ? () => {} : await claimScope(ctx, gooseReconcileScope(GOOSE_CLIENT_NAME, listed.id))
      if (!release) {
        sessionsBusy += 1
        log.warn('goose.backfill.session_busy', {
          component: COMPONENT,
          operation: 'backfill.project',
          session_id: listed.id,
          status: 'deferred',
          error_kind: 'cache_partition_mutation_busy',
        })
        continue
      }
      try {
        const snapshot = await db.readSessionSnapshot(listed.id)
        if (!snapshot) {
          sessionsSkipped += 1
          continue
        }
        // @ref LLP 0570#reconciliation [implements]: step 4, the sweep digests
        // every session in scope, catching in-place edits and bare truncations.
        const entry = watermark?.sessions[listed.id]
        if (watermark && entry?.digest !== undefined && entry.digest === snapshot.mark.digest) {
          if (entry.updated_at !== snapshot.mark.updated_at || entry.max_id !== snapshot.mark.max_id) watermark.sessions[listed.id] = snapshot.mark
          sessionsUnchanged += 1
          continue
        }
        const item = await projectGooseSession({
          session: snapshot.session,
          messages: snapshot.messages,
          sourcePath: sessionsDbPath,
          clientName: GOOSE_CLIENT_NAME,
          resolver,
          log,
        })
        if (item) {
          sessionsProjected += 1
          log.info('goose.backfill.session_projected', {
            component: COMPONENT,
            operation: 'backfill.project',
            session_id: listed.id,
            message_count: snapshot.messages.length,
            status: 'ok',
          })
        } else {
          // A usage-policy drop, already logged by the projector.
          sessionsSkippedPolicy += 1
        }
        const failedBefore = ctx.itemsFailed ?? 0
        // @ref LLP 0570#privacy [implements]: an ignored session reconciles to
        // an empty snapshot, as the poll does, removing rows captured before.
        yield item ?? emptySessionItem(listed.id, sessionsDbPath)
        // The runner writes the item before resuming; a moved failure count
        // means its rows did not land, so the entry stays and the next sweep retries.
        if (watermark && (ctx.itemsFailed ?? 0) === failedBefore && !ctx.signal?.aborted) {
          watermark.sessions[listed.id] = snapshot.mark
        }
      } finally {
        release()
      }
    }

    if (watermark && !ctx.signal?.aborted) {
      // @ref LLP 0570#reconciliation [implements]: the watermark keeps entries
      // only for sessions in the sweep's scope; deleted and out-of-window ones go.
      const inScope = new Set(windowed.map(({ session }) => session.id))
      for (const id of Object.keys(watermark.sessions)) {
        if (inScope.has(id)) continue
        delete watermark.sessions[id]
        entriesPruned += 1
      }
      capGooseWatermarkSessions(watermark.sessions)
    }
    completed = true
  } finally {
    db.close()
  }

  // A reload that swapped the poll's database mid-run left this watermark
  // behind: its cursors name the old store, so it is not written back.
  const stale = runner !== undefined && runner.watermark !== watermark
  if (watermark && completed && !ctx.signal?.aborted && !stale) writeGooseWatermark(runner?.stateDir ?? opts.stateDir, watermark)

  log.info('goose.backfill.scan_complete', {
    component: COMPONENT,
    operation: 'backfill.scan',
    sweep: sweeping,
    sessions_seen: sessionsSeen,
    sessions_skipped_window: sessionsSkippedWindow,
    sessions_excluded: sessionsExcluded,
    sessions_unchanged: sessionsUnchanged,
    sessions_skipped: sessionsSkipped,
    sessions_skipped_policy: sessionsSkippedPolicy,
    sessions_busy: sessionsBusy,
    sessions_projected: sessionsProjected,
    entries_pruned: entriesPruned,
    status: sessionsBusy ? 'partial' : 'ok',
  })

  if (sessionsBusy) {
    throw Object.assign(
      new Error(`${sessionsBusy} goose session(s) stayed busy in the cache; rerun the backfill to import them`),
      { error_kind: 'cache_partition_mutation_busy' })
  }
}

/**
 * Claim one session's reconcile scope, retrying a busy one a bounded number
 * of times. Resolves null when it is still busy after the last attempt.
 * Storage without the guard (a test double) yields a no-op release.
 *
 * @param {BackfillRunContext} ctx
 * @param {Record<string, string>} where
 * @returns {Promise<(() => void) | null>}
 */
async function claimScope(ctx, where) {
  for (let attempt = 1; ; attempt++) {
    try {
      return ctx.storage.claimReconcileScope?.(AI_GATEWAY_MESSAGES_DATASET, where) ?? (() => {})
    } catch (err) {
      if (!isPartitionMutationBusy(err)) throw err
      if (attempt >= SCOPE_BUSY_ATTEMPTS || ctx.signal?.aborted) return null
      await new Promise(resolve => setTimeout(resolve, SCOPE_BUSY_DELAY_MS))
    }
  }
}

/**
 * The item that reconciles a usage-policy-ignored session's scope to no
 * rows. It carries ids only, never the session's content or directory.
 *
 * @param {string} sessionId
 * @param {string} sourcePath
 * @returns {BackfillItem}
 */
function emptySessionItem(sessionId, sourcePath) {
  /** @type {AiGatewayProjectedExchange} */
  const exchange = {
    provider: 'unknown',
    session_id: gooseScopeId(sessionId),
    conversation_source: GOOSE_CLIENT_NAME,
    client_name: GOOSE_CLIENT_NAME,
    messages: [],
  }
  const item = projectedExchangeItem(exchange, {
    client_name: GOOSE_CLIENT_NAME,
    native_id: sessionId,
    source_path: sourcePath,
  })
  item.reconcile = { where: gooseReconcileScope(GOOSE_CLIENT_NAME, sessionId), key: 'part_id' }
  return item
}

/**
 * A session's window key: its `updated_at` (SQLite UTC text) as epoch
 * millis. An unparseable value is treated as absent, which `filterByWindow`
 * keeps rather than drops.
 *
 * @param {GooseSessionRow} session
 * @returns {number | undefined}
 */
function updatedAtMs(session) {
  const ms = Date.parse(gooseTimestampToIso(session.updated_at) ?? '')
  return Number.isFinite(ms) ? ms : undefined
}
