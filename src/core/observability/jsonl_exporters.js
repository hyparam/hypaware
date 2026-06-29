// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { hrTimeToIso } from './runtime.js'

/**
 * @import { LogRecord, MetricRecord } from '../../../src/core/observability/types.js'
 * @import { Span } from './runtime.js'
 */

const ExportResultCode = Object.freeze({
  SUCCESS: 0,
  FAILED: 1,
})

/**
 * Append-only JSONL writer. One file per signal per pid; the file is
 * opened lazily on first write so a no-op shutdown doesn't create
 * empty artifacts.
 */
// @ref LLP 0021#shutdown-and-flush [implements]: one file per signal per pid, opened lazily so no-op runs leave none
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
 * @param {Span} span
 */
function spanToJsonl(span) {
  const ctx = span.spanContext()
  const startMs = hrtimeToMs(span.startTime)
  const endMs = hrtimeToMs(span.endTime)
  return {
    serviceName: span.resource.attributes['service.name'] ?? 'unknown',
    name: span.name,
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    kind: span.kind,
    startTimestamp: hrTimeToIso(span.startTime),
    endTimestamp: hrTimeToIso(span.endTime),
    durationMs: endMs - startMs,
    status: spanStatusName(span.status.code),
    statusMessage: span.status.message,
    attributes: span.attributes,
    events: span.events.map((e) => ({
      name: e.name,
      time: hrTimeToIso(e.time),
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
 * SpanExporter implementation that writes each batch as JSONL.
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
   * @param {Span[]} spans
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

  /** @param {Span[]} spans */
  exportBatch(spans) {
    this.export(spans, () => {})
  }

  async shutdown() {
    await this.writer.close()
  }

  async forceFlush() {
    await this.writer.flush()
  }
}

/**
 * @param {LogRecord} record
 */
function logRecordToJsonl(record) {
  const hr = record.hrTime || record.hrTimeObserved || [0, 0]
  return {
    serviceName: record.resource.attributes['service.name'] ?? 'unknown',
    timestamp: hrTimeToIso(hr),
    observedTimestamp: hrTimeToIso(record.hrTimeObserved || hr),
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
   * @param {LogRecord[]} records
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

  /** @param {LogRecord[]} records */
  exportBatch(records) {
    this.export(records, () => {})
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
 */
// @ref LLP 0021#the-attribute-contract [explains]: flatten to one record per line is why the vocabulary stays bounded
export class JsonlMetricExporter {
  /**
   * @param {object} opts
   * @param {string} opts.dir
   * @param {number} [opts.pid]
   */
  constructor({ dir, pid = process.pid }) {
    this.writer = new JsonlWriter(dir, `metrics-${pid}.jsonl`)
  }

  /**
   * @param {MetricRecord[]} records
   * @param {(result: { code: number, error?: Error }) => void} resultCallback
   */
  export(records, resultCallback) {
    try {
      this.writer.writeBatch(records.map(metricRecordToJsonl))
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }

  /** @param {MetricRecord[]} records */
  exportBatch(records) {
    this.export(records, () => {})
  }

  async shutdown() {
    await this.writer.close()
  }

  async forceFlush() {
    await this.writer.flush()
  }
}

/**
 * @param {MetricRecord} record
 */
function metricRecordToJsonl(record) {
  const resourceAttrs = record.resource.attributes
  return {
    serviceName: resourceAttrs['service.name'] ?? 'unknown',
    name: record.name,
    description: record.description,
    unit: record.unit,
    type: record.kind,
    attributes: record.attributes,
    value: record.value,
    startTimestamp: hrTimeToIso(record.startTime),
    endTimestamp: hrTimeToIso(record.endTime),
    resource: resourceAttrs,
  }
}

/**
 * @param {[number, number]} hrtime
 */
function hrtimeToMs(hrtime) {
  return hrtime[0] * 1000 + hrtime[1] / 1_000_000
}
