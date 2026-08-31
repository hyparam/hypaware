// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import crypto from 'node:crypto'

export const SpanStatusCode = Object.freeze({
  UNSET: 0,
  OK: 1,
  ERROR: 2,
})

export const SeverityNumber = Object.freeze({
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
})

export const ROOT_CONTEXT = Object.freeze({ span: null })

/** @type {AsyncLocalStorage<{ span: Span|null }>} */
const activeContext = new AsyncLocalStorage()

/** @type {TracerProvider|null} */
let globalTracerProvider = null
/** @type {LoggerProvider|null} */
let globalLoggerProvider = null
/** @type {MeterProvider|null} */
let globalMeterProvider = null

export const context = Object.freeze({
  /**
   * @template T
   * @param {{ span: Span|null }} ctx
   * @param {() => T} fn
   * @returns {T}
   */
  with(ctx, fn) {
    return activeContext.run(ctx ?? ROOT_CONTEXT, fn)
  },
  active() {
    return activeContext.getStore() ?? ROOT_CONTEXT
  },
})

export const trace = Object.freeze({
  /**
   * @param {string} name
   * @param {string} [version]
   */
  getTracer(name, version) {
    return new Tracer(name, version)
  },
  getActiveSpan() {
    return activeContext.getStore()?.span ?? null
  },
  getTracerProvider() {
    return globalTracerProvider ?? NOOP_TRACER_PROVIDER
  },
})

export const logs = Object.freeze({
  /** @param {LoggerProvider} provider */
  setGlobalLoggerProvider(provider) {
    globalLoggerProvider = provider
  },
  /**
   * @param {string} name
   * @param {string} [version]
   */
  getLogger(name, version) {
    return new Logger(name, version)
  },
})

export const metrics = Object.freeze({
  /** @param {MeterProvider} provider */
  setGlobalMeterProvider(provider) {
    globalMeterProvider = provider
  },
  /**
   * @param {string} name
   * @param {string} [version]
   */
  getMeter(name, version) {
    return new Meter(name, version)
  },
})

export class TracerProvider {
  /**
   * @param {object} opts
   * @param {{ attributes: Record<string, string|number|boolean> }} opts.resource
   * @param {Array<{ exportBatch(spans: Span[]): unknown, forceFlush?: () => Promise<void>|void, shutdown?: () => Promise<void>|void }>} [opts.exporters]
   */
  constructor({ resource, exporters = [] }) {
    this.resource = resource
    this.exporters = exporters
    this.reportedExporterFailures = new Set()
  }

  register() {
    globalTracerProvider = this
  }

  /** @param {Span} span */
  exportSpan(span) {
    if (this.exporters.length === 0) return
    exportGuarded('traces', this.exporters, [span], this.reportedExporterFailures)
  }

  async forceFlush() {
    await flushExporters(this.exporters)
  }

  async shutdown() {
    await shutdownExporters(this.exporters)
    if (globalTracerProvider === this) globalTracerProvider = null
  }
}

export class LoggerProvider {
  /**
   * @param {object} opts
   * @param {{ attributes: Record<string, string|number|boolean> }} opts.resource
   * @param {Array<{ exportBatch(records: LogRecord[]): unknown, forceFlush?: () => Promise<void>|void, shutdown?: () => Promise<void>|void }>} [opts.exporters]
   */
  constructor({ resource, exporters = [] }) {
    this.resource = resource
    this.exporters = exporters
    this.reportedExporterFailures = new Set()
  }

  /** @param {LogRecord} record */
  exportRecord(record) {
    if (this.exporters.length === 0) return
    exportGuarded('logs', this.exporters, [record], this.reportedExporterFailures)
  }

  async forceFlush() {
    await flushExporters(this.exporters)
  }

  async shutdown() {
    await shutdownExporters(this.exporters)
    if (globalLoggerProvider === this) globalLoggerProvider = null
  }
}

export class MeterProvider {
  /**
   * @param {object} opts
   * @param {{ attributes: Record<string, string|number|boolean> }} opts.resource
   * @param {Array<{ exportBatch(records: MetricRecord[]): unknown, forceFlush?: () => Promise<void>|void, shutdown?: () => Promise<void>|void }>} [opts.exporters]
   */
  constructor({ resource, exporters = [] }) {
    this.resource = resource
    this.exporters = exporters
    this.reportedExporterFailures = new Set()
  }

