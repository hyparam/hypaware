// @ts-check

/**
 * The `mastracode` source: polls Mastra Code's `mastra.db` and reconciles
 * each changed thread into `ai_gateway_messages` through the shared
 * projected-exchange materializer. One poll tick is one budgeted batch: at
 * most `MASTRACODE_THREADS_PER_TICK` threads and about
 * `MASTRACODE_ROWS_PER_TICK` rows, one cache commit, one watermark flush.
 *
 * @ref LLP 0586#source [implements]: one short-lived connection per tick,
 *   opened only when the stat signature moved, closed before the tick ends.
 * @ref LLP 0586#reconciliation [implements]: cursor, floor and signature for
 *   the database, a digest per thread; nothing advances past an uncommitted
 *   thread.
 *
 * @import { BackfillItem, PluginActivationContext, SourceStatus, StartedSource } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { MastraBatchEntry, MastraDbLocation, MastraDbWatermark, MastraPollRunner, MastraRunnerHolder, MastraSkipCounts, MastraThreadWatermark } from './types.js'
 * @import { MastraDb } from './mastra_db.js'
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { isPartitionMutationBusy } from '../../../../src/core/util/mutation_guard.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { createUsagePolicyResolver, localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { AI_GATEWAY_MESSAGES_DATASET, PROJECTED_EXCHANGE_KIND } from '../../../../src/core/backfill/scan_util.js'
import { markerName, refreshSessionIgnores, sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import { compareStrings } from '../../../../src/core/util/compare_strings.js'
import {
  resolveHomeDir,
  resolveMastraDbLocation,
  resolveMastracodeEnabled,
  resolvePollIntervalMs,
} from './config.js'
import { openMastraDb } from './mastra_db.js'
import { MastraDbError } from './errors.js'
import { deriveRepoFromCwd } from './git_repo.js'
import { MASTRACODE_CLIENT_NAME, mastracodeReconcileScope, mastracodeScopeId, projectMastracodeThread } from './projector.js'
import { compareUpdatedAt, dropMastraWatermarkThread, readMastraWatermark, writeMastraWatermark } from './watermark.js'

const PLUGIN_NAME = '@hypaware/mastracode'

/**
 * Threads admitted to one tick's batch.
 *
 * @ref LLP 0527#tick-budget [implements]: start commits at most one batch
 *   whatever the change volume.
 */
export const MASTRACODE_THREADS_PER_TICK = 64

/**
 * Rows admitted to one tick's batch. A thread is projected whole, so the
 * last one admitted can carry the batch past this. The first thread is
 * always admitted.
 */
export const MASTRACODE_ROWS_PER_TICK = 4096

export const MASTRACODE_CATCH_UP_DELAY_MS = 1000

export const IGNORE_LOAD_FAILED = 'session_ignore_load_failed'

class MastracodeSessionIgnoreError extends Error {}

/**
 * `SourceContribution.start` for the `mastracode` source. Awaits one bounded
 * tick, then polls on the configured interval.
 *
 * @param {PluginActivationContext} ctx
 * @param {{ ignoredSessions?: Set<string>, holder?: MastraRunnerHolder }} [opts]
 * @returns {Promise<StartedSource>}
 */
