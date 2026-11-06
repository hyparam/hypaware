// @ts-check

/**
 * `@hypaware/mastracode` backfill provider: imports local Mastra Code history
 * into `ai_gateway_messages` from Mastra Code's own `mastra.db` (LLP 0586).
 *
 * It reuses the T3 reader and projector, so backfilled and polled rows
 * converge for the same thread (`client_name = 'mastracode'`). One item per
 * thread keeps the whole-thread invariant: each item reconciles the thread's
 * scope, so a re-run replaces rather than appends.
 *
 * @ref LLP 0586#backfill [implements]: scope is the threads whose `updatedAt`
 *   falls in the window, or every thread when unset, read one at a time on
 *   one connection.
 *
 * @import { AiGatewayProjectedExchange, BackfillContribution, BackfillItem, BackfillRunContext, JsonObject } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 * @import { MastraDbLocation, MastraRunnerHolder, MastraSkipCounts, MastraThreadWatermark, MastraWatermarkState } from './types.js'
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
import { deriveRepoFromCwd } from './git_repo.js'
import { MastraDbError } from './errors.js'
import { openMastraDb } from './mastra_db.js'
import { MASTRACODE_CLIENT_NAME, mastracodeReconcileScope, mastracodeScopeId, projectMastracodeThread } from './projector.js'
import { isExcluded } from './source.js'
import { pruneMastraWatermark, readMastraWatermark, writeMastraWatermark } from './watermark.js'

const PLUGIN_NAME = '@hypaware/mastracode'
const COMPONENT = 'plugin.mastracode.backfill'

/**
 * How often the scheduled sweep runs. A code constant, not a key
 * (LLP 0586#config): an in-place edit the poll cannot see arrives within one
 * interval.
 */
export const MASTRACODE_SWEEP_CRON = '*/15 * * * *'

/**
 * How long a run waits for a thread another writer holds before it gives
 * the thread up, as goose does. A thread still busy after the last attempt
 * fails the run once the rest of the import has finished.
 */
export const SCOPE_BUSY_ATTEMPTS = 50
export const SCOPE_BUSY_DELAY_MS = 100

/**
 * Build the mastracode backfill provider. `holder` is shared with the poll
 * source, so a sweep updates the same in-memory watermark the poll reads
 * instead of racing it through the sidecar.
 *
 * @param {{
 *   location: MastraDbLocation,
 *   stateDir: string,
 *   config?: JsonObject,
 *   ignoredSessions?: Set<string>,
 *   resolver?: UsagePolicyResolver,
 *   localOnlyListPath?: string,
 *   holder?: MastraRunnerHolder,
 * }} opts
 * @returns {BackfillContribution}
 */
export function createMastracodeBackfillProvider(opts) {
  const policy = readBackfillPolicy({ name: PLUGIN_NAME, config: opts.config })
  return {
    name: MASTRACODE_CLIENT_NAME,
    plugin: PLUGIN_NAME,
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import local Mastra Code threads into ai_gateway_messages',
    // @ref LLP 0359#sweep-context [constrained-by]: the sweep runs inside the
    // same window as the join-time import, and not at all when `on_join` is off.
    ...(policy.onJoin !== false ? { sweep: { cron: MASTRACODE_SWEEP_CRON } } : {}),
    async *run(ctx) {
      // One resolver per run (LLP 0050), so its per-cwd cache lives as long
      // as the scan and a changed `.hypignore` is read on the next run.
      const resolver = opts.resolver ?? createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })
      yield* runMastracodeBackfill(ctx, opts, resolver)
    },
  }
}

/**
 * @param {BackfillRunContext} ctx
 * @param {Parameters<typeof createMastracodeBackfillProvider>[0]} opts
 * @param {UsagePolicyResolver} resolver
 * @returns {AsyncGenerator<BackfillItem>}
 */
