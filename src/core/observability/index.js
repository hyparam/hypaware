// @ts-check

import { readObservabilityEnv } from './env.js'
import { buildResource } from './resource.js'
import { installTracerProvider } from './tracer.js'
import { installLoggerProvider } from './logger.js'
import { installMeterProvider, resetKernelInstruments } from './meter.js'
import { installRuntimeMetrics } from './runtime_metrics.js'

/**
 * @import { LoggerProvider, MeterProvider, TracerProvider } from './runtime.js'
 * @import { MetricReader, ObservabilityEnv } from '../../../src/core/observability/types.js'
 */

/** @type {ReturnType<typeof buildHandle> | null} */
let installed = null

/**
 * Install tracer, logger, and meter providers using a single shared
 * Resource derived from env. Returns a handle exposing each provider
 * and a `shutdown()` that flushes and closes exporters in reverse
 * order. Idempotent: a second call returns the existing handle.
 *
 * @param {{ env?: ObservabilityEnv }} [opts]
 * @ref LLP 0021#otel-is-the-substrate [implements]: idempotent install over one shared Resource; safe-by-default tracer
 */
export function installObservability(opts = {}) {
  if (installed) return installed
  const env = opts.env ?? readObservabilityEnv()
  const resource = buildResource(env)
  const tracer = installTracerProvider({ env, resource })
  const logger = installLoggerProvider({ env, resource })
  const meter = installMeterProvider({ env, resource })
  const runtimeMetrics = installRuntimeMetrics({ env, provider: meter.provider })
  installed = buildHandle({ env, resource, tracer, logger, meter, runtimeMetrics })
  return installed
}

/**
 * @param {{
 *   env: ObservabilityEnv,
 *   resource: { attributes: Record<string, string|number|boolean> },
 *   tracer: { provider: TracerProvider|null },
 *   logger: { provider: LoggerProvider|null },
 *   meter: { provider: MeterProvider|null, readers: MetricReader[] },
 *   runtimeMetrics: { active: true, intervalMs: number, stop: () => void }|null
 * }} parts
 */
function buildHandle({ env, resource, tracer, logger, meter, runtimeMetrics }) {
  // @ref LLP 0021#shutdown-and-flush [implements]: close exporters reverse order; dev gets 5s budget + forceFlush
  async function shutdown() {
    runtimeMetrics?.stop()
    const timeoutMs = env.devTelemetry ? 5_000 : 500
    for (const reader of meter.readers ?? []) {
      if (env.devTelemetry) await safe(() => withTimeout(reader.forceFlush(), timeoutMs))
      await safe(() => withTimeout(reader.shutdown(), timeoutMs))
    }
    const meterProvider = meter.provider
    if (meterProvider) {
      if (env.devTelemetry) await safe(() => withTimeout(meterProvider.forceFlush(), timeoutMs))
      await safe(() => withTimeout(meterProvider.shutdown(), timeoutMs))
    }
    const loggerProvider = logger.provider
    if (loggerProvider) {
      if (env.devTelemetry) await safe(() => withTimeout(loggerProvider.forceFlush(), timeoutMs))
      await safe(() => withTimeout(loggerProvider.shutdown(), timeoutMs))
    }
    const tracerProvider = tracer.provider
    if (tracerProvider) {
      if (env.devTelemetry) await safe(() => withTimeout(tracerProvider.forceFlush(), timeoutMs))
      await safe(() => withTimeout(tracerProvider.shutdown(), timeoutMs))
    }
    resetKernelInstruments()
    installed = null
  }
  return { env, resource, tracer, logger, meter, runtimeMetrics, shutdown }
}

/**
 * @param {Promise<unknown>|unknown} operation
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
function withTimeout(operation, timeoutMs) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  return Promise.race([
    Promise.resolve(operation),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** @param {() => Promise<unknown>|unknown} fn */
async function safe(fn) {
  try { await fn() } catch { /* shutdown should not throw */ }
}

export { readObservabilityEnv } from './env.js'
export { buildResource } from './resource.js'
export { getTracer } from './tracer.js'
export { getLogger } from './logger.js'
export { getMeter, getKernelInstruments } from './meter.js'
export { markSpanStatus, withSpan, runRoot } from './span_helpers.js'
export { buildAttrs, normalizeKey, Attr } from './attrs.js'
export { context, ROOT_CONTEXT, SpanStatusCode, getActiveSpan } from './runtime.js'
