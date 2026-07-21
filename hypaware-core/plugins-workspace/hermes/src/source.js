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
 * @ref LLP 0122#watermark [implements]: the per-tick change-detection and
 *   whole-session re-projection loop, leaning on the shared
 *   `ai_gateway.projected_exchange` materializer's pre-write `part_id`
 *   dedupe (`aiGatewayBackfillMaterializer`, ai-gateway `dataset.js`) to
 *   turn a whole-session re-projection into "append only the new tail".
 *   The watermark itself persists in the plugin's kernel-managed state
 *   dir (`watermark.js`), the same sidecar-file pattern
 *   `context-graph-enrich`/`vector-search` use for their own cursors.
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
 * @import { HermesWatermarkState } from './types.js'
 * @import { HermesStateDb } from './state_db.js'
 */

import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { createUsagePolicyResolver, localOnlyListPath } from '../../../../src/core/usage-policy/index.js'
import { AI_GATEWAY_MESSAGES_DATASET, PROJECTED_EXCHANGE_KIND } from '../../../../src/core/backfill/scan_util.js'
import { HermesStateDbError } from './errors.js'
import { HERMES_CLIENT_NAME, projectHermesSession } from './projector.js'
import { openHermesStateDb } from './state_db.js'
import { readHermesWatermark, writeHermesWatermark } from './watermark.js'

const PLUGIN_NAME = '@hypaware/hermes'

/** Default poll interval when config carries none: LLP 0122#config's `poll_interval = "60s"`. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000

/** The cache partition segment hermes's poll writes land under, distinct from `hyp backfill`'s `backfill` segment. */
export const HERMES_PARTITION_SEGMENT = 'hermes'

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
  const runner = createHermesPollRunner(ctx)
  let activeCtx = ctx
  let stopped = false
  /** @type {NodeJS.Timeout | null} */
  let handle = null
  /** @type {Promise<void> | null} */
  let inFlight = null

  // @ref LLP 0122#source [implements]: the initial probe/open/first-poll
  // happens synchronously during start, not only on the first timer fire.
  await runHermesPollTick(runner, activeCtx)

  function startTimer() {
    handle = setInterval(() => {
      if (stopped || inFlight) return
      inFlight = runHermesPollTick(runner, activeCtx).finally(() => {
        inFlight = null
      })
    }, runner.pollIntervalMs)
    if (typeof handle.unref === 'function') handle.unref()
  }
  startTimer()

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
      if (inFlight) await inFlight.catch(() => {})
      if (runner.db) {
        runner.db.close()
        runner.db = null
      }
    },
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
    devRunId: randomUUID(),
    db: null,
    watermark: {},
    rowsWritten: 0,
    sessionsTracked: 0,
    lastPollAt: undefined,
    lastError: undefined,
    idleLogged: false,
  }
}

/**
 * Run one poll tick against `runner`, mutating it in place: probe/open when
 * idle, list changed sessions against the persisted watermark, re-project
 * each changed session whole and write through the shared
 * `ai_gateway.projected_exchange` materializer, then persist the advanced
 * watermark. Never throws: a `state_db` read/open error degrades
 * `runner.lastError` + logs, matching LLP 0122#sqlite's "degrade status
 * rather than error the daemon" and spec R9's "idle cleanly, no error
 * noise" for the specific missing-file case.
 *
 * @ref LLP 0122#watermark [implements]
 * @ref LLP 0118#requirements [implements]: spec R9
 * @param {HermesPollRunner} runner
 * @param {PluginActivationContext} ctx
 * @returns {Promise<void>}
 */
export async function runHermesPollTick(runner, ctx) {
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
        const sessions = await db.listSessions()
        const changed = await db.listChangedSessions(runner.watermark)
        runner.sessionsTracked = sessions.length
        span.setAttribute('sessions_examined', changed.length)

        let rowsAppended = 0
        if (changed.length > 0) {
          const sessionsById = new Map(sessions.map((s) => [s.id, s]))
          for (const change of changed) {
            const session = sessionsById.get(change.session_id)
            if (!session) continue
            const messages = await db.listMessagesForSession(change.session_id)
            // @ref LLP 0122#watermark [implements]: the whole session is
            // re-projected every time, never a partial batch, so identity
            // (message_index / previous_message_id chains / part ids)
            // never depends on when the session was first observed.
            const item = await projectHermesSession({
              session,
              messages,
              sourcePath: runner.stateDbPath,
              clientName: HERMES_CLIENT_NAME,
              homeDir: runner.homeDir,
              resolver: runner.resolver,
              log: ctx.log,
            })
            if (item) {
              rowsAppended += await writeProjectedItem(runner, ctx, item)
            }
            // Watermark advances whether or not the item produced rows
            // (usage-policy drop, or nothing new to write): the session
            // was still examined through to its current state, and not
            // advancing would re-examine (and, for a drop, re-log) it
            // every tick forever.
            runner.watermark[String(change.session_id)] = {
              max_message_id: change.max_message_id,
              ended_at: change.ended_at,
            }
          }
          writeHermesWatermark(runner.stateDir, runner.watermark)
        }

        runner.rowsWritten += rowsAppended
        span.setAttribute('rows_appended', rowsAppended)
        ctx.log.info('hermes.poll_tick', {
          component: 'hermes',
          operation: 'hermes.poll',
          state_db: runner.stateDbPath,
          sessions_examined: changed.length,
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
 * required by hermes's manifest) and append the resulting rows.
 *
 * @ref LLP 0122#watermark [implements]: relies on the materializer's
 *   pre-write `part_id` dedupe to turn a whole-session re-projection into
 *   "append only the new tail".
 * @param {HermesPollRunner} runner
 * @param {PluginActivationContext} ctx
 * @param {BackfillItem} item
 * @returns {Promise<number>} rows appended
 */
async function writeProjectedItem(runner, ctx, item) {
  const materializer = ctx.backfillMaterializers.get(PROJECTED_EXCHANGE_KIND)
  if (!materializer) {
    ctx.log.error('hermes.materializer_missing', {
      component: 'hermes',
      operation: 'hermes.poll',
      kind: PROJECTED_EXCHANGE_KIND,
    })
    return 0
  }
  const rows = await materializer.materialize(item, {
    env: ctx.env,
    log: ctx.log,
    storage: ctx.storage,
    devRunId: runner.devRunId,
  })
  if (!Array.isArray(rows) || rows.length === 0) return 0

  const dataset = ctx.query.getDataset?.(AI_GATEWAY_MESSAGES_DATASET)
  if (!dataset) {
    ctx.log.error('hermes.dataset_not_registered', {
      component: 'hermes',
      operation: 'hermes.poll',
      dataset: AI_GATEWAY_MESSAGES_DATASET,
    })
    return 0
  }
  const schemaColumns = dataset.schema?.columns ?? []
  await ctx.storage.appendRowsToPartition(
    AI_GATEWAY_MESSAGES_DATASET,
    [HERMES_PARTITION_SEGMENT],
    schemaColumns,
    rows
  )
  return rows.length
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