export async function startMastracodeSource(ctx, opts = {}) {
  // @ref LLP 0586#config [implements]: `enabled = false` turns ongoing
  // capture off; the source still registers, so status says why nothing is
  // captured. Registration lives in activation and the daemon is the only
  // starter (issue #348).
  if (!resolveMastracodeEnabled(ctx.config)) return createDisabledSource(ctx)
  const runner = createMastracodePollRunner(ctx, opts)
  if (opts.holder) opts.holder.runner = runner
  let activeCtx = ctx
  let stopped = false
  /** @type {ReturnType<typeof setInterval> | null} */
  let handle = null
  /** @type {Promise<void> | null} */
  let inFlight = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let catchUp = null

  // A healthy tick that left work pending asks for another one soon. A
  // failed tick never does: it waits for the poll timer, so a persistent
  // failure cannot spin.
  const scheduleCatchUp = () => {
    if (stopped || catchUp || runner.lastError || runner.threadsPending === 0) return
    catchUp = setTimeout(() => {
      catchUp = null
      runTick()
    }, MASTRACODE_CATCH_UP_DELAY_MS)
    catchUp.unref?.()
  }

  const runTick = () => {
    if (stopped || inFlight) return
    inFlight = runMastracodePollTick(runner, activeCtx).finally(() => {
      inFlight = null
      scheduleCatchUp()
    })
  }

  const startTimer = () => {
    handle = setInterval(runTick, runner.pollIntervalMs)
    handle.unref?.()
  }

  // @ref LLP 0527#tick-budget [implements]: the first poll is one budgeted
  // batch; any remainder is reconciled by catch-up ticks after start returns.
  inFlight = runMastracodePollTick(runner, ctx).finally(() => { inFlight = null })
  await inFlight
  startTimer()
  scheduleCatchUp()

  return {
    async status() {
      return mastracodeSourceStatus({ ...statusInputs(runner), stopped })
    },
    async reload(next) {
      activeCtx = next
      runner.homeDir = resolveHomeDir(next)
      runner.location = resolveMastraDbLocation(next, runner.homeDir)
      const interval = resolvePollIntervalMs(next)
      if (interval !== runner.pollIntervalMs) {
        runner.pollIntervalMs = interval
        if (handle) clearInterval(handle)
        if (!stopped) startTimer()
      }
    },
    async stop() {
      stopped = true
      if (handle) clearInterval(handle)
      if (catchUp) clearTimeout(catchUp)
      handle = null
      catchUp = null
      // The in-flight tick closes its connection before it resolves, so no
      // connection outlives the source.
      if (inFlight) await inFlight.catch(() => {})
    },
  }
}

/**
 * @param {PluginActivationContext} ctx
 * @param {{ ignoredSessions?: Set<string> }} [opts]
 * @returns {MastraPollRunner}
 */
export function createMastracodePollRunner(ctx, opts = {}) {
  const homeDir = resolveHomeDir(ctx)
  const localOnlyList = localOnlyListPath(readObservabilityEnv(ctx.env).stateDir)
  return {
    location: resolveMastraDbLocation(ctx, homeDir),
    pollIntervalMs: resolvePollIntervalMs(ctx),
    homeDir,
    stateDir: ctx.paths.stateDir,
    resolver: createUsagePolicyResolver({ localOnlyListPath: localOnlyList }),
    localOnlyListPath: localOnlyList,
    devRunId: randomUUID(),
    watermark: null,
    dbPresent: false,
    rowsWritten: 0,
    threadsTracked: 0,
    threadsPending: 0,
    ...(opts.ignoredSessions ? { ignoredSessions: opts.ignoredSessions } : {}),
  }
}

/**
 * One poll tick under a `mastracode.poll` span. A failed tick records its
 * kind on the runner and never throws to the caller.
 *
 * @ref LLP 0586#privacy [implements]: the log and span carry counts, ids and
 *   error kinds, never message text, titles, `projectPath` or the database
 *   path.
 * @param {MastraPollRunner} runner
 * @param {PluginActivationContext} ctx
 */
export async function runMastracodePollTick(runner, ctx) {
  /** @type {unknown} */
  let failure
  try {
    await withSpan('mastracode.poll', {
      [Attr.COMPONENT]: 'mastracode',
      [Attr.OPERATION]: 'mastracode.poll',
      [Attr.PLUGIN]: PLUGIN_NAME,
      status: 'ok',
    }, async (span) => {
      try {
        const result = await pollOnce(runner, ctx)
        span.setAttribute('poll_status', result.status)
        span.setAttribute('changed', result.changed)
        span.setAttribute('threads_changed', result.threadsChanged)
        span.setAttribute('threads_pending', runner.threadsPending)
        span.setAttribute('rows', result.rows)
        // `status` is the fixed attribute set (LLP 0021), which would rewrite
        // `baseline` and `unchanged` to `failed`; the tick outcome rides
        // `poll_status`, as it does on the span.
        ctx.log.info('mastracode.poll', {
          component: 'mastracode',
          operation: 'mastracode.poll',
          status: 'ok',
          poll_status: result.status,
          changed: result.changed,
          threads_changed: result.threadsChanged,
          threads_pending: runner.threadsPending,
          parts_skipped: result.partsSkipped,
          rows: result.rows,
        })
      } catch (err) {
        // `withSpan` records the thrown message; the span gets the kind and
        // a path-free error.
        failure = err
        const kind = errorKind(err)
        span.setAttribute('error_kind', kind)
        throw new Error(`mastracode poll failed: ${kind}`)
      }
    }, { component: 'mastracode' })
    runner.lastPollAt = new Date().toISOString()
    runner.lastError = undefined
    runner.lastErrorKind = undefined
  } catch (thrown) {
    const err = failure ?? thrown
    runner.lastErrorKind = errorKind(err)
    // Status keeps the message only of a `MastraDbError` or
    // `MastracodeSessionIgnoreError`, whose texts never name a path.
    runner.lastError = err instanceof MastraDbError || err instanceof MastracodeSessionIgnoreError
      ? err.message
      : `mastracode poll failed: ${runner.lastErrorKind}`
    ctx.log.error('mastracode.poll', {
      component: 'mastracode',
      operation: 'mastracode.poll',
      status: 'failed',
      threads_pending: runner.threadsPending,
      error_kind: runner.lastErrorKind,
    })
  }
}

