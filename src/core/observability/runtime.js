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
  /** @param {{ span: Span|null }} ctx @param {() => unknown} fn */
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
  }

  register() {
    globalTracerProvider = this
  }

  /** @param {Span} span */
  exportSpan(span) {
    if (this.exporters.length === 0) return
    for (const exporter of this.exporters) exporter.exportBatch([span])
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
  }

  /** @param {LogRecord} record */
  exportRecord(record) {
    if (this.exporters.length === 0) return
    for (const exporter of this.exporters) exporter.exportBatch([record])
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
  }

  /** @param {MetricRecord} record */
  exportRecord(record) {
    if (this.exporters.length === 0) return
    for (const exporter of this.exporters) exporter.exportBatch([record])
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
    const parent = spanOptions.root ? null : (activeContext.getStore()?.span ?? null)
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

/** @param {bigint} ns */
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
 * @import { LogRecord, MetricRecord } from './types.d.ts'
 */