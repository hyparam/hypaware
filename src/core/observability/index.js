// @ts-check

import { readObservabilityEnv } from './env.js'
import { buildResource } from './resource.js'
import { installTracerProvider } from './tracer.js'
import { installLoggerProvider } from './logger.js'
import { installMeterProvider, resetKernelInstruments } from './meter.js'

/** @typedef {Awaited<ReturnType<typeof installObservability>>} ObservabilityHandle */

/** @type {ReturnType<typeof buildHandle> | null} */
let installed = null

/**
 * Install tracer, logger, and meter providers using a single shared
 * Resource derived from env. Returns a handle exposing each provider
 * and a `shutdown()` that flushes and closes exporters in reverse
 * order. Idempotent — a second call returns the existing handle.
 *
 * @param {{ env?: import('./env.js').ObservabilityEnv }} [opts]
 */
export function installObservability(opts = {}) {
  if (installed) return installed
  const env = opts.env ?? readObservabilityEnv()
  const resource = buildResource(env)
  const tracer = installTracerProvider({ env, resource })
  const logger = installLoggerProvider({ env, resource })
  const meter = installMeterProvider({ env, resource })
  installed = buildHandle({ env, resource, tracer, logger, meter })
  return installed
}

/**
 * @param {{
 *   env: import('./env.js').ObservabilityEnv,
 *   resource: import('@opentelemetry/resources').Resource,
 *   tracer: { provider: import('@opentelemetry/sdk-trace-node').NodeTracerProvider|null },
 *   logger: { provider: import('@opentelemetry/sdk-logs').LoggerProvider|null },
 *   meter: { provider: import('@opentelemetry/sdk-metrics').MeterProvider|null, readers: import('@opentelemetry/sdk-metrics').MetricReader[] }
 * }} parts
 */
function buildHandle({ env, resource, tracer, logger, meter }) {
  async function shutdown() {
    const timeoutMs = env.devTelemetry ? 5_000 : 500
    for (const reader of meter.readers ?? []) {
      if (env.devTelemetry) await safe(() => withTimeout(reader.forceFlush(), timeoutMs))
      await safe(() => withTimeout(reader.shutdown(), timeoutMs))
    }
    if (logger.provider) {
      if (env.devTelemetry) await safe(() => withTimeout(logger.provider.forceFlush(), timeoutMs))
      await safe(() => withTimeout(logger.provider.shutdown(), timeoutMs))
    }
    if (tracer.provider) {
      if (env.devTelemetry) await safe(() => withTimeout(tracer.provider.forceFlush(), timeoutMs))
      await safe(() => withTimeout(tracer.provider.shutdown(), timeoutMs))
    }
    resetKernelInstruments()
    installed = null
  }
  return { env, resource, tracer, logger, meter, shutdown }
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
export { withSpan, runRoot } from './span_helpers.js'
export { buildAttrs, normalizeKey, Attr } from './attrs.js'
