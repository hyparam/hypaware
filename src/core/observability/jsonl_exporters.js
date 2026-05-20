// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { ExportResultCode } from '@opentelemetry/core'

/**
 * Append-only JSONL writer. One file per signal per pid; the file is
 * opened lazily on first write so a no-op shutdown doesn't create
 * empty artifacts.
 */
class JsonlWriter {
  /**
   * @param {string} dir
   * @param {string} filename
   */
  constructor(dir, filename) {
    this.dir = dir
    this.filePath = path.join(dir, filename)
    /** @type {fs.WriteStream|null} */
    this.stream = null
  }

  ensureOpen() {
    if (this.stream) return
    fs.mkdirSync(this.dir, { recursive: true })
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' })
  }

  /**
   * @param {object[]} records
   */
  writeBatch(records) {
    if (!records.length) return
    this.ensureOpen()
    const stream = /** @type {fs.WriteStream} */ (this.stream)
    for (const record of records) {
      stream.write(JSON.stringify(record) + '\n')
    }
  }

  /** @returns {Promise<void>} */
  flush() {
    if (!this.stream) return Promise.resolve()
    return new Promise((resolve) => {
      const stream = /** @type {fs.WriteStream} */ (this.stream)
      if (typeof stream.write === 'function') {
        // drain
        if (stream.writableNeedDrain) {
          stream.once('drain', () => resolve())
        } else {
          resolve()
        }
      } else {
        resolve()
      }
    })
  }

  /** @returns {Promise<void>} */
  close() {
    return new Promise((resolve) => {
      if (!this.stream) {
        resolve()
        return
      }
      const stream = /** @type {fs.WriteStream} */ (this.stream)
      stream.end(() => {
        this.stream = null
        resolve()
      })
    })
  }
}

/**
 * @param {import('@opentelemetry/sdk-trace-base').ReadableSpan} span
 */
function spanToJsonl(span) {
  const ctx = span.spanContext()
  const startMs = span.startTime[0] * 1000 + span.startTime[1] / 1_000_000
  const endMs = span.endTime[0] * 1000 + span.endTime[1] / 1_000_000
  return {
    serviceName: span.resource.attributes['service.name'] ?? 'unknown',
    name: span.name,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    kind: span.kind,
    startTimestamp: hrtimeToIso(span.startTime),
    endTimestamp: hrtimeToIso(span.endTime),
    durationMs: endMs - startMs,
    status: spanStatusName(span.status.code),
    statusMessage: span.status.message,
    attributes: span.attributes,
    events: span.events.map((e) => ({
      name: e.name,
      time: hrtimeToIso(e.time),
      attributes: e.attributes,
    })),
    resource: span.resource.attributes,
  }
}

/**
 * Translate the OTel SpanStatusCode enum to a queryable string.
 * @param {number} code
 */
function spanStatusName(code) {
  // 0 UNSET, 1 OK, 2 ERROR
  if (code === 1) return 'ok'
  if (code === 2) return 'failed'
  return 'unset'
}

/**
 * @param {[number, number]} hrtime
 */
function hrtimeToIso(hrtime) {
  const ms = hrtime[0] * 1000 + hrtime[1] / 1_000_000
  return new Date(ms).toISOString()
}

/**
 * SpanExporter implementation that writes each batch as JSONL.
 *
 * @implements {import('@opentelemetry/sdk-trace-base').SpanExporter}
 */
export class JsonlSpanExporter {
  /**
   * @param {object} opts
   * @param {string} opts.dir
   * @param {number} [opts.pid]
   */
  constructor({ dir, pid = process.pid }) {
    this.writer = new JsonlWriter(dir, `traces-${pid}.jsonl`)
  }