  /** @param {MetricRecord} record */
  exportRecord(record) {
    this.exportRecords([record])
  }

  /** @param {MetricRecord[]} records */
  exportRecords(records) {
    if (records.length === 0) return
    if (this.exporters.length === 0) return
    exportGuarded('metrics', this.exporters, records, this.reportedExporterFailures)
  }

  async forceFlush() {
    await flushExporters(this.exporters)
  }

  async shutdown() {
    await shutdownExporters(this.exporters)
    if (globalMeterProvider === this) globalMeterProvider = null
  }
}

class Tracer {
  /** @param {string} name @param {string} [version] */
  constructor(name, version) {
    this.name = name
    this.version = version
  }

  /**
   * @param {string} name
   * @param {object|((span: Span) => unknown)} [options]
   * @param {(span: Span) => unknown} [fn]
   */
  startActiveSpan(name, options, fn) {
    const callback = typeof options === 'function' ? options : fn
    const spanOptions = typeof options === 'object' && options !== null ? options : {}
    const provider = globalTracerProvider
    const parent = Reflect.get(spanOptions, 'root') ? null : (activeContext.getStore()?.span ?? null)
    const span = new Span({
      name,
      tracerName: this.name,
      tracerVersion: this.version,
      provider,
      resource: provider?.resource ?? EMPTY_RESOURCE,
      parent,
      attributes: normalizeAttributes(Reflect.get(spanOptions, 'attributes')),
    })
    if (!callback) return span
    return activeContext.run({ span }, () => callback(span))
  }
}

export class Span {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} opts.tracerName
   * @param {string} [opts.tracerVersion]
   * @param {TracerProvider|null} opts.provider
   * @param {{ attributes: Record<string, string|number|boolean> }} opts.resource
   * @param {Span|null} opts.parent
   * @param {Record<string, unknown>} opts.attributes
   */
  constructor({ name, tracerName, tracerVersion, provider, resource, parent, attributes }) {
    this.name = name
    this.tracerName = tracerName
    this.tracerVersion = tracerVersion
    this.provider = provider
    this.resource = resource
    this.parentSpanContext = parent ? parent.spanContext() : undefined
    this.kind = 0
    this.attributes = { ...attributes }
    this.events = []
    /** @type {{ code: number, message?: string }} */
    this.status = { code: SpanStatusCode.UNSET }
    this.startTime = nowHrTime()
    this.endTime = this.startTime
    this._ended = false
    this._context = {
      traceId: parent ? parent.spanContext().traceId : randomHex(16),
      spanId: randomHex(8),
      traceFlags: 1,
    }
  }

  spanContext() {
    return this._context
  }

  /** @param {string} key @param {unknown} value */
  setAttribute(key, value) {
    if (value !== undefined) this.attributes[key] = value
    return this
  }

  /** @param {Record<string, unknown>} attrs */
  setAttributes(attrs) {
    for (const [key, value] of Object.entries(attrs ?? {})) this.setAttribute(key, value)
    return this
  }

  /** @param {{ code: number, message?: string }} status */
  setStatus(status) {
    this.status = { ...status }
    return this
  }

  /** @param {Error} error */
  recordException(error) {
    this.addEvent('exception', {
      'exception.type': error.name,
      'exception.message': error.message,
      ...(error.stack ? { 'exception.stacktrace': error.stack } : {}),
    })
  }

  /** @param {string} name @param {Record<string, unknown>} [attributes] */
  addEvent(name, attributes = {}) {
    this.events.push({ name, time: nowHrTime(), attributes })
  }

  end() {
    if (this._ended) return
    this._ended = true
    this.endTime = nowHrTime()
    if (compareHrTime(this.endTime, this.startTime) <= 0) {
      this.endTime = addNanos(this.startTime, 1_000_000)
    }
    this.provider?.exportSpan(this)
  }
}

class Logger {
  /** @param {string} name @param {string} [version] */
  constructor(name, version) {
    this.name = name
    this.version = version
  }

