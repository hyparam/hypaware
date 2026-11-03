// @ts-check

/**
 * Poll source for `@hypaware/goose`: `startGooseSource(ctx)` is the
 * `SourceContribution.start` callback that gives Goose ongoing capture from
 * its own `sessions.db` (LLP 0570).
 *
 * @ref LLP 0570#source [implements]: start awaits one bounded tick, then
 *   polls on `poll_interval`, with catch-up ticks while sessions are pending.
 * @ref LLP 0570#reconciliation [implements]: change detection by range reads
 *   against two cursors, then a whole-session snapshot reconcile per change.
 *
 * @import { BackfillItem, PluginActivationContext, SourceStatus, StartedSource } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { GooseBatchEntry, GooseChanges, GoosePollRunner, GooseRunnerHolder, GooseWatermarkState } from './types.js'
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
import { resolveGooseEnabled, resolveHomeDir, resolvePollIntervalMs, resolveSessionsDbPath } from './config.js'
import { GooseSessionsDbError } from './errors.js'
import { GOOSE_CLIENT_NAME, gooseReconcileScope, projectGooseSession } from './projector.js'
import { openGooseSessionsDb } from './sessions_db.js'
import { emptyGooseWatermark, readGooseWatermark, writeGooseWatermark } from './watermark.js'

const PLUGIN_NAME = '@hypaware/goose'

/**
 * How many changed sessions one poll tick reconciles, as one batch with one
 * commit and one watermark flush. Changed sessions past the budget wait for
 * a catch-up tick, so start never holds for a large burst of changes.
 * @ref LLP 0527#tick-budget [implements]: start commits at most one batch whatever the change volume.
 */
export const GOOSE_SESSIONS_PER_TICK = 64

/**
 * The batch also stops admitting sessions once it holds this many projected
 * rows. A session is projected whole, so the last one admitted can carry the
 * batch past this. The first session is always admitted.
 */
export const GOOSE_ROWS_PER_TICK = 4096

/** Delay before a catch-up tick when a healthy tick left sessions pending. */
export const GOOSE_CATCH_UP_DELAY_MS = 1000

/** The `error_kind` of a session-exclusions store that could not be loaded. */
const IGNORE_LOAD_FAILED = 'session_ignore_load_failed'

/** A session-exclusions load failure, which fails the tick closed. */
class GooseSessionIgnoreError extends Error {}

/**
 * `startGooseSource(ctx, opts)` is the `SourceContribution.start` callback.
 *
 * @param {PluginActivationContext} ctx
 * @param {{ ignoredSessions?: Set<string>, holder?: GooseRunnerHolder }} [opts]
 * @returns {Promise<StartedSource>}
 */
export async function startGooseSource(ctx, opts = {}) {
  // @ref LLP 0570#config [implements]: the `enabled: false` kill switch is
  // checked in `start`, not `activate()`, because the daemon runtime starts
  // every registered source (issue #348).
  if (!resolveGooseEnabled(ctx.config)) return createDisabledSource(ctx)

  const runner = createGoosePollRunner(ctx, opts)
  // The backfill sweep shares this runner's in-memory watermark (LLP 0570#backfill).
  if (opts.holder) opts.holder.runner = runner
  let activeCtx = ctx
  let stopped = false
  /** @type {NodeJS.Timeout | null} */
  let handle = null
  /** @type {Promise<void> | null} */
  let inFlight = null
  /** @type {NodeJS.Timeout | null} */
  let catchUp = null

  // A healthy tick that left sessions pending asks for another one soon. A
  // failed tick never does: it waits for the poll timer, so a persistent
  // failure cannot spin.
  function scheduleCatchUp() {
    if (stopped || catchUp || runner.lastError || runner.sessionsPending === 0) return
    catchUp = setTimeout(() => {
      catchUp = null
      runTick()
    }, GOOSE_CATCH_UP_DELAY_MS)
    if (typeof catchUp.unref === 'function') catchUp.unref()
  }

  function runTick() {
    if (stopped || inFlight) return
    inFlight = runGoosePollTick(runner, activeCtx).finally(() => {
      inFlight = null
      scheduleCatchUp()
    })
  }

  // @ref LLP 0527#tick-budget [implements]: the first poll is one budgeted
  // batch; any remainder is reconciled by catch-up ticks after start returns.
  await runGoosePollTick(runner, activeCtx)

  function startTimer() {
    handle = setInterval(runTick, runner.pollIntervalMs)
    if (typeof handle.unref === 'function') handle.unref()
  }
  startTimer()
  scheduleCatchUp()

  return {
    async status() {
      return gooseSourceStatus(runner, stopped)
    },

    async reload(nextCtx) {
      activeCtx = nextCtx
      const homeDir = resolveHomeDir(nextCtx)
      const nextSessionsDbPath = resolveSessionsDbPath(nextCtx, homeDir)
      const nextPollIntervalMs = resolvePollIntervalMs(nextCtx)

      runner.homeDir = homeDir
      if (nextSessionsDbPath !== runner.sessionsDbPath) {
        if (runner.db) {
          runner.db.close()
          runner.db = null
        }
        runner.sessionsDbPath = nextSessionsDbPath
        // The sidecar's cursors name the old database: baseline the new one.
        runner.watermark = emptyGooseWatermark()
        runner.dataVersion = null
        runner.idleLogged = false
      }
      if (nextPollIntervalMs !== runner.pollIntervalMs) {
        runner.pollIntervalMs = nextPollIntervalMs
        if (handle) clearInterval(handle)
        startTimer()
      }
    },

    async stop() {
      stopped = true
      if (handle) {
        clearInterval(handle)
        handle = null
      }
      if (catchUp) {
        clearTimeout(catchUp)
        catchUp = null
      }
      if (inFlight) await inFlight.catch(() => {})
      if (runner.db) {
        runner.db.close()
        runner.db = null
      }
    },
  }
}