async function* runMastracodeBackfill(ctx, opts, resolver) {
  const log = ctx.log
  const window = resolveWindow(ctx)
  // Only a real sweep reads and settles the watermark; the join-time import
  // and a dry run project every thread in scope.
  const sweeping = Boolean(ctx.sweep) && !ctx.dryRun

  // @ref LLP 0586#privacy [implements]: refreshed at the start of each run; a
  // load error fails the run closed before anything is projected.
  try { refreshSessionIgnores(opts.ignoredSessions) } catch { /* recorded as loadError */ }
  if (sessionIgnoreLoadError(opts.ignoredSessions)) {
    throw Object.assign(new Error('Mastra Code session exclusions are unreadable'), { error_kind: 'session_ignore_load_failed' })
  }

  log.info('mastracode.backfill.scan_started', {
    component: COMPONENT,
    operation: 'backfill.scan',
    sweep: sweeping,
    ...(window.sinceMs !== undefined ? { since: new Date(window.sinceMs).toISOString() } : {}),
    ...(window.untilMs !== undefined ? { until: new Date(window.untilMs).toISOString() } : {}),
    status: 'ok',
  })

  // A running poll owns the live location, which a config reload may have
  // moved since activation.
  const runner = opts.holder?.runner
  const location = runner?.location ?? opts.location
  if (location.kind === 'remote') {
    // @ref LLP 0586#config [implements]: MASTRA_DB_URL names a remote store,
    // which is not read even when a local file exists.
    log.info('mastracode.backfill.remote_store', {
      component: COMPONENT,
      operation: 'backfill.scan',
      status: 'skipped',
      error_kind: 'remote_store_unsupported',
    })
    // The poll's status already says so; a scheduled sweep stays quiet.
    if (ctx.sweep) return
    throw new MastraDbError('MASTRA_DB_URL is set; remote stores are not supported', { code: 'remote_store_unsupported' })
  }
  const dbPath = location.path

  let db
  try {
    db = openMastraDb(dbPath)
  } catch (err) {
    if (err instanceof MastraDbError && err.code === 'missing') {
      // No Mastra Code installation on this machine is nothing to import yet.
      log.info('mastracode.backfill.no_store', { component: COMPONENT, operation: 'backfill.scan', status: 'skipped' })
      return
    }
    const kind = err instanceof MastraDbError ? err.code : 'open_failed'
    // @ref LLP 0586#privacy [implements]: logged by kind only, and the
    // reader's errors are path-free, so the kernel's provider_error log
    // names no path either.
    log.warn('mastracode.backfill.open_failed', {
      component: COMPONENT,
      operation: 'backfill.scan',
      status: 'error',
      error_kind: kind,
    })
    throw err
  }

  /** @type {MastraWatermarkState | null} */
  // Shared with the poll when one runs, so both settle one in-memory copy.
  const watermark = !sweeping
    ? null
    : runner
      ? (runner.watermark ?? (runner.watermark = readMastraWatermark(runner.stateDir)))
      : readMastraWatermark(opts.stateDir)
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
  /** @type {MastraSkipCounts} */
  const skipped = {}
  let threadsSeen = 0
  let threadsSkippedWindow = 0
  let threadsExcluded = 0
  let threadsUnchanged = 0
  let threadsSkipped = 0
  let threadsSkippedPolicy = 0
  let threadsBusy = 0
  let threadsProjected = 0
  let entriesPruned = 0
  let completed = false

  try {
    if (watermark && watermark.db?.path !== dbPath) {
      // No watermark describes this database yet: record the poll's
      // first-start baseline before reading, so the entries this sweep
      // settles persist and the next sweep skips what it finds unchanged.
      const maxima = await db.maxima()
      watermark.db = { path: dbPath, stat_sig: null, max_rowid: maxima.maxRowid, floor: maxima.maxUpdatedAt }
      watermark.threads = {}
    }
    const threads = await db.listThreads()
    threadsSeen = threads.length
    /** @type {Array<{ thread: { id: string, updatedAt: string }, timestampMs?: number }>} */
    const keyed = threads.map(thread => ({ thread, timestampMs: updatedAtMs(thread.updatedAt) }))
    const windowed = filterByWindow(keyed, window)
    threadsSkippedWindow = threads.length - windowed.length

    for (const { thread: listed } of windowed) {
      if (ctx.signal?.aborted) break
      if (isExcluded(opts.ignoredSessions, mastracodeScopeId(listed.id))) {
        // Not projected, and its watermark entry does not advance, so the
        // next sweep after `session unignore` recovers a change made meanwhile.
        threadsExcluded += 1
        continue
      }

      // @ref LLP 0449#read-commit-guard [implements]: the thread is re-read
      // under its scope guard, held across the yield so the runner commits
      // this exact view before another writer reads a newer one.
      const release = ctx.dryRun ? () => {} : await claimScope(ctx, mastracodeReconcileScope(MASTRACODE_CLIENT_NAME, listed.id))
      if (!release) {
        threadsBusy += 1
        log.warn('mastracode.backfill.thread_busy', {
          component: COMPONENT,
          operation: 'backfill.project',
          session_id: listed.id,
          status: 'deferred',
          error_kind: 'cache_partition_mutation_busy',
        })
        continue
      }
      try {
        const snapshot = await db.readThreadSnapshot(listed.id)
        if (!snapshot) {
          threadsSkipped += 1
          continue
        }
        // @ref LLP 0586#reconciliation [implements]: step 6, the sweep digests
        // every thread in scope and catches an in-place edit the poll missed.
        const entry = watermark?.threads[listed.id]
        if (watermark && entry?.digest !== undefined && entry.digest === snapshot.mark.digest) {
          watermark.threads[listed.id] = { ...snapshot.mark, open: false }
          threadsUnchanged += 1
          continue
        }
        // `open` as the poll records it: the digest moved since the entry.
        // A thread the sweep is first to record is history, not one being
        // written; a live one also has new rows, which make it a poll
        // candidate without the flag.
        /** @type {MastraThreadWatermark} */
        const mark = { ...snapshot.mark, open: entry !== undefined }
        const item = await projectMastracodeThread({
          thread: snapshot.thread,
          messages: snapshot.messages,
          sourcePath: dbPath,
          clientName: MASTRACODE_CLIENT_NAME,
          deriveRepo,
          resolver,
          log,
          skipped,
        })
        if (item) {
          threadsProjected += 1
          log.info('mastracode.backfill.thread_projected', {
            component: COMPONENT,
            operation: 'backfill.project',
            session_id: listed.id,
            message_count: snapshot.messages.length,
            status: 'ok',
          })
        } else {
          // A usage-policy drop, already logged by the projector.
          threadsSkippedPolicy += 1
        }
        const failedBefore = ctx.itemsFailed ?? 0
        // @ref LLP 0586#privacy [implements]: an ignored thread reconciles to
        // an empty snapshot, as the poll does, removing rows captured before.
        yield item ?? emptyThreadItem(listed.id, dbPath)
        // The runner writes the item before resuming; a moved failure count
        // means its rows did not land, so the entry stays and the next sweep retries.
        if (watermark && watermark.db?.path === dbPath && (ctx.itemsFailed ?? 0) === failedBefore && !ctx.signal?.aborted) {
          watermark.threads[listed.id] = mark
        }
      } finally {
        release()
      }
    }

    if (watermark && !ctx.signal?.aborted) {
      // @ref LLP 0586#prune [implements]: entries exist only for threads in
      // the sweep's scope. A thread deleted upstream or outside the window
      // loses only its entry, which raises the floor; its cached rows stay.
      entriesPruned = pruneMastraWatermark(watermark, new Set(windowed.map(({ thread }) => thread.id)))
    }
    completed = true
  } finally {
    db.close()
  }

  // A reload that moved the poll to another database mid-run left this
  // watermark describing the old one, so it is not written back.
  const stale = watermark !== null && (watermark.db?.path !== dbPath || (runner !== undefined && runner.watermark !== watermark))
  if (watermark && completed && !ctx.signal?.aborted && !stale) writeMastraWatermark(runner?.stateDir ?? opts.stateDir, watermark)
  if (runner && watermark && !stale) runner.threadsTracked = Object.keys(watermark.threads).length

  log.info('mastracode.backfill.scan_complete', {
    component: COMPONENT,
    operation: 'backfill.scan',
    sweep: sweeping,
    threads_seen: threadsSeen,
    threads_skipped_window: threadsSkippedWindow,
    threads_excluded: threadsExcluded,
    threads_unchanged: threadsUnchanged,
    threads_skipped: threadsSkipped,
    threads_skipped_policy: threadsSkippedPolicy,
    threads_busy: threadsBusy,
    threads_projected: threadsProjected,
    parts_skipped: Object.values(skipped).reduce((sum, n) => sum + (n ?? 0), 0),
    entries_pruned: entriesPruned,
    status: threadsBusy ? 'partial' : 'ok',
  })

  if (threadsBusy) {
    throw Object.assign(
      new Error(`${threadsBusy} Mastra Code thread(s) stayed busy in the cache; rerun the backfill to import them`),
      { error_kind: 'cache_partition_mutation_busy' })
  }
}