  /**
   * @param {{
   *   severityNumber?: number,
   *   severityText?: string,
   *   body?: unknown,
   *   attributes?: Record<string, unknown>,
   * }} record
   */
  emit(record) {
    const provider = globalLoggerProvider
    if (!provider) return
    const now = nowHrTime()
    const activeSpan = trace.getActiveSpan()
    provider.exportRecord({
      loggerName: this.name,
      loggerVersion: this.version,
      resource: provider.resource,
      hrTime: now,
      hrTimeObserved: now,
      spanContext: activeSpan?.spanContext(),
      severityNumber: record.severityNumber,
      severityText: record.severityText,
      body: record.body,
      attributes: normalizeAttributes(record.attributes),
    })
  }
}

class Meter {
  /** @param {string} name @param {string} [version] */
  constructor(name, version) {
    this.name = name
    this.version = version
  }

  /** @param {string} name @param {{ description?: string, unit?: string }} [opts] */
  createCounter(name, opts = {}) {
    return new Instrument({ meter: this, name, kind: 'counter', monotonic: true, ...opts })
  }

  /** @param {string} name @param {{ description?: string, unit?: string }} [opts] */
  createUpDownCounter(name, opts = {}) {
    return new Instrument({ meter: this, name, kind: 'upDownCounter', monotonic: false, ...opts })
  }

  /** @param {string} name @param {{ description?: string, unit?: string }} [opts] */
  createGauge(name, opts = {}) {
    return new Instrument({ meter: this, name, kind: 'gauge', monotonic: false, ...opts })
  }

  /** @param {string} name @param {{ description?: string, unit?: string }} [opts] */
  createHistogram(name, opts = {}) {
    return new Instrument({ meter: this, name, kind: 'histogram', monotonic: false, ...opts })
  }
}

class Instrument {
  /**
   * @param {object} opts
   * @param {Meter} opts.meter
   * @param {string} opts.name
   * @param {'counter'|'upDownCounter'|'gauge'|'histogram'} opts.kind
   * @param {boolean} opts.monotonic
   * @param {string} [opts.description]
   * @param {string} [opts.unit]
   */
  constructor(opts) {
    this.meter = opts.meter
    this.name = opts.name
    this.kind = opts.kind
    this.description = opts.description
    this.unit = opts.unit
    this.monotonic = opts.monotonic
  }

  /** @param {number} value @param {Record<string, unknown>} [attributes] */
  add(value, attributes = {}) {
    this._record(value, attributes)
  }

  /** @param {number} value @param {Record<string, unknown>} [attributes] */
  record(value, attributes = {}) {
    this._record(value, attributes)
  }

  /** @param {number} value @param {Record<string, unknown>} attributes */
  _record(value, attributes) {
    const provider = globalMeterProvider
    if (!provider) return
    const now = nowHrTime()
    provider.exportRecord({
      meterName: this.meter.name,
      meterVersion: this.meter.version,
      resource: provider.resource,
      name: this.name,
      description: this.description,
      unit: this.unit,
      kind: this.kind,
      monotonic: this.monotonic,
      value,
      attributes: normalizeAttributes(attributes),
      startTime: now,
      endTime: now,
    })
  }
}

const EMPTY_RESOURCE = Object.freeze({ attributes: Object.freeze({}) })
const NOOP_TRACER_PROVIDER = Object.freeze({ resource: EMPTY_RESOURCE })

/** @param {unknown} value */
export function normalizeAttributes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, attr] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (attr !== undefined) out[key] = attr
  }
  return out
}

export function getActiveSpan() {
  return trace.getActiveSpan()
}

