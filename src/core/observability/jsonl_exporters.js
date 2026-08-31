// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { hrTimeToIso } from './runtime.js'

/**
 * @import { LogRecord, MetricRecord } from '../../../src/core/observability/types.js'
 * @import { Span } from './runtime.js'
 */

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
    // The first failure the stream reported on its own, held so the flush or
    // close that follows can say what went wrong instead of resolving as if
    // the records had landed.
    /** @type {unknown} */
    this.streamError = null
  }

  // @ref LLP 0337#writer-owns-its-stream [implements]: the writer listens for the failure its own resource reports, so it is neither fatal nor silent.
  ensureOpen() {
    if (this.stream) return
    fs.mkdirSync(this.dir, { recursive: true })
    // A failure belongs to the stream that reported it. Reopening after a
    // close means a new descriptor, and the old one's error must not be
    // reported against it.
    this.streamError = null
    const stream = fs.createWriteStream(this.filePath, { flags: 'a' })
    // A write that fails after `stream.write` returned reports itself here, a
    // tick after the try/catch in `exportBatch` has gone. With no listener
    // that is an uncaught 'error' event, which ends the process: the outcome
    // LLP 0335#never-throws exists to prevent, arriving by the one route its
    // seams cannot cover. Listened, it becomes the failure `flush` and
    // `close` report, and the daemon keeps running without its telemetry.
    stream.on('error', (error) => {
      // Only while this is still the writer's descriptor. The event can arrive
      // after the close that already reported the failure, and holding it then
      // would strand a failure on a writer whose stream is gone, to be reported
      // again by the next close.
      if (this.stream !== stream) return
      if (this.streamError === null) this.streamError = error
    })
    this.stream = stream
  }

  /**
   * @param {object[]} records
   */
  writeBatch(records) {
    if (!records.length) return
    // A directory that cannot be made, or a file that cannot be opened, throws
    // out of `ensureOpen` rather than reporting itself on a stream that never
    // existed. The exporters below swallow that throw so an export never
    // reaches the caller, which left every record lost and the close resolving
    // clean over them: the same silence the 'error' listener above ends, by
    // the one route that listener cannot cover. Held the same way, so the
    // close says the records were lost. Not sticky: the next `ensureOpen` that
    // succeeds clears it, because it opened a descriptor this one never had.
    try {
      this.ensureOpen()
    } catch (error) {
      if (this.streamError === null) this.streamError = error
      return
    }
    const stream = /** @type {fs.WriteStream} */ (this.stream)
    for (const record of records) {
      stream.write(JSON.stringify(record) + '\n')
    }
  }

  /**
   * The failure the current descriptor is carrying, from both places it can
   * be recorded.
   *
   * The 'error' listener holds what the stream *emitted*, which is several
   * ticks after the failure: `destroy(err)` sets `errored` and `destroyed`
   * synchronously and only then queues the event. A flush or close landing
   * inside that window sees a destroyed stream with nothing held against it,
   * which is the clean-shutdown-over-lost-records silence this class exists
   * to end. Reading `errored` too closes the window.
   *
   * @param {fs.WriteStream|null} stream
   * @returns {unknown} the failure, or null
   */
  failureOf(stream) {
    if (this.streamError !== null) return this.streamError
    return stream?.errored ?? null
  }

  /** @returns {Promise<void>} */
  flush() {
    const failure = this.failureOf(this.stream)
    if (failure !== null) return Promise.reject(failure)
    if (!this.stream) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const stream = /** @type {fs.WriteStream} */ (this.stream)
      // drain
      if (typeof stream.write !== 'function' || !stream.writableNeedDrain) {
        resolve()
        return
      }
      // A stream that fails while draining never drains, so waiting only on
      // 'drain' here would hang the flush rather than report it.
      const onDrain = () => {
        stream.off('error', onError)
        resolve()
      }
      /** @param {unknown} error */
      const onError = (error) => {
        stream.off('drain', onDrain)
        reject(error)
      }
      stream.once('drain', onDrain)
      stream.once('error', onError)
    })
  }

  /**
   * Close the stream, rejecting with whatever it failed on.
   *
   * Resolved from `stream.end`'s callback without reading the failure it is
   * handed, this reported a clean close for a disk that had taken none of the
   * buffered records, and the settled-failure report in LLP 0335#close-failures
   * could never fire for either exporter this repo ships.
   *
   * Settled on 'close' rather than on `end`'s callback because the two carry
   * different halves of the failure: the callback is handed the write error,
   * the event arrives with the close error, and only the 'error' listener in
   * `ensureOpen` sees both. 'close' is emitted after either outcome, so one
   * wait covers both.
   *
   * The failure is read through {@link failureOf}, not off the held value
   * alone: `destroyed` is set synchronously and the 'error' event arrives
   * ticks later, so a close in between saw a destroyed stream with nothing
   * held and resolved clean over records that were never written.
   *
   * @ref LLP 0337#close-rejects [implements]: a close that lost its records rejects, and the shutdown seam turns that into one line.
   * @returns {Promise<void>}
   */
  close() {
    const stream = this.stream
    this.stream = null
    const failure = this.failureOf(stream)
    // Read before it is cleared, and cleared here rather than in `ensureOpen`:
    // an export arriving while this close is in flight reopens the writer, and
    // a reset done there would wipe the failure this close still has to report.
    // The failure belongs to the descriptor being closed, and it has now been
    // taken off it.
    this.streamError = null
    // An already-failed or already-destroyed stream emitted its 'close' before
    // this call, so waiting for another one would wait forever.
    if (!stream || failure !== null || stream.destroyed) {
      return failure !== null ? Promise.reject(failure) : Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      stream.once('close', () => {
        // Off the stream, not off `this`: a reopened writer's held error would
        // belong to a different descriptor than the one that just closed.
        const closeFailure = stream.errored ?? null
        if (closeFailure !== null) reject(closeFailure)
        else resolve()
      })
      stream.end()
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

  /** @param {Span[]} spans */
  exportBatch(spans) {
    // Telemetry export must never throw into the caller's path.
    try {
      this.writer.writeBatch(spans.map(spanToJsonl))
    } catch {}
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

  /** @param {LogRecord[]} records */
  exportBatch(records) {
    // Telemetry export must never throw into the caller's path.
    try {
      this.writer.writeBatch(records.map(logRecordToJsonl))
    } catch {}
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

  /** @param {MetricRecord[]} records */
  exportBatch(records) {
    // Telemetry export must never throw into the caller's path.
    try {
      this.writer.writeBatch(records.map(metricRecordToJsonl))
    } catch {}
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