/**
 * One poll tick: the stat gate, the budgeted reads, one batch commit, one
 * watermark flush.
 *
 * @param {MastraPollRunner} runner
 * @param {PluginActivationContext} ctx
 * @returns {Promise<{ status: 'ok' | 'unchanged' | 'baseline' | 'missing', changed: boolean, threadsChanged: number, partsSkipped: number, rows: number }>}
 */
async function pollOnce(runner, ctx) {
  const idle = { changed: false, threadsChanged: 0, partsSkipped: 0, rows: 0 }
  if (runner.location.kind === 'remote') {
    // @ref LLP 0586#config [implements]: MASTRA_DB_URL names a remote store,
    // which is not read even when a local file exists.
    runner.threadsPending = 0
    throw new MastraDbError('MASTRA_DB_URL is set; remote stores are not supported', { code: 'remote_store_unsupported' })
  }
  const dbPath = runner.location.path
  const before = mastraStatSig(dbPath)
  runner.dbPresent = before !== null
  if (!runner.watermark) runner.watermark = readMastraWatermark(runner.stateDir)
  const watermark = runner.watermark
  runner.threadsTracked = Object.keys(watermark.threads).length
  if (before === null) {
    runner.threadsPending = 0
    return { status: 'missing', ...idle }
  }
  const prior = watermark.db?.path === dbPath ? watermark.db : null
  // @ref LLP 0586#cost [implements]: an unchanged signature is two stats and
  // no open.
  if (prior && prior.stat_sig === before) {
    runner.threadsPending = 0
    return { status: 'unchanged', ...idle }
  }

  /** @type {MastraBatchEntry[]} */
  const batch = []
  /** @type {(() => void)[]} */
  const releases = []
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
  /** @type {MastraDbWatermark | null} */
  let baseline = null
  let newRowsTo = prior?.max_rowid ?? 0
  let admitted = 0
  let batchRows = 0
  let threadsPending = 0
  let threadsChanged = 0
  let held = false
  let heldNewRows = false
  /** @type {{ err: unknown, threadId: string | null } | null} */
  let failure = null
  let pendingMarks = 0
  /** @type {string | null} */
  let after = null

  const budgetSpent = () => admitted >= MASTRACODE_THREADS_PER_TICK || (admitted > 0 && batchRows >= MASTRACODE_ROWS_PER_TICK)

  /** @param {MastraBatchEntry} entry */
  const markCommitted = (entry) => {
    if (entry.mark) watermark.threads[entry.thread_id] = entry.mark
    else dropMastraWatermarkThread(watermark, entry.thread_id)
    pendingMarks++
  }

  /**
   * Claim the thread's reconcile scope. Returns false when the claim was
   * deferred or failed, which holds the thread.
   *
   * @param {string} threadId
   */
  const claim = (threadId) => {
    // @ref LLP 0449#read-commit-guard [implements]: claim before the
    // authoritative read, hold through the commit. A scope another writer
    // holds is deferred and holds the cursor and signature, so the next
    // tick finds it.
    // @ref LLP 0527#batched-reconcile [constrained-by]: every claim in the
    // batch is held until the batch commit returns.
    try {
      releases.push(ctx.storage.claimReconcileScope?.(AI_GATEWAY_MESSAGES_DATASET,
        mastracodeReconcileScope(MASTRACODE_CLIENT_NAME, threadId)) ?? (() => {}))
      return true
    } catch (claimErr) {
      if (!isPartitionMutationBusy(claimErr)) {
        failure = { err: claimErr, threadId }
        return false
      }
      ctx.log.info('mastracode.thread_deferred', {
        component: 'mastracode',
        operation: 'mastracode.poll',
        status: 'deferred',
        error_kind: 'cache_partition_mutation_busy',
        session_id: threadId,
      })
      return false
    }
  }

  /** @type {MastraDb | null} */
  let handle = null
  try {
    try {
      handle = openMastraDb(dbPath)
      if (!prior) {
        // @ref LLP 0586#reconciliation [implements]: a first start, or a
        // database at a new path, records the cursor and the floor and walks
        // no history; history is the backfill's.
        const maxima = await handle.maxima()
        baseline = { path: dbPath, stat_sig: null, max_rowid: maxima.maxRowid, floor: maxima.maxUpdatedAt }
      } else {
        const newRows = await handle.newRows(prior.max_rowid)
        newRowsTo = newRows.maxRowid
        const withNewRows = new Set(newRows.threadIds)
        const candidates = selectCandidates(await handle.listThreads(), withNewRows, prior, watermark.threads)
        if (candidates.length) refreshExclusions(runner)
        for (const meta of candidates) {
          const entry = watermark.threads[meta.id]
          const hold = () => {
            held = true
            if (withNewRows.has(meta.id)) heldNewRows = true
            // An open thread is hashed every changed tick, so it is never
            // pending and never asks for a catch-up.
            if (!entry?.open) threadsPending++
          }
          if (failure) {
            hold()
            continue
          }
          // @ref LLP 0586#privacy [implements]: an excluded thread is not
          // projected and its entry does not advance.
          if (isExcluded(runner.ignoredSessions, mastracodeScopeId(meta.id))) continue
          if (budgetSpent()) {
            hold()
            continue
          }
          const counts = await handle.threadCounts(meta.id)
          // @ref LLP 0586#reconciliation [implements]: skip without hashing
          // only when `updatedAt`, the count and `max_rowid` all match and
          // the entry is not open.
          if (entry && !entry.open && entry.digest !== undefined
            && entry.updated_at === meta.updatedAt
            && entry.message_count === counts.message_count
            && entry.max_rowid === counts.max_rowid) continue
          if (!claim(meta.id)) {
            hold()
            continue
          }
          admitted++
          threadsChanged++
          let snapshot
          try {
            snapshot = await handle.readThreadSnapshot(meta.id)
          } catch (err) {
            hold()
            throw err
          }
          if (!snapshot) {
            // Gone since the threads read: drop its entry.
            batch.push({ thread_id: meta.id, mark: null })
            continue
          }
          // @ref LLP 0586#reconciliation [implements]: `open` records that
          // the digest changed on this reconcile, so an assistant row
          // rewritten in place is read again on the next changed tick.
          /** @type {MastraThreadWatermark} */
          const mark = { ...snapshot.mark, open: entry?.digest !== snapshot.mark.digest }
          if (!mark.open) {
            batch.push({ thread_id: meta.id, mark })
            continue
          }
          try {
            const item = await projectMastracodeThread({
              thread: snapshot.thread,
              messages: snapshot.messages,
              sourcePath: dbPath,
              clientName: MASTRACODE_CLIENT_NAME,
              deriveRepo,
              resolver: runner.resolver,
              log: ctx.log,
              skipped,
            })
            // @ref LLP 0586#privacy [implements]: a usage-policy ignore
            // reconciles the thread to an empty snapshot, removing rows
            // captured before.
            const prepared = item ? await prepareProjectedItem(runner, ctx, item) : emptySnapshot(ctx, meta.id)
            batchRows += prepared.rows.length
            batch.push({ thread_id: meta.id, mark, snapshot: prepared })
          } catch (err) {
            hold()
            failure = { err, threadId: meta.id }
          }
        }
      }
    } catch (err) {
      held = true
      failure ??= { err, threadId: null }
    } finally {
      if (handle) handle.close()
      // @ref LLP 0586#reconciliation [implements]: the signature after the
      // reader closed, compared with the one before it opened.
      after = mastraStatSig(dbPath)
    }

    if (failure && failure.err instanceof MastraDbError && failure.err.code === 'missing') {
      // The file went between the stat and the open.
      runner.dbPresent = false
      runner.threadsPending = 0
      return { status: 'missing', ...idle }
    }

    /** @type {{ written: number, failed?: { err: unknown, threadId: string | null } }} */
    let committed = { written: 0 }
    try {
      committed = await commitMastracodeBatch(ctx, batch, markCommitted)
    } finally {
      for (const release of releases) {
        try {
          release()
        } catch {
          // a release failure must not mask the commit result
        }
      }
    }
    const tickError = failure?.err ?? committed.failed?.err

    let dbMoved = false
    if (baseline) {
      if (sigsAgree(before, after)) baseline.stat_sig = after
      watermark.db = baseline
      watermark.threads = {}
      dbMoved = true
    } else if (!tickError && prior) {
      // @ref LLP 0586#reconciliation [implements]: the cursor moves only past
      // committed or unchanged threads, and the after-close signature is
      // recorded only when every candidate was admitted and the reader saw
      // no write. On a mismatch the previous signature stays, so the next
      // tick reopens the database.
      const next = {
        path: dbPath,
        stat_sig: !held && sigsAgree(before, after) ? after : prior.stat_sig,
        max_rowid: heldNewRows ? prior.max_rowid : Math.max(prior.max_rowid, newRowsTo),
        floor: prior.floor,
      }
      if (next.stat_sig !== prior.stat_sig || next.max_rowid !== prior.max_rowid) {
        watermark.db = { ...next, floor: watermark.db?.floor ?? prior.floor }
        dbMoved = true
      }
    }

    try {
      if (pendingMarks > 0 || dbMoved) writeMastraWatermark(runner.stateDir, watermark)
    } catch (flushErr) {
      ctx.log.warn('mastracode.watermark_flush_failed', {
        component: 'mastracode',
        operation: 'mastracode.poll',
        error_kind: errorKind(flushErr),
        threads_changed: threadsChanged,
      })
      if (!tickError) throw flushErr
    }

    const broken = failure ?? committed.failed
    if (broken) {
      const staged = batch.filter(entry => entry.snapshot)
      ctx.log.warn('mastracode.thread_reconcile_failed', {
        component: 'mastracode',
        operation: 'mastracode.poll',
        status: 'partial',
        error_kind: errorKind(broken.err),
        threads_persisted: committed.written > 0 ? pendingMarks : 0,
        threads_changed: threadsChanged,
        ...(broken.threadId
          ? { session_id: broken.threadId }
          : staged.length
            ? { threads_in_batch: staged.length, first_session_id: staged[0].thread_id, last_session_id: staged[staged.length - 1].thread_id }
            : {}),
      })
    }

    runner.rowsWritten += committed.written
    runner.threadsTracked = Object.keys(watermark.threads).length
    runner.threadsPending = threadsPending
    if (tickError) throw tickError
    return {
      status: baseline ? 'baseline' : 'ok',
      changed: true,
      threadsChanged,
      partsSkipped: Object.values(skipped).reduce((sum, n) => sum + (n ?? 0), 0),
      rows: committed.written,
    }
  } catch (err) {
    runner.threadsPending = threadsPending
    throw err
  }
}

