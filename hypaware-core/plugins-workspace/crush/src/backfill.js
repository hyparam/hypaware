// @ts-check

/**
 * `@hypaware/crush` backfill provider: imports local Crush history into
 * `ai_gateway_messages` from every discovered project `crush.db`
 * (LLP 0573).
 *
 * It reuses the T1 discovery, the T3 reader and projector and the T4
 * watermark, so backfilled and polled rows converge for the same session
 * (`client_name = 'crush'`). One item per session keeps the whole-session
 * invariant, and each item reconciles the session's scope, so a re-run
 * replaces rather than appends.
 *
 * @ref LLP 0573#backfill [implements]: scope is every non-title session in
 *   every database in the set whose `updated_at` falls in the window, or
 *   every non-title session when unset; one database open at a time.
 *
 * @import { AiGatewayProjectedExchange, BackfillContribution, BackfillItem, BackfillRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 * @import { CrushBackfillOptions, CrushDatabase, CrushSessionRow, CrushWatermarkState } from './types.js'
 * @import { CrushDb } from './crush_db.js'
 */

import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { isPartitionMutationBusy } from '../../../../src/core/util/mutation_guard.js'
import { readBackfillPolicy } from '../../../../src/core/config/backfill_policy.js'
import { refreshSessionIgnores, sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import {
  AI_GATEWAY_MESSAGES_DATASET,
  filterByWindow,
  projectedExchangeItem,
  resolveWindow,
} from '../../../../src/core/backfill/scan_util.js'
import { openCrushDb } from './crush_db.js'
import { createDiscoveryState, discoverDatabases } from './discovery.js'
import { CrushDbError } from './errors.js'
import { deriveRepoFromCwd } from './git_repo.js'
import { CRUSH_CLIENT_NAME, crushReconcileScope, crushScopeId, projectCrushSession } from './projector.js'
import { isExcluded } from './source.js'
import {
  capCrushWatermarkSessions,
  dropCrushWatermarkSession,
  pruneCrushWatermark,
  readCrushWatermark,
  writeCrushWatermark,
} from './watermark.js'

const PLUGIN_NAME = '@hypaware/crush'
const COMPONENT = 'plugin.crush.backfill'

/**
 * How often the scheduled sweep runs. A code constant, not a key
 * (LLP 0573#config): an in-place edit outside streaming arrives within one
 * interval.
 */
export const CRUSH_SWEEP_CRON = '*/15 * * * *'

/**
 * How long a run waits for a session another writer holds before it gives
 * the session up, as goose does. A session still busy after the last
 * attempt fails the run once the rest of the import has finished.
 */
export const SCOPE_BUSY_ATTEMPTS = 50
export const SCOPE_BUSY_DELAY_MS = 100

/**
 * Build the crush backfill provider. `holder` is shared with the poll
 * source, so a sweep updates the same in-memory watermark the poll reads
 * instead of racing it through the sidecar.
 *
 * @param {CrushBackfillOptions} opts
 * @returns {BackfillContribution}
 */
export function createCrushBackfillProvider(opts) {
  const policy = readBackfillPolicy({ name: PLUGIN_NAME, config: opts.config })
  return {
    name: CRUSH_CLIENT_NAME,
    plugin: PLUGIN_NAME,
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import local Crush sessions into ai_gateway_messages',
    // @ref LLP 0359#sweep-context [constrained-by]: the sweep runs inside the
    // same window as the join-time import, and not at all when `on_join` is off.
    ...(policy.onJoin !== false ? { sweep: { cron: CRUSH_SWEEP_CRON } } : {}),
    async *run(ctx) {
      // One resolver per run (LLP 0050), so its per-cwd cache lives as long
      // as the scan and a changed `.hypignore` is read on the next run.
      const resolver = opts.resolver ?? createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })
      yield* runCrushBackfill(ctx, opts, resolver)
    },
  }
}

/**
 * @param {BackfillRunContext} ctx
 * @param {CrushBackfillOptions} opts
 * @param {UsagePolicyResolver} resolver
 * @returns {AsyncGenerator<BackfillItem>}
 */
