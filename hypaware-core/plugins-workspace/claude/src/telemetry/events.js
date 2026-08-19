// @ts-check

/**
 * @import { ClaudeTelemetryEvent } from '../types.js'
 */

/**
 * Instrumentation scope Claude Code stamps on its telemetry log
 * records (`com.anthropic.claude_code.events`). Everything this
 * listener understands comes from that scope; anything else on the
 * wire is another exporter that found the port and is ignored rather
 * than half-parsed.
 */
export const CLAUDE_EVENT_SCOPE_PREFIX = 'com.anthropic.claude_code'

/**
 * Resource attribute the daemon stamps on its OWN telemetry
 * (`src/core/observability/resource.js`). A daemon exporting into a
 * listener the daemon hosts is the loop LLP 0021 forbids.
 */
const SELF_MARKER_KEY = 'hypaware.self'

/**
 * Decode one OTLP/JSON logs envelope into flat Claude Code events.
 *
 * The transport (routing, content type, encoding, response envelope) is
 * the shared core server's; this is the payload half, and it is
 * deliberately Claude-shaped: the record's identity is the `event.name`
 * attribute, the timestamp is the `event.timestamp` attribute Claude
 * Code sends as ISO-8601, and the OTLP `AnyValue` wrappers are unwrapped
 * so the projector never sees `{ stringValue: ... }`.
 *
 * Never throws on a malformed envelope: a missing array, a null record,
 * or an attribute with no recognizable value type simply contributes
 * nothing. An exporter we cannot fix from our side must not be able to
 * fail the request.
 *
 * @ref LLP 0257#registration [implements]: the shared server carries the
 *   transport; payload interpretation is claude-owned, including the
 *   self-telemetry loop guard
 * @param {unknown} data OTLP/JSON `ExportLogsServiceRequest`
 * @returns {ClaudeTelemetryEvent[]}
 */
export function flattenClaudeTelemetryEvents(data) {
  /** @type {ClaudeTelemetryEvent[]} */
  const events = []
  const root = asObject(data)
  if (!root) return events
  const groups = Array.isArray(root.resourceLogs) ? root.resourceLogs : []

  for (const groupValue of groups) {
    const group = asObject(groupValue)
    if (!group) continue
    if (resourceHasSelfMarker(group.resource)) continue
    const scopes = Array.isArray(group.scopeLogs) ? group.scopeLogs : []
    for (const scopeValue of scopes) {
      const scopeLog = asObject(scopeValue)
      if (!scopeLog) continue
      const scopeName = stringOf(asObject(scopeLog.scope)?.name)
      if (!scopeName || !scopeName.startsWith(CLAUDE_EVENT_SCOPE_PREFIX)) continue
      const records = Array.isArray(scopeLog.logRecords) ? scopeLog.logRecords : []
      for (const recordValue of records) {
        const event = eventFromRecord(recordValue)
        if (event) events.push(event)
      }
    }
  }

  return events
}

/**
 * Decode one OTLP/JSON metrics envelope into the same flat event shape.
 *
 * Claude Code exports its activity counters (`claude_code.cost.usage`,
 * `claude_code.lines_of_code.count`, `claude_code.active_time.total`,
 * ...) as OTLP metrics on the same exporter config, and they are part of
 * the behavioral record LLP 0255 gives a home: one data point becomes
 * one event, named by the metric, its data-point attributes joined by
 * `value` (and `unit` when the metric declares one). The same scope and
 * self-marker guards apply, and the same never-throw posture: a shape
 * this decoder does not recognize contributes nothing.
 *
 * @ref LLP 0255#row-shape [implements]: a metric data point is an event too -
 *   one row, named by the metric, value and attributes preserved
 * @param {unknown} data OTLP/JSON `ExportMetricsServiceRequest`
 * @returns {ClaudeTelemetryEvent[]}
 */
export function flattenClaudeTelemetryMetrics(data) {
  /** @type {ClaudeTelemetryEvent[]} */
  const events = []
  const root = asObject(data)
  if (!root) return events
  const groups = Array.isArray(root.resourceMetrics) ? root.resourceMetrics : []

  for (const groupValue of groups) {
    const group = asObject(groupValue)
    if (!group) continue
    if (resourceHasSelfMarker(group.resource)) continue
    const scopes = Array.isArray(group.scopeMetrics) ? group.scopeMetrics : []
    for (const scopeValue of scopes) {
      const scopeMetric = asObject(scopeValue)
      if (!scopeMetric) continue
      const scopeName = stringOf(asObject(scopeMetric.scope)?.name)
      if (!scopeName || !scopeName.startsWith(CLAUDE_EVENT_SCOPE_PREFIX)) continue
      const metrics = Array.isArray(scopeMetric.metrics) ? scopeMetric.metrics : []
      for (const metricValue of metrics) {
        const metric = asObject(metricValue)
        if (!metric) continue
        const name = stringOf(metric.name)
        if (!name) continue
        const unit = stringOf(metric.unit)
        for (const pointValue of metricDataPoints(metric)) {
          const event = eventFromDataPoint(name, unit, pointValue)
          if (event) events.push(event)
        }
      }
    }
  }

  return events
}

