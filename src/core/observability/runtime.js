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

/**
 * Bumped on every `setGlobalLoggerProvider`. `getLogger`'s emit-seam guard
 * has no provider to hang its one-line bound off, the way the exporter guard
 * hangs its own off the provider instance, so it counts against this instead:
 * a swapped-in provider is a different thing to diagnose and re-arms the line.
 */
let loggerProviderGeneration = 0

/** The generation of the currently installed global logger provider. */
export function currentLoggerProviderGeneration() {
  return loggerProviderGeneration
}

export const logs = Object.freeze({
  /** @param {LoggerProvider} provider */
  setGlobalLoggerProvider(provider) {
    globalLoggerProvider = provider
    loggerProviderGeneration += 1
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
    /** @type {Set<string>} */
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
    await flushExporters('traces', this.exporters, this.reportedExporterFailures)
  }

  async shutdown() {
    await shutdownExporters('traces', this.exporters, this.reportedExporterFailures)
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
    /** @type {Set<string>} */
    this.reportedExporterFailures = new Set()
  }

  /** @param {LogRecord} record */
  exportRecord(record) {
    if (this.exporters.length === 0) return
    exportGuarded('logs', this.exporters, [record], this.reportedExporterFailures)
  }

  async forceFlush() {
    await flushExporters('logs', this.exporters, this.reportedExporterFailures)
  }

  async shutdown() {
    await shutdownExporters('logs', this.exporters, this.reportedExporterFailures)
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
    /** @type {Set<string>} */
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
    await flushExporters('metrics', this.exporters, this.reportedExporterFailures)
  }

  async shutdown() {
    await shutdownExporters('metrics', this.exporters, this.reportedExporterFailures)
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
   * @returns {unknown} whatever the installed provider handed back, which for
   *   a provider that is not ours may be a promise its caller has to guard
   */
  emit(record) {
    const provider = globalLoggerProvider
    if (!provider) return
    const now = nowHrTime()
    const activeSpan = trace.getActiveSpan()
    // Returned, not discarded. A globally installed provider that is not ours
    // may hand back a promise, and `getLogger` guards what it gets back the
    // same way it guards a synchronous throw.
    return provider.exportRecord({
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
 * One consequence worth knowing when writing a fake: an `assert` placed
 * inside a test exporter's `exportBatch` is now swallowed like any other
 * throw, so a fake that asserts has to record instead and let the test assert.
 *
 * @ref LLP 0329#stderr-mirror [constrained-by]: the channel of last resort cannot sit downstream of an exporter that can throw.
 * @ref LLP 0335#never-throws [implements]: export never throws into the caller; a broken exporter cannot take down the ones behind it.
 * @template T
 * @param {'traces'|'logs'|'metrics'} channel
 * @param {Array<{ exportBatch(batch: T[]): unknown }>} exporters
 * @param {T[]} batch
 * @param {Set<string>} reported which exporters have already been diagnosed
 */
function exportGuarded(channel, exporters, batch, reported) {
  // Indexed rather than `exporters.entries()`, which the index requirement
  // makes tempting: this loop runs once per record on all three channels, and
  // the iterator plus a fresh two-element tuple per exporter per record is a
  // cost the guard has no reason to add.
  for (let index = 0; index < exporters.length; index++) {
    const exporter = exporters[index]
    try {
      // The seam is built in the two failure branches rather than up front:
      // this loop runs once per record, and both in-tree exporters return
      // nothing (`jsonl_exporters.js` swallows and returns, `otlp_exporters.js`
      // does not return its `post`), so their healthy path allocates neither
      // the object nor its key. An exporter that does return a promise pays
      // for one per record, which is the price of guarding what it returns.
      const result = exporter.exportBatch(batch)
      if (result) guardTelemetryResult(result, exporterSeam(channel, exporter, index, reported))
    } catch (error) {
      reportTelemetryFailure({ ...exporterSeam(channel, exporter, index, reported), error })
    }
  }
}

/**
 * Name one exporter for the report, and give the one-line bound a key that
 * distinguishes it from a sibling of the same class. Two exporters of one
 * class is a shape only a third party builds (two OTLP endpoints, say), and
 * it is two things to fix: on a name-only key the first one to break consumes
 * the report and the second is undiagnosable for the life of the process.
 *
 * @param {'traces'|'logs'|'metrics'} channel
 * @param {unknown} exporter
 * @param {number} index
 * @param {Set<string>} reported
 */
function exporterSeam(channel, exporter, index, reported) {
  const source = exporterName(exporter)
  return { channel, source, key: `${source}#${index}`, reported }
}

/**
 * Name an exporter for the report, without trusting it to have a name. The
 * whole premise is an exporter we did not write, and a Proxy with a throwing
 * `get` trap would otherwise throw here rather than in `exportBatch`, which
 * is outside every guard below.
 *
 * @param {unknown} exporter
 */
function exporterName(exporter) {
  try {
    const name = /** @type {{ constructor?: { name?: unknown } }} */ (exporter)?.constructor?.name
    return typeof name === 'string' && name.length > 0 ? name : 'exporter'
  } catch {
    return 'exporter'
  }
}

/**
 * Guard the other half of the same contract: what an export *returns*.
 *
 * `exportBatch` is typed as returning `unknown` because an exporter is free to
 * do its work asynchronously, and an asynchronous one does not throw, it
 * rejects. A synchronous try/catch never sees that, and on Node's default
 * unhandled-rejection policy the rejection ends the process a tick after the
 * mirror wrote its line: strictly worse than the dropped record this guard
 * exists to bound, and the same silencing by another route, since a dead
 * daemon reports no further refusals either. So a returned thenable gets the
 * same treatment, and the same one-line bound, as a synchronous throw.
 *
 * The seam is read only on the failure path, so a caller on a hot path can
 * pass one that costs something to describe.
 *
 * @param {unknown} result whatever the telemetry seam returned
 * @param {{ channel: 'traces'|'logs'|'metrics', source: string, key?: string, reported: Set<string> }} seam
 */
export function guardTelemetryResult(result, seam) {
  if (!result || (typeof result !== 'object' && typeof result !== 'function')) return
  const thenable = /** @type {{ then?: unknown }} */ (result)
  if (typeof thenable.then !== 'function') return
  Promise.resolve(result).catch((error) => {
    // A handler that throws is an unhandled rejection again, which is the
    // outcome this function exists to prevent.
    try {
      reportTelemetryFailure({ ...seam, error })
    } catch { /* nothing left to say it with */ }
  })
}

/**
 * Say on stderr, once, that a telemetry component threw and its export was
 * dropped. Losing the telemetry is acceptable; losing the refusal is not, but
 * neither is a broken exporter that nobody can diagnose. Bounded to one line
 * per broken component (`key`, which defaults to `source`) because the
 * throwing call sits on the path of every record: an exporter broken by
 * configuration would otherwise print once per row for the life of the
 * daemon.
 *
 * Deliberately `process.stderr`, like the mirror in `getLogger`, and for the
 * same reason: this is the report that fires when the structured substrate is
 * the broken thing.
 *
 * @ref LLP 0335#one-line [implements]: one stderr line per broken component per operation per provider instance, marked before the write.
 * @param {object} args
 * @param {'traces'|'logs'|'metrics'} args.channel
 * @param {string} args.source the exporter class, or the emit seam, that threw
 * @param {string} [args.key] what the one-line bound is counted against, when
 *   the source name alone does not identify the thing that threw
 * @param {unknown} args.error
 * @param {Set<string>} args.reported
 * @param {'export'|'flush'|'shutdown'} [args.operation] which telemetry
 *   operation threw; an export drops the record in hand, a flush or shutdown
 *   risks whatever the exporter still buffers
 */
export function reportTelemetryFailure({ channel, source, key = source, error, reported, operation = 'export' }) {
  if (reported.has(key)) return
  reported.add(key)
  const message = describeThrown(error)
  const attributes = {
    hyp_component: 'observability',
    hyp_operation: `observability.${operation}_${channel}`,
    error_kind: `telemetry_${operation}_threw`,
    telemetry_channel: channel,
    telemetry_source: source,
    error_message: message.slice(0, 200),
  }
  const consequence = operation === 'export' ? 'the record is dropped' : 'buffered records may be lost'
  try {
    process.stderr.write(`[hypaware:observability] WARN a telemetry ${operation} threw; ${consequence} ${JSON.stringify(attributes)}\n`)
  } catch { /* stderr itself is gone; there is nowhere left to say so */ }
}

/**
 * Say what was thrown, for a value that need not be an `Error` and need not
 * be convertible to a string: `String(Object.create(null))` is a `TypeError`,
 * and one thrown from here would escape the guard that called us.
 *
 * @param {unknown} error
 */
function describeThrown(error) {
  try {
    if (error instanceof Error && typeof error.message === 'string') return error.message
    return String(error)
  } catch {
    return 'a value that cannot be described'
  }
}

/**
 * Flush every exporter, absorbing a synchronous throw as well as a rejection.
 *
 * `Promise.allSettled` absorbs only rejections: a `forceFlush` that throws
 * synchronously throws out of the `map` callback before the array exists, so
 * it rejected the provider's own `forceFlush`/`shutdown` into the caller and
 * left every exporter after it neither flushed nor closed. Same contract as
 * {@link exportGuarded}, one seam later (hyparam/hypaware#1122).
 *
 * @param {'traces'|'logs'|'metrics'} channel
 * @param {Array<{ forceFlush?: () => Promise<void>|void }>} exporters
 * @param {Set<string>} reported which exporters have already been diagnosed
 */
async function flushExporters(channel, exporters, reported) {
  const results = await Promise.allSettled(exporters.map((exporter) => settled(() => exporter.forceFlush?.())))
  reportSettledFailures('flush', channel, exporters, results, reported)
}

/**
 * @param {'traces'|'logs'|'metrics'} channel
 * @param {Array<{ forceFlush?: () => Promise<void>|void, shutdown?: () => Promise<void>|void }>} exporters
 * @param {Set<string>} reported which exporters have already been diagnosed
 */
async function shutdownExporters(channel, exporters, reported) {
  await flushExporters(channel, exporters, reported)
  const results = await Promise.allSettled(exporters.map((exporter) => settled(() => exporter.shutdown?.())))
  reportSettledFailures('shutdown', channel, exporters, results, reported)
}

/**
 * Say which exporters failed to flush or close, under the usual one-line
 * bound. Absorbing the failure kept a broken `forceFlush`/`shutdown` from
 * stranding its sibling exporters, but absorbing it silently made a JSONL
 * writer that fails to close at daemon shutdown lose its buffered records
 * with no line anywhere (hyparam/hypaware#1130 item 2). The key carries the
 * operation, so an exporter that exports fine all day and only breaks at
 * close is still diagnosable after its export line was never needed, and the
 * other way round.
 *
 * @ref LLP 0335#close-failures [implements]: a failed flush or close gets the same one-line report as a failed export.
 * @param {'flush'|'shutdown'} operation
 * @param {'traces'|'logs'|'metrics'} channel
 * @param {Array<object>} exporters
 * @param {PromiseSettledResult<unknown>[]} results
 * @param {Set<string>} reported
 */
function reportSettledFailures(operation, channel, exporters, results, reported) {
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    if (result.status !== 'rejected') continue
    const source = exporterName(exporters[index])
    reportTelemetryFailure({
      channel,
      source,
      key: `${source}#${index}#${operation}`,
      error: result.reason,
      reported,
      operation,
    })
  }
}

/**
 * Run `fn` and hand back its outcome as a promise either way, so a
 * synchronous throw reaches `Promise.allSettled` as a rejection instead of
 * unwinding the `map` that was building its input.
 *
 * @param {() => unknown} fn
 */
function settled(fn) {
  try {
    return Promise.resolve(fn())
  } catch (error) {
    return Promise.reject(error)
  }
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
