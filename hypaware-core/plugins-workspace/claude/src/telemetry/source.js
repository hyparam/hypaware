// @ts-check

import { Attr, getActiveSpan, withSpan } from '../../../../../src/core/observability/index.js'
import { resolveLiveSourceListenPortFromStatus } from '../../../../../src/core/daemon/status.js'
import { createOtlpJsonServer, listenAndResolve } from '../../../../../src/core/otlp/server.js'
import { createSessionContextReader, pickLatestMatching } from '../session_context.js'
import { flattenClaudeTelemetryEvents } from './events.js'
import { projectClaudeTelemetryEvents } from './projection.js'

/**
 * @import { Server } from 'node:http'
 * @import { AiGatewayCapability, PluginActivationContext, SourceStatus, StartedSource } from '../../../../../hypaware-plugin-kernel-types.js'
 * @import { OtlpRequest } from '../../../../../src/core/otlp/types.js'
 * @import { SessionContextRecord } from '../types.js'
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
 * `/v1/metrics` too. Serving the route and dropping the payload keeps
 * the exporter from retrying against a 404 forever; the metrics half of
 * the stream lands in `claude_telemetry_events` under LLP 0255, not here.
 */
const SERVED_SIGNALS = /** @type {const} */ (['logs', 'metrics'])

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
    /** @type {{ rowsWritten: number, rowsSkipped: number, eventsReceived: number, lastEventAt: string | undefined, lastError: string | undefined, listenFallbackFrom: number | undefined }} */
    const state = {
      rowsWritten: 0,
      rowsSkipped: 0,
      eventsReceived: 0,
      lastEventAt: undefined,
      lastError: undefined,
      listenFallbackFrom: undefined,
    }

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

    const handler = makeReceiveHandler({ ctx, deps, state, usageByRequestId, readSessionContext })
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
            // @ref LLP 0257#status-and-health [implements]: the status details
            // carry the last event seen; `hyp status` renders the health line
            // from it.
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
 * project its events, and write the rows.
 *
 * A throw here becomes an HTTP 500 the exporter will retry, so
 * everything recoverable is handled: an unparseable envelope yields zero
 * events, an event this listener does not model is skipped, and only a
 * genuine write failure propagates.
 *
 * @param {{
 *   ctx: PluginActivationContext,
 *   deps: { gateway: AiGatewayCapability, clientName: string, stateFile: string },
 *   state: { rowsWritten: number, rowsSkipped: number, eventsReceived: number, lastEventAt: string | undefined, lastError: string | undefined },
 *   usageByRequestId: Map<string, Record<string, unknown>>,
 *   readSessionContext: () => Promise<SessionContextRecord[]>,
 * }} args
 * @returns {(req: OtlpRequest) => Promise<void>}
 */
function makeReceiveHandler({ ctx, deps, state, usageByRequestId, readSessionContext }) {
  return async function handle(req) {
    // Metrics ride the same exporter config; the message dataset has
    // nothing to learn from them.
    if (req.signal !== 'logs') return

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

        const records = await readSessionContext()
        const projections = projectClaudeTelemetryEvents(events, {
          clientName: deps.clientName,
          usageByRequestId,
          sessionContext: (sessionId) => pickLatestMatching(records, { sessionId }),
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
        span.setAttribute('row_count', rowsWritten)
        span.setAttribute('rows_skipped', rowsSkipped)
        ctx.log.info('claude.telemetry.batch', {
          [Attr.PLUGIN]: PLUGIN_NAME,
          event_count: events.length,
          session_count: projections.length,
          rows_written: rowsWritten,
          rows_skipped: rowsSkipped,
        })
      },
      { component: 'plugin.claude' }
    )
  }
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
