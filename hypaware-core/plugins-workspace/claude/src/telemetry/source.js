// @ts-check

import { Attr, getActiveSpan, withSpan } from '../../../../../src/core/observability/index.js'
import { readObservabilityEnv } from '../../../../../src/core/observability/env.js'
import { resolveLiveSourceListenPortFromStatus } from '../../../../../src/core/daemon/status.js'
import { createOtlpJsonServer, listenAndResolve } from '../../../../../src/core/otlp/server.js'
import { createSessionContextReader, pickLatestMatching } from '../session_context.js'
import { deleteSpooledBodies, loadSpooledBodies } from './bodies.js'
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
      lastEventAt: undefined,
      lastError: undefined,
      listenFallbackFrom: undefined,
      spoolBytes: 0,
      bodiesProjected: 0,
      bodiesDeleted: 0,
      bodiesEvicted: 0,
      bodiesMissing: 0,
      bodiesUnparseable: 0,
    }

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
    })
    const server = createOtlpJsonServer({
      name: LISTENER_NAME,
      handler: { handle: handler },
      signals: [...SERVED_SIGNALS],
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
 * }} args
 * @returns {(req: OtlpRequest) => Promise<void>}
 */
function makeReceiveHandler({ ctx, deps, state, usageByRequestId, sessionBodyFacts, readSessionContext, spoolDir }) {
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
          const metricEvents = flattenClaudeTelemetryMetrics(req.data)
          span.setAttribute('event_count', metricEvents.length)
          span.setAttribute('row_count', 0)
          if (metricEvents.length === 0) {
            span.setAttribute('telemetry_row_count', 0)
            return
          }
          state.eventsReceived += metricEvents.length
          for (const event of metricEvents) {
            if (event.timestamp && (state.lastEventAt === undefined || event.timestamp > state.lastEventAt)) {
              state.lastEventAt = event.timestamp
            }
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

        const events = flattenClaudeTelemetryEvents(req.data)
        span.setAttribute('event_count', events.length)
        if (events.length === 0) {
          span.setAttribute('row_count', 0)
          return
        }
        state.eventsReceived += events.length
        for (const event of events) {
          if (event.timestamp && (state.lastEventAt === undefined || event.timestamp > state.lastEventAt)) {
            state.lastEventAt = event.timestamp
          }
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