/**
 * Claim one thread's reconcile scope, retrying a busy one a bounded number
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
 * The item that reconciles a usage-policy-ignored thread's scope to no
 * rows. It carries ids only, never the thread's content or directory.
 *
 * @param {string} threadId
 * @param {string} sourcePath
 * @returns {BackfillItem}
 */
function emptyThreadItem(threadId, sourcePath) {
  /** @type {AiGatewayProjectedExchange} */
  const exchange = {
    provider: 'unknown',
    session_id: mastracodeScopeId(threadId),
    conversation_source: MASTRACODE_CLIENT_NAME,
    client_name: MASTRACODE_CLIENT_NAME,
    messages: [],
  }
  const item = projectedExchangeItem(exchange, {
    client_name: MASTRACODE_CLIENT_NAME,
    native_id: threadId,
    source_path: sourcePath,
  })
  item.reconcile = { where: mastracodeReconcileScope(MASTRACODE_CLIENT_NAME, threadId), key: 'part_id' }
  return item
}

/**
 * A thread's window key: its ISO `updatedAt` as epoch millis. An
 * unparseable value is treated as absent, which `filterByWindow` keeps
 * rather than drops.
 *
 * @param {string} updatedAt
 * @returns {number | undefined}
 */
function updatedAtMs(updatedAt) {
  const ms = Date.parse(updatedAt)
  return Number.isFinite(ms) ? ms : undefined
}
