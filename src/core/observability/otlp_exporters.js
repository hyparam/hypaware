// @ts-check

import { hrTimeToUnixNano, SpanStatusCode } from './runtime.js'

/**
 * @import { LogRecord, MetricRecord } from './types.d.ts'
 * @import { Span } from './runtime.js'
 */

const OTLP_AGGREGATION_TEMPORALITY_CUMULATIVE = 2

class OtlpHttpJsonExporter {
  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {number} opts.timeoutMillis
   */
  constructor({ url, timeoutMillis }) {
    this.url = url
    this.timeoutMillis = timeoutMillis
    /** @type {Promise<unknown>[]} */
    this.pending = []
  }

  /** @param {unknown} payload */
  post(payload) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMillis)
    if (typeof timer.unref === 'function') timer.unref()
    const request = fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).catch(() => undefined).finally(() => clearTimeout(timer))
    this.pending.push(request)
  }

  async forceFlush() {
    const pending = this.pending.splice(0)
    await Promise.allSettled(pending)
  }

  async shutdown() {
    await this.forceFlush()
  }
}

export class OtlpSpanExporter extends OtlpHttpJsonExporter {
  /** @param {Span[]} spans */
  exportBatch(spans) {
    if (spans.length === 0) return
    this.post({ resourceSpans: groupByResourceAndScope(spans, spanToOtlp) })
  }
}

export class OtlpLogExporter extends OtlpHttpJsonExporter {
  /** @param {LogRecord[]} records */
  exportBatch(records) {
    if (records.length === 0) return
    this.post({ resourceLogs: groupLogsByResourceAndScope(records) })
  }
}

export class OtlpMetricExporter extends OtlpHttpJsonExporter {
  /** @param {MetricRecord[]} records */
  exportBatch(records) {
    if (records.length === 0) return
    this.post({ resourceMetrics: groupMetricsByResourceAndScope(records) })
  }
}

/**
 * @param {Span[]} spans
 * @param {(span: Span) => object} mapSpan
 */
function groupByResourceAndScope(spans, mapSpan) {
  /** @type {Map<string, { resource: object, scopeSpans: Array<{ scope: object, spans: object[] }> }>} */
  const byResource = new Map()
  for (const span of spans) {
    const resourceKey = JSON.stringify(span.resource.attributes)
    let group = byResource.get(resourceKey)
    if (!group) {
      group = { resource: { attributes: attrsToOtlp(span.resource.attributes) }, scopeSpans: [] }
      byResource.set(resourceKey, group)
    }
    let scope = group.scopeSpans.find((s) => s.scope.name === span.tracerName && s.scope.version === span.tracerVersion)
    if (!scope) {
      scope = { scope: cleanObject({ name: span.tracerName, version: span.tracerVersion }), spans: [] }
      group.scopeSpans.push(scope)
    }
    scope.spans.push(mapSpan(span))
  }
  return [...byResource.values()]
}

/** @param {LogRecord[]} records */
function groupLogsByResourceAndScope(records) {
  /** @type {Map<string, { resource: object, scopeLogs: Array<{ scope: object, logRecords: object[] }> }>} */
  const byResource = new Map()
  for (const record of records) {
    const resourceKey = JSON.stringify(record.resource.attributes)
    let group = byResource.get(resourceKey)
    if (!group) {
      group = { resource: { attributes: attrsToOtlp(record.resource.attributes) }, scopeLogs: [] }
      byResource.set(resourceKey, group)
    }
    let scope = group.scopeLogs.find((s) => s.scope.name === record.loggerName && s.scope.version === record.loggerVersion)
    if (!scope) {
      scope = { scope: cleanObject({ name: record.loggerName, version: record.loggerVersion }), logRecords: [] }
      group.scopeLogs.push(scope)
    }
    scope.logRecords.push(logToOtlp(record))
  }
  return [...byResource.values()]
}

