// @ts-check

import { Attr, getActiveSpan, withSpan } from '../../../../../src/core/observability/index.js'
import { readObservabilityEnv } from '../../../../../src/core/observability/env.js'
import { SESSION_IGNORE_ROUTE, createControlHandler } from '../../../../../src/core/control/session_ignore.js'
import { resolveLiveSourceListenPortFromStatus } from '../../../../../src/core/daemon/status.js'
import { createOtlpJsonServer, listenAndResolve } from '../../../../../src/core/otlp/server.js'
import { createSessionContextReader, pickLatestMatching } from '../session_context.js'
import { deleteSpooledBodies, deleteSpooledBodiesForEvents, loadSpooledBodies } from './bodies.js'
import { flattenClaudeTelemetryEvents, flattenClaudeTelemetryMetrics } from './events.js'
import {
  CLAUDE_TELEMETRY_EVENT_COLUMNS,
  claudeTelemetryEventRows,
  claudeTelemetryTablePath,
} from './events_dataset.js'
import { projectClaudeTelemetryEvents } from './projection.js'
import {
  DEFAULT_SPOOL_MAX_BYTES,
  claudeBodySpoolDir,
  enforceClaudeBodySpoolCap,
  ensureClaudeBodySpool,
} from './spool.js'

/**
 * @import { Server } from 'node:http'
 * @import { AiGatewayCapability, PluginActivationContext, SourceStatus, StartedSource } from '../../../../../hypaware-plugin-kernel-types.js'
 * @import { OtlpRequest } from '../../../../../src/core/otlp/types.js'
 * @import { ClaudeTelemetryEvent, ClaudeTelemetryListenerState, SessionContextRecord } from '../types.js'
 */

const PLUGIN_NAME = '@hypaware/claude'

/** Kernel source name. Registered by `@hypaware/claude`, not by `@hypaware/otel`. */
export const CLAUDE_TELEMETRY_SOURCE = 'claude-telemetry'

/** What this listener calls itself on the wire banner and in bind errors. */
const LISTENER_NAME = 'hypaware/claude-telemetry'

/**
 * Loopback only. The endpoint attach writes into the settings `env`
 * block is `http://127.0.0.1:<port>` (LLP 0258 #env-keys), and a
 * listener that carried raw prompt text off the loopback interface
 * would be a capture surface nobody asked for.
 */
const DEFAULT_HOST = '127.0.0.1'

/**
 * Own port, next to `@hypaware/otel`'s 4318 and separate from the
 * gateway's. One listener per payload dialect: the OTLP receiver keeps
 * flattening generic logs/traces/metrics, and this one reads Claude
 * Code's event vocabulary.
 * @ref LLP 0257#registration [implements]: its own port, separate from the otel
 *   receiver and from the gateway
 */
export const DEFAULT_TELEMETRY_PORT = 4319

/**
 * Claude Code's exporter is configured with both `OTEL_LOGS_EXPORTER`
 * and `OTEL_METRICS_EXPORTER` (LLP 0258 #env-keys), so it POSTs to
 * `/v1/metrics` too. Both halves of the stream are consumed: log events
 * feed the message projection plus the behavioral dataset, and metric
 * data points land in `claude_telemetry_events` under LLP 0255.
 */
const SERVED_SIGNALS = /** @type {const} */ (['logs', 'metrics'])

/**
 * How often the daemon re-enforces the spool's byte cap. The listener
 * deletes what it projects, so under normal flow the sweep finds
 * nothing; the interval exists for the window where Claude Code is
 * writing bodies and nothing is consuming them (a misdirected exporter,
 * a wedged storage service), which is exactly when nobody else would
 * notice the directory growing.
 */
const SPOOL_SWEEP_INTERVAL_MS = 60_000