/**
 * @param {string} name
 * @param {string | undefined} unit
 * @param {unknown} value one OTLP `NumberDataPoint`
 * @returns {ClaudeTelemetryEvent | undefined}
 */
function eventFromDataPoint(name, unit, value) {
  const point = asObject(value)
  if (!point) return undefined
  const attributes = decodeAttributes(point.attributes)
  // `value`/`unit` are plain keys (not `metric.`-namespaced) so SQL
  // reads them as `JSON_VALUE(attributes, '$.value')`; no Claude Code
  // data point carries attributes by those names.
  const pointValue = numberOf(point.asDouble) ?? numberOf(point.asInt) ?? numberOf(point.sum)
  if (pointValue !== undefined) attributes.value = pointValue
  if (unit) attributes.unit = unit
  const timestamp = isoFromUnixNano(point.timeUnixNano) ?? isoFromUnixNano(point.startTimeUnixNano)
  return {
    name,
    attributes,
    ...(timestamp ? { timestamp } : {}),
  }
}

/**
 * The data points under whichever aggregation the metric carries.
 * Claude Code's are all sums (counters); gauge and histogram are read
 * too so an upstream change of aggregation degrades to "value read
 * differently", not to a dropped metric.
 *
 * @param {Record<string, unknown>} metric
 * @returns {unknown[]}
 */
function metricDataPoints(metric) {
  for (const key of ['sum', 'gauge', 'histogram']) {
    const aggregation = asObject(metric[key])
    if (aggregation && Array.isArray(aggregation.dataPoints)) return aggregation.dataPoints
  }
  return []
}

/**
 * @param {unknown} value
 * @returns {ClaudeTelemetryEvent | undefined}
 */
function eventFromRecord(value) {
  const record = asObject(value)
  if (!record) return undefined
  const attributes = decodeAttributes(record.attributes)
  const name = stringOf(attributes['event.name'])
  if (!name) return undefined
  const timestamp = stringOf(attributes['event.timestamp'])
    ?? isoFromUnixNano(record.timeUnixNano)
    ?? isoFromUnixNano(record.observedTimeUnixNano)
  const sequence = numberOf(attributes['event.sequence'])
  return {
    name,
    attributes,
    ...(timestamp ? { timestamp } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
  }
}

/**
 * Unwrap an OTLP `KeyValue[]` into a plain object. Values keep their
 * natural JS type where OTLP names one (`intValue`, `doubleValue`,
 * `boolValue`); Claude Code sends several numeric fields as strings, so
 * consumers still coerce rather than trusting the wire type.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function decodeAttributes(value) {
  /** @type {Record<string, unknown>} */
  const out = {}
  if (!Array.isArray(value)) return out
  for (const entry of value) {
    const pair = asObject(entry)
    const key = stringOf(pair?.key)
    if (!key) continue
    out[key] = decodeAnyValue(pair?.value)
  }
  return out
}

/**
 * @param {unknown} value OTLP `AnyValue`
 * @returns {unknown}
 */
function decodeAnyValue(value) {
  const wrapper = asObject(value)
  if (!wrapper) return undefined
  if ('stringValue' in wrapper) return wrapper.stringValue
  if ('boolValue' in wrapper) return wrapper.boolValue
  if ('doubleValue' in wrapper) return numberOf(wrapper.doubleValue)
  // OTLP/JSON may render an int64 as a string; keep numeric identity
  // when it fits, and fall back to the raw string when it does not.
  if ('intValue' in wrapper) return numberOf(wrapper.intValue) ?? wrapper.intValue
  if ('arrayValue' in wrapper) {
    const values = asObject(wrapper.arrayValue)?.values
    return Array.isArray(values) ? values.map(decodeAnyValue) : []
  }
  if ('kvlistValue' in wrapper) {
    return decodeAttributes(asObject(wrapper.kvlistValue)?.values)
  }
  if ('bytesValue' in wrapper) return wrapper.bytesValue
  return undefined
}

/**
 * @param {unknown} resource
 * @returns {boolean}
 */
function resourceHasSelfMarker(resource) {
  const attrs = decodeAttributes(asObject(resource)?.attributes)
  const marker = attrs[SELF_MARKER_KEY]
  return marker === true || marker === 'true'
}

/**
 * @param {unknown} value nanoseconds since the epoch, as a string or number
 * @returns {string | undefined}
 */
function isoFromUnixNano(value) {
  const nanos = typeof value === 'string' ? Number(value)
    : typeof value === 'number' ? value
    : undefined
  if (nanos === undefined || !Number.isFinite(nanos) || nanos <= 0) return undefined
  const date = new Date(Math.round(nanos / 1e6))
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
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
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