/**
 * The change gate's signature: `mastra.db` and `mastra.db-wal`, never
 * `-shm`. Null when `mastra.db` is absent.
 *
 * @ref LLP 0586#reconciliation [implements]: size, mtime in nanoseconds and
 *   inode of the main file and the WAL.
 * @param {string} dbPath
 * @returns {string | null}
 */
export function mastraStatSig(dbPath) {
  const main = fileSig(dbPath)
  if (main === null) return null
  return `${main}|${fileSig(`${dbPath}-wal`) ?? '-'}`
}

/**
 * @param {string} p
 * @returns {string | null}
 */
function fileSig(p) {
  try {
    const st = fs.statSync(p, { bigint: true })
    return st.isFile() ? `${st.size}:${st.mtimeNs}:${st.ino}` : null
  } catch {
    return null
  }
}

/**
 * Whether the reader saw no write: the signatures match, or differ only by
 * an empty `-wal` the read-only connection itself left behind.
 *
 * @param {string} before
 * @param {string | null} after
 * @returns {after is string}
 */
function sigsAgree(before, after) {
  if (after === null || after === before) return after !== null
  const [beforeDb, beforeWal] = before.split('|')
  const [afterDb, afterWal] = after.split('|')
  return beforeDb === afterDb && beforeWal === '-' && afterWal.startsWith('0:')
}