/** @param {MetricRecord[]} records */
function groupMetricsByResourceAndScope(records) {
  /** @type {Map<string, { resource: object, scopeMetrics: Array<{ scope: object, metrics: object[] }> }>} */
  const byResource = new Map()
  for (const record of records) {
    const resourceKey = JSON.stringify(record.resource.attributes)
    let group = byResource.get(resourceKey)
    if (!group) {
      group = { resource: { attributes: attrsToOtlp(record.resource.attributes) }, scopeMetrics: [] }
      byResource.set(resourceKey, group)
    }
    let scope = group.scopeMetrics.find((s) => s.scope.name === record.meterName && s.scope.version === record.meterVersion)
    if (!scope) {
      scope = { scope: cleanObject({ name: record.meterName, version: record.meterVersion }), metrics: [] }
      group.scopeMetrics.push(scope)
    }
    scope.metrics.push(metricToOtlp(record))
  }
  return [...byResource.values()]
}

/** @param {Span} span */
function spanToOtlp(span) {
  const ctx = span.spanContext()
  return cleanObject({
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: String(hrTimeToUnixNano(span.startTime)),
    endTimeUnixNano: String(hrTimeToUnixNano(span.endTime)),
    attributes: attrsToOtlp(span.attributes),
    events: span.events.map((event) => ({
      timeUnixNano: String(hrTimeToUnixNano(event.time)),
      name: event.name,
      attributes: attrsToOtlp(event.attributes),
    })),
    status: spanStatusToOtlp(span.status),
  })
}

/** @param {LogRecord} record */
function logToOtlp(record) {
  return cleanObject({
    timeUnixNano: String(hrTimeToUnixNano(record.hrTime)),
    observedTimeUnixNano: String(hrTimeToUnixNano(record.hrTimeObserved)),
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    body: anyValueToOtlp(record.body),
    traceId: record.spanContext?.traceId,
    spanId: record.spanContext?.spanId,
    flags: record.spanContext?.traceFlags,
    attributes: attrsToOtlp(record.attributes),
  })
}

/** @param {MetricRecord} record */
function metricToOtlp(record) {
  const pointBase = {
    startTimeUnixNano: String(hrTimeToUnixNano(record.startTime)),
    timeUnixNano: String(hrTimeToUnixNano(record.endTime)),
    attributes: attrsToOtlp(record.attributes),
  }
  if (record.kind === 'histogram') {
    return cleanObject({
      name: record.name,
      description: record.description,
      unit: record.unit,
      histogram: {
        aggregationTemporality: OTLP_AGGREGATION_TEMPORALITY_CUMULATIVE,
        dataPoints: [{
          ...pointBase,
          count: '1',
          sum: record.value,
          bucketCounts: ['1'],
          explicitBounds: [],
        }],
      },
    })
  }
  const containerName = record.kind === 'gauge' ? 'gauge' : 'sum'
  return cleanObject({
    name: record.name,
    description: record.description,
    unit: record.unit,
    [containerName]: {
      ...(containerName === 'sum'
        ? {
            aggregationTemporality: OTLP_AGGREGATION_TEMPORALITY_CUMULATIVE,
            isMonotonic: record.monotonic,
          }
        : {}),
      dataPoints: [{ ...pointBase, asDouble: record.value }],
    },
  })
}

/**
 * @param {{ code: number, message?: string }} status
 */
function spanStatusToOtlp(status) {
  return cleanObject({
    code: status.code === SpanStatusCode.ERROR ? 2 : status.code === SpanStatusCode.OK ? 1 : 0,
    message: status.message,
  })
}

/** @param {Record<string, unknown>} attrs */
function attrsToOtlp(attrs) {
  return Object.entries(attrs ?? {})
    .filter(([key, value]) => key.length > 0 && value !== undefined)
    .map(([key, value]) => ({ key, value: anyValueToOtlp(value) }))
}

/** @param {unknown} value */
function anyValueToOtlp(value) {
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  if (typeof value === 'bigint') return { intValue: String(value) }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValueToOtlp) } }
  if (value && typeof value === 'object') {
    return {
      kvlistValue: {
        values: Object.entries(/** @type {Record<string, unknown>} */ (value))
          .map(([key, item]) => ({ key, value: anyValueToOtlp(item) })),
      },
    }
  }
  return { stringValue: '' }
}

/** @param {Record<string, unknown>} obj */
function cleanObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined))
}