/**
 * Hand a batch to every exporter, guarding each one on its own.
 *
 * Telemetry export must never throw into the caller's path. Both in-tree log
 * exporters already promise that individually (jsonl_exporters.js swallows,
 * otlp_exporters.js catches its own promise), but as per-exporter discipline
 * it binds nobody: an exporter that throws synchronously used to propagate
 * out of `Logger.emit` and abandon whatever the caller does after the emit
 * returns. For a containment refusal that is the stderr mirror, which is the
 * entire guarantee, so one third-party exporter could silence all four
 * containment guards at once (hyparam/hypaware#1122). Guarding here makes the
 * contract structural, and keeps a broken exporter from taking down the
 * healthy ones queued behind it.
 *
 * @ref LLP 0329#stderr-mirror [constrained-by]: the channel of last resort cannot sit downstream of an exporter that can throw.
 * @template T
 * @param {'traces'|'logs'|'metrics'} channel
 * @param {Array<{ exportBatch(batch: T[]): unknown }>} exporters
 * @param {T[]} batch
 * @param {Set<string>} reported which exporters have already been diagnosed
 */
function exportGuarded(channel, exporters, batch, reported) {
  for (const exporter of exporters) {
    try {
      exporter.exportBatch(batch)
    } catch (error) {
      reportTelemetryFailure({
        channel,
        source: exporter?.constructor?.name || 'exporter',
        error,
        reported,
      })
    }
  }
}

/**
 * Say on stderr, once, that a telemetry component threw and its export was
 * dropped. Losing the telemetry is acceptable; losing the refusal is not, but
 * neither is a broken exporter that nobody can diagnose. Bounded to one line
 * per source because the throwing call sits on the path of every record: an
 * exporter broken by configuration would otherwise print once per row for the
 * life of the daemon.
 *
 * Deliberately `process.stderr`, like the mirror in `getLogger`, and for the
 * same reason: this is the report that fires when the structured substrate is
 * the broken thing.
 *
 * @param {object} args
 * @param {'traces'|'logs'|'metrics'} args.channel
 * @param {string} args.source the exporter class, or the emit seam, that threw
 * @param {unknown} args.error
 * @param {Set<string>} args.reported
 */
export function reportTelemetryFailure({ channel, source, error, reported }) {
  if (reported.has(source)) return
  reported.add(source)
  const message = error instanceof Error ? error.message : String(error)
  const attributes = {
    hyp_component: 'observability',
    hyp_operation: `observability.export_${channel}`,
    error_kind: 'telemetry_export_threw',
    telemetry_channel: channel,
    telemetry_source: source,
    error_message: message.slice(0, 200),
  }
  try {
    process.stderr.write(`[hypaware:observability] WARN a telemetry export threw; the record is dropped ${JSON.stringify(attributes)}\n`)
  } catch { /* stderr itself is gone; there is nowhere left to say so */ }
}

/** @param {Array<{ forceFlush?: () => Promise<void>|void }>} exporters */
async function flushExporters(exporters) {
  await Promise.allSettled(exporters.map((exporter) => exporter.forceFlush?.()))
}

/** @param {Array<{ forceFlush?: () => Promise<void>|void, shutdown?: () => Promise<void>|void }>} exporters */
async function shutdownExporters(exporters) {
  await flushExporters(exporters)
  await Promise.allSettled(exporters.map((exporter) => exporter.shutdown?.()))
}

function nowHrTime() {
  return nsToHrTime(nowUnixNano())
}

export function nowUnixNano() {
  return BigInt(Math.round((performance.timeOrigin + performance.now()) * 1_000_000))
}

/**
 * @param {bigint} ns
 * @returns {[number, number]}
 */
export function nsToHrTime(ns) {
  const sec = ns / 1_000_000_000n
  const nanos = ns % 1_000_000_000n
  return [Number(sec), Number(nanos)]
}

/** @param {[number, number]} hr */
export function hrTimeToUnixNano(hr) {
  return BigInt(hr[0]) * 1_000_000_000n + BigInt(hr[1])
}

/** @param {[number, number]} hr */
export function hrTimeToIso(hr) {
  return new Date(Number(hrTimeToUnixNano(hr) / 1_000_000n)).toISOString()
}

/** @param {[number, number]} a @param {[number, number]} b */
function compareHrTime(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0]
  return a[1] - b[1]
}

/** @param {[number, number]} hr @param {number} nanos */
function addNanos(hr, nanos) {
  return nsToHrTime(hrTimeToUnixNano(hr) + BigInt(nanos))
}

/** @param {number} bytes */
function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex')
}

/**
 * @import { LogRecord, MetricRecord } from '../../../src/core/observability/types.js'
 */