/**
 * The threads a changed database's reads name: rows above the cursor, an
 * `updatedAt` that moved, a new thread above the floor, or an open entry.
 * Threads that moved come before re-reads of open entries, so those
 * re-reads never spend the budget a catch-up tick owes its leftovers. An
 * open entry with rows above a held cursor is a re-read: it is hashed
 * either way, and the cursor held for the leftovers names it again;
 * oldest `updatedAt` first within each group, so a budget-limited tick
 * drains in order.
 *
 * @param {{ id: string, updatedAt: string }[]} threads
 * @param {Set<string>} withNewRows
 * @param {MastraDbWatermark} prior
 * @param {Record<string, MastraThreadWatermark>} entries
 * @returns {{ id: string, updatedAt: string }[]}
 */
function selectCandidates(threads, withNewRows, prior, entries) {
  /** @type {{ id: string, updatedAt: string }[]} */
  const moved = []
  /** @type {{ id: string, updatedAt: string }[]} */
  const reread = []
  for (const meta of threads) {
    const entry = entries[meta.id]
    if (entry ? entry.updated_at !== meta.updatedAt || (!entry.open && withNewRows.has(meta.id))
      : withNewRows.has(meta.id) || prior.floor === null || compareUpdatedAt(meta.updatedAt, prior.floor) > 0) moved.push(meta)
    else if (entry?.open) reread.push(meta)
  }
  moved.sort(byUpdatedThenId)
  reread.sort(byUpdatedThenId)
  return moved.concat(reread)
}