  /**
   * @param {import('@opentelemetry/sdk-trace-base').ReadableSpan[]} spans
   * @param {(result: { code: number, error?: Error }) => void} resultCallback
   */
  export(spans, resultCallback) {
    try {
      this.writer.writeBatch(spans.map(spanToJsonl))
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }

  async shutdown() {
    await this.writer.close()
  }

  async forceFlush() {
    await this.writer.flush()
  }
}

/**
 * @param {import('@opentelemetry/sdk-logs').ReadableLogRecord} record
 */
function logRecordToJsonl(record) {
  const hr = record.hrTime || record.hrTimeObserved || [0, 0]
  return {
    serviceName: record.resource.attributes['service.name'] ?? 'unknown',
    timestamp: hrtimeToIso(hr),
    observedTimestamp: hrtimeToIso(record.hrTimeObserved || hr),
    severityNumber: record.severityNumber ?? 0,
    severityText: record.severityText ?? '',
    body: serializeBody(record.body),
    traceId: record.spanContext?.traceId ?? null,
    spanId: record.spanContext?.spanId ?? null,
    attributes: record.attributes,
    resource: record.resource.attributes,
  }
}

/** @param {unknown} body */
function serializeBody(body) {
  if (body === undefined || body === null) return ''
  if (typeof body === 'string') return body
  try {
    return JSON.stringify(body)
  } catch {
    return String(body)
  }
}

/**
 * LogRecordExporter that writes JSONL.
 *
 * @implements {import('@opentelemetry/sdk-logs').LogRecordExporter}
 */
export class JsonlLogRecordExporter {
  /**
   * @param {object} opts
   * @param {string} opts.dir
   * @param {number} [opts.pid]
   */
  constructor({ dir, pid = process.pid }) {
    this.writer = new JsonlWriter(dir, `logs-${pid}.jsonl`)
  }

  /**
   * @param {import('@opentelemetry/sdk-logs').ReadableLogRecord[]} records
   * @param {(result: { code: number, error?: Error }) => void} resultCallback
   */
  export(records, resultCallback) {
    try {
      this.writer.writeBatch(records.map(logRecordToJsonl))
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }

  async shutdown() {
    await this.writer.close()
  }

  async forceFlush() {
    await this.writer.flush()
  }
}

/**
 * PushMetricExporter that writes JSONL. Each export call emits one
 * record per data point, flattened so smoke assertions can query a
 * single named metric without unpacking the OTel resource metrics tree.
 *
 * @implements {import('@opentelemetry/sdk-metrics').PushMetricExporter}
 */
export class JsonlMetricExporter {
  /**
   * @param {object} opts
   * @param {string} opts.dir
   * @param {number} [opts.pid]
   * @param {import('@opentelemetry/sdk-metrics').AggregationTemporality} [opts.temporality]
   */
  constructor({ dir, pid = process.pid, temporality }) {
    this.writer = new JsonlWriter(dir, `metrics-${pid}.jsonl`)
    this._temporality = temporality
  }

  /**
   * @param {import('@opentelemetry/sdk-metrics').ResourceMetrics} metrics
   * @param {(result: { code: number, error?: Error }) => void} resultCallback
   */
  export(metrics, resultCallback) {
    try {
      /** @type {object[]} */
      const records = []
      const resourceAttrs = metrics.resource.attributes
      const serviceName = resourceAttrs['service.name'] ?? 'unknown'
      for (const scopeMetrics of metrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          for (const dataPoint of metric.dataPoints) {
            records.push({
              serviceName,
              name: metric.descriptor.name,
              description: metric.descriptor.description,
              unit: metric.descriptor.unit,
              type: metric.dataPointType,
              attributes: dataPoint.attributes,
              value: serializeMetricValue(metric.dataPointType, dataPoint.value),
              startTimestamp: hrtimeToIso(dataPoint.startTime),
              endTimestamp: hrtimeToIso(dataPoint.endTime),
              resource: resourceAttrs,
            })
          }
        }
      }
      this.writer.writeBatch(records)
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }

  selectAggregationTemporality() {
    // Cumulative matches the default for Sum/Histogram aggregations and
    // keeps Sum data points monotonic across exports.
    return /** @type {import('@opentelemetry/sdk-metrics').AggregationTemporality} */ (
      this._temporality ?? 1
    )
  }

  async shutdown() {
    await this.writer.close()
  }

  async forceFlush() {
    await this.writer.flush()
  }
}

/**
 * @param {number} type
 * @param {unknown} value
 */
function serializeMetricValue(type, value) {
  if (value && typeof value === 'object' && 'buckets' in value) {
    const v = /** @type {{count:number,sum:number,min?:number,max?:number,buckets:{boundaries:number[],counts:number[]}}} */ (value)
    return {
      count: v.count,
      sum: v.sum,
      min: v.min,
      max: v.max,
      boundaries: v.buckets.boundaries,
      counts: v.buckets.counts,
    }
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return Number(value)
  }
  return value
}
