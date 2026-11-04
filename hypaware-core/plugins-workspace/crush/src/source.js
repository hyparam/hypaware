// @ts-check

/**
 * The `crush` source: polls every discovered project `crush.db` and
 * reconciles each changed session into `ai_gateway_messages` through the
 * shared projected-exchange materializer. One poll tick is one budgeted
 * batch: at most `CRUSH_OPENS_PER_TICK` databases opened one at a time, at
 * most `CRUSH_SESSIONS_PER_TICK` sessions and about `CRUSH_ROWS_PER_TICK`
 * rows, one cache commit, one watermark flush.
 *
 * @ref LLP 0573#source [implements]: poll every discovered database, one
 *   connection at a time, opened only when its stat signature moved.
 * @ref LLP 0573#reconciliation [implements]: per-database cursor, floor and
 *   signature, per-session digest; nothing advances past an uncommitted session.
 *
 * @import { BackfillItem, PluginActivationContext, SourceStatus, StartedSource } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { CrushBatchEntry, CrushChanges, CrushDatabase, CrushDbWatermark, CrushDiscoveryResult, CrushPollRunner, CrushRunnerHolder, CrushSessionMeta, CrushSessionWatermark } from './types.js'
 * @import { CrushDb } from './crush_db.js'
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
import { groupThousands } from '../../../../src/core/util/format_number.js'
import { compareStrings } from '../../../../src/core/util/compare_strings.js'
import {
  resolveCrushEnabled,
  resolveDataDirs,
  resolveHomeDir,
  resolveIndexPath,
  resolvePollIntervalMs,
} from './config.js'
import { openCrushDb } from './crush_db.js'
import { MAX_DATABASES, createDiscoveryState, discoverDatabases, fileSig } from './discovery.js'
import { CrushDbError } from './errors.js'
import { deriveRepoFromCwd } from './git_repo.js'
import { CRUSH_CLIENT_NAME, crushReconcileScope, crushScopeId, projectCrushSession } from './projector.js'
import { readCrushWatermark, writeCrushWatermark } from './watermark.js'

const PLUGIN_NAME = '@hypaware/crush'

/**
 * Sessions admitted to one tick's batch, across every database.
 *
 * @ref LLP 0527#tick-budget [implements]: start commits at most one batch
 *   whatever the change volume.
 */
export const CRUSH_SESSIONS_PER_TICK = 64

/**
 * Rows admitted to one tick's batch. A session is projected whole, so the
 * last one admitted can carry the batch past this. The first session is
 * always admitted.
 */
export const CRUSH_ROWS_PER_TICK = 4096

/** Changed databases opened in one tick; the rest wait for the next. */
export const CRUSH_OPENS_PER_TICK = 16

export const CRUSH_CATCH_UP_DELAY_MS = 1000

export const IGNORE_LOAD_FAILED = 'session_ignore_load_failed'

class CrushSessionIgnoreError extends Error {}

/**
 * `SourceContribution.start` for the `crush` source. Awaits one bounded
 * tick, then polls on the configured interval.
 *
 * @param {PluginActivationContext} ctx
 * @param {{ ignoredSessions?: Set<string>, holder?: CrushRunnerHolder }} [opts]
 * @returns {Promise<StartedSource>}
 */
