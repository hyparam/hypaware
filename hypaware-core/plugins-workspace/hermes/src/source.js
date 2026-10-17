// @ts-check

/**
 * Poll source for `@hypaware/hermes`: `startHermesSource(ctx)` is the
 * `SourceContribution.start` callback that gives hermes ongoing capture
 * (spec R6) without a gateway proxy in front of hermes's own LLM traffic
 * (spec R8, LLP 0119).
 *
 * @ref LLP 0122#source [implements]: start probes `state_db` (missing ->
 *   idle, present -> open + load watermark + start the poll timer),
 *   `status()`/`reload()`/`stop()`.
 * @ref LLP 0449#reconciliation [implements]: reconcile whole visible sessions,
 *   including rewinds and in-place edits, through the shared cache writer.
 * @ref LLP 0118#requirements [implements]: spec R9, no `~/.hermes/state.db`
 *   -> idle mode, `status()` reports it, no error noise, and the same poll
 *   timer re-probes each tick so an install that appears later is picked up
 *   without a daemon restart.
 * @ref LLP 0118#requirements [implements]: spec R7, a `hermes.poll` span
 *   per tick (`component: 'hermes'`, sessions examined, rows appended,
 *   `error_kind` on failure) plus `status()` surfacing state, rows
 *   written, watermark position, and the last error.
 *
 * @import { BackfillItem, JsonObject, PluginActivationContext, SourceStatus, StartedSource } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 * @import { HermesBatchEntry, HermesWatermarkState } from './types.js'
 * @import { HermesStateDb } from './state_db.js'
 */

import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { isPartitionMutationBusy } from '../../../../src/core/util/mutation_guard.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { createUsagePolicyResolver, localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { AI_GATEWAY_MESSAGES_DATASET, PROJECTED_EXCHANGE_KIND } from '../../../../src/core/backfill/scan_util.js'
import { resolveHermesEnabled } from './config.js'
import { HermesStateDbError } from './errors.js'
import { HERMES_CLIENT_NAME, hermesReconcileScope, projectHermesSession } from './projector.js'
import { openHermesStateDb } from './state_db.js'
import { readHermesWatermark, writeHermesWatermark } from './watermark.js'

const PLUGIN_NAME = '@hypaware/hermes'

/** Default poll interval when config carries none: LLP 0122#config's `poll_interval = "60s"`. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000

/** The cache partition segment hermes's poll writes land under, distinct from `hyp backfill`'s `backfill` segment. */
export const HERMES_PARTITION_SEGMENT = 'hermes'

/**
 * How many changed sessions one poll tick reconciles. The tick reconciles
 * them as one batch, a single metadata load and commit per cache partition,
 * then persists the watermark once, so a restart repeats at most this one
 * uncommitted batch. Changed sessions past the budget wait for the next tick,
 * which keeps a pass that flags every session (a first tick, a lost sidecar,
 * the LLP 0449 fingerprint upgrade) from holding daemon start for the whole
 * history. A session another writer holds is deferred and does not count.
 * @ref LLP 0527#tick-budget [implements]: start does a bounded amount of work whatever the history size.
 */
export const HERMES_SESSIONS_PER_TICK = 64

/**
 * The batch also stops admitting sessions once it holds this many projected
 * rows, so its memory stays bounded when sessions are long. The first session
 * is always admitted, so one oversized session still makes progress.
 */
export const HERMES_ROWS_PER_TICK = 4096

/**
 * Delay before a catch-up tick when a healthy tick left changed sessions
 * past its budget, so a large repair pass converges in seconds of wall time
 * rather than one batch per poll interval, while each batch still yields the
 * event loop to the daemon.
 */
export const HERMES_CATCH_UP_DELAY_MS = 1000