/**
 * @param {{ id: string, updatedAt: string }} a
 * @param {{ id: string, updatedAt: string }} b
 */
function byUpdatedThenId(a, b) {
  return compareUpdatedAt(a.updatedAt, b.updatedAt) || compareStrings(a.id, b.id)
}

/**
 * Reload the exclusion markers when their directory moved.
 *
 * @ref LLP 0586#privacy [implements]: only on ticks with candidates, so an
 *   idle tick reads nothing; a load error fails closed.
 * @param {MastraPollRunner} runner
 */
export function refreshExclusions(runner) {
  const set = runner.ignoredSessions
  if (!set) return
  const directory = /** @type {{ directory?: string }} */ (set).directory
  let signature = 'missing'
  if (directory) {
    try {
      const stat = fs.statSync(directory)
      signature = [stat.ino, stat.mtimeMs, stat.ctimeMs].join(':')
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') throw new MastracodeSessionIgnoreError('session exclusions could not be read')
    }
  }
  if (signature !== runner.exclusionsSignature) {
    try {
      refreshSessionIgnores(set)
    } catch {
      throw new MastracodeSessionIgnoreError(sessionIgnoreLoadError(set) ?? 'session exclusions could not be loaded')
    }
    runner.exclusionsSignature = signature
  }
  const loadError = sessionIgnoreLoadError(set)
  if (loadError) {
    // Retry the load next tick rather than trust a cached signature.
    runner.exclusionsSignature = undefined
    throw new MastracodeSessionIgnoreError(loadError)
  }
}

/**
 * The thread's own marker decides membership both ways, so an ignore or
 * unignore written since the last refresh is seen at once.
 *
 * @param {Set<string> | undefined} set
 * @param {string} scopeId
 * @returns {boolean}
 */
export function isExcluded(set, scopeId) {
  if (!set) return false
  const directory = /** @type {{ directory?: string }} */ (set).directory
  return directory ? present(path.join(directory, markerName(scopeId))) : set.has(scopeId)
}