/**
 * The source health `hyp status` reports (LLP 0570#status). The database
 * path appears here and nowhere in logs.
 *
 * @param {GoosePollRunner} runner
 * @param {boolean} [stopped]
 * @returns {SourceStatus}
 */
export function gooseSourceStatus(runner, stopped = false) {
  const every = `polling ${runner.sessionsDbPath} every ${runner.pollIntervalMs}ms`
  /** @type {string} */
  let message
  if (runner.lastError) {
    if (runner.lastErrorKind === 'permission_denied') message = `cannot read the database at ${runner.sessionsDbPath}`
    else if (runner.lastErrorKind === 'sqlite_busy') message = 'database busy, retrying next poll'
    else message = runner.lastError
  } else if (!runner.db) {
    // @ref LLP 0570#status [implements]: a missing `sessions.db` is `ready`
    // with zero rows, not an error: most hosts never install Goose.
    message = `no goose installation detected at ${runner.sessionsDbPath}`
  } else {
    message = runner.noSessions ? `${every}, no sessions yet` : every
  }
  /** @type {SourceStatus} */
  const status = {
    state: stopped ? 'stopped' : runner.lastError ? 'degraded' : 'ready',
    message,
    rowsWritten: runner.rowsWritten,
    details: {
      sessions_db: runner.sessionsDbPath,
      poll_interval_ms: runner.pollIntervalMs,
      sessions_tracked: runner.sessionsTracked,
      sessions_pending: runner.sessionsPending,
      last_poll_at: runner.lastPollAt ?? null,
    },
  }
  if (runner.lastError) {
    status.lastError = runner.lastError
    if (status.details && runner.lastErrorKind) status.details.error_kind = runner.lastErrorKind
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
  const sessionsDbPath = resolveSessionsDbPath(ctx, resolveHomeDir(ctx))
  ctx.log.info('goose.source_disabled', {
    component: 'goose',
    operation: 'goose.start',
    detail: 'goose.enabled = false',
  })
  return {
    async status() {
      return {
        state: 'ready',
        message: 'goose ongoing capture disabled (goose.enabled = false)',
        rowsWritten: 0,
        details: { sessions_db: sessionsDbPath, enabled: false },
      }
    },
    async reload() {},
    async stop() {},
  }
}

/**
 * Build a fresh {@link GoosePollRunner}. Exported so tests can drive
 * {@link runGoosePollTick} without timers.
 *
 * @param {PluginActivationContext} ctx
 * @param {{ ignoredSessions?: Set<string>, holder?: GooseRunnerHolder }} [opts]
 * @returns {GoosePollRunner}
 */
export function createGoosePollRunner(ctx, opts = {}) {
  const homeDir = resolveHomeDir(ctx)
  const localOnlyList = localOnlyListPath(readObservabilityEnv(ctx.env).stateDir)
  return {
    sessionsDbPath: resolveSessionsDbPath(ctx, homeDir),
    pollIntervalMs: resolvePollIntervalMs(ctx),
    homeDir,
    stateDir: ctx.paths.stateDir,
    resolver: createUsagePolicyResolver({ localOnlyListPath: localOnlyList }),
    devRunId: randomUUID(),
    db: null,
    watermark: null,
    dataVersion: null,
    rowsWritten: 0,
    sessionsTracked: 0,
    sessionsPending: 0,
    idleLogged: false,
    noSessions: true,
    ...(opts.ignoredSessions ? { ignoredSessions: opts.ignoredSessions } : {}),
  }
}

/**
 * Run one poll tick against `runner`, mutating it in place. Never throws: an
 * error degrades `runner.lastError` and is logged by kind only.
 *
 * @param {GoosePollRunner} runner
 * @param {PluginActivationContext} ctx
 * @returns {Promise<void>}
 */
export async function runGoosePollTick(runner, ctx) {
  runner.devRunId = randomUUID()
  /** @type {unknown} */
  let failure
  try {
    await withSpan(
      'goose.poll',
      {
        [Attr.COMPONENT]: 'goose',
        [Attr.OPERATION]: 'goose.poll',
        [Attr.PLUGIN]: PLUGIN_NAME,
        status: 'ok',
      },
      async (span) => {
        try {
          if (!runner.db) {
            const opened = await tryOpen(runner, ctx)
            span.setAttribute('mode', opened ? 'active' : 'idle')
            if (!opened) return
          } else {
            span.setAttribute('mode', 'active')
          }
          const result = await pollOnce(runner, ctx)
          span.setAttribute('poll_status', result.status)
          span.setAttribute('sessions_changed', result.sessionsChanged)
          span.setAttribute('sessions_pending', runner.sessionsPending)
          span.setAttribute('rows', result.rows)
          // `status` is the fixed attribute set (LLP 0021), which would rewrite
          // `baseline` and `unchanged` to `failed`; the tick outcome rides
          // `poll_status`, as it does on the span.
          ctx.log.info('goose.poll', {
            component: 'goose',
            operation: 'goose.poll',
            status: 'ok',
            poll_status: result.status,
            sessions_changed: result.sessionsChanged,
            sessions_pending: runner.sessionsPending,
            rows: result.rows,
          })
        } catch (err) {
          // @ref LLP 0570#privacy [implements]: `withSpan` records the thrown
          // message, which can name the database path; the span gets the kind
          // and a path-free error, and status keeps the original message.
          failure = err
          const kind = errorKind(err)
          span.setAttribute('error_kind', kind)
          throw new Error(`goose poll failed: ${kind}`)
        }
      },
      { component: 'goose' }
    )
    runner.lastPollAt = new Date().toISOString()
    runner.lastError = undefined
    runner.lastErrorKind = undefined
  } catch (thrown) {
    const err = failure ?? thrown
    const kind = errorKind(err)
    runner.lastError = err instanceof Error ? err.message : String(err)
    runner.lastErrorKind = kind
    // @ref LLP 0570#privacy [implements]: the failure is logged by kind; the
    // message can carry the database path, which belongs in status only.
    ctx.log.error('goose.poll', {
      component: 'goose',
      operation: 'goose.poll',
      status: 'failed',
      sessions_pending: runner.sessionsPending,
      error_kind: kind,
    })
  }
}

/**
 * The body of an active tick, after the database is open.
 *
 * @param {GoosePollRunner} runner
 * @param {PluginActivationContext} ctx
 * @returns {Promise<{ status: 'ok' | 'unchanged' | 'baseline', sessionsChanged: number, rows: number }>}
 */
async function pollOnce(runner, ctx) {
  const db = /** @type {NonNullable<GoosePollRunner['db']>} */ (runner.db)
  const watermark = runner.watermark ?? (runner.watermark = emptyGooseWatermark())
  // Read before the detection read, stored only after success, so a commit
  // that lands mid-tick moves it again and the next tick looks.
  const version = await db.dataVersion()

  if (watermark.cursor_id === null || watermark.cursor_updated_at === null) {
    await baseline(runner, db, watermark, version)
    return { status: 'baseline', sessionsChanged: 0, rows: 0 }
  }

  // @ref LLP 0570#cost [implements]: an idle tick is one `PRAGMA data_version`.
  if (runner.sessionsPending === 0 && version === runner.dataVersion) {
    return { status: 'unchanged', sessionsChanged: 0, rows: 0 }
  }

  const changes = await db.detectChanges(watermark.cursor_id, watermark.cursor_updated_at)
  runner.noSessions = changes.maxUpdatedAt === null
  const candidates = orderCandidates(changes)
  if (candidates.length > 0) refreshExclusions(runner)

  let pendingMarks = 0
  let sessionsPersisted = 0
  /** @param {GooseBatchEntry} entry */
  const markCommitted = (entry) => {
    if (entry.mark) watermark.sessions[entry.session_id] = entry.mark
    else delete watermark.sessions[entry.session_id]
    pendingMarks += 1
  }

  /** @type {GooseBatchEntry[]} */
  const batch = []
  /** @type {(() => void)[]} */
  const releases = []
  let admitted = 0
  let batchRows = 0
  let sessionsPending = 0
  let sessionsDeferred = 0
  let allSettled = true
  /** @type {number | null} */
  let holdBelow = null
  /** @type {{ err: unknown, sessionId: string } | null} */
  let failure = null
  /** @type {{ err: unknown, sessionId: string | null } | null} */
  let commitFailure = null
  let written = 0

  /** @param {{ id: string, first_id: number | null }} candidate */
  const hold = (candidate) => {
    allSettled = false
    if (candidate.first_id !== null && (holdBelow === null || candidate.first_id < holdBelow)) holdBelow = candidate.first_id
  }

  try {
    for (const candidate of candidates) {
      if (failure) {
        sessionsPending += 1
        hold(candidate)
        continue
      }
      const entry = watermark.sessions[candidate.id]
      // @ref LLP 0570#reconciliation [implements]: step 3, a candidate whose
      // `{updated_at, max_id}` both match is a no-op and is not hashed.
      if (entry && entry.updated_at === candidate.updated_at
        && await db.maxMessageId(candidate.id) === entry.max_id) continue
      // @ref LLP 0570#privacy [implements]: an excluded session is not
      // projected and its entry does not advance; the cursors move past it.
      if (isExcluded(runner.ignoredSessions, candidate.id)) continue
      if (admitted >= GOOSE_SESSIONS_PER_TICK || (admitted > 0 && batchRows >= GOOSE_ROWS_PER_TICK)) {
        sessionsPending += 1
        hold(candidate)
        continue
      }
      // @ref LLP 0449#read-commit-guard [implements]: claim before the
      // authoritative read, hold through the commit. A scope another writer
      // holds is deferred and holds the cursors, so the next tick finds it.
      // @ref LLP 0527#batched-reconcile [constrained-by]: every claim in the
      // batch is held until the batch commit returns.
      try {
        releases.push(ctx.storage.claimReconcileScope?.(AI_GATEWAY_MESSAGES_DATASET,
          gooseReconcileScope(GOOSE_CLIENT_NAME, candidate.id)) ?? (() => {}))
      } catch (claimErr) {
        hold(candidate)
        if (!isPartitionMutationBusy(claimErr)) {
          failure = { err: claimErr, sessionId: candidate.id }
          continue
        }
        sessionsDeferred += 1
        sessionsPending += 1
        ctx.log.info('goose.session_deferred', {
          component: 'goose',
          operation: 'goose.poll',
          status: 'deferred',
          error_kind: 'cache_partition_mutation_busy',
          session_id: candidate.id,
        })
        continue
      }
      admitted += 1
      try {
        const snapshot = await db.readSessionSnapshot(candidate.id)
        // Gone or hidden since the detection read: drop its entry.
        if (!snapshot) {
          batch.push({ session_id: candidate.id, mark: null })
          continue
        }
        if (entry?.digest !== undefined && entry.digest === snapshot.mark.digest) {
          batch.push({ session_id: candidate.id, mark: snapshot.mark })
          continue
        }
        const item = await projectGooseSession({
          session: snapshot.session,
          messages: snapshot.messages,
          sourcePath: runner.sessionsDbPath,
          clientName: GOOSE_CLIENT_NAME,
          resolver: runner.resolver,
          log: ctx.log,
        })
        // @ref LLP 0570#privacy [implements]: a usage-policy ignore reconciles
        // the session to an empty snapshot, removing rows captured before.
        const prepared = item
          ? await prepareProjectedItem(runner, ctx, item)
          : emptySnapshot(ctx, candidate.id)
        batchRows += prepared.rows.length
        batch.push({ session_id: candidate.id, mark: snapshot.mark, snapshot: prepared })
      } catch (err) {
        hold(candidate)
        failure = { err, sessionId: candidate.id }
      }
    }
    const committed = await commitGooseBatch(ctx, batch, markCommitted)
    written = committed.written
    if (committed.failed) commitFailure = committed.failed
  } finally {
    for (const release of releases) release()
  }

  const tickError = failure?.err ?? commitFailure?.err
  let cursorsMoved = false
  if (!tickError) {
    const nextCursorId = holdBelow !== null ? holdBelow - 1 : (changes.maxId ?? watermark.cursor_id)
    const nextCursorUpdatedAt = allSettled ? (changes.maxUpdatedAt ?? watermark.cursor_updated_at) : watermark.cursor_updated_at
    cursorsMoved = nextCursorId !== watermark.cursor_id || nextCursorUpdatedAt !== watermark.cursor_updated_at
    watermark.cursor_id = nextCursorId
    watermark.cursor_updated_at = nextCursorUpdatedAt
    watermark.data_version = version
  }
  try {
    if (pendingMarks > 0 || cursorsMoved) {
      writeGooseWatermark(runner.stateDir, watermark)
      sessionsPersisted = pendingMarks
    }
  } catch (flushErr) {
    // The marks stay in memory, so this tick's work is not repeated
    // in-process. When a session is the tick's error, that error is the one
    // to report; this record names the unwritable sidecar.
    ctx.log.warn('goose.watermark_flush_failed', {
      component: 'goose',
      operation: 'goose.poll',
      error_kind: errorKind(flushErr),
      sessions_persisted: 0,
      sessions_changed: candidates.length,
    })
    if (!tickError) throw flushErr
  }
  for (const broke of [failure, commitFailure]) {
    if (!broke) continue
    /** @type {Record<string, unknown>} */
    const fields = {
      component: 'goose',
      operation: 'goose.poll',
      status: 'partial',
      error_kind: errorKind(broke.err),
      sessions_persisted: sessionsPersisted,
      sessions_changed: candidates.length,
    }
    if (broke.sessionId !== null) {
      fields.session_id = broke.sessionId
    } else {
      // A batch commit failed as a whole: name the batch it held.
      const staged = batch.filter(entry => entry.snapshot)
      fields.sessions_in_batch = staged.length
      fields.first_session_id = staged[0]?.session_id
      fields.last_session_id = staged[staged.length - 1]?.session_id
    }
    ctx.log.warn('goose.session_reconcile_failed', fields)
  }
  runner.rowsWritten += written
  runner.sessionsTracked = Object.keys(watermark.sessions).length
  runner.sessionsPending = sessionsPending
  if (tickError) throw tickError

  runner.dataVersion = version
  return { status: 'ok', sessionsChanged: candidates.length, rows: written }
}

/**
 * First start: set the cursors to the store's current maxima so the poll
 * does not walk history (the backfill's job), and seed entries for the
 * sessions at the time cursor, which the inclusive bound reads again. The
 * seeds carry no digest, so a later change to one forces a reconcile.
 *
 * @param {GoosePollRunner} runner
 * @param {NonNullable<GoosePollRunner['db']>} db
 * @param {GooseWatermarkState} watermark
 * @param {number} version
 */
async function baseline(runner, db, watermark, version) {
  const { maxId, maxUpdatedAt } = await db.maxima()
  const seeds = maxUpdatedAt === null ? [] : await db.sessionsAt(maxUpdatedAt)
  for (const seed of seeds) watermark.sessions[seed.id] = { updated_at: seed.updated_at, max_id: seed.max_id }
  watermark.cursor_id = maxId ?? 0
  watermark.cursor_updated_at = maxUpdatedAt ?? ''
  watermark.data_version = version
  writeGooseWatermark(runner.stateDir, watermark)
  runner.noSessions = maxUpdatedAt === null
  runner.sessionsTracked = Object.keys(watermark.sessions).length
  runner.sessionsPending = 0
  runner.dataVersion = version
}

/**
 * Admission order: sessions with new messages by their first new id, then
 * sessions found only by `updated_at`, oldest first.
 *
 * @param {GooseChanges} changes
 * @returns {{ id: string, first_id: number | null, updated_at: string | null }[]}
 */
function orderCandidates(changes) {
  const withMessages = changes.newMessages
    .map(row => ({ id: row.session_id, first_id: row.first_id, updated_at: row.updated_at }))
    .sort((a, b) => a.first_id - b.first_id)
  const seen = new Set(withMessages.map(row => row.id))
  /** @type {{ id: string, first_id: number | null, updated_at: string | null }[]} */
  const out = withMessages
  for (const row of changes.updated) {
    if (!seen.has(row.id)) out.push({ id: row.id, first_id: null, updated_at: row.updated_at })
  }
  return out
}

/**
 * Refresh the session exclusions when the store directory's signature moved,
 * and fail the tick closed when they cannot be loaded.
 *
 * @ref LLP 0570#privacy [implements]: only on ticks with candidates, so an idle tick reads nothing.
 * @param {GoosePollRunner} runner
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
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') throw new GooseSessionIgnoreError('session exclusions could not be read')
    }
  }
  if (signature !== runner.exclusionsSignature) {
    try {
      refreshSessionIgnores(set)
    } catch {
      throw new GooseSessionIgnoreError('session exclusions could not be loaded')
    }
    runner.exclusionsSignature = signature
  }
  const loadError = sessionIgnoreLoadError(set)
  if (loadError) {
    // Retry the load next tick rather than trust a cached signature.
    runner.exclusionsSignature = undefined
    throw new GooseSessionIgnoreError(loadError)
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
 * Probe `runner.sessionsDbPath` and open it when present. A missing file is
 * the not-installed case: logged once, reported as idle. Any other error
 * propagates to the tick's catch.
 *
 * @param {GoosePollRunner} runner
 * @param {PluginActivationContext} ctx
 * @returns {Promise<boolean>} whether `runner.db` is now open
 */
async function tryOpen(runner, ctx) {
  try {
    runner.db = await openGooseSessionsDb(runner.sessionsDbPath)
  } catch (err) {
    if (err instanceof GooseSessionsDbError && err.code === 'missing') {
      if (!runner.idleLogged) {
        ctx.log.info('goose.source_idle', {
          component: 'goose',
          operation: 'goose.poll',
          detail: 'no goose installation detected',
        })
        runner.idleLogged = true
      }
      return false
    }
    throw err
  }
  // `data_version` is local to a connection, so a new one starts unknown.
  runner.dataVersion = null
  if (!runner.watermark) runner.watermark = readGooseWatermark(runner.stateDir)
  runner.idleLogged = false
  ctx.log.info('goose.source_activated', { component: 'goose', operation: 'goose.poll' })
  return true
}

/**
 * Materialize one projected-exchange item through the shared
 * `ai_gateway.projected_exchange` materializer into a scoped snapshot for
 * the batch commit. Throws when the seam is missing, so nothing advances.
 *
 * @param {GoosePollRunner} runner
 * @param {PluginActivationContext} ctx
 * @param {BackfillItem} item
 * @returns {Promise<NonNullable<GooseBatchEntry['snapshot']>>}
 */
async function prepareProjectedItem(runner, ctx, item) {
  const materializer = ctx.backfillMaterializers.get(PROJECTED_EXCHANGE_KIND)
  if (!materializer) throw new Error(`goose capture requires the ${PROJECTED_EXCHANGE_KIND} materializer`)
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
 * @returns {NonNullable<GooseBatchEntry['snapshot']>}
 */
function emptySnapshot(ctx, sessionId) {
  const { columns } = snapshotTarget(ctx)
  return { rows: [], scope: { where: gooseReconcileScope(GOOSE_CLIENT_NAME, sessionId), key: 'part_id' }, columns }
}

/**
 * @param {PluginActivationContext} ctx
 * @returns {{ columns: NonNullable<GooseBatchEntry['snapshot']>['columns'] }}
 */
function snapshotTarget(ctx) {
  const dataset = ctx.query.getDataset?.(AI_GATEWAY_MESSAGES_DATASET)
  if (!dataset) throw new Error(`goose capture requires the ${AI_GATEWAY_MESSAGES_DATASET} dataset`)
  if (!ctx.storage.reconcileRowsBatch && !ctx.storage.reconcileRows) {
    throw new Error('goose capture requires local snapshot reconciliation support')
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
 * @param {GooseBatchEntry[]} batch
 * @param {(entry: GooseBatchEntry) => void} markCommitted
 * @returns {Promise<{ written: number, failed?: { err: unknown, sessionId: string | null } }>}
 */
async function commitGooseBatch(ctx, batch, markCommitted) {
  /** @type {(GooseBatchEntry & { snapshot: NonNullable<GooseBatchEntry['snapshot']> })[]} */
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
      ctx.log.warn('goose.batch_reconcile_failed', {
        component: 'goose',
        operation: 'goose.poll',
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
function errorKind(err) {
  if (err instanceof GooseSessionsDbError) return err.code
  if (err instanceof GooseSessionIgnoreError) return IGNORE_LOAD_FAILED
  if (isPartitionMutationBusy(err)) return 'cache_partition_mutation_busy'
  return 'unknown'
}
