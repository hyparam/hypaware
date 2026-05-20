import fs from 'node:fs'
import path from 'node:path'
import { createServer } from './server.js'

/**
 * @import { Server } from 'node:http'
 * @import { NormalizedLogRow, NormalizedServiceRow, MetricRowBase, Sink } from './types.js'
 * @import { UploadOptions } from './upload/upload.js'
 */

const OTLP_NS_PER_MS = 1000000n
const MIN_DATE_MS = -8640000000000000n
const MAX_DATE_MS = 8640000000000000n

export class Collector {
  /** @param {{ port?: number, host?: string, outputDir?: string, gatewayId: string, upload?: UploadOptions, rowSinks?: Partial<Record<'logs' | 'traces' | 'metrics', Sink>> }} options */
  constructor(options) {
    if (!options || typeof options.gatewayId !== 'string' || options.gatewayId.length === 0) {
      throw new Error('Collector: gatewayId is required')
    }
    this.port = options.port ?? 4318
    /** @type {string | undefined} */
    this.host = options.host
    this.outputDir = options.outputDir || './otel-data'
    this.gatewayId = options.gatewayId
    this.uploadOptions = options.upload
    /** @type {Partial<Record<'logs' | 'traces' | 'metrics', Sink>> | undefined} */
    this.rowSinks = options.rowSinks
    /** @type {Server | undefined} */
    this.server = undefined
    /** @type {{ start: () => Promise<void>, stop: () => Promise<void> } | undefined} */
    this.uploader = undefined
  }