/**
 * Build the `SourceContribution.start` callback for the Claude
 * telemetry listener.
 *
 * The source owns one HTTP listener and writes into
 * `ai_gateway_messages` through the gateway capability, so the dataset
 * keeps one owner and the OTEL rows cannot drift from the proxy's.
 *
 * @ref LLP 0257#registration [implements]: a listener source contributed by
 *   `@hypaware/claude` through the kernel source registry
 * @param {{ gateway: AiGatewayCapability, clientName: string, stateFile: string }} deps
 */
export function createStartClaudeTelemetrySource(deps) {
  /**
   * @param {PluginActivationContext} ctx
   * @returns {Promise<StartedSource>}
   */
  return async function startClaudeTelemetrySource(ctx) {
    const listen = readListenConfig(ctx)
    const spool = readSpoolConfig(ctx)
    /** @type {ClaudeTelemetryListenerState} */
    const state = {
      rowsWritten: 0,
      rowsSkipped: 0,
      telemetryRowsWritten: 0,
      eventsReceived: 0,
      eventsDropped: 0,
      lastEventAt: undefined,
      lastError: undefined,
      listenFallbackFrom: undefined,
      spoolBytes: 0,
      bodiesProjected: 0,
      bodiesDeleted: 0,
      bodiesDropped: 0,
      bodiesEvicted: 0,
      bodiesMissing: 0,
      bodiesUnparseable: 0,
    }

    // The same per-session opt-out the gateway keeps: an in-memory set that
    // dies with the process, written through the identical control route and
    // matched verbatim against the `session.id` the events carry (LLP 0066
    // R5). Nothing about it touches disk.
    // @ref LLP 0256#in-memory-only [implements]: no new on-disk contract; the
    //   durable expressions of the same intent stay `.hypignore` and the
    //   machine-local list
    /** @type {Set<string>} */
    const ignoredSessions = new Set()

    // The spool exists whether or not this daemon was up when attach ran:
    // Claude Code starts writing bodies the moment a session launches with
    // the attach-written env, so the listener repairs permissions and
    // enforces the cap on every start, then keeps enforcing on a timer for
    // the window where bodies arrive but nothing consumes them.
    // @ref LLP 0253#spool-location [implements]: owner-only under the HypAware
    //   home, tightened here even when Claude Code created it first
    try {
      await ensureClaudeBodySpool(spool.dir)
    } catch (err) {
      ctx.log.warn('claude.telemetry.spool_unavailable', {
        [Attr.PLUGIN]: PLUGIN_NAME,
        spool_dir: spool.dir,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const sweepSpool = async () => {
      try {
        const swept = await enforceClaudeBodySpoolCap(spool.dir, spool.maxBytes)
        state.spoolBytes = swept.spoolBytes
        if (swept.evictedCount > 0) {
          state.bodiesEvicted += swept.evictedCount
          // A machine that is routinely evicting is losing detail to the
          // backfill path; the count is what makes that visible.
          // @ref LLP 0253#byte-cap [implements]: eviction is logged with a count
          ctx.log.warn('claude.telemetry.spool_evicted', {
            [Attr.PLUGIN]: PLUGIN_NAME,
            [Attr.COMPONENT]: 'sources',
            [Attr.OPERATION]: 'spool_sweep',
            spool_dir: spool.dir,
            evicted_count: swept.evictedCount,
            evicted_bytes: swept.evictedBytes,
            spool_bytes: swept.spoolBytes,
            spool_max_bytes: spool.maxBytes,
          })
        }
      } catch (err) {
        ctx.log.warn('claude.telemetry.spool_sweep_failed', {
          [Attr.PLUGIN]: PLUGIN_NAME,
          spool_dir: spool.dir,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    await sweepSpool()
    const sweepTimer = setInterval(sweepSpool, SPOOL_SWEEP_INTERVAL_MS)
    sweepTimer.unref?.()

    const readSessionContext = createSessionContextReader(deps.stateFile, (err) => {
      ctx.log.warn('claude.telemetry.session_context_unreadable', {
        [Attr.PLUGIN]: PLUGIN_NAME,
        error: err instanceof Error ? err.message : String(err),
      })
    })

    /**
     * Held across batches: the exporter flushes on a timer, so a turn's
     * `api_request` (which carries the tokens) and its
     * `assistant_response` (which carries the uuid the row is keyed by)
     * can arrive in different POSTs. Bounded so a stream of requests
     * that never produce an assistant response cannot grow it forever.
     */
    /** @type {Map<string, Record<string, unknown>>} */
    const usageByRequestId = new Map()

    /**
     * Also held across batches: a session's system prompt and tool
     * declarations arrive once, in the request body, while the rows they
     * belong on keep arriving for the session's lifetime.
     */
    /** @type {Map<string, { systemText?: string, tools?: unknown }>} */
    const sessionBodyFacts = new Map()

    const handler = makeReceiveHandler({
      ctx,
      deps,
      state,
      usageByRequestId,
      sessionBodyFacts,
      readSessionContext,
      spoolDir: spool.dir,
      ignoredSessions,
    })
    const server = createOtlpJsonServer({
      name: LISTENER_NAME,
      handler: { handle: handler },
      signals: [...SERVED_SIGNALS],
      // The same `/_hypaware/ignore/session` route the gateway proxy hosts,
      // over this listener's own set: with Claude Code traffic no longer on
      // the gateway's wire, "don't record this conversation" has to reach
      // the recorder that now writes the rows.
      // @ref LLP 0256#control-route-on-listener [implements]: same shape,
      //   verbs, and reply as the gateway's, via the shared handler
      onControlRequest: createControlHandler({
        ignoredSessions,
        log: ctx.log,
        logEvent: 'claude.telemetry.control.ignore_session',
        logFields: { [Attr.PLUGIN]: PLUGIN_NAME, [Attr.COMPONENT]: 'sources' },
      }),
    })
    const bound = await bindWithFallback({ server, listen, log: ctx.log, state })

    const span = getActiveSpan()
    span?.setAttribute('listen_host', bound.host)
    span?.setAttribute('listen_port', bound.port)
    ctx.log.info('claude.telemetry.listener_started', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      listen_host: bound.host,
      listen_port: bound.port,
    })

    return {
      async status() {
        /** @type {SourceStatus} */
        const status = {
          state: 'ready',
          rowsWritten: state.rowsWritten,
          details: {
            listen_host: bound.host,
            listen_port: bound.port,
            // Says "I host the session-ignore route here", which is how
            // `hyp session ignore` discovers this recorder beside the
            // gateway without the client-agnostic verb naming any plugin.
            // @ref LLP 0256#cli-posts-to-both [implements]: offering the route
            //   is advertised by the recorder itself
            control_routes: [SESSION_IGNORE_ROUTE],
            events_received: state.eventsReceived,
            rows_skipped: state.rowsSkipped,
            // Behavioral rows, counted apart from `rowsWritten` (message
            // rows) so a capture gap in either dataset is visible alone.
            telemetry_rows_written: state.telemetryRowsWritten,
            // @ref LLP 0257#status-and-health [implements]: the status details
            // carry the last event seen and the spool's byte size and eviction
            // count; `hyp status` renders health from them.
            spool_bytes: state.spoolBytes,
            bodies_projected: state.bodiesProjected,
            bodies_evicted: state.bodiesEvicted,
            // The live opt-out surface, mirroring the gateway source's
            // details: the set size plus what enforcing it dropped.
            // @ref LLP 0066#ephemeral: an active session drop is visible in
            //   status, not only in logs
            ignored_sessions: ignoredSessions.size,
            events_dropped: state.eventsDropped,
            bodies_dropped: state.bodiesDropped,
            ...(state.lastEventAt ? { last_event_at: state.lastEventAt } : {}),
            ...(state.listenFallbackFrom !== undefined
              ? { listen_fallback_from: state.listenFallbackFrom }
              : {}),
          },
        }
        if (state.lastError) status.lastError = state.lastError
        return status
      },

      async stop() {
        clearInterval(sweepTimer)
        await new Promise((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve(undefined)))
          server.closeIdleConnections?.()
          server.closeAllConnections?.()
        })
      },
    }
  }
}

/**
 * Wrap one decoded OTLP request in a `claude.telemetry.receive` span,
 * read the spooled bodies its events reference, project everything, and
 * write the rows. Consumed body files are deleted only after the writes
 * succeeded: a write failure becomes an HTTP error the exporter
 * retries, and the retried batch re-reads the same files.
 *
 * A throw here becomes an HTTP 500 the exporter will retry, so
 * everything recoverable is handled: an unparseable envelope yields zero
 * events, an event this listener does not model is skipped, a missing
 * or refused body ref is counted, and only a genuine write failure
 * propagates.
 *
 * @param {{
 *   ctx: PluginActivationContext,
 *   deps: { gateway: AiGatewayCapability, clientName: string, stateFile: string },
 *   state: ClaudeTelemetryListenerState,
 *   usageByRequestId: Map<string, Record<string, unknown>>,
 *   sessionBodyFacts: Map<string, { systemText?: string, tools?: unknown }>,
 *   readSessionContext: () => Promise<SessionContextRecord[]>,
 *   spoolDir: string,
 *   ignoredSessions: Set<string>,
 * }} args
 * @returns {(req: OtlpRequest) => Promise<void>}
 */
function makeReceiveHandler({ ctx, deps, state, usageByRequestId, sessionBodyFacts, readSessionContext, spoolDir, ignoredSessions }) {
  /**
   * Enforce the per-session opt-out on one batch: delete the dropped
   * sessions' spooled bodies without reading them, count the drops, and
   * emit one policy-drop signal per ignored session so the audit trail
   * matches the proxy path's (`policy_source: 'session_opt_out'`).
   *
   * @ref LLP 0256#bodies-deleted [implements]: an ignored session's bodies
   *   are a deletion target, not a skip target
   * @param {Map<string, ClaudeTelemetryEvent[]>} droppedBySession
   * @param {{ setAttribute(key: string, value: unknown): unknown }} span
   */
  async function dropIgnoredSessions(droppedBySession, span) {
    let eventsDropped = 0
    let bodiesDropped = 0
    for (const [sessionId, sessionEvents] of droppedBySession) {
      const removal = await deleteSpooledBodiesForEvents(sessionEvents, { spoolDir })
      eventsDropped += sessionEvents.length
      bodiesDropped += removal.deleted
      state.eventsDropped += sessionEvents.length
      state.bodiesDropped += removal.deleted
      for (const ref of removal.refused) {
        ctx.log.warn('claude.telemetry.body_ref_refused', {
          [Attr.PLUGIN]: PLUGIN_NAME,
          error_kind: 'body_ref_outside_spool',
          body_ref: ref,
        })
      }
      ctx.log.info('claude.telemetry.usage_policy_drop', {
        [Attr.PLUGIN]: PLUGIN_NAME,
        [Attr.COMPONENT]: 'sources',
        [Attr.OPERATION]: 'usage_policy_drop',
        policy_source: 'session_opt_out',
        session_id: sessionId,
        events_dropped: sessionEvents.length,
        bodies_deleted: removal.deleted,
      })
    }
    span.setAttribute('events_dropped', eventsDropped)
    span.setAttribute('bodies_dropped', bodiesDropped)
  }

  return async function handle(req) {
    await withSpan(
      'claude.telemetry.receive',
      {
        [Attr.COMPONENT]: 'sources',
        [Attr.PLUGIN]: PLUGIN_NAME,
        [Attr.OPERATION]: 'claude.telemetry.receive',
        hyp_source: CLAUDE_TELEMETRY_SOURCE,
        signal: req.signal,
        payload_bytes: req.payloadBytes,
        status: 'ok',
      },
      async (span) => {
        // Metrics ride the same exporter config; the message dataset has
        // nothing to learn from them, but the behavioral dataset does
        // (cost and activity counters), so they take the short path:
        // flatten, record, done - no bodies, no projection.
        if (req.signal === 'metrics') {
          const allMetricEvents = flattenClaudeTelemetryMetrics(req.data)
          span.setAttribute('event_count', allMetricEvents.length)
          span.setAttribute('row_count', 0)
          if (allMetricEvents.length === 0) {
            span.setAttribute('telemetry_row_count', 0)
            return
          }
          state.eventsReceived += allMetricEvents.length
          for (const event of allMetricEvents) {
            if (event.timestamp && (state.lastEventAt === undefined || event.timestamp > state.lastEventAt)) {
              state.lastEventAt = event.timestamp
            }
          }
          // The opt-out covers the behavioral record too: a metric data
          // point names its session, so it is droppable on the same key.
          // @ref LLP 0256#control-route-on-listener [implements]: ingest drops
          //   by session id on every signal this listener serves
          const metricSplit = partitionIgnoredSessionEvents(allMetricEvents, ignoredSessions)
          if (metricSplit.droppedBySession.size > 0) {
            await dropIgnoredSessions(metricSplit.droppedBySession, span)
          }
          const metricEvents = metricSplit.kept
          if (metricEvents.length === 0) {
            span.setAttribute('telemetry_row_count', 0)
            return
          }
          const written = await recordTelemetryEvents(metricEvents, { ctx, state, span })
          span.setAttribute('telemetry_row_count', written)
          ctx.log.info('claude.telemetry.batch', {
            [Attr.PLUGIN]: PLUGIN_NAME,
            signal: req.signal,
            event_count: metricEvents.length,
            telemetry_rows_written: written,
          })
          return
        }

        const allEvents = flattenClaudeTelemetryEvents(req.data)
        span.setAttribute('event_count', allEvents.length)
        if (allEvents.length === 0) {
          span.setAttribute('row_count', 0)
          return
        }
        state.eventsReceived += allEvents.length
        for (const event of allEvents) {
          if (event.timestamp && (state.lastEventAt === undefined || event.timestamp > state.lastEventAt)) {
            state.lastEventAt = event.timestamp
          }
        }

        // The per-session opt-out, enforced at ingest BEFORE the spool is
        // read: a dropped session's events project nothing into either
        // dataset, and its body files are deleted rather than skipped, so
        // the transport works AND the content goes.
        // @ref LLP 0256#bodies-deleted [implements]
        const split = partitionIgnoredSessionEvents(allEvents, ignoredSessions)
        if (split.droppedBySession.size > 0) {
          await dropIgnoredSessions(split.droppedBySession, span)
        }
        const events = split.kept
        if (events.length === 0) {
          span.setAttribute('row_count', 0)
          span.setAttribute('telemetry_row_count', 0)
          return
        }

        // @ref LLP 0257#ingest [implements]: body files named by `body_ref`
        // are read for the gap fields, then deleted after the write below.
        const spooled = await loadSpooledBodies(events, { spoolDir })
        state.bodiesMissing += spooled.missing
        state.bodiesUnparseable += spooled.unparseable
        span.setAttribute('body_count', spooled.bodies.size)
        if (spooled.unparseable > 0) {
          span.setAttribute('bodies_unparseable', spooled.unparseable)
          ctx.log.warn('claude.telemetry.body_unparseable', {
            [Attr.PLUGIN]: PLUGIN_NAME,
            error_kind: 'body_unparseable',
            body_count: spooled.unparseable,
          })
        }
        for (const ref of spooled.refused) {
          ctx.log.warn('claude.telemetry.body_ref_refused', {
            [Attr.PLUGIN]: PLUGIN_NAME,
            error_kind: 'body_ref_outside_spool',
            body_ref: ref,
          })
        }

        const records = await readSessionContext()
        const projections = projectClaudeTelemetryEvents(events, {
          clientName: deps.clientName,
          usageByRequestId,
          sessionContext: (sessionId) => pickLatestMatching(records, { sessionId }),
          spooledBodies: spooled.bodies,
          sessionBodyFacts,
        })
        span.setAttribute('session_count', projections.length)

        let rowsWritten = 0
        let rowsSkipped = 0
        try {
          for (const projection of projections) {
            // @ref LLP 0252#projection-unchanged [implements]: the same
            // projected-exchange path the proxy and backfill producers use, so
            // `part_id` dedupe absorbs the overlap between them.
            const result = await deps.gateway.recordProjectedExchange(projection, {
              gatewayAttributes: { gateway: { source: 'otel' } },
            })
            rowsWritten += result.rowsWritten
            rowsSkipped += result.rowsSkipped
          }
        } catch (err) {
          state.lastError = err instanceof Error ? err.message : String(err)
          span.setAttribute('error_kind', 'dataset_write')
          span.setAttribute('row_count', rowsWritten)
          ctx.log.error('claude.telemetry.write_failed', {
            [Attr.PLUGIN]: PLUGIN_NAME,
            event_count: events.length,
            error: state.lastError,
          })
          throw err
        }

        state.rowsWritten += rowsWritten
        state.rowsSkipped += rowsSkipped

        // The behavioral half of the batch, written AFTER the message
        // rows: a failure here becomes an HTTP error the exporter
        // retries, and on that retry the message rows dedupe by
        // `part_id` while this write (which never happened) is
        // re-attempted - the reverse order would duplicate behavioral
        // rows on every message-write retry.
        // @ref LLP 0255#own-dataset [implements]: behavioral events land in
        //   `claude_telemetry_events`, next to (not inside) the message rows
        const telemetryRowsWritten = await recordTelemetryEvents(events, { ctx, state, span })
        span.setAttribute('telemetry_row_count', telemetryRowsWritten)

        // Projected, then deleted: the writes above succeeded, so nothing
        // will ever need these files again.
        // @ref LLP 0252#project-then-delete [implements]: deletion is the
        //   normal end of a body's life, not a cleanup pass
        if (spooled.consumedFiles.length > 0) {
          const deleted = await deleteSpooledBodies(spooled.consumedFiles)
          state.bodiesProjected += spooled.bodies.size
          state.bodiesDeleted += deleted
          state.spoolBytes = Math.max(0, state.spoolBytes - spooled.consumedBytes)
          span.setAttribute('bodies_projected', spooled.bodies.size)
          span.setAttribute('bodies_deleted', deleted)
        }

        span.setAttribute('row_count', rowsWritten)
        span.setAttribute('rows_skipped', rowsSkipped)
        ctx.log.info('claude.telemetry.batch', {
          [Attr.PLUGIN]: PLUGIN_NAME,
          event_count: events.length,
          session_count: projections.length,
          rows_written: rowsWritten,
          rows_skipped: rowsSkipped,
          telemetry_rows_written: telemetryRowsWritten,
          bodies_projected: spooled.bodies.size,
          bodies_missing: spooled.missing,
        })
      },
      { component: 'plugin.claude' }
    )
  }
}

/**
 * Split one batch by the in-memory ignored-session set: events whose
 * `session.id` is in the set are dropped, everything else is kept.
 *
 * The match key is the raw `session.id` the event carries, compared
 * verbatim against the raw token the control route stored - the same R5
 * discipline the gateway's drop applies, so `hyp session ignore` reaches
 * both recorders with one resolved id. An event that names NO session is
 * kept: the set holds exact keys, and dropping what cannot be matched
 * would suppress rows nobody opted out.
 *
 * @ref LLP 0066#requirements: R5 - the match key is the session_id the
 *   recorder resolves and stamps, verbatim
 * @param {ClaudeTelemetryEvent[]} events
 * @param {Set<string>} ignoredSessions
 * @returns {{ kept: ClaudeTelemetryEvent[], droppedBySession: Map<string, ClaudeTelemetryEvent[]> }}
 */
export function partitionIgnoredSessionEvents(events, ignoredSessions) {
  /** @type {ClaudeTelemetryEvent[]} */
  const kept = []
  /** @type {Map<string, ClaudeTelemetryEvent[]>} */
  const droppedBySession = new Map()
  if (ignoredSessions.size === 0) return { kept: events.slice(), droppedBySession }
  for (const event of events) {
    const sessionId = event.attributes['session.id']
    if (typeof sessionId === 'string' && ignoredSessions.has(sessionId)) {
      const bucket = droppedBySession.get(sessionId)
      if (bucket) bucket.push(event)
      else droppedBySession.set(sessionId, [event])
    } else {
      kept.push(event)
    }
  }
  return { kept, droppedBySession }
}

/**
 * Write one batch's behavioral rows into `claude_telemetry_events`.
 * Content and body-pointer events yield no rows (`claudeTelemetryEventRows`
 * filters them), so a purely conversational batch writes nothing here.
 *
 * A failure is handled exactly like a message-dataset write failure:
 * counted on the state, marked on the span, logged, and re-thrown so
 * the transport answers with an error the exporter retries.
 *
 * @ref LLP 0257#outputs [implements]: one row per event, hot fields typed,
 *   the remainder in the attributes JSON column
 * @param {ClaudeTelemetryEvent[]} events
 * @param {{
 *   ctx: PluginActivationContext,
 *   state: ClaudeTelemetryListenerState,
 *   span: { setAttribute(key: string, value: unknown): unknown },
 * }} args
 * @returns {Promise<number>} rows written
 */
async function recordTelemetryEvents(events, { ctx, state, span }) {
  const rows = claudeTelemetryEventRows(events)
  if (rows.length === 0) return 0
  try {
    await ctx.storage.appendRows(
      claudeTelemetryTablePath(ctx.storage),
      [...CLAUDE_TELEMETRY_EVENT_COLUMNS],
      rows
    )
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err)
    span.setAttribute('error_kind', 'dataset_write')
    ctx.log.error('claude.telemetry.write_failed', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      dataset: 'claude_telemetry_events',
      event_count: events.length,
      error: state.lastError,
    })
    throw err
  }
  state.telemetryRowsWritten += rows.length
  return rows.length
}

/**
 * Bind the listener, falling back to an ephemeral port when the DEFAULT
 * port is taken. An address the operator wrote down fails loudly
 * instead; a default that happens to collide must not stop the daemon,
 * because attach reads the bound port off the source status anyway.
 *
 * @ref LLP 0114#explicit-listen-fails-loudly [constrained-by]: only the
 *   unconfigured default falls back
 * @param {{
 *   server: Server,
 *   listen: { host: string, port: number, portConfigured: boolean },
 *   log: PluginActivationContext['log'],
 *   state: { listenFallbackFrom: number | undefined },
 * }} args
 */
async function bindWithFallback({ server, listen, log, state }) {
  try {
    return await listenAndResolve(server, listen.host, listen.port, LISTENER_NAME)
  } catch (err) {
    const code = err && /** @type {NodeJS.ErrnoException} */ (err).code
    if (listen.portConfigured || code !== 'EADDRINUSE') throw err
    log.warn('claude.telemetry.default_port_taken', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      listen_port: listen.port,
    })
    state.listenFallbackFrom = listen.port
    return listenAndResolve(server, listen.host, 0, LISTENER_NAME)
  }
}

/**
 * The listener port `otel`-mode attach writes into
 * `env.OTEL_EXPORTER_OTLP_ENDPOINT`.
 *
 * Three rungs, in trust order. The running daemon's bound port wins: it is the
 * only place the truth lives once the default-port fallback in
 * {@link bindWithFallback} has moved the listener, and the source status is
 * where that promise was made. With no live daemon, a configured fixed port is
 * the address the operator stated. Otherwise the well-known default: the same
 * port the next daemon start will try first, so an attach that ran before the
 * first daemon start still points where the listener will appear. A configured
 * `0` (dynamic) has no knowable port until a daemon publishes one, so it reads
 * as unconfigured here.
 *
 * @ref LLP 0258#env-keys [constrained-by]: the endpoint's port must be the
 *   listener's real one, or the whole env block captures nothing
 * @param {{ stateRoot: string, config: unknown }} args
 * @returns {number}
 */
export function resolveAttachTelemetryPort({ stateRoot, config }) {
  const live = resolveLiveSourceListenPortFromStatus({
    stateRoot,
    sourceName: CLAUDE_TELEMETRY_SOURCE,
  })
  if (live !== undefined) return live

  const raw = /** @type {Record<string, unknown>} */ (
    config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  )
  const telemetry = raw.telemetry
  const slice = telemetry && typeof telemetry === 'object' && !Array.isArray(telemetry)
    ? /** @type {Record<string, unknown>} */ (telemetry)
    : {}
  const portRaw = slice.listen_port
  if (typeof portRaw === 'number' && Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535) {
    return portRaw
  }
  return DEFAULT_TELEMETRY_PORT
}

/**
 * Resolve where the body spool lives and how large it may grow. The
 * directory is fixed under the HypAware home (attach, detach, and
 * `hyp purge` all derive the same path); only the byte cap is config,
 * `telemetry.spool_max_bytes`, defaulting to 512 MB. A mistyped cap
 * falls back to the default and warns, matching `readListenConfig`.
 *
 * @ref LLP 0253#byte-cap [implements]: the cap is one config value an operator
 *   can lower on a small disk
 * @param {PluginActivationContext} ctx
 * @returns {{ dir: string, maxBytes: number }}
 */
export function readSpoolConfig(ctx) {
  const dir = claudeBodySpoolDir(readObservabilityEnv(ctx.env).hypHome)
  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const telemetry = config.telemetry
  const slice = telemetry && typeof telemetry === 'object' && !Array.isArray(telemetry)
    ? /** @type {Record<string, unknown>} */ (telemetry)
    : {}

  let maxBytes = DEFAULT_SPOOL_MAX_BYTES
  const raw = slice.spool_max_bytes
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) {
    maxBytes = raw
  } else if (raw !== undefined) {
    ctx.log.warn('claude.telemetry.config_invalid', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      key: 'telemetry.spool_max_bytes',
      value_type: typeof raw,
    })
  }
  return { dir, maxBytes }
}

