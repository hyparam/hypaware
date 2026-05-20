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
    for (const reader of meter.readers ?? []) {
      await safe(() => reader.forceFlush())
      await safe(() => reader.shutdown())
    }
    if (logger.provider) {
      await safe(() => logger.provider.forceFlush())
      await safe(() => logger.provider.shutdown())
    }
    if (tracer.provider) {
      await safe(() => tracer.provider.forceFlush())
      await safe(() => tracer.provider.shutdown())
    }
    resetKernelInstruments()
    installed = null
  }
  return { env, resource, tracer, logger, meter, shutdown }
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