  async start() {
    if (!this.rowSinks || this.uploadOptions) {
      ensureDir(this.outputDir)
    }

    const server = createServer(this.handleData.bind(this))
    this.server = server

    await new Promise((resolve, reject) => {
      /** @param {Error} err */
      function onError(err) {
        server.off('listening', onListening)
        reject(err)
      }
      function onListening() {
        server.off('error', onError)
        resolve(undefined)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      if (this.host !== undefined) {
        server.listen(this.port, this.host)
      } else {
        server.listen(this.port)
      }
    })

    if (this.uploadOptions) {
      const { createUploader } = await import('./upload/index.js')
      this.uploader = createUploader({
        outputDir: this.outputDir,
        options: this.uploadOptions,
      })
      await this.uploader.start()
    }
  }

  async stop() {
    if (this.uploader) {
      await this.uploader.stop()
      this.uploader = undefined
    }
    await new Promise((resolve, reject) => {
      const { server } = this
      if (!server) {
        resolve(undefined)
        return
      }
      server.close((err) => err ? reject(err) : resolve(undefined))
    })
  }

  /**
   * @param {string} signal
   * @param {unknown} data
   */
  async handleData(signal, data) {
    if (this.rowSinks) {
      await writeRowsToSinks(this.rowSinks, signal, data)
      return
    }
    writeRawEnvelope(this.outputDir, this.gatewayId, signal, data)
    writeNormalizedRows(this.outputDir, this.gatewayId, signal, data)
  }
}

/**
 * @returns {string}
 */
function todayUtc() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Write the raw OTLP envelope for a signal under
 * `<outputDir>/<gatewayId>/raw/<signal>/<UTC-date>.jsonl`. Preserved alongside
 * the normalized rows so debugging tools can still see the original
 * resource/scope grouping that the per-record flattener discards.
 *
 * @param {string} outputDir
 * @param {string} gatewayId
 * @param {string} signal
 * @param {unknown} data
 * @returns {void}
 */
function writeRawEnvelope(outputDir, gatewayId, signal, data) {
  const dir = path.join(outputDir, gatewayId, 'raw', signal)
  ensureDir(dir)
  const filePath = path.join(dir, `${todayUtc()}.jsonl`)
  fs.appendFileSync(filePath, JSON.stringify(data) + '\n')
}

/**
 * Write normalized per-record rows under
 * `<outputDir>/<gatewayId>/<signal>/<UTC-date>.jsonl`. This is the path the
 * upload pipeline drains and matches the layout the server-mode ingest
 * endpoint writes, so standalone and server installs share one shape.
 *
 * @param {string} outputDir
 * @param {string} gatewayId
 * @param {string} signal
 * @param {unknown} data
 * @returns {void}
 */
function writeNormalizedRows(outputDir, gatewayId, signal, data) {
  const rows = flattenSignalRows(signal, data)
  if (rows.length === 0) return
  const dir = path.join(outputDir, gatewayId, signal)
  ensureDir(dir)
  const filePath = path.join(dir, `${todayUtc()}.jsonl`)
  let buf = ''
  for (const row of rows) buf += JSON.stringify(row) + '\n'
  fs.appendFileSync(filePath, buf)
}

/**
 * Write normalized OTLP rows to Gateway-mode durable outbox sinks. Raw OTLP
 * envelopes are intentionally not preserved in this path; Central server is
 * the canonical recording store for managed gateways.
 *
 * @param {Partial<Record<'logs' | 'traces' | 'metrics', Sink>>} sinks
 * @param {string} signal
 * @param {unknown} data
 * @returns {Promise<void>}
 */
async function writeRowsToSinks(sinks, signal, data) {
  const rows = flattenSignalRows(signal, data)
  if (rows.length === 0) return
  if (signal !== 'logs' && signal !== 'traces' && signal !== 'metrics') return
  const sink = sinks[signal]
  if (!sink) return
  for (const row of rows) {
    await sink.writeRow(row)
  }
}

/**
 * @param {string} signal
 * @param {unknown} data
 * @returns {NormalizedServiceRow[]}
 */
function flattenSignalRows(signal, data) {
  if (signal === 'logs') return flattenOtlpLogs(data)
  if (signal === 'traces') return flattenOtlpTraces(data)
  if (signal === 'metrics') return flattenOtlpMetrics(data)
  return []
}

/**
 * Flatten OTLP log export envelopes into one normalized row per log record.
 *
 * @param {unknown} data
 * @returns {NormalizedLogRow[]}
 */
function flattenOtlpLogs(data) {
  const payload = objectRecord(data)
  const resourceLogs = Array.isArray(payload?.resourceLogs) ? payload.resourceLogs : []
  /** @type {NormalizedLogRow[]} */
  const rows = []

  for (const resourceLog of resourceLogs) {
    const resourceLogObj = objectRecord(resourceLog) ?? {}
    const resource = objectRecord(resourceLogObj.resource)
    const resourceAttrs = attrsToObject(resource?.attributes)
    const serviceName = stringValue(resourceAttrs['service.name']) || '_unknown'
    const scopeLogs = Array.isArray(resourceLogObj.scopeLogs) ? resourceLogObj.scopeLogs : []

    for (const scopeLog of scopeLogs) {
      const scopeLogObj = objectRecord(scopeLog) ?? {}
      const scope = objectRecord(scopeLogObj.scope) ?? {}
      const logRecords = Array.isArray(scopeLogObj.logRecords) ? scopeLogObj.logRecords : []

      for (const logRecord of logRecords) {
        const logRecordObj = objectRecord(logRecord) ?? {}
        const attributes = attrsToObject(logRecordObj.attributes)
        rows.push({
          serviceName,
          timestamp: otlpTimestampToIso(logRecordObj.timeUnixNano),
          observedTimestamp: otlpTimestampToIso(logRecordObj.observedTimeUnixNano),
          severityNumber: numberValue(logRecordObj.severityNumber),
          severityText: stringValue(logRecordObj.severityText),
          body: anyValue(logRecordObj.body),
          traceId: stringValue(logRecordObj.traceId),
          spanId: stringValue(logRecordObj.spanId),
          flags: numberValue(logRecordObj.flags),
          droppedAttributesCount: numberValue(logRecordObj.droppedAttributesCount),
          resource: resourceAttrs,
          scope: normalizeScope(scope),
          attributes,
        })
      }
    }
  }

  return rows
}

/**
 * Flatten OTLP trace export envelopes into one normalized row per span.
 *
 * @param {unknown} data
 * @returns {NormalizedServiceRow[]}
 */
function flattenOtlpTraces(data) {
  const payload = objectRecord(data)
  const resourceSpans = Array.isArray(payload?.resourceSpans) ? payload.resourceSpans : []
  /** @type {NormalizedServiceRow[]} */
  const rows = []

  for (const resourceSpan of resourceSpans) {
    const resourceSpanObj = objectRecord(resourceSpan) ?? {}
    const resource = objectRecord(resourceSpanObj.resource)
    const resourceAttrs = attrsToObject(resource?.attributes)
    const serviceName = stringValue(resourceAttrs['service.name']) || '_unknown'
    const scopeSpans = Array.isArray(resourceSpanObj.scopeSpans) ? resourceSpanObj.scopeSpans : []

    for (const scopeSpan of scopeSpans) {
      const scopeSpanObj = objectRecord(scopeSpan) ?? {}
      const scope = objectRecord(scopeSpanObj.scope) ?? {}
      const spans = Array.isArray(scopeSpanObj.spans) ? scopeSpanObj.spans : []

      for (const span of spans) {
        const spanObj = objectRecord(span) ?? {}
        rows.push({
          serviceName,
          traceId: stringValue(spanObj.traceId),
          spanId: stringValue(spanObj.spanId),
          parentSpanId: stringValue(spanObj.parentSpanId),
          name: stringValue(spanObj.name),
          kind: numberValue(spanObj.kind),
          traceState: stringValue(spanObj.traceState),
          startTimestamp: otlpTimestampToIso(spanObj.startTimeUnixNano),
          endTimestamp: otlpTimestampToIso(spanObj.endTimeUnixNano),
          durationMs: otlpDurationMs(spanObj.startTimeUnixNano, spanObj.endTimeUnixNano),
          flags: numberValue(spanObj.flags),
          droppedAttributesCount: numberValue(spanObj.droppedAttributesCount),
          droppedEventsCount: numberValue(spanObj.droppedEventsCount),
          droppedLinksCount: numberValue(spanObj.droppedLinksCount),
          status: normalizeSpanStatus(spanObj.status),
          resource: resourceAttrs,
          scope: normalizeScope(scope),
          attributes: attrsToObject(spanObj.attributes),
          events: normalizeSpanEvents(spanObj.events),
          links: normalizeSpanLinks(spanObj.links),
        })
      }
    }
  }

  return rows
}

/**
 * Flatten OTLP metric export envelopes into one normalized row per data point.
 *
 * @param {unknown} data
 * @returns {NormalizedServiceRow[]}
 */
function flattenOtlpMetrics(data) {
  const payload = objectRecord(data)
  const resourceMetrics = Array.isArray(payload?.resourceMetrics) ? payload.resourceMetrics : []
  /** @type {NormalizedServiceRow[]} */
  const rows = []

  for (const resourceMetric of resourceMetrics) {
    const resourceMetricObj = objectRecord(resourceMetric) ?? {}
    const resource = objectRecord(resourceMetricObj.resource)
    const resourceAttrs = attrsToObject(resource?.attributes)
    const serviceName = stringValue(resourceAttrs['service.name']) || '_unknown'
    const scopeMetrics = Array.isArray(resourceMetricObj.scopeMetrics) ? resourceMetricObj.scopeMetrics : []

    for (const scopeMetric of scopeMetrics) {
      const scopeMetricObj = objectRecord(scopeMetric) ?? {}
      const scope = objectRecord(scopeMetricObj.scope) ?? {}
      const metrics = Array.isArray(scopeMetricObj.metrics) ? scopeMetricObj.metrics : []

      for (const metric of metrics) {
        rows.push(...flattenMetricRows(serviceName, resourceAttrs, scope, metric))
      }
    }
  }

  return rows
}

/**
 * @param {string} serviceName
 * @param {Record<string, unknown>} resource
 * @param {Record<string, unknown>} scope
 * @param {unknown} metric
 * @returns {NormalizedServiceRow[]}
 */
function flattenMetricRows(serviceName, resource, scope, metric) {
  const metricObj = objectRecord(metric) ?? {}
  const scopeInfo = normalizeScope(scope)
  const metadata = attrsToObject(metricObj.metadata)
  /** @type {MetricRowBase} */
  const base = {
    serviceName,
    metricName: stringValue(metricObj.name),
    description: stringValue(metricObj.description),
    unit: stringValue(metricObj.unit),
    resource,
    scope: scopeInfo,
    metadata,
  }
  /** @type {NormalizedServiceRow[]} */
  const rows = []

  const gauge = objectRecord(metricObj.gauge)
  if (gauge) rows.push(...flattenNumberMetricRows(base, 'gauge', gauge))

  const sum = objectRecord(metricObj.sum)
  if (sum) rows.push(...flattenNumberMetricRows(base, 'sum', sum))

  const histogram = objectRecord(metricObj.histogram)
  if (histogram) rows.push(...flattenHistogramRows(base, histogram))

  const exponentialHistogram = objectRecord(metricObj.exponentialHistogram)
  if (exponentialHistogram) rows.push(...flattenExponentialHistogramRows(base, exponentialHistogram))

  const summary = objectRecord(metricObj.summary)
  if (summary) rows.push(...flattenSummaryRows(base, summary))

  return rows
}

/**
 * @param {MetricRowBase} base
 * @param {'gauge' | 'sum'} metricType
 * @param {Record<string, unknown>} container
 * @returns {NormalizedServiceRow[]}
 */
function flattenNumberMetricRows(base, metricType, container) {
  const dataPoints = Array.isArray(container.dataPoints) ? container.dataPoints : []
  return dataPoints.map((point) => {
    const pointObj = objectRecord(point) ?? {}
    return {
      ...base,
      metricType,
      aggregationTemporality: numberValue(container.aggregationTemporality),
      isMonotonic: booleanValue(container.isMonotonic),
      startTimestamp: otlpTimestampToIso(pointObj.startTimeUnixNano),
      timestamp: otlpTimestampToIso(pointObj.timeUnixNano),
      flags: numberValue(pointObj.flags),
      value: metricPointValue(pointObj),
      valueType: metricPointValueType(pointObj),
      resource: base.resource,
      scope: base.scope,
      metadata: base.metadata,
      attributes: attrsToObject(pointObj.attributes),
      exemplars: normalizeMetricExemplars(pointObj.exemplars),
    }
  })
}

/**
 * @param {MetricRowBase} base
 * @param {Record<string, unknown>} histogram
 * @returns {NormalizedServiceRow[]}
 */
function flattenHistogramRows(base, histogram) {
  const dataPoints = Array.isArray(histogram.dataPoints) ? histogram.dataPoints : []
  return dataPoints.map((point) => {
    const pointObj = objectRecord(point) ?? {}
    return {
      ...base,
      metricType: 'histogram',
      aggregationTemporality: numberValue(histogram.aggregationTemporality),
      startTimestamp: otlpTimestampToIso(pointObj.startTimeUnixNano),
      timestamp: otlpTimestampToIso(pointObj.timeUnixNano),
      flags: numberValue(pointObj.flags),
      count: numberLike(pointObj.count),
      sum: numberValue(pointObj.sum),
      bucketCounts: arrayValue(pointObj.bucketCounts),
      explicitBounds: arrayValue(pointObj.explicitBounds),
      min: numberValue(pointObj.min),
      max: numberValue(pointObj.max),
      resource: base.resource,
      scope: base.scope,
      metadata: base.metadata,
      attributes: attrsToObject(pointObj.attributes),
      exemplars: normalizeMetricExemplars(pointObj.exemplars),
    }
  })
}

/**
 * @param {MetricRowBase} base
 * @param {Record<string, unknown>} histogram
 * @returns {NormalizedServiceRow[]}
 */
function flattenExponentialHistogramRows(base, histogram) {
  const dataPoints = Array.isArray(histogram.dataPoints) ? histogram.dataPoints : []
  return dataPoints.map((point) => {
    const pointObj = objectRecord(point) ?? {}
    return {
      ...base,
      metricType: 'exponentialHistogram',
      aggregationTemporality: numberValue(histogram.aggregationTemporality),
      startTimestamp: otlpTimestampToIso(pointObj.startTimeUnixNano),
      timestamp: otlpTimestampToIso(pointObj.timeUnixNano),
      flags: numberValue(pointObj.flags),
      count: numberLike(pointObj.count),
      sum: numberValue(pointObj.sum),
      scale: numberValue(pointObj.scale),
      zeroCount: numberLike(pointObj.zeroCount),
      zeroThreshold: numberValue(pointObj.zeroThreshold),
      min: numberValue(pointObj.min),
      max: numberValue(pointObj.max),
      positive: normalizeExponentialHistogramBuckets(pointObj.positive),
      negative: normalizeExponentialHistogramBuckets(pointObj.negative),
      resource: base.resource,
      scope: base.scope,
      metadata: base.metadata,
      attributes: attrsToObject(pointObj.attributes),
      exemplars: normalizeMetricExemplars(pointObj.exemplars),
    }
  })
}

/**
 * @param {MetricRowBase} base
 * @param {Record<string, unknown>} summary
 * @returns {NormalizedServiceRow[]}
 */
function flattenSummaryRows(base, summary) {
  const dataPoints = Array.isArray(summary.dataPoints) ? summary.dataPoints : []
  return dataPoints.map((point) => {
    const pointObj = objectRecord(point) ?? {}
    return {
      ...base,
      metricType: 'summary',
      startTimestamp: otlpTimestampToIso(pointObj.startTimeUnixNano),
      timestamp: otlpTimestampToIso(pointObj.timeUnixNano),
      flags: numberValue(pointObj.flags),
      count: numberLike(pointObj.count),
      sum: numberValue(pointObj.sum),
      quantileValues: normalizeQuantileValues(pointObj.quantileValues),
      resource: base.resource,
      scope: base.scope,
      metadata: base.metadata,
      attributes: attrsToObject(pointObj.attributes),
    }
  })
}

/**
 * @param {unknown} scope
 * @returns {{ name?: string, version?: string, attributes: Record<string, unknown> }}
 */
function normalizeScope(scope) {
  const scopeObj = objectRecord(scope) ?? {}
  return {
    name: stringValue(scopeObj.name),
    version: stringValue(scopeObj.version),
    attributes: attrsToObject(scopeObj.attributes),
  }
}

/**
 * @param {unknown} status
 * @returns {Record<string, unknown> | undefined}
 */
function normalizeSpanStatus(status) {
  const statusObj = objectRecord(status)
  if (!statusObj) return undefined
  return {
    code: numberValue(statusObj.code),
    message: stringValue(statusObj.message),
  }
}

/**
 * @param {unknown} events
 * @returns {Record<string, unknown>[]}
 */
function normalizeSpanEvents(events) {
  if (!Array.isArray(events)) return []
  return events.map((event) => {
    const eventObj = objectRecord(event) ?? {}
    return {
      timestamp: otlpTimestampToIso(eventObj.timeUnixNano),
      name: stringValue(eventObj.name),
      droppedAttributesCount: numberValue(eventObj.droppedAttributesCount),
      attributes: attrsToObject(eventObj.attributes),
    }
  })
}

/**
 * @param {unknown} links
 * @returns {Record<string, unknown>[]}
 */
function normalizeSpanLinks(links) {
  if (!Array.isArray(links)) return []
  return links.map((link) => {
    const linkObj = objectRecord(link) ?? {}
    return {
      traceId: stringValue(linkObj.traceId),
      spanId: stringValue(linkObj.spanId),
      traceState: stringValue(linkObj.traceState),
      flags: numberValue(linkObj.flags),
      droppedAttributesCount: numberValue(linkObj.droppedAttributesCount),
      attributes: attrsToObject(linkObj.attributes),
    }
  })
}

/**
 * @param {unknown} exemplars
 * @returns {Record<string, unknown>[]}
 */
function normalizeMetricExemplars(exemplars) {
  if (!Array.isArray(exemplars)) return []
  return exemplars.map((exemplar) => {
    const exemplarObj = objectRecord(exemplar) ?? {}
    return {
      timestamp: otlpTimestampToIso(exemplarObj.timeUnixNano),
      value: numberValue(exemplarObj.asDouble) ?? numberLike(exemplarObj.asInt),
      valueType: exemplarObj.asDouble !== undefined ? 'double'
        : exemplarObj.asInt !== undefined ? 'int'
          : undefined,
      traceId: stringValue(exemplarObj.traceId),
      spanId: stringValue(exemplarObj.spanId),
      filteredAttributes: attrsToObject(exemplarObj.filteredAttributes),
    }
  })
}

/**
 * @param {unknown} buckets
 * @returns {Record<string, unknown> | undefined}
 */
function normalizeExponentialHistogramBuckets(buckets) {
  const bucketObj = objectRecord(buckets)
  if (!bucketObj) return undefined
  return {
    offset: numberValue(bucketObj.offset),
    bucketCounts: arrayValue(bucketObj.bucketCounts),
  }
}

/**
 * @param {unknown} quantileValues
 * @returns {Record<string, unknown>[]}
 */
function normalizeQuantileValues(quantileValues) {
  if (!Array.isArray(quantileValues)) return []
  return quantileValues.map((quantileValue) => {
    const quantileValueObj = objectRecord(quantileValue) ?? {}
    return {
      quantile: numberValue(quantileValueObj.quantile),
      value: numberValue(quantileValueObj.value),
    }
  })
}

/**
 * @param {Record<string, unknown>} pointObj
 * @returns {number | string | undefined}
 */
function metricPointValue(pointObj) {
  if (pointObj.asDouble !== undefined) return numberValue(pointObj.asDouble)
  return numberLike(pointObj.asInt)
}

/**
 * @param {Record<string, unknown>} pointObj
 * @returns {'double' | 'int' | undefined}
 */
function metricPointValueType(pointObj) {
  if (pointObj.asDouble !== undefined) return 'double'
  if (pointObj.asInt !== undefined) return 'int'
}

/**
 * Convert OTLP KeyValue[] into a plain object.
 *
 * @param {unknown} attrs
 * @returns {Record<string, unknown>}
 */
function attrsToObject(attrs) {
  if (!Array.isArray(attrs)) return {}
  /** @type {Record<string, unknown>} */
  const result = {}
  for (const attr of attrs) {
    const pair = objectRecord(attr)
    if (!pair) continue
    const key = stringValue(pair.key)
    if (!key) continue
    result[key] = anyValue(pair.value)
  }
  return result
}

/**
 * Convert an OTLP AnyValue into a JS value.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function anyValue(value) {
  const anyVal = objectRecord(value)
  if (!anyVal) return value ?? null
  if ('stringValue' in anyVal) return anyStringValue(anyVal.stringValue)
  if ('boolValue' in anyVal) return Boolean(anyVal.boolValue)
  if ('intValue' in anyVal) return numberLike(anyVal.intValue)
  if ('doubleValue' in anyVal) return numberValue(anyVal.doubleValue)
  if ('bytesValue' in anyVal) return anyStringValue(anyVal.bytesValue)
  if ('arrayValue' in anyVal) {
    const arrayValue = objectRecord(anyVal.arrayValue)
    const values = Array.isArray(arrayValue?.values) ? arrayValue.values : []
    return values.map(anyValue)
  }
  if ('kvlistValue' in anyVal) {
    return attrsToObject(objectRecord(anyVal.kvlistValue)?.values)
  }
  return null
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function anyStringValue(value) {
  return typeof value === 'string' ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {number | string | undefined}
 */
function numberLike(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) return value
}

