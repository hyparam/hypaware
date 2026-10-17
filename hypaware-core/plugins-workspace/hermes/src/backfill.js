// @ts-check

import path from 'node:path'

import { createUsagePolicyResolver } from '../../../../src/core/usage-policy/index.js'
import { isPartitionMutationBusy } from '../../../../src/core/util/mutation_guard.js'
import {
  AI_GATEWAY_MESSAGES_DATASET,
  errMessage,
  filterByWindow,
  resolveWindow,
} from '../../../../src/core/backfill/scan_util.js'
import { HermesStateDbError } from './errors.js'
import { hermesReconcileScope, hermesTimestampToIso, projectHermesSession } from './projector.js'
import { openHermesStateDb } from './state_db.js'

/**
 * @import { BackfillContribution, BackfillItem, BackfillRunContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { HermesSessionRow } from './types.js'
 * @import { HermesStateDb } from './state_db.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

/**
 * `@hypaware/hermes` backfill provider.
 *
 * Imports local Hermes Agent history into `ai_gateway_messages` by reading
 * every session out of hermes's own `state.db` (`src/state_db.js`, LLP 0119)
 * and projecting each session, whole, into an `AiGatewayProjectedExchange`
 * via {@link projectHermesSession} (T2, LLP 0122#projection). The
 * `@hypaware/ai-gateway` `ai_gateway.projected_exchange` materializer
 * expands those into the same canonical rows the live hermes poll source
 * (T4) produces, so backfilled and live rows converge for the same session
 * (`client_name = 'hermes'`).
 *
 * @ref LLP 0122#backfill [implements]: `ctx.backfills.register` contribution,
 *   `--since` windowing via `resolveWindow`/`filterByWindow`, one item per
 *   session, provenance naming the state.db path.
 *
 * One item per session mirrors the claude/codex backfill shape and keeps
 * the whole-session invariant spec R2 depends on: `message_id`/`part_id`
 * identity is always computed from a session's full row set, never a
 * partial window, so a row's identity does not depend on when it was first
 * observed (LLP 0122#watermark). The `--since` window therefore selects
 * WHICH sessions to import (by `started_at`), not which of a session's
 * messages: a session that started before the window is left for a later,
 * wider backfill rather than importing it split across runs.
 *
 * Usage-policy skip (spec R3, LLP 0050) happens inside
 * {@link projectHermesSession} itself, over the session's effective scope
 * (real `cwd` for interactive sessions, the LLP 0124 canonical channel
 * scope path for channel sessions), so this provider does not duplicate
 * that logic.
 */

const DEFAULT_CLIENT_NAME = 'hermes'
const DEFAULT_PLUGIN_NAME = '@hypaware/hermes'

const COMPONENT = 'plugin.hermes.backfill'

/**
 * How long a backfill waits for a session another writer holds before it
 * gives the session up: one poll reconcile normally finishes well inside it.
 * A session still busy after the last attempt fails the run visibly once the
 * rest of the import has finished, never a silent success.
 */
export const SCOPE_BUSY_ATTEMPTS = 50
export const SCOPE_BUSY_DELAY_MS = 100

/**
 * Default hermes state.db path: `<homeDir>/.hermes/state.db`, mirroring
 * hermes's own `get_hermes_home()` resolution on POSIX (LLP 0122#config).
 *
 * @param {string} homeDir
 * @returns {string}
 */
export function defaultHermesStateDbPath(homeDir) {
  return path.join(homeDir, '.hermes', 'state.db')
}

/**
 * Build the hermes backfill provider. Registered at plugin activation via
 * `ctx.backfills.register(...)`. The provider closes over the resolved
 * `state.db` path so `run()` needs only the kernel-supplied
 * `BackfillRunContext`.
 *
 * @param {{
 *   homeDir: string,
 *   stateDbPath?: string,
 *   clientName?: string,
 *   pluginName?: string,
 *   resolver?: UsagePolicyResolver,
 *   localOnlyListPath?: string,
 * }} opts
 * @returns {BackfillContribution}
 */
export function createHermesBackfillProvider(opts) {
  const clientName = opts.clientName ?? DEFAULT_CLIENT_NAME
  const pluginName = opts.pluginName ?? DEFAULT_PLUGIN_NAME
  const stateDbPath = opts.stateDbPath ?? defaultHermesStateDbPath(opts.homeDir)
  const homeDir = opts.homeDir
  // One resolver per backfill run (LLP 0050), holding its per-cwd cache for
  // the whole scan. Injectable so tests stay hermetic.
  // @ref LLP 0103 [implements]: the machine-local list is the resolver's second
  // source, so `hyp backfill` skips `--private` (`ignore`) channels/dirs, never
  // re-importing sessions a live capture already dropped.
  const resolver = opts.resolver ?? createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })

  return {
    name: clientName,
    plugin: pluginName,
    datasets: [AI_GATEWAY_MESSAGES_DATASET],
    summary: 'Import local Hermes Agent sessions into ai_gateway_messages',
    async *run(ctx) {
      yield* runHermesBackfill({ ctx, stateDbPath, homeDir, clientName, resolver })
    },
  }
}

/**
 * Open the store, window its sessions, and yield one
 * `ai_gateway.projected_exchange` item per session that survives the window
 * and the usage-policy skip. A missing `state.db` (no hermes installation on
 * this machine, spec R9) degrades to a clean no-op rather than an error,
 * matching the claude/codex backfills' "missing root yields nothing"
 * behavior.
 *
 * @param {{
 *   ctx: BackfillRunContext,
 *   stateDbPath: string,
 *   homeDir: string,
 *   clientName: string,
 *   resolver: UsagePolicyResolver,
 * }} args
 * @returns {AsyncGenerator<BackfillItem>}
 */