/**
 * Mutable poll-tick state for one `startHermesSource` lifetime. Exported
 * (via {@link createHermesPollRunner}) and threaded explicitly through
 * {@link runHermesPollTick} rather than closed over privately, so tests can
 * drive multiple ticks deterministically without real timers.
 *
 * @typedef {{
 *   stateDbPath: string,
 *   pollIntervalMs: number,
 *   homeDir: string,
 *   stateDir: string,
 *   resolver: UsagePolicyResolver,
 *   devRunId: string,
 *   db: HermesStateDb | null,
 *   watermark: HermesWatermarkState,
 *   rowsWritten: number,
 *   sessionsTracked: number,
 *   sessionsPending: number,
 *   lastPollAt: string | undefined,
 *   lastError: string | undefined,
 *   idleLogged: boolean,
 * }} HermesPollRunner
 */

/**
 * `startHermesSource(ctx)` is the `SourceContribution.start` callback.
 *
 * @param {PluginActivationContext} ctx
 * @returns {Promise<StartedSource>}
 */
export async function startHermesSource(ctx) {
  // @ref LLP 0122#config [implements]: the `enabled: false` static kill switch.
  // It is enforced here (in the `start` callback), not in `activate()`, so it
  // holds no matter who starts the source. `activate()` only registers the
  // source; the daemon runtime is the sole starter (issue #348), and it starts
  // every registered source unconditionally, so the gate has to live on this
  // side of the boundary.
  if (!resolveHermesEnabled(ctx.config)) return createDisabledSource(ctx)

  const runner = createHermesPollRunner(ctx)
  let activeCtx = ctx
  let stopped = false
  /** @type {NodeJS.Timeout | null} */
  let handle = null
  /** @type {Promise<void> | null} */
  let inFlight = null
  /** @type {NodeJS.Timeout | null} */
  let catchUp = null

  // A healthy tick that left changed sessions past its budget asks for
  // another one soon. A failed tick never does: it waits for the poll timer,
  // so a persistent failure cannot spin.
  function scheduleCatchUp() {
    if (stopped || catchUp || runner.lastError || runner.sessionsPending === 0) return
    catchUp = setTimeout(() => {
      catchUp = null
      runTick()
    }, HERMES_CATCH_UP_DELAY_MS)
    if (typeof catchUp.unref === 'function') catchUp.unref()
  }

  function runTick() {
    if (stopped || inFlight) return
    inFlight = runHermesPollTick(runner, activeCtx).finally(() => {
      inFlight = null
      scheduleCatchUp()
    })
  }

  // @ref LLP 0122#source [implements]: the initial probe/open/first-poll
  // happens synchronously during start, not only on the first timer fire.
  // @ref LLP 0527#tick-budget [implements]: that first poll is one budgeted
  // batch; any remainder is reconciled by catch-up ticks after start returns.
  await runHermesPollTick(runner, activeCtx)

  function startTimer() {
    handle = setInterval(runTick, runner.pollIntervalMs)
    if (typeof handle.unref === 'function') handle.unref()
  }
  startTimer()
  scheduleCatchUp()

  return {
    async status() {
      /** @type {SourceStatus} */
      const status = {
        state: stopped ? 'stopped' : runner.lastError ? 'degraded' : 'ready',
        message: runner.db
          ? `polling ${runner.stateDbPath} every ${runner.pollIntervalMs}ms`
          : 'no hermes installation detected',
        rowsWritten: runner.rowsWritten,
        details: {
          state_db: runner.stateDbPath,
          poll_interval_ms: runner.pollIntervalMs,
          sessions_tracked: runner.sessionsTracked,
          last_poll_at: runner.lastPollAt ?? null,
          watermark: /** @type {JsonObject} */ (/** @type {unknown} */ (runner.watermark)),
        },
      }
      if (runner.lastError) status.lastError = runner.lastError
      return status
    },

    async reload(nextCtx) {
      activeCtx = nextCtx
      const homeDir = resolveHomeDir(nextCtx)
      const nextStateDbPath = resolveStateDbPath(nextCtx, homeDir)
      const nextPollIntervalMs = resolvePollIntervalMs(nextCtx)

      runner.homeDir = homeDir
      if (nextStateDbPath !== runner.stateDbPath) {
        if (runner.db) {
          runner.db.close()
          runner.db = null
        }
        runner.stateDbPath = nextStateDbPath
        runner.watermark = {}
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
 * The `StartedSource` returned when `enabled: false` turns ongoing capture
 * off (LLP 0122#config). It opens nothing, runs no timer, and reports a
 * stable disabled status, so a kill-switched source is a clean no-op the
 * daemon can list without special-casing. `hyp backfill hermes` is
 * unaffected: the backfill provider is registered independently in
 * `activate()`.
 *
 * @param {PluginActivationContext} ctx
 * @returns {StartedSource}
 */
function createDisabledSource(ctx) {
  const homeDir = resolveHomeDir(ctx)
  const stateDbPath = resolveStateDbPath(ctx, homeDir)
  ctx.log.info('hermes.source_disabled', {
    component: 'hermes',
    operation: 'hermes.start',
    state_db: stateDbPath,
    detail: 'hermes.enabled = false',
  })
  return {
    async status() {
      return {
        state: 'ready',
        message: 'hermes ongoing capture disabled (hermes.enabled = false)',
        rowsWritten: 0,
        details: { state_db: stateDbPath, enabled: false },
      }
    },
    async reload() {},
    async stop() {},
  }
}

/**
 * Build a fresh {@link HermesPollRunner} from the activation context's
 * config slice. Exported so tests can drive {@link runHermesPollTick}
 * directly, without going through `startHermesSource`'s timer.
 *
 * @param {PluginActivationContext} ctx
 * @returns {HermesPollRunner}
 */
export function createHermesPollRunner(ctx) {
  const homeDir = resolveHomeDir(ctx)
  const localOnlyList = localOnlyListPath(readObservabilityEnv(ctx.env).stateDir)
  return {
    stateDbPath: resolveStateDbPath(ctx, homeDir),
    pollIntervalMs: resolvePollIntervalMs(ctx),
    homeDir,
    stateDir: ctx.paths.stateDir,
    resolver: createUsagePolicyResolver({ localOnlyListPath: localOnlyList }),
    // Diagnostic identity, refreshed once per poll.
    devRunId: randomUUID(),
    db: null,
    watermark: {},
    rowsWritten: 0,
    sessionsTracked: 0,
    sessionsPending: 0,
    lastPollAt: undefined,
    lastError: undefined,
    idleLogged: false,
  }
}

/**
 * Run one poll tick against `runner`, mutating it in place: probe/open when
 * idle, list changed sessions against the persisted watermark, re-project
 * up to {@link HERMES_SESSIONS_PER_TICK} changed sessions whole through the
 * shared `ai_gateway.projected_exchange` materializer, reconcile them as one
 * batch, then persist the advanced watermark once, whether the tick finished
 * or broke part-way. Sessions past the budget are counted in
 * `runner.sessionsPending` for the next tick. Never throws: a `state_db` read/open
 * error degrades `runner.lastError` + logs, matching LLP 0122#sqlite's "degrade status
 * rather than error the daemon" and spec R9's "idle cleanly, no error
 * noise" for the specific missing-file case.
 *
 * @ref LLP 0449#detection [implements]
 * @ref LLP 0118#requirements [implements]: spec R9
 * @param {HermesPollRunner} runner
 * @param {PluginActivationContext} ctx
 * @returns {Promise<void>}
 */
export async function runHermesPollTick(runner, ctx) {
  runner.devRunId = randomUUID()
  try {
    await withSpan(
      'hermes.poll',
      {
        [Attr.COMPONENT]: 'hermes',
        [Attr.OPERATION]: 'hermes.poll',
        [Attr.PLUGIN]: PLUGIN_NAME,
        state_db: runner.stateDbPath,
        status: 'ok',
      },
      async (span) => {
        if (!runner.db) {
          const opened = await tryOpen(runner, ctx)
          span.setAttribute('mode', opened ? 'active' : 'idle')
          if (!opened) return
        } else {
          span.setAttribute('mode', 'active')
        }

        const db = runner.db
        if (!db) return // unreachable, narrows the type for TS below
        const changed = await db.listChangedSessions(runner.watermark)
        // The change scan already walked every session; its marks count them.
        runner.sessionsTracked = db.snapshot?.length ?? 0
        span.setAttribute('sessions_examined', changed.length)

        let rowsAppended = 0
        let sessionsDeferred = 0
        let sessionsPending = 0
        if (changed.length > 0) {
          // @ref LLP 0449#detection [constrained-by]: a fingerprint is persisted
          // only after its session reconciled, so a flush can never make a
          // restart skip work that did not finish.
          let pendingMarks = 0
          let sessionsPersisted = 0
          /** @param {HermesBatchEntry} entry */
          const markCommitted = (entry) => {
            // Watermark advances whether or not the item produced rows
            // (usage-policy drop, or nothing new to write): the session
            // was still examined through to its current state, and not
            // advancing would re-examine (and, for a drop, re-log) it
            // every tick forever. It names the view just committed, not
            // the earlier change scan, so a rewind between the two is
            // seen again on the next tick.
            runner.watermark[String(entry.session_id)] = {
              max_message_id: entry.mark.max_message_id,
              ended_at: entry.mark.ended_at,
              fingerprint: entry.mark.fingerprint,
            }
            pendingMarks += 1
          }
          /** @type {HermesBatchEntry[]} */
          const batch = []
          /** @type {(() => void)[]} */
          const releases = []
          let admitted = 0
          let batchRows = 0
          // The first session whose read or projection broke. The sessions
          // admitted before it still commit, so a session that always fails
          // holds back only itself and what sorts after it.
          /** @type {{ err: unknown, sessionId: string | number } | null} */
          let failure = null
          /** @type {{ err: unknown, sessionId: string | number | null, entries: HermesBatchEntry[] } | null} */
          let commitFailure = null
          try {
            for (const change of changed) {
              if (failure || admitted >= HERMES_SESSIONS_PER_TICK || (admitted > 0 && batchRows >= HERMES_ROWS_PER_TICK)) {
                sessionsPending += 1
                continue
              }
              // @ref LLP 0449#read-commit-guard [implements]: claim before the
              // authoritative read, hold through the commit. A scope another
              // writer holds is deferred with its watermark untouched, so the
              // next tick re-lists it and reads whatever that writer left.
              // @ref LLP 0527#batched-reconcile [constrained-by]: every claim in
              // the batch is held until the batch commit returns.
              try {
                releases.push(ctx.storage.claimReconcileScope?.(AI_GATEWAY_MESSAGES_DATASET,
                  hermesReconcileScope(HERMES_CLIENT_NAME, change.session_id)) ?? (() => {}))
              } catch (claimErr) {
                if (!isPartitionMutationBusy(claimErr)) {
                  failure = { err: claimErr, sessionId: change.session_id }
                  continue
                }
                sessionsDeferred += 1
                ctx.log.info('hermes.session_deferred', {
                  component: 'hermes',
                  operation: 'hermes.poll',
                  status: 'deferred',
                  error_kind: 'cache_partition_mutation_busy',
                  session_id: String(change.session_id),
                })
                continue
              }
              admitted += 1
              try {
                const snapshot = await db.readSessionSnapshot(change.session_id)
                // Deleted since the change scan; nothing to project or mark.
                if (!snapshot) continue
                // @ref LLP 0449#reconciliation [implements]: replace shifted parts
                // and removed suffixes from a complete visible transcript.
                const item = await projectHermesSession({
                  session: snapshot.session,
                  messages: snapshot.messages,
                  sourcePath: runner.stateDbPath,
                  clientName: HERMES_CLIENT_NAME,
                  homeDir: runner.homeDir,
                  resolver: runner.resolver,
                  log: ctx.log,
                })
                const prepared = item ? await prepareProjectedItem(runner, ctx, item) : null
                rowsAppended += prepared?.appended ?? 0
                if (prepared?.snapshot) batchRows += prepared.snapshot.rows.length
                batch.push({ session_id: change.session_id, mark: snapshot.mark, snapshot: prepared?.snapshot })
              } catch (err) {
                failure = { err, sessionId: change.session_id }
              }
            }
            const committed = await commitHermesBatch(ctx, batch, markCommitted)
            rowsAppended += committed.written
            if (committed.failed) commitFailure = { ...committed.failed, entries: batch }
          } finally {
            for (const release of releases) release()
          }
          const tickError = failure?.err ?? commitFailure?.err
          try {
            if (pendingMarks > 0) {
              writeHermesWatermark(runner.stateDir, runner.watermark)
              sessionsPersisted = pendingMarks
              pendingMarks = 0
            }
          } catch (flushErr) {
            // The marks stay in memory, so this tick's work is not repeated
            // in-process, but nothing re-triggers a flush for them:
            // `listChangedSessions` reads the in-memory map, so these
            // sessions are not "changed" again. They reach disk only if some
            // other session changes later, since a flush rewrites the whole
            // map; a restart before then re-scans them, which is the benign
            // pre-fix behaviour. Record the failure with the tick's progress:
            // when a reconcile is the tick's error nothing else reports an
            // unwritable sidecar, and when the flush is the tick's error this
            // record is the one that names the write as the step that broke.
            ctx.log.warn('hermes.watermark_flush_failed', {
              component: 'hermes',
              operation: 'hermes.poll',
              error_kind: errorKind(flushErr),
              error: flushErr instanceof Error ? flushErr.message : String(flushErr),
              sessions_persisted: sessionsPersisted,
              sessions_examined: changed.length,
            })
            // A sidecar write that fails while degrading must not replace the
            // error that got us here, which is the one worth reporting.
            if (!tickError) throw flushErr
          }
          // These fire only when a read, projection or reconcile is what
          // broke: a flush failure names the write above, never a session
          // whose reconcile completed.
          for (const broke of [failure, commitFailure]) {
            if (!broke) continue
            /** @type {Record<string, unknown>} */
            const fields = {
              component: 'hermes',
              operation: 'hermes.poll',
              status: 'partial',
              error_kind: errorKind(broke.err),
              sessions_persisted: sessionsPersisted,
              sessions_examined: changed.length,
            }
            if (broke.sessionId !== null) {
              fields.session_id = String(broke.sessionId)
            } else if ('entries' in broke) {
              // A batch commit failed as a whole: name the batch it held.
              fields.sessions_in_batch = broke.entries.length
              fields.first_session_id = String(broke.entries[0]?.session_id)
              fields.last_session_id = String(broke.entries[broke.entries.length - 1]?.session_id)
            }
            ctx.log.warn('hermes.session_reconcile_failed', fields)
          }
          if (tickError) {
            runner.sessionsPending = sessionsPending
            throw tickError
          }
        }

        runner.rowsWritten += rowsAppended
        runner.sessionsPending = sessionsPending
        span.setAttribute('rows_appended', rowsAppended)
        span.setAttribute('sessions_deferred', sessionsDeferred)
        span.setAttribute('sessions_pending', sessionsPending)
        ctx.log.info('hermes.poll_tick', {
          component: 'hermes',
          operation: 'hermes.poll',
          state_db: runner.stateDbPath,
          sessions_examined: changed.length,
          sessions_deferred: sessionsDeferred,
          sessions_pending: sessionsPending,
          rows_appended: rowsAppended,
        })
      },
      { component: 'hermes' }
    )
    runner.lastPollAt = new Date().toISOString()
    runner.lastError = undefined
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    runner.lastError = message
    ctx.log.error('hermes.poll_failed', {
      component: 'hermes',
      operation: 'hermes.poll',
      state_db: runner.stateDbPath,
      error_kind: errorKind(err),
      error: message,
    })
  }
}

/**
 * Probe `runner.stateDbPath` and open it when present. A `missing`
 * `HermesStateDbError` is the expected not-yet-installed case (spec R9):
 * it is swallowed here, logged at most once (not every tick, "no error
 * noise"), and reported back as "stayed idle". Any other error (activation
 * probe failure, open failure) propagates to {@link runHermesPollTick}'s
 * catch, which is a genuine degrade-and-log condition.
 *
 * @param {HermesPollRunner} runner
 * @param {PluginActivationContext} ctx
 * @returns {Promise<boolean>} whether `runner.db` is now open
 */
async function tryOpen(runner, ctx) {
  try {
    runner.db = await openHermesStateDb(runner.stateDbPath)
  } catch (err) {
    if (err instanceof HermesStateDbError && err.code === 'missing') {
      if (!runner.idleLogged) {
        ctx.log.info('hermes.source_idle', {
          component: 'hermes',
          operation: 'hermes.poll',
          state_db: runner.stateDbPath,
          detail: 'no hermes installation detected',
        })
        runner.idleLogged = true
      }
      return false
    }
    throw err
  }
  runner.watermark = readHermesWatermark(runner.stateDir)
  runner.idleLogged = false
  ctx.log.info('hermes.source_activated', {
    component: 'hermes',
    operation: 'hermes.poll',
    state_db: runner.stateDbPath,
  })
  return true
}

/**
 * Materialize one projected-exchange `BackfillItem` through the shared
 * `ai_gateway.projected_exchange` materializer (`@hypaware/ai-gateway`,
 * required by hermes's manifest). A reconcile item comes back as a scoped
 * snapshot for the tick's batch commit; any other item is appended here.
 *
 * @ref LLP 0449#reconciliation [implements]: authoritative snapshots retain
 *   equal parts, replace changed parts and remove withdrawn parts.
 * @param {HermesPollRunner} runner
 * @param {PluginActivationContext} ctx
 * @param {BackfillItem} item
 * @returns {Promise<{ appended: number, snapshot?: HermesBatchEntry['snapshot'] }>}
 */
async function prepareProjectedItem(runner, ctx, item) {
  const materializer = ctx.backfillMaterializers.get(PROJECTED_EXCHANGE_KIND)
  if (!materializer) {
    ctx.log.error('hermes.materializer_missing', {
      component: 'hermes',
      operation: 'hermes.poll',
      kind: PROJECTED_EXCHANGE_KIND,
    })
    return { appended: 0 }
  }
  const rows = await materializer.materialize(item, {
    env: ctx.env,
    log: ctx.log,
    storage: ctx.storage,
    devRunId: runner.devRunId,
  })
  if (!Array.isArray(rows) || (rows.length === 0 && !item.reconcile)) return { appended: 0 }

  const dataset = ctx.query.getDataset?.(AI_GATEWAY_MESSAGES_DATASET)
  if (!dataset) {
    ctx.log.error('hermes.dataset_not_registered', {
      component: 'hermes',
      operation: 'hermes.poll',
      dataset: AI_GATEWAY_MESSAGES_DATASET,
    })
    return { appended: 0 }
  }
  const schemaColumns = dataset.schema?.columns ?? []
  if (item.reconcile) {
    if (!ctx.storage.reconcileRowsBatch && !ctx.storage.reconcileRows) {
      throw new Error('Hermes capture requires local snapshot reconciliation support')
    }
    return { appended: 0, snapshot: { rows, scope: item.reconcile, columns: schemaColumns } }
  }
  await ctx.storage.appendRowsToPartition(
    AI_GATEWAY_MESSAGES_DATASET,
    [HERMES_PARTITION_SEGMENT],
    schemaColumns,
    rows
  )
  return { appended: rows.length }
}

/**
 * Commit the tick's batch and mark each session it settled. Sessions with no
 * snapshot are already settled. The snapshots go to the cache in one
 * `reconcileRowsBatch` call; when that fails, or the storage has no batch
 * call, they are retried one at a time in session order, so a session that
 * cannot commit holds back only itself and the sessions after it, as it did
 * before batching, and the failure names it. Reconciling a snapshot twice is
 * idempotent, so a retry after a partly committed batch is safe.
 *
 * @ref LLP 0527#batched-reconcile [implements]: one cache commit per partition per tick.
 * @param {PluginActivationContext} ctx
 * @param {HermesBatchEntry[]} batch
 * @param {(entry: HermesBatchEntry) => void} markCommitted
 * @returns {Promise<{ written: number, failed?: { err: unknown, sessionId: string | number | null } }>}
 */
async function commitHermesBatch(ctx, batch, markCommitted) {
  const pending = []
  for (const entry of batch) {
    if (entry.snapshot) pending.push(entry)
    else markCommitted(entry)
  }
  if (!pending.length) return { written: 0 }
  const storage = ctx.storage
  if (storage.reconcileRowsBatch) {
    try {
      const written = await storage.reconcileRowsBatch(AI_GATEWAY_MESSAGES_DATASET,
        /** @type {NonNullable<HermesBatchEntry['snapshot']>} */ (pending[0].snapshot).columns,
        pending.map(entry => {
          const { rows, scope } = /** @type {NonNullable<HermesBatchEntry['snapshot']>} */ (entry.snapshot)
          return { rows, scope }
        }))
      for (const entry of pending) markCommitted(entry)
      return { written }
    } catch (err) {
      if (!storage.reconcileRows) return { written: 0, failed: { err, sessionId: null } }
      ctx.log.warn('hermes.batch_reconcile_failed', {
        component: 'hermes',
        operation: 'hermes.poll',
        status: 'retrying',
        error_kind: errorKind(err),
        error: err instanceof Error ? err.message : String(err),
        sessions_in_batch: pending.length,
      })
    }
  }
  const reconcileRows = /** @type {NonNullable<typeof storage.reconcileRows>} */ (storage.reconcileRows)
  let written = 0
  for (const entry of pending) {
    const { rows, scope, columns } = /** @type {NonNullable<HermesBatchEntry['snapshot']>} */ (entry.snapshot)
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
  if (err instanceof HermesStateDbError) return err.code
  return 'unknown'
}

/** @param {PluginActivationContext} ctx @returns {string} */
export function resolveHomeDir(ctx) {
  return ctx.env.HOME ?? os.homedir()
}

/**
 * Resolve `state_db` from config (LLP 0122#config), defaulting to the
 * hermes home the same way hermes's own `get_hermes_home()` resolves it
 * on POSIX: `~/.hermes/state.db`.
 *
 * @param {PluginActivationContext} ctx
 * @param {string} homeDir
 * @returns {string}
 */
export function resolveStateDbPath(ctx, homeDir) {
  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const raw = config.state_db
  if (typeof raw === 'string' && raw.trim().length > 0) return expandHome(raw.trim(), homeDir)
  return path.join(homeDir, '.hermes', 'state.db')
}

/** @param {string} raw @param {string} homeDir @returns {string} */
function expandHome(raw, homeDir) {
  if (raw === '~') return homeDir
  if (raw.startsWith('~/')) return path.join(homeDir, raw.slice(2))
  return raw
}

/** Duration string shape `poll_interval` accepts: an integer plus an `ms`/`s`/`m`/`h` suffix. Exported so `config.js` validates against the same pattern this module parses. */
export const DURATION_RE = /^(\d+)(ms|s|m|h)$/

/**
 * Resolve `poll_interval` from config (LLP 0122#config's
 * `poll_interval = "60s"`). A plain number is milliseconds directly; a
 * string requires an explicit `ms`/`s`/`m`/`h` suffix. Anything else
 * (missing, wrong type, unparseable) falls back to
 * {@link DEFAULT_POLL_INTERVAL_MS}.
 *
 * @param {PluginActivationContext} ctx
 * @returns {number}
 */
export function resolvePollIntervalMs(ctx) {
  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const raw = config.poll_interval
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw)
  if (typeof raw === 'string') {
    const match = DURATION_RE.exec(raw.trim())
    if (match) {
      const amount = Number(match[1])
      const unitMs = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]]
      if (amount > 0) return amount * unitMs
    }
  }
  return DEFAULT_POLL_INTERVAL_MS
}