/**
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
function booleanValue(value) {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {unknown[] | undefined}
 */
function arrayValue(value) {
  return Array.isArray(value) ? value : undefined
}

/**
 * Convert OTLP nanoseconds-since-epoch into ISO 8601.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function otlpTimestampToIso(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  if (typeof value === 'number' && (!Number.isFinite(value) || !Number.isInteger(value))) return undefined
  let asBigInt
  try {
    asBigInt = BigInt(value)
  } catch {
    return undefined
  }
  const ms = asBigInt / OTLP_NS_PER_MS
  if (ms < MIN_DATE_MS || ms > MAX_DATE_MS) return undefined
  return new Date(Number(ms)).toISOString()
}

/**
 * @param {unknown} start
 * @param {unknown} end
 * @returns {number | undefined}
 */
function otlpDurationMs(start, end) {
  if (!otlpTimeValue(start) || !otlpTimeValue(end)) return undefined
  try {
    const diff = BigInt(end) - BigInt(start)
    if (diff < 0n) return undefined
    return Number(diff) / Number(OTLP_NS_PER_MS)
  } catch {
    return undefined
  }
}

/**
 * @param {unknown} value
 * @returns {value is string | number | bigint}
 */
function otlpTimeValue(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
}

/**
 * @param {string} dir
 * @returns {void}
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function objectRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return { ...value }
}
