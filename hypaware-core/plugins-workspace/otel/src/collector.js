// @ts-check

import {
  Attr,
  getActiveSpan,
  withSpan,
} from '../../../../src/core/observability/index.js'
import { columnsFor, otelTablePath, PLUGIN_NAME } from './datasets.js'
import { flattenOtlpLogs } from './otlp/logs.js'
import { flattenOtlpTraces } from './otlp/traces.js'
import { flattenOtlpMetrics } from './otlp/metrics.js'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginActivationContext} PluginActivationContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginLogger} PluginLogger */
/** @typedef {import('./server.js').OtlpRequest} OtlpRequest */

const FLATTENERS = {
  logs: flattenOtlpLogs,
  traces: flattenOtlpTraces,
  metrics: flattenOtlpMetrics,
}

/**
 * Wrap a single OTLP request in an `otel.receive` span and dispatch it
 * into the storage cache. `signal`, `payload_bytes`, and `row_count`
 * are pinned on the span per the §Phase 8.1 contract; parse and persist
 * failures land with `error_kind=otlp_parse|otlp_persist` so the
 * operator can grep for either.
 *
 * @param {PluginActivationContext} ctx
 * @param {{ rowsWritten: number, lastError: string | undefined }} state
 * @param {PluginLogger} log
 * @returns {(req: OtlpRequest) => Promise<void>}
 */
export function makeReceiveHandler(ctx, state, log) {
  return async function handle(req) {
    if (shouldDropHypAwareSelfTelemetry(ctx, req)) return

    await withSpan(
      'otel.receive',
      {
        [Attr.COMPONENT]: 'sources',
        [Attr.PLUGIN]: PLUGIN_NAME,
        [Attr.OPERATION]: 'otel.receive',
        hyp_source: 'otlp',
        signal: req.signal,
        payload_bytes: req.payloadBytes,
        status: 'ok',
      },
      async (span) => {
        /** @type {Record<string, unknown>[]} */
        let rows
        try {
          rows = FLATTENERS[req.signal](req.data)
        } catch (err) {
          state.lastError = err instanceof Error ? err.message : String(err)
          const wrapped = err instanceof Error ? err : new Error(String(err))
          /** @type {Error & { hypErrorKind?: string }} */ (wrapped).hypErrorKind = 'otlp_parse'
          span.setAttribute('error_kind', 'otlp_parse')
          span.setAttribute('row_count', 0)
          log.error('otel.parse_failed', {
            signal: req.signal,
            payload_bytes: req.payloadBytes,
            error: state.lastError,
          })
          throw wrapped
        }

        span.setAttribute('row_count', rows.length)

        if (rows.length === 0) return

        try {
          const tablePath = otelTablePath(ctx.storage, req.signal)
          await ctx.storage.appendRows(tablePath, [...columnsFor(req.signal)], rows)
          state.rowsWritten += rows.length
        } catch (err) {
          state.lastError = err instanceof Error ? err.message : String(err)
          const wrapped = err instanceof Error ? err : new Error(String(err))
          /** @type {Error & { hypErrorKind?: string }} */ (wrapped).hypErrorKind = 'otlp_persist'
          span.setAttribute('error_kind', 'otlp_persist')
          log.error('otel.persist_failed', {
            signal: req.signal,
            row_count: rows.length,
            error: state.lastError,
          })
          throw wrapped
        }
      },
      { component: 'plugin' }
    )
  }
}

/**
 * Avoid a feedback loop when the HypAware daemon's own OTel exporter is
 * pointed at the bundled OTLP listener. The self resource marker is
 * added by `src/core/observability/resource.js`; external telemetry is
 * unaffected unless the operator opts into self capture.
 *
 * @param {PluginActivationContext} ctx
 * @param {OtlpRequest} req
 * @returns {boolean}
 */
function shouldDropHypAwareSelfTelemetry(ctx, req) {
  if (ctx.config && typeof ctx.config === 'object') {
    const captureSelf = Reflect.get(/** @type {object} */ (ctx.config), 'capture_self_telemetry')
    if (captureSelf === true) return false
  }
  return requestContainsOnlySelfResources(req.signal, req.data)
}

/**
 * @param {'logs' | 'traces' | 'metrics'} signal
 * @param {unknown} payload
 * @returns {boolean}
 */
function requestContainsOnlySelfResources(signal, payload) {
  const root = asObject(payload)
  if (!root) return false
  const key =
    signal === 'logs' ? 'resourceLogs'
    : signal === 'traces' ? 'resourceSpans'
    : 'resourceMetrics'
  const groups = Reflect.get(root, key)
  if (!Array.isArray(groups) || groups.length === 0) return false
  return groups.every((group) => resourceHasSelfMarker(asObject(group)?.resource))
}

/**
 * @param {unknown} resource
 * @returns {boolean}
 */
function resourceHasSelfMarker(resource) {
  const attrs = asObject(resource)?.attributes
  if (!Array.isArray(attrs)) return false
  for (const entry of attrs) {
    const pair = asObject(entry)
    if (pair?.key !== 'hypaware.self') continue
    const value = asObject(pair.value)
    return value?.boolValue === true || value?.stringValue === 'true'
  }
  return false
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * Stamp `listen_host` and `listen_port` onto the currently-active
 * `source.start` span. Called by `source.js` once the HTTP listener has
 * bound — the kernel opens the span for us, and we just enrich it.
 *
 * @param {string} host
 * @param {number} port
 */
export function stampBoundAddress(host, port) {
  const span = getActiveSpan()
  if (!span) return
  span.setAttribute('listen_host', host)
  span.setAttribute('listen_port', port)
}