export async function startCrushSource(ctx, opts = {}) {
  // @ref LLP 0573#config [implements]: `enabled = false` turns ongoing capture
  // off; the source still registers, so status says why nothing is captured.
  // Registration lives in activation and the daemon is the only starter (issue #348).
  if (!resolveCrushEnabled(ctx.config)) return createDisabledSource(ctx)
  const runner = createCrushPollRunner(ctx, opts)
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
    if (stopped || catchUp || runner.lastError) return
    if (runner.sessionsPending === 0 && runner.dbsPending === 0) return
    catchUp = setTimeout(() => {
      catchUp = null
      runTick()
    }, CRUSH_CATCH_UP_DELAY_MS)
    catchUp.unref?.()
  }

  const runTick = () => {
    if (stopped || inFlight) return
    inFlight = runCrushPollTick(runner, activeCtx).finally(() => {
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
  await runCrushPollTick(runner, ctx)
  startTimer()
  scheduleCatchUp()

  return {
    async status() {
      return crushSourceStatus(runner.lastResult ?? discoverDatabases(runner.discovery, runner), {
        indexPath: runner.indexPath,
        pollIntervalMs: runner.pollIntervalMs,
        rowsWritten: runner.rowsWritten,
        stopped,
        errorCounts: runner.errorCounts,
        schemaDetail: runner.schemaDetail,
        lastError: runner.lastError,
        lastErrorKind: runner.lastErrorKind,
        sessionsTracked: runner.sessionsTracked,
        sessionsPending: runner.sessionsPending,
        lastPollAt: runner.lastPollAt,
      })
    },
    async reload(next) {
      activeCtx = next
      runner.homeDir = resolveHomeDir(next)
      runner.indexPath = resolveIndexPath(next, runner.homeDir)
      runner.dataDirs = resolveDataDirs(next, runner.homeDir)
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
      if (inFlight) await inFlight.catch(() => {})
    },
  }
}

/**
 * @param {PluginActivationContext} ctx
 * @param {{ ignoredSessions?: Set<string> }} [opts]
 * @returns {CrushPollRunner}
 */
export function createCrushPollRunner(ctx, opts = {}) {
  const homeDir = resolveHomeDir(ctx)
  const localOnlyList = localOnlyListPath(readObservabilityEnv(ctx.env).stateDir)
  return {
    indexPath: resolveIndexPath(ctx, homeDir),
    dataDirs: resolveDataDirs(ctx, homeDir),
    pollIntervalMs: resolvePollIntervalMs(ctx),
    homeDir,
    stateDir: ctx.paths.stateDir,
    resolver: createUsagePolicyResolver({ localOnlyListPath: localOnlyList }),
    localOnlyListPath: localOnlyList,
    devRunId: randomUUID(),
    discovery: createDiscoveryState(),
    watermark: null,
    rowsWritten: 0,
    sessionsTracked: 0,
    sessionsPending: 0,
    dbsPending: 0,
    errorCounts: {},
    ...(opts.ignoredSessions ? { ignoredSessions: opts.ignoredSessions } : {}),
  }
}

/**
 * One poll tick under a `crush.poll` span. A failed tick records its kind
 * on the runner and never throws to the caller.
 *
 * @param {CrushPollRunner} runner
 * @param {PluginActivationContext} ctx
 */
export async function runCrushPollTick(runner, ctx) {
  /** @type {unknown} */
  let failure
  try {
    await withSpan('crush.poll', {
      [Attr.COMPONENT]: 'crush',
      [Attr.OPERATION]: 'crush.poll',
      [Attr.PLUGIN]: PLUGIN_NAME,
      status: 'ok',
    }, async (span) => {
      try {
        const result = await pollOnce(runner, ctx)
        span.setAttribute('poll_status', result.status)
        span.setAttribute('dbs_changed', result.dbsChanged)
        span.setAttribute('dbs_opened', result.dbsOpened)
        span.setAttribute('sessions_changed', result.sessionsChanged)
        span.setAttribute('sessions_pending', runner.sessionsPending)
        span.setAttribute('rows', result.rows)
        // `status` is the fixed attribute set (LLP 0021), which would rewrite
        // `baseline` and `unchanged` to `failed`; the tick outcome rides
        // `poll_status`, as it does on the span.
        ctx.log.info('crush.poll', {
          component: 'crush',
          operation: 'crush.poll',
          status: 'ok',
          poll_status: result.status,
          dbs_total: result.dbsTotal,
          dbs_changed: result.dbsChanged,
          dbs_opened: result.dbsOpened,
          dbs_pending: runner.dbsPending,
          sessions_changed: result.sessionsChanged,
          sessions_pending: runner.sessionsPending,
          rows: result.rows,
          ...(result.errorKind ? { error_kind: result.errorKind } : {}),
        })
      } catch (err) {
        // @ref LLP 0573#privacy [implements]: `withSpan` records the thrown
        // message, which can name a database path; the span gets the kind
        // and a path-free error, and status keeps the original message.
        failure = err
        const kind = errorKind(err)
        span.setAttribute('error_kind', kind)
        throw new Error(`crush poll failed: ${kind}`)
      }
    }, { component: 'crush' })
    runner.lastPollAt = new Date().toISOString()
    runner.lastError = undefined
    runner.lastErrorKind = undefined
  } catch (thrown) {
    const err = failure ?? thrown
    runner.lastError = err instanceof Error ? err.message : String(err)
    runner.lastErrorKind = errorKind(err)
    ctx.log.error('crush.poll', {
      component: 'crush',
      operation: 'crush.poll',
      status: 'failed',
      sessions_pending: runner.sessionsPending,
      error_kind: runner.lastErrorKind,
    })
  }
}

/**
 * One poll tick: discovery, the stat gate, the budgeted reads, one batch
 * commit, one watermark flush.
 *
 * @param {CrushPollRunner} runner
 * @param {PluginActivationContext} ctx
 * @returns {Promise<{ status: 'ok' | 'unchanged' | 'baseline', dbsTotal: number, dbsChanged: number, dbsOpened: number, sessionsChanged: number, rows: number, errorKind?: string }>}
 */
async function pollOnce(runner, ctx) {
  const result = discoverDatabases(runner.discovery, { indexPath: runner.indexPath, dataDirs: runner.dataDirs })
  runner.lastResult = result
  runner.errorCounts = {}
  runner.schemaDetail = undefined
  if (!runner.watermark) runner.watermark = readCrushWatermark(runner.stateDir)
  const watermark = runner.watermark

  /** @type {{ db: CrushDatabase, sig: string, prior: CrushDbWatermark | undefined }[]} */
  const changed = []
  for (const db of result.databases) {
    const sig = statSig(db.dbPath, db.dbSig)
    const prior = watermark.dbs[db.dbPath]
    // @ref LLP 0573#cost [implements]: an unchanged signature is two stats
    // and no open.
    if (prior && prior.stat_sig === sig) continue
    // An ignore-policy database has no watermark entry; its last signature
    // is kept in memory so an idle one is not resolved again every tick.
    if (!prior && runner.ignoredSigs?.get(db.dbPath) === sig) continue
    changed.push({ db, sig, prior })
  }
  if (runner.ignoredSigs?.size) {
    const live = new Set(result.databases.map(db => db.dbPath))
    for (const p of runner.ignoredSigs.keys()) if (!live.has(p)) runner.ignoredSigs.delete(p)
  }
  runner.sessionsTracked = Object.keys(watermark.sessions).length
  if (!changed.length) {
    runner.sessionsPending = 0
    runner.dbsPending = 0
    const kind = discoveryErrorKind(result)
    return { status: 'unchanged', dbsTotal: result.databases.length, dbsChanged: 0, dbsOpened: 0, sessionsChanged: 0, rows: 0, ...(kind ? { errorKind: kind } : {}) }
  }
  // Fairness across ticks: start at the first changed path after the one the
  // previous tick opened last, wrapping to the first path when none sorts
  // after it, so a budget-limited tick never starves the tail of the set.
  changed.sort((a, b) => compareStrings(a.db.dbPath, b.db.dbPath))
  const lastOpened = runner.lastOpened
  let start = lastOpened === undefined ? 0 : changed.findIndex(c => c.db.dbPath > lastOpened)
  if (start < 0) start = 0
  const ordered = start === 0 ? changed : [...changed.slice(start), ...changed.slice(0, start)]

  const observedSecond = Math.floor(Date.now() / 1000)
  /** @type {CrushBatchEntry[]} */
  const batch = []
  /** @type {(() => void)[]} */
  const releases = []
  /** @type {Map<string, string>} */
  const claimedBy = new Map()
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
  /** @type {{ db: CrushDatabase, prior: CrushDbWatermark | undefined, before: string, after: string | null, changes?: CrushChanges, baseline?: CrushDbWatermark, ignored: boolean, held: boolean, heldNewRows: boolean, dbError: boolean }[]} */
  const visited = []
  let admitted = 0
  let batchRows = 0
  let sessionsPending = 0
  let sessionsChanged = 0
  let dbsPending = 0
  let dbsOpened = 0
  let exclusionsChecked = false
  /** @type {{ err: unknown, sessionId: string | null } | null} */
  let failure = null
  let pendingMarks = 0
  let written = 0

  const unsettled = runner.unsettled ?? (runner.unsettled = new Set())
  const budgetSpent = () => admitted >= CRUSH_SESSIONS_PER_TICK || (admitted > 0 && batchRows >= CRUSH_ROWS_PER_TICK)

  /** @param {CrushBatchEntry} entry */
  const markCommitted = (entry) => {
    if (entry.mark) watermark.sessions[entry.session_id] = entry.mark
    else delete watermark.sessions[entry.session_id]
    // @ref LLP 0573#reconciliation [implements]: an entry recorded in the
    // second it carries is unsettled: a write later in that second can leave
    // updated_at, message_count and max_rowid unchanged, so the session stays
    // a candidate and is hashed when its database next moves.
    if (entry.mark && entry.mark.updated_at >= observedSecond) unsettled.add(entry.session_id)
    else unsettled.delete(entry.session_id)
    pendingMarks++
  }

  /**
   * Claim the session's reconcile scope. Returns false when the claim was
   * deferred or failed, which holds the session.
   *
   * @param {string} sessionId
   */
  const claim = (sessionId) => {
    // @ref LLP 0449#read-commit-guard [implements]: claim before the
    // authoritative read, hold through the commit. A scope another writer
    // holds is deferred and holds the database's cursor and signature, so
    // the next tick finds it.
    // @ref LLP 0527#batched-reconcile [constrained-by]: every claim in the
    // batch is held until the batch commit returns.
    try {
      releases.push(ctx.storage.claimReconcileScope?.(AI_GATEWAY_MESSAGES_DATASET,
        crushReconcileScope(CRUSH_CLIENT_NAME, sessionId)) ?? (() => {}))
      return true
    } catch (claimErr) {
      if (!isPartitionMutationBusy(claimErr)) {
        failure = { err: claimErr, sessionId }
        return false
      }
      ctx.log.info('crush.session_deferred', {
        component: 'crush',
        operation: 'crush.poll',
        status: 'deferred',
        error_kind: 'cache_partition_mutation_busy',
        session_id: sessionId,
      })
      return false
    }
  }

  try {
    for (let i = 0; i < ordered.length; i++) {
      const { db, sig, prior } = ordered[i]
      if (failure || budgetSpent()) {
        // An unopened changed database keeps its signature and is pending.
        dbsPending++
        continue
      }
      const visit = { db, prior, before: sig, after: /** @type {string | null} */ (null), ignored: false, held: false, heldNewRows: false, dbError: false }

      // @ref LLP 0573#privacy [implements]: an ignore-policy project's
      // database is never opened, so it spends no open budget; the sessions
      // captured from it before are reconciled to empty snapshots.
      if (runner.resolver.resolve(db.projectDir).class === 'ignore') {
        visit.ignored = true
        visited.push(visit)
        for (const [sessionId, entry] of Object.entries(watermark.sessions)) {
          if (entry.db !== db.dbPath) continue
          if (failure || budgetSpent()) {
            visit.held = true
            sessionsPending++
            continue
          }
          if (!claim(sessionId)) {
            visit.held = true
            sessionsPending++
            continue
          }
          admitted++
          claimedBy.set(sessionId, db.dbPath)
          batch.push({ session_id: sessionId, db: db.dbPath, mark: null, snapshot: emptySnapshot(ctx, sessionId) })
        }
        continue
      }
      if (dbsOpened >= CRUSH_OPENS_PER_TICK) {
        dbsPending++
        continue
      }
      dbsOpened++
      runner.lastOpened = db.dbPath
      runner.ignoredSigs?.delete(db.dbPath)
      visited.push(visit)

      /** @type {CrushDb | null} */
      let handle = null
      try {
        handle = openCrushDb(db.dbPath)
        if (!prior) {
          // @ref LLP 0573#reconciliation [implements]: a first start or a new
          // database records the cursor and the floor and walks no history.
          visit.baseline = { stat_sig: null, max_rowid: await handle.maxRowid(), floor: observedSecond }
          continue
        }
        const changes = await handle.changes(prior.max_rowid)
        visit.changes = changes
        const candidates = selectCandidates(changes, prior, watermark.sessions, unsettled)
        if (candidates.length && !exclusionsChecked) {
          exclusionsChecked = true
          try {
            refreshExclusions(runner)
          } catch (err) {
            failure = { err, sessionId: null }
          }
        }
        for (const meta of candidates) {
          const entry = watermark.sessions[meta.id]
          const hasNewRows = changes.newRows.some(r => r.session_id === meta.id)
          const hold = () => {
            visit.held = true
            if (hasNewRows) visit.heldNewRows = true
            // An open session is hashed every changed tick, so it is never
            // pending and never asks for a catch-up.
            if (!entry?.open) sessionsPending++
          }
          if (failure) {
            hold()
            continue
          }
          // @ref LLP 0573#privacy [implements]: an excluded session is not
          // projected and its entry does not advance.
          if (isExcluded(runner.ignoredSessions, crushScopeId(meta.id))) continue
          const owner = claimedBy.get(meta.id)
          if ((entry && entry.db !== db.dbPath) || (owner !== undefined && owner !== db.dbPath)) {
            runner.errorCounts.session_collision = (runner.errorCounts.session_collision ?? 0) + 1
            continue
          }
          if (budgetSpent()) {
            hold()
            continue
          }
          const maxRowid = await handle.sessionMaxRowid(meta.id)
          // @ref LLP 0573#reconciliation [implements]: skip without hashing
          // only when every field matches and the entry predates the
          // observed second, so a same-second write is never missed.
          if (entry && !entry.open && entry.digest !== undefined
            && entry.updated_at === meta.updated_at
            && entry.message_count === meta.message_count
            && entry.max_rowid === maxRowid
            && entry.updated_at < observedSecond
            && !unsettled.has(meta.id)) continue
          if (!claim(meta.id)) {
            hold()
            continue
          }
          admitted++
          sessionsChanged++
          claimedBy.set(meta.id, db.dbPath)
          let snapshot
          try {
            snapshot = await handle.readSessionSnapshot(meta.id)
          } catch (err) {
            hold()
            throw err
          }
          if (!snapshot) {
            // Gone or a title session since the metadata read: drop its entry.
            batch.push({ session_id: meta.id, db: db.dbPath, mark: null })
            continue
          }
          const mark = { db: db.dbPath, ...snapshot.mark }
          if (entry?.digest !== undefined && entry.digest === snapshot.mark.digest) {
            batch.push({ session_id: meta.id, db: db.dbPath, mark })
            continue
          }
          try {
            const item = await projectCrushSession({
              session: snapshot.session,
              messages: snapshot.messages,
              projectDir: db.projectDir,
              sourcePath: db.dbPath,
              clientName: CRUSH_CLIENT_NAME,
              deriveRepo,
              resolver: runner.resolver,
              log: ctx.log,
            })
            // @ref LLP 0573#privacy [implements]: a usage-policy ignore
            // reconciles the session to an empty snapshot, removing rows
            // captured before.
            const prepared = item ? await prepareProjectedItem(runner, ctx, item) : emptySnapshot(ctx, meta.id)
            batchRows += prepared.rows.length
            batch.push({ session_id: meta.id, db: db.dbPath, mark, snapshot: prepared })
          } catch (err) {
            hold()
            failure = { err, sessionId: meta.id }
          }
        }
      } catch (err) {
        if (!(err instanceof CrushDbError)) {
          visit.held = true
          failure = { err, sessionId: null }
        } else if (err.code !== 'missing') {
          // A per-database error keeps that database's cursor and signature
          // and does not fail the tick; status counts it by kind.
          visit.dbError = true
          runner.errorCounts[err.code] = (runner.errorCounts[err.code] ?? 0) + 1
          if (err.code === 'schema_unsupported' && runner.schemaDetail === undefined) runner.schemaDetail = err.message
        } else {
          visit.dbError = true
        }
      } finally {
        if (handle) handle.close()
        // @ref LLP 0573#reconciliation [implements]: the signature after the
        // reader closed, compared with the one before it opened.
        visit.after = statSig(db.dbPath, fileSig(db.dbPath))
      }
    }

    /** @type {{ written: number, failed?: { err: unknown, sessionId: string | null } }} */
    let committed = { written: 0 }
    try {
      committed = await commitCrushBatch(ctx, batch, markCommitted)
    } finally {
      for (const release of releases) {
        try {
          release()
        } catch {
          // a release failure must not mask the commit result
        }
      }
    }
    written = committed.written
    const tickError = failure?.err ?? committed.failed?.err

    let dbsMoved = false
    for (const visit of visited) {
      const path = visit.db.dbPath
      // A baseline holds no session, so it lands even when the batch failed.
      if (visit.baseline) {
        if (sigsAgree(visit.before, visit.after)) visit.baseline.stat_sig = visit.after
        watermark.dbs[path] = visit.baseline
        dbsMoved = true
        continue
      }
      if (tickError || visit.dbError) continue
      if (visit.ignored) {
        if (visit.held) {
          dbsPending++
          continue
        }
        if (watermark.dbs[path]) {
          delete watermark.dbs[path]
          dbsMoved = true
        }
        // Dropping the entry means a project that leaves the ignore policy
        // is baselined like a new database; the backfill imports its history.
        if (!runner.ignoredSigs) runner.ignoredSigs = new Map()
        runner.ignoredSigs.set(path, visit.before)
        continue
      }
      const prior = /** @type {CrushDbWatermark} */ (visit.prior)
      const changes = /** @type {CrushChanges} */ (visit.changes)
      // @ref LLP 0573#reconciliation [implements]: the cursor moves only past
      // committed or unchanged sessions, and the after-close signature is
      // recorded only when every candidate was admitted and the reader saw
      // no write. On a mismatch the previous signature stays (null for a
      // database first seen this run), so the next tick reopens it.
      const next = {
        stat_sig: !visit.held && sigsAgree(visit.before, visit.after) ? visit.after : prior.stat_sig,
        max_rowid: visit.heldNewRows ? prior.max_rowid : Math.max(prior.max_rowid, changes.maxRowid),
        floor: prior.floor,
      }
      if (next.stat_sig !== prior.stat_sig || next.max_rowid !== prior.max_rowid) {
        watermark.dbs[path] = next
        dbsMoved = true
      }
    }

    try {
      if (pendingMarks > 0 || dbsMoved) writeCrushWatermark(runner.stateDir, watermark)
    } catch (flushErr) {
      ctx.log.warn('crush.watermark_flush_failed', {
        component: 'crush',
        operation: 'crush.poll',
        error_kind: errorKind(flushErr),
        sessions_persisted: 0,
        sessions_changed: sessionsChanged,
      })
      if (!tickError) throw flushErr
    }

    const broken = failure ?? committed.failed
    if (broken) {
      const staged = batch.filter(entry => entry.snapshot)
      ctx.log.warn('crush.session_reconcile_failed', {
        component: 'crush',
        operation: 'crush.poll',
        status: 'partial',
        error_kind: errorKind(broken.err),
        sessions_persisted: written > 0 ? pendingMarks : 0,
        sessions_changed: sessionsChanged,
        ...(broken.sessionId
          ? { session_id: broken.sessionId }
          : staged.length
            ? {
                sessions_in_batch: staged.length,
                first_session_id: staged[0].session_id,
                last_session_id: staged[staged.length - 1].session_id,
              }
            : {}),
      })
    }

    for (const id of unsettled) if (!watermark.sessions[id]) unsettled.delete(id)
    runner.rowsWritten += written
    runner.sessionsTracked = Object.keys(watermark.sessions).length
    runner.sessionsPending = sessionsPending
    runner.dbsPending = dbsPending
    if (tickError) throw tickError
  } catch (err) {
    runner.sessionsPending = sessionsPending
    runner.dbsPending = dbsPending
    throw err
  }

  const onlyBaselines = visited.length > 0 && visited.every(v => v.baseline)
  const kind = discoveryErrorKind(result) ?? Object.keys(runner.errorCounts)[0]
  return {
    status: onlyBaselines ? 'baseline' : 'ok',
    dbsTotal: result.databases.length,
    dbsChanged: changed.length,
    dbsOpened,
    sessionsChanged,
    rows: written,
    ...(kind ? { errorKind: kind } : {}),
  }
}

/**
 * The degraded kind a discovery pass carries on its own, ahead of any
 * per-database kind, in the order status ranks them.
 *
 * @param {CrushDiscoveryResult} result
 * @returns {string | undefined}
 */
function discoveryErrorKind(result) {
  if (result.indexUnreadable) return 'index_unreadable'
  if (result.overCap > 0) return 'too_many_projects'
  return undefined
}

/**
 * The change gate's signature: `crush.db` and `crush.db-wal`, never `-shm`.
 *
 * @param {string} dbPath
 * @param {string | null} dbPart
 * @returns {string}
 */
function statSig(dbPath, dbPart) {
  return `${dbPart ?? '-'}|${fileSig(`${dbPath}-wal`) ?? '-'}`
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
 * The sessions one changed database's reads name: rows above the cursor,
 * metadata that moved, a new session above the floor, an open entry, or an
 * entry recorded in its own `updated_at` second.
 * Sessions that moved come before re-reads of open or unsettled entries, so
 * those re-reads never spend the budget a catch-up tick owes its leftovers;
 * oldest `updated_at` first within each group, so a budget-limited tick
 * drains in order. Rows above a held cursor that an entry already covers
 * are not movement: the session committed them on an earlier tick.
 *
 * @param {CrushChanges} changes
 * @param {CrushDbWatermark} prior
 * @param {Record<string, CrushSessionWatermark>} sessions
 * @param {Set<string>} unsettled
 * @returns {CrushSessionMeta[]}
 */
function selectCandidates(changes, prior, sessions, unsettled) {
  const newMax = new Map(changes.newRows.map(r => [r.session_id, r.max_rowid]))
  /** @type {CrushSessionMeta[]} */
  const moved = []
  /** @type {CrushSessionMeta[]} */
  const reread = []
  for (const meta of changes.sessions) {
    const entry = sessions[meta.id]
    const rowsTo = newMax.get(meta.id)
    if ((rowsTo !== undefined && (!entry || rowsTo > entry.max_rowid))
      || (entry && (entry.updated_at !== meta.updated_at || entry.message_count !== meta.message_count))
      || (!entry && meta.updated_at > prior.floor)) moved.push(meta)
    else if (entry?.open || (entry && unsettled.has(meta.id))) reread.push(meta)
  }
  moved.sort(byUpdatedThenId)
  reread.sort(byUpdatedThenId)
  return moved.concat(reread)
}

/**
 * @param {CrushSessionMeta} a
 * @param {CrushSessionMeta} b
 */
function byUpdatedThenId(a, b) {
  return a.updated_at - b.updated_at || compareStrings(a.id, b.id)
}

/**
 * Reload the exclusion markers when their directory moved.
 *
 * @ref LLP 0573#privacy [implements]: only on ticks with candidates, so an
 *   idle tick reads nothing; a load error fails closed.
 * @param {CrushPollRunner} runner
 */
function refreshExclusions(runner) {
  const set = runner.ignoredSessions
  if (!set) return
  const directory = /** @type {{ directory?: string }} */ (set).directory
  let signature = 'missing'
  if (directory) {
    try {
      const stat = fs.statSync(directory)
      signature = [stat.ino, stat.mtimeMs, stat.ctimeMs].join(':')
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') throw new CrushSessionIgnoreError('session exclusions could not be read')
    }
  }
  if (signature !== runner.exclusionsSignature) {
    try {
      refreshSessionIgnores(set)
    } catch {
      throw new CrushSessionIgnoreError('session exclusions could not be loaded')
    }
    runner.exclusionsSignature = signature
  }
  const loadError = sessionIgnoreLoadError(set)
  if (loadError) {
    // Retry the load next tick rather than trust a cached signature.
    runner.exclusionsSignature = undefined
    throw new CrushSessionIgnoreError(loadError)
  }
}

/**
 * The session's own marker decides membership both ways, so an ignore or
 * unignore written since the last refresh is seen at once.
 *
 * @param {Set<string> | undefined} set
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isExcluded(set, sessionId) {
  if (!set) return false
  const directory = /** @type {{ directory?: string }} */ (set).directory
  return directory ? present(path.join(directory, markerName(sessionId))) : set.has(sessionId)
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
 * @param {CrushPollRunner} runner
 * @param {PluginActivationContext} ctx
 * @param {BackfillItem} item
 * @returns {Promise<NonNullable<CrushBatchEntry['snapshot']>>}
 */
export async function prepareProjectedItem(runner, ctx, item) {
  const materializer = ctx.backfillMaterializers.get(PROJECTED_EXCHANGE_KIND)
  if (!materializer) throw new Error(`crush capture requires the ${PROJECTED_EXCHANGE_KIND} materializer`)
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
 * The empty snapshot that removes an ignored session's rows.
 *
 * @param {PluginActivationContext} ctx
 * @param {string} sessionId
 * @returns {NonNullable<CrushBatchEntry['snapshot']>}
 */
export function emptySnapshot(ctx, sessionId) {
  const { columns } = snapshotTarget(ctx)
  return { rows: [], scope: { where: crushReconcileScope(CRUSH_CLIENT_NAME, sessionId), key: 'part_id' }, columns }
}

/**
 * @param {PluginActivationContext} ctx
 * @returns {{ columns: NonNullable<CrushBatchEntry['snapshot']>['columns'] }}
 */
function snapshotTarget(ctx) {
  const dataset = ctx.query.getDataset?.(AI_GATEWAY_MESSAGES_DATASET)
  if (!dataset) throw new Error(`crush capture requires the ${AI_GATEWAY_MESSAGES_DATASET} dataset`)
  if (!ctx.storage.reconcileRowsBatch && !ctx.storage.reconcileRows) {
    throw new Error('crush capture requires local snapshot reconciliation support')
  }
  return { columns: dataset.schema?.columns ?? [] }
}

/**
 * Commit the tick's batch and mark each session it settled. Entries with no
 * snapshot are already settled. The snapshots go to the cache in one
 * `reconcileRowsBatch` call; when that fails, or the storage has no batch
 * call, they are retried one at a time, so a session that cannot commit
 * holds back only itself and the sessions after it.
 *
 * @ref LLP 0527#batched-reconcile [implements]: one cache commit per partition per tick.
 * @param {PluginActivationContext} ctx
 * @param {CrushBatchEntry[]} batch
 * @param {(entry: CrushBatchEntry) => void} markCommitted
 * @returns {Promise<{ written: number, failed?: { err: unknown, sessionId: string | null } }>}
 */
export async function commitCrushBatch(ctx, batch, markCommitted) {
  /** @type {(CrushBatchEntry & { snapshot: NonNullable<CrushBatchEntry['snapshot']> })[]} */
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
      if (!storage.reconcileRows) return { written: 0, failed: { err, sessionId: null } }
      ctx.log.warn('crush.batch_reconcile_failed', {
        component: 'crush',
        operation: 'crush.poll',
        status: 'retrying',
        error_kind: errorKind(err),
        sessions_in_batch: pending.length,
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
      return { written, failed: { err, sessionId: entry.session_id } }
    }
    markCommitted(entry)
  }
  return { written }
}

/** @param {unknown} err @returns {string} */
export function errorKind(err) {
  if (err instanceof CrushDbError) return err.code
  if (err instanceof CrushSessionIgnoreError) return IGNORE_LOAD_FAILED
  if (isPartitionMutationBusy(err)) return 'cache_partition_mutation_busy'
  return 'unknown'
}

/**
 * Map the last discovery pass and tick to the source's health. Messages
 * carry the index path and counts only, never a project path.
 *
 * @ref LLP 0573#status [implements]: no index is `ready` with zero rows, an
 *   unreadable index, the database cap and per-database errors are
 *   `degraded`, stale entries only append a count.
 *
 * @param {CrushDiscoveryResult} result
 * @param {{
 *   indexPath: string,
 *   pollIntervalMs: number,
 *   rowsWritten: number,
 *   stopped?: boolean,
 *   errorCounts?: Record<string, number>,
 *   schemaDetail?: string,
 *   lastError?: string,
 *   lastErrorKind?: string,
 *   sessionsTracked?: number,
 *   sessionsPending?: number,
 *   lastPollAt?: string,
 * }} opts
 * @returns {SourceStatus}
 */
export function crushSourceStatus(result, opts) {
  const { indexPath, pollIntervalMs, rowsWritten } = opts
  const counts = opts.errorCounts ?? {}
  const unreadable = (counts.permission_denied ?? 0) + (counts.open_failed ?? 0) + (counts.sqlite_unavailable ?? 0)
  /** @type {string | null} */
  let errorKind = null
  /** @type {string} */
  let message
  if (result.indexUnreadable) {
    errorKind = 'index_unreadable'
    message = `cannot read the crush index at ${indexPath}`
  } else if (result.overCap > 0) {
    errorKind = 'too_many_projects'
    message = `${groupThousands(result.overCap)} crush projects skipped over the ${groupThousands(MAX_DATABASES)} limit`
  } else if (counts.schema_unsupported) {
    errorKind = 'schema_unsupported'
    const detail = opts.schemaDetail ?? 'crush.db has an unsupported schema'
    message = `${detail} (${groupThousands(counts.schema_unsupported)} crush databases)`
  } else if (unreadable > 0) {
    errorKind = counts.permission_denied ? 'permission_denied' : counts.open_failed ? 'open_failed' : 'sqlite_unavailable'
    message = `cannot read ${groupThousands(unreadable)} crush databases`
  } else if (counts.sqlite_busy) {
    errorKind = 'sqlite_busy'
    message = `${groupThousands(counts.sqlite_busy)} crush databases busy, retrying next poll`
  } else if (counts.session_collision) {
    errorKind = 'session_collision'
    message = `${groupThousands(counts.session_collision)} sessions appear in more than one crush database`
  } else if (opts.lastError) {
    errorKind = opts.lastErrorKind ?? 'unknown'
    message = opts.lastError
  } else if (!result.indexPresent && result.listed === 0) {
    message = `no crush installation detected at ${indexPath}`
  } else if (result.listed === 0) {
    message = `crush index at ${indexPath} lists no projects yet`
  } else {
    const every = `polling ${groupThousands(result.databases.length)} crush projects every ${pollIntervalMs}ms`
    message = rowsWritten > 0 ? every : `${every}, no sessions yet`
  }
  if (result.stale > 0) message = `${message}; ${groupThousands(result.stale)} listed projects have no crush.db`

  /** @type {SourceStatus} */
  const status = {
    state: opts.stopped ? 'stopped' : errorKind ? 'degraded' : 'ready',
    message,
    rowsWritten,
    details: {
      index_path: indexPath,
      poll_interval_ms: pollIntervalMs,
      databases: result.databases.length,
      stale: result.stale,
      over_cap: result.overCap,
      ...(opts.sessionsTracked !== undefined ? { sessions_tracked: opts.sessionsTracked } : {}),
      ...(opts.sessionsPending !== undefined ? { sessions_pending: opts.sessionsPending } : {}),
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
  const indexPath = resolveIndexPath(ctx, resolveHomeDir(ctx))
  ctx.log.info('crush.source_disabled', {
    component: 'crush',
    operation: 'crush.start',
    detail: 'crush.enabled = false',
  })
  return {
    async status() {
      return {
        state: 'ready',
        message: 'crush ongoing capture disabled (crush.enabled = false)',
        rowsWritten: 0,
        details: { index_path: indexPath, enabled: false },
      }
    },
    async reload() {},
    async stop() {},
  }
}