async function* runCrushBackfill(ctx, opts, resolver) {
  const log = ctx.log
  const window = resolveWindow(ctx)
  // Only a real sweep reads and settles the watermark; the join-time import
  // and a dry run project every session in scope.
  const sweeping = Boolean(ctx.sweep) && !ctx.dryRun

  // @ref LLP 0573#privacy [implements]: refreshed at the start of each run; a
  // load error fails the run closed before anything is projected.
  try { refreshSessionIgnores(opts.ignoredSessions) } catch { /* recorded as loadError */ }
  if (sessionIgnoreLoadError(opts.ignoredSessions)) {
    throw Object.assign(new Error('Crush session exclusions are unreadable'), { error_kind: 'session_ignore_load_failed' })
  }

  log.info('crush.backfill.scan_started', {
    component: COMPONENT,
    operation: 'backfill.scan',
    sweep: sweeping,
    ...(window.sinceMs !== undefined ? { since: new Date(window.sinceMs).toISOString() } : {}),
    ...(window.untilMs !== undefined ? { until: new Date(window.untilMs).toISOString() } : {}),
    status: 'ok',
  })

  // A running poll owns the live paths, which a config reload may have moved
  // since activation; the sweep reads the set the poll's watermark names.
  const runner = opts.holder?.runner
  const indexPath = runner?.indexPath ?? opts.indexPath
  const dataDirs = runner?.dataDirs ?? opts.dataDirs
  const stateDir = runner?.stateDir ?? opts.stateDir
  // A fresh discovery state: the run reads the index whatever the poll last saw.
  const discovery = discoverDatabases(createDiscoveryState(), { indexPath, dataDirs })
  if (discovery.databases.length === 0 && !discovery.indexPresent) {
    // No Crush installation on this machine is nothing to import yet.
    log.info('crush.backfill.no_store', { component: COMPONENT, operation: 'backfill.scan', status: 'skipped' })
    return
  }

  /** @type {CrushWatermarkState | null} */
  // Shared with the poll when one runs, so both settle one in-memory copy.
  const watermark = !sweeping
    ? null
    : runner
      ? (runner.watermark ?? (runner.watermark = readCrushWatermark(stateDir)))
      : readCrushWatermark(stateDir)
  // Read-only view for ownership and ignore-policy emptying outside a sweep.
  const known = watermark ?? runner?.watermark ?? readCrushWatermark(stateDir)

  /** @type {Map<string, Promise<{ git_remote?: string, repo_root?: string }>>} */
  const repoCache = new Map()
  const deriveRepo = (/** @type {string | undefined} */ cwd) => {
    const key = cwd ?? ''
    let derived = repoCache.get(key)
    if (!derived) {
      derived = deriveRepoFromCwd(cwd)
      repoCache.set(key, derived)
    }
    return derived
  }
  const discovered = new Set(discovery.databases.map(db => db.dbPath))
  /** @type {Map<string, string>} session id to the database that claimed it this run */
  const owner = new Map()
  const nowSecond = () => Math.floor(Date.now() / 1000)

  let sessionsSeen = 0
  let sessionsSkippedWindow = 0
  let sessionsExcluded = 0
  let sessionsUnchanged = 0
  let sessionsSkipped = 0
  let sessionsSkippedPolicy = 0
  let sessionsBusy = 0
  let sessionsProjected = 0
  let sessionsCollision = 0
  let entriesPruned = 0
  let dbsIgnored = 0
  let dbsFailed = 0
  /** @type {string | undefined} */
  let firstFailedKind
  let completed = false

  /**
   * @param {string} id
   * @param {string} dbPath
   * @returns {AsyncGenerator<BackfillItem>}
   */
  async function* emptySession(id, dbPath) {
    const release = ctx.dryRun ? () => {} : await claimScope(ctx, crushReconcileScope(CRUSH_CLIENT_NAME, id))
    if (!release) {
      sessionsBusy += 1
      warnBusy(id)
      return
    }
    try {
      const failedBefore = ctx.itemsFailed ?? 0
      yield emptySessionItem(id, dbPath)
      if (watermark && (ctx.itemsFailed ?? 0) === failedBefore && !ctx.signal?.aborted) {
        dropCrushWatermarkSession(watermark, id)
        entriesPruned += 1
      }
    } finally {
      release()
    }
  }

  /** @param {string} id */
  function warnBusy(id) {
    log.warn('crush.backfill.session_busy', {
      component: COMPONENT,
      operation: 'backfill.project',
      session_id: id,
      status: 'deferred',
      error_kind: 'cache_partition_mutation_busy',
    })
  }

  for (const db of discovery.databases) {
    if (ctx.signal?.aborted) break

    // @ref LLP 0573#privacy [implements]: an ignore-policy project's database
    // is never opened; the sessions captured from it before are reconciled
    // to empty snapshots and their entries dropped.
    if (resolver.resolve(db.projectDir).class === 'ignore') {
      dbsIgnored += 1
      for (const [id, entry] of Object.entries(known.sessions)) {
        if (ctx.signal?.aborted) break
        if (entry.db !== db.dbPath) continue
        yield* emptySession(id, db.dbPath)
      }
      continue
    }

    /** @type {CrushDb | null} */
    let handle = null
    try {
      handle = openCrushDb(db.dbPath)
      const sessions = await handle.listSessions()
      sessionsSeen += sessions.length
      /** @type {Array<{ session: CrushSessionRow, timestampMs?: number }>} */
      const keyed = sessions.map(session => ({ session, timestampMs: session.updated_at * 1000 }))
      const windowed = filterByWindow(keyed, window)
      sessionsSkippedWindow += sessions.length - windowed.length
      /** @type {Set<string>} */
      const inScope = new Set()

      for (const { session: listed } of windowed) {
        if (ctx.signal?.aborted) break
        const id = listed.id
        const entry = known.sessions[id]
        const claimed = owner.get(id)
        // The database that recorded a session id first owns it, as the poll rules.
        if ((entry && entry.db !== db.dbPath && discovered.has(entry.db))
          || (claimed !== undefined && claimed !== db.dbPath)) {
          sessionsCollision += 1
          continue
        }
        owner.set(id, db.dbPath)
        inScope.add(id)
        if (isExcluded(opts.ignoredSessions, crushScopeId(id))) {
          // Not projected, and its watermark entry does not advance, so the
          // next sweep after `session unignore` recovers a change made meanwhile.
          sessionsExcluded += 1
          continue
        }

        // @ref LLP 0449#read-commit-guard [implements]: the session is re-read
        // under its scope guard, held across the yield so the runner commits
        // this exact view before another writer reads a newer one.
        const release = ctx.dryRun ? () => {} : await claimScope(ctx, crushReconcileScope(CRUSH_CLIENT_NAME, id))
        if (!release) {
          sessionsBusy += 1
          warnBusy(id)
          continue
        }
        try {
          const snapshot = await handle.readSessionSnapshot(id)
          if (!snapshot) {
            sessionsSkipped += 1
            inScope.delete(id)
            continue
          }
          const mark = { db: db.dbPath, ...snapshot.mark }
          // @ref LLP 0573#reconciliation [implements]: step 6, the sweep digests
          // every session in scope; a digest-equal result also clears `open`.
          if (watermark && entry?.digest !== undefined && entry.digest === snapshot.mark.digest) {
            watermark.sessions[id] = mark
            sessionsUnchanged += 1
            continue
          }
          const item = await projectCrushSession({
            session: snapshot.session,
            messages: snapshot.messages,
            projectDir: db.projectDir,
            sourcePath: db.dbPath,
            clientName: CRUSH_CLIENT_NAME,
            deriveRepo,
            resolver,
            log,
          })
          if (item) {
            sessionsProjected += 1
            log.info('crush.backfill.session_projected', {
              component: COMPONENT,
              operation: 'backfill.project',
              session_id: id,
              message_count: snapshot.messages.length,
              status: 'ok',
            })
          } else {
            // A usage-policy drop, already logged by the projector.
            sessionsSkippedPolicy += 1
          }
          const failedBefore = ctx.itemsFailed ?? 0
          // @ref LLP 0573#privacy [implements]: an ignored session reconciles to
          // an empty snapshot, as the poll does, removing rows captured before.
          yield item ?? emptySessionItem(id, db.dbPath)
          // The runner writes the item before resuming; a moved failure count
          // means its rows did not land, so the entry stays and the next sweep retries.
          if (watermark && (ctx.itemsFailed ?? 0) === failedBefore && !ctx.signal?.aborted) {
            watermark.sessions[id] = mark
            // Recorded in the second it carries: the poll hashes it again, as
            // it does its own same-second entries.
            if (runner && mark.updated_at >= nowSecond()) (runner.unsettled ?? (runner.unsettled = new Set())).add(id)
          }
        } finally {
          release()
        }
      }

      if (watermark && !ctx.signal?.aborted) {
        // @ref LLP 0573#reconciliation [implements]: entries exist only for
        // sessions in the sweep's scope; deleted and out-of-window ones go,
        // raising the database's floor.
        entriesPruned += pruneCrushWatermark(watermark, db.dbPath, inScope)
      }
    } catch (err) {
      if (!(err instanceof CrushDbError)) throw err
      if (err.code === 'missing') continue
      // @ref LLP 0573#privacy [implements]: logged by kind only; the reader's
      // error message names the database path.
      log.warn('crush.backfill.open_failed', {
        component: COMPONENT,
        operation: 'backfill.scan',
        status: 'error',
        error_kind: err.code,
      })
      if (err.code === 'sqlite_unavailable') throw err
      // The database's entries stay, so a later sweep that can read it settles them.
      dbsFailed += 1
      firstFailedKind ??= err.code
    } finally {
      handle?.close()
    }
  }

  // A database left out of a partial discovery is not known to be gone.
  const setComplete = !discovery.indexUnreadable && discovery.overCap === 0
  if (watermark && !ctx.signal?.aborted) {
    if (setComplete) {
      // Databases no longer in the set: their entries and cursors go. One that
      // returns is baselined by the poll and its history imported here.
      for (const [id, entry] of Object.entries(watermark.sessions)) {
        if (discovered.has(entry.db)) continue
        delete watermark.sessions[id]
        entriesPruned += 1
      }
      for (const dbPath of Object.keys(watermark.dbs)) if (!discovered.has(dbPath)) delete watermark.dbs[dbPath]
    }
    capCrushWatermarkSessions(watermark)
  }
  completed = !ctx.signal?.aborted

  // A reload that replaced the poll's watermark mid-run left this one
  // behind, so it is not written back.
  const stale = runner !== undefined && runner.watermark !== watermark
  if (watermark && completed && !stale) writeCrushWatermark(stateDir, watermark)

  log.info('crush.backfill.scan_complete', {
    component: COMPONENT,
    operation: 'backfill.scan',
    sweep: sweeping,
    dbs: discovery.databases.length,
    dbs_ignored: dbsIgnored,
    dbs_failed: dbsFailed,
    sessions_seen: sessionsSeen,
    sessions_skipped_window: sessionsSkippedWindow,
    sessions_excluded: sessionsExcluded,
    sessions_unchanged: sessionsUnchanged,
    sessions_skipped: sessionsSkipped,
    sessions_skipped_policy: sessionsSkippedPolicy,
    sessions_collision: sessionsCollision,
    sessions_busy: sessionsBusy,
    sessions_projected: sessionsProjected,
    entries_pruned: entriesPruned,
    status: sessionsBusy || dbsFailed ? 'partial' : 'ok',
  })

  if (sessionsBusy) {
    throw Object.assign(
      new Error(`${sessionsBusy} crush session(s) stayed busy in the cache; rerun the backfill to import them`),
      { error_kind: 'cache_partition_mutation_busy' })
  }
  if (dbsFailed) {
    // The kernel logs a provider's error message, so it names no path.
    throw new CrushDbError(`${dbsFailed} crush database(s) could not be read; see hyp status`,
      { code: /** @type {CrushDbError['code']} */ (firstFailedKind) })
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
 * The item that reconciles an ignored session's scope to no rows. It
 * carries ids only, never the session's content or directory.
 *
 * @param {string} sessionId
 * @param {string} sourcePath
 * @returns {BackfillItem}
 */
function emptySessionItem(sessionId, sourcePath) {
  /** @type {AiGatewayProjectedExchange} */
  const exchange = {
    provider: 'unknown',
    session_id: crushScopeId(sessionId),
    conversation_source: CRUSH_CLIENT_NAME,
    client_name: CRUSH_CLIENT_NAME,
    messages: [],
  }
  const item = projectedExchangeItem(exchange, {
    client_name: CRUSH_CLIENT_NAME,
    native_id: sessionId,
    source_path: sourcePath,
  })
  item.reconcile = { where: crushReconcileScope(CRUSH_CLIENT_NAME, sessionId), key: 'part_id' }
  return item
}