async function* runHermesBackfill(args) {
  const { ctx, stateDbPath, homeDir, clientName, resolver } = args
  const log = ctx.log
  const window = resolveWindow(ctx)

  log.info('hermes.backfill.scan_started', {
    component: COMPONENT,
    operation: 'backfill.scan',
    state_db: stateDbPath,
    ...(window.sinceMs !== undefined ? { since: new Date(window.sinceMs).toISOString() } : {}),
    ...(window.untilMs !== undefined ? { until: new Date(window.untilMs).toISOString() } : {}),
    status: 'ok',
  })

  /** @type {HermesStateDb | undefined} */
  let reader
  try {
    reader = await openHermesStateDb(stateDbPath)
  } catch (err) {
    if (err instanceof HermesStateDbError && err.code === 'missing') {
      // @ref LLP 0122#backfill [implements], spec R9: no hermes installation
      // on this machine is not an error, it's nothing to import yet.
      log.info('hermes.backfill.no_store', {
        component: COMPONENT,
        operation: 'backfill.scan',
        state_db: stateDbPath,
        status: 'skipped',
      })
      return
    }
    log.warn('hermes.backfill.open_failed', {
      component: COMPONENT,
      operation: 'backfill.scan',
      state_db: stateDbPath,
      status: 'error',
      error_kind: err instanceof HermesStateDbError ? err.code : 'unknown',
      error: errMessage(err),
    })
    throw err
  }

  let sessionsSeen = 0
  let sessionsSkippedWindow = 0
  let sessionsSkipped = 0
  let sessionsBusy = 0
  let sessionsProjected = 0
  let messagesProjected = 0

  try {
    const sessions = await reader.listSessions()
    sessionsSeen = sessions.length

    const windowed = filterByWindow(
      sessions.map((session) => ({ session, timestampMs: startedAtMs(session) })),
      window
    )
    sessionsSkippedWindow = sessions.length - windowed.length

    for (const { session: listed } of windowed) {
      if (ctx.signal?.aborted) break

      // @ref LLP 0449#read-commit-guard [implements]: the session is re-read
      // under its scope guard, and the guard is held across the yield so the
      // runner's reconcile commits this exact view before any other writer
      // can read a newer one. A dry run writes nothing and takes no guard.
      const release = ctx.dryRun ? () => {} : await claimScope(ctx, hermesReconcileScope(clientName, listed.id))
      if (!release) {
        sessionsBusy += 1
        log.warn('hermes.backfill.session_busy', {
          component: COMPONENT,
          operation: 'backfill.project',
          session_id: listed.id,
          status: 'deferred',
          error_kind: 'cache_partition_mutation_busy',
        })
        continue
      }
      try {
        const snapshot = await reader.readSessionSnapshot(listed.id)
        const item = snapshot && await projectHermesSession({
          session: snapshot.session,
          messages: snapshot.messages,
          sourcePath: stateDbPath,
          clientName,
          homeDir,
          resolver,
          log,
        })
        if (!item) {
          // Either a usage-policy drop (already logged by projectHermesSession
          // as `plugin.hermes.usage_policy_drop`), a session with nothing
          // projectable (no messages, not yet ended), or one deleted since
          // the listing.
          sessionsSkipped += 1
          continue
        }

        sessionsProjected += 1
        messagesProjected += /** @type {{ messages: unknown[] }} */ (/** @type {unknown} */ (item.value)).messages.length
        log.info('hermes.backfill.session_projected', {
          component: COMPONENT,
          operation: 'backfill.project',
          session_id: listed.id,
          message_count: /** @type {{ messages: unknown[] }} */ (/** @type {unknown} */ (item.value)).messages.length,
          status: 'ok',
        })

        yield item
      } finally {
        release()
      }
    }
  } finally {
    reader.close()
  }

  log.info('hermes.backfill.scan_complete', {
    component: COMPONENT,
    operation: 'backfill.scan',
    sessions_seen: sessionsSeen,
    sessions_skipped_window: sessionsSkippedWindow,
    sessions_skipped: sessionsSkipped,
    sessions_busy: sessionsBusy,
    sessions_projected: sessionsProjected,
    messages_projected: messagesProjected,
    status: sessionsBusy ? 'partial' : 'ok',
  })

  if (sessionsBusy) {
    // Every other session is imported; the held ones are not, so the run
    // must not read as complete.
    throw Object.assign(
      new Error(`${sessionsBusy} hermes session(s) stayed busy in the cache; rerun the backfill to import them`),
      { error_kind: 'cache_partition_mutation_busy' })
  }
}

/**
 * Claim one session's reconcile scope, retrying a busy one a bounded number
 * of times. Resolves null when it is still busy after the last attempt.
 * Storage without the guard (a test double) yields a no-op release.
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
      await new Promise((resolve) => setTimeout(resolve, SCOPE_BUSY_DELAY_MS))
    }
  }
}

/**
 * A session's window key: its `started_at`, parsed to epoch millis. Hermes
 * stores `started_at` as an epoch-seconds REAL, so it is normalized to ISO
 * (`hermesTimestampToIso`) before parsing, exactly like the projection seam;
 * a bare `Date.parse` of the raw float would yield NaN and silently disable
 * window filtering. An unparseable timestamp is treated as absent (kept by
 * `filterByWindow` rather than dropped), matching that helper's "no timestamp
 * -> keep" convention for legacy/malformed records.
 *
 * @param {HermesSessionRow} session
 * @returns {number | undefined}
 */
function startedAtMs(session) {
  const ms = Date.parse(hermesTimestampToIso(session.started_at) ?? '')
  return Number.isFinite(ms) ? ms : undefined
}
