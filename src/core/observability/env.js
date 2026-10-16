// @ts-check

import os from 'node:os'
import path from 'node:path'

const DEFAULT_SERVICE_NAME = 'hypaware'
const DEFAULT_HYP_HOME_DIRNAME = '.hyp'
const HYP_STATE_SUBDIR = 'hypaware'

export const DEFAULT_RUNTIME_METRICS_INTERVAL_MS = 30_000
export const MIN_RUNTIME_METRICS_INTERVAL_MS = 5_000
// Node stores a timer delay in a signed 32-bit integer. A larger delay raises
// TimeoutOverflowWarning and is silently reset to 1ms, so an operator asking
// for an absurdly long interval would get roughly a thousand samples a second:
// exactly the tight sampling loop the five-second floor exists to prevent.
// @ref LLP 0318#activation [constrained-by]: the interval knob must not be able to undo the floor
export const MAX_RUNTIME_METRICS_INTERVAL_MS = 2_147_483_647

/**
 * @import { ObservabilityEnv } from '../../../src/core/observability/types.js'
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ObservabilityEnv}
 */
export function readObservabilityEnv(env = process.env) {
  const devTelemetry = env.HYP_DEV_TELEMETRY === '1' || env.HYP_DEV_TELEMETRY === 'true'
  const otlpEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || ''
  const serviceName = env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME
  const hypHome = env.HYP_HOME || path.join(os.homedir(), DEFAULT_HYP_HOME_DIRNAME)
  const stateDir = path.join(hypHome, HYP_STATE_SUBDIR)
  const devRunId = env.DEV_RUN_ID
  const resourceAttributes = env.OTEL_RESOURCE_ATTRIBUTES || ''
  const runtimeMetrics = env.HYP_OTEL_RUNTIME_METRICS === '1' ||
    env.HYP_OTEL_RUNTIME_METRICS === 'true'
  const requestedRuntimeInterval = Number(env.HYP_OTEL_RUNTIME_METRICS_INTERVAL_MS)
  const runtimeMetricsIntervalMs = Number.isFinite(requestedRuntimeInterval) && requestedRuntimeInterval > 0
    ? Math.min(
      MAX_RUNTIME_METRICS_INTERVAL_MS,
      Math.max(MIN_RUNTIME_METRICS_INTERVAL_MS, Math.floor(requestedRuntimeInterval)),
    )
    : DEFAULT_RUNTIME_METRICS_INTERVAL_MS
  return {
    devTelemetry,
    otlpEndpoint,
    serviceName,
    hypHome,
    stateDir,
    devRunId,
    resourceAttributes,
    runtimeMetrics,
    runtimeMetricsIntervalMs,
  }
}

/**
 * Resolve directory for dev-telemetry JSONL outputs.
 * @param {string} stateDir
 * @returns {string}
 */
export function devTelemetryDir(stateDir) {
  return path.join(stateDir, 'dev-telemetry')
}