/**
 * Read `telemetry.listen_host` / `telemetry.listen_port` out of the
 * plugin's config slice. Mistyped values fall back to the defaults and
 * warn, matching the OTLP receiver's behavior.
 *
 * @param {PluginActivationContext} ctx
 * @returns {{ host: string, port: number, portConfigured: boolean }}
 */
export function readListenConfig(ctx) {
  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const telemetry = config.telemetry
  const slice = telemetry && typeof telemetry === 'object' && !Array.isArray(telemetry)
    ? /** @type {Record<string, unknown>} */ (telemetry)
    : {}

  let host = DEFAULT_HOST
  const hostRaw = slice.listen_host
  if (typeof hostRaw === 'string' && hostRaw.length > 0) host = hostRaw
  else if (hostRaw !== undefined) {
    ctx.log.warn('claude.telemetry.config_invalid', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      key: 'telemetry.listen_host',
      value_type: typeof hostRaw,
    })
  }

  let port = DEFAULT_TELEMETRY_PORT
  let portConfigured = false
  const portRaw = slice.listen_port
  if (typeof portRaw === 'number' && Number.isInteger(portRaw) && portRaw >= 0 && portRaw <= 65535) {
    port = portRaw
    portConfigured = true
  } else if (portRaw !== undefined) {
    ctx.log.warn('claude.telemetry.config_invalid', {
      [Attr.PLUGIN]: PLUGIN_NAME,
      key: 'telemetry.listen_port',
      value_type: typeof portRaw,
    })
  }

  return { host, port, portConfigured }
}