/** @param {string} file @returns {boolean} */
function present(file) {
  try {
    fs.statSync(file)
    return true
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

/**
 * Materialize one projected-exchange item through the shared
 * `ai_gateway.projected_exchange` materializer into a scoped snapshot for
 * the batch commit. Throws when the seam is missing, so nothing advances.
 *
 * @param {{ devRunId?: string }} runner
 * @param {PluginActivationContext} ctx
 * @param {BackfillItem} item
 * @returns {Promise<NonNullable<MastraBatchEntry['snapshot']>>}
 */
export async function prepareProjectedItem(runner, ctx, item) {
  const materializer = ctx.backfillMaterializers.get(PROJECTED_EXCHANGE_KIND)
  if (!materializer) throw new Error(`mastracode capture requires the ${PROJECTED_EXCHANGE_KIND} materializer`)
  const rows = await materializer.materialize(item, {
    env: ctx.env,
    log: ctx.log,
    storage: ctx.storage,
    devRunId: runner.devRunId,
  })
  const { columns } = snapshotTarget(ctx)
  return {
    rows: Array.isArray(rows) ? rows : [],
    scope: /** @type {NonNullable<BackfillItem['reconcile']>} */ (item.reconcile),
    columns,
  }
}

/**
 * The empty snapshot that removes an ignored thread's rows.
 *
 * @param {PluginActivationContext} ctx
 * @param {string} threadId
 * @returns {NonNullable<MastraBatchEntry['snapshot']>}
 */
export function emptySnapshot(ctx, threadId) {
  const { columns } = snapshotTarget(ctx)
  return { rows: [], scope: { where: mastracodeReconcileScope(MASTRACODE_CLIENT_NAME, threadId), key: 'part_id' }, columns }
}

/**
 * @param {PluginActivationContext} ctx
 * @returns {{ columns: NonNullable<MastraBatchEntry['snapshot']>['columns'] }}
 */
function snapshotTarget(ctx) {
  const dataset = ctx.query.getDataset?.(AI_GATEWAY_MESSAGES_DATASET)
  if (!dataset) throw new Error(`mastracode capture requires the ${AI_GATEWAY_MESSAGES_DATASET} dataset`)
  if (!ctx.storage.reconcileRowsBatch && !ctx.storage.reconcileRows) {
    throw new Error('mastracode capture requires local snapshot reconciliation support')
  }
  return { columns: dataset.schema?.columns ?? [] }
}

/**
 * Commit the tick's batch and mark each thread it settled. Entries with no
 * snapshot are already settled. The snapshots go to the cache in one
 * `reconcileRowsBatch` call; when that fails, or the storage has no batch
 * call, they are retried one at a time, so a thread that cannot commit
 * holds back only itself and the threads after it.
 *
 * @ref LLP 0527#batched-reconcile [implements]: one cache commit per partition per tick.
 * @param {PluginActivationContext} ctx
 * @param {MastraBatchEntry[]} batch
 * @param {(entry: MastraBatchEntry) => void} markCommitted
 * @returns {Promise<{ written: number, failed?: { err: unknown, threadId: string | null } }>}
 */
export async function commitMastracodeBatch(ctx, batch, markCommitted) {
  /** @type {(MastraBatchEntry & { snapshot: NonNullable<MastraBatchEntry['snapshot']> })[]} */
  const pending = []
  for (const entry of batch) {
    if (entry.snapshot) pending.push(/** @type {any} */ (entry))
    else markCommitted(entry)
  }
  if (!pending.length) return { written: 0 }
  const storage = ctx.storage
  if (storage.reconcileRowsBatch) {
    try {
      const written = await storage.reconcileRowsBatch(AI_GATEWAY_MESSAGES_DATASET, pending[0].snapshot.columns,
        pending.map(({ snapshot: { rows, scope } }) => ({ rows, scope })))
      for (const entry of pending) markCommitted(entry)
      return { written }
    } catch (err) {
      if (!storage.reconcileRows) return { written: 0, failed: { err, threadId: null } }
      ctx.log.warn('mastracode.batch_reconcile_failed', {
        component: 'mastracode',
        operation: 'mastracode.poll',
        status: 'retrying',
        error_kind: errorKind(err),
        threads_in_batch: pending.length,
      })
    }
  }
  const reconcileRows = /** @type {NonNullable<typeof storage.reconcileRows>} */ (storage.reconcileRows)
  let written = 0
  for (const entry of pending) {
    const { rows, scope, columns } = entry.snapshot
    try {
      written += await reconcileRows(AI_GATEWAY_MESSAGES_DATASET, columns, rows, scope)
    } catch (err) {
      return { written, failed: { err, threadId: entry.thread_id } }
    }
    markCommitted(entry)
  }
  return { written }
}

/** @param {unknown} err @returns {string} */
export function errorKind(err) {
  if (err instanceof MastraDbError) return err.code
  if (err instanceof MastracodeSessionIgnoreError) return IGNORE_LOAD_FAILED
  if (isPartitionMutationBusy(err)) return 'cache_partition_mutation_busy'
  return 'unknown'
}

/**
 * @param {MastraPollRunner} runner
 * @returns {Parameters<typeof mastracodeSourceStatus>[0]}
 */
export function statusInputs(runner) {
  return {
    location: runner.location,
    dbPresent: runner.dbPresent,
    pollIntervalMs: runner.pollIntervalMs,
    rowsWritten: runner.rowsWritten,
    lastError: runner.lastError,
    lastErrorKind: runner.lastErrorKind,
    threadsTracked: runner.threadsTracked,
    threadsPending: runner.threadsPending,
    lastPollAt: runner.lastPollAt,
  }
}

/**
 * Map the last tick to the source's health, one state per row of the
 * LLP 0586#status table.
 *
 * @ref LLP 0586#status [implements]: no database and no traffic are `ready`
 *   with zero rows; an unreadable, busy, unsupported or remote store is
 *   `degraded` with its `error_kind`.
 *
 * @param {{
 *   location: MastraDbLocation,
 *   dbPresent: boolean,
 *   pollIntervalMs: number,
 *   rowsWritten: number,
 *   stopped?: boolean,
 *   lastError?: string,
 *   lastErrorKind?: string,
 *   threadsTracked?: number,
 *   threadsPending?: number,
 *   lastPollAt?: string,
 * }} opts
 * @returns {SourceStatus}
 */
export function mastracodeSourceStatus(opts) {
  const { location, pollIntervalMs, rowsWritten } = opts
  const dbPath = location.kind === 'local' ? location.path : null
  /** @type {string | null} */
  let errorKind = null
  /** @type {string} */
  let message
  if (opts.lastErrorKind) {
    errorKind = opts.lastErrorKind
    if (errorKind === 'permission_denied' || errorKind === 'open_failed') {
      message = `cannot read the mastracode database at ${dbPath}`
    } else if (errorKind === 'sqlite_busy') {
      message = 'mastracode database busy, retrying next poll'
    } else {
      message = opts.lastError ?? `mastracode poll failed: ${errorKind}`
    }
  } else if (!opts.dbPresent) {
    message = `no mastracode installation detected at ${dbPath}`
  } else {
    const every = `polling mastracode every ${pollIntervalMs}ms`
    message = rowsWritten > 0 ? every : `${every}, no threads yet`
  }

  /** @type {SourceStatus} */
  const status = {
    state: opts.stopped ? 'stopped' : errorKind ? 'degraded' : 'ready',
    message,
    rowsWritten,
    details: {
      ...(dbPath ? { db_path: dbPath } : { remote_store: true }),
      poll_interval_ms: pollIntervalMs,
      ...(opts.threadsTracked !== undefined ? { threads_tracked: opts.threadsTracked } : {}),
      ...(opts.threadsPending !== undefined ? { threads_pending: opts.threadsPending } : {}),
      ...(opts.lastPollAt ? { last_poll_at: opts.lastPollAt } : {}),
    },
  }
  if (errorKind) {
    // Plain `hyp status` prints `lastError` over `message`, so both carry the
    // text; the kind stays in `details`.
    status.lastError = message
    if (status.details) status.details.error_kind = errorKind
  }
  return status
}

/**
 * The `StartedSource` returned when `enabled: false` turns ongoing capture
 * off. It opens nothing and runs no timer.
 *
 * @param {PluginActivationContext} ctx
 * @returns {StartedSource}
 */
function createDisabledSource(ctx) {
  ctx.log.info('mastracode.source_disabled', {
    component: 'mastracode',
    operation: 'mastracode.start',
    detail: 'mastracode.enabled = false',
  })
  return {
    async status() {
      return {
        state: 'ready',
        message: 'mastracode ongoing capture disabled (mastracode.enabled = false)',
        rowsWritten: 0,
        details: { enabled: false },
      }
    },
    async reload() {},
    async stop() {},
  }
}
