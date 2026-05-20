// @ts-check

import os from 'node:os'
import path from 'node:path'

const DEFAULT_OTLP_ENDPOINT = 'http://127.0.0.1:4318'
const DEFAULT_SERVICE_NAME = 'hypaware'
const DEFAULT_HYP_HOME_DIRNAME = '.hyp'
const HYP_STATE_SUBDIR = 'hypaware'

/**
 * @typedef {Object} ObservabilityEnv
 * @property {boolean} devTelemetry
 * @property {string} otlpEndpoint
 * @property {string} serviceName
 * @property {string} hypHome
 * @property {string} stateDir
 * @property {string|undefined} devRunId
 * @property {string} resourceAttributes
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ObservabilityEnv}
 */
export function readObservabilityEnv(env = process.env) {
  const devTelemetry = env.HYP_DEV_TELEMETRY === '1' || env.HYP_DEV_TELEMETRY === 'true'
  const otlpEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_OTLP_ENDPOINT
  const serviceName = env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME
  const hypHome = env.HYP_HOME || path.join(os.homedir(), DEFAULT_HYP_HOME_DIRNAME)
  const stateDir = path.join(hypHome, HYP_STATE_SUBDIR)
  const devRunId = env.DEV_RUN_ID
  const resourceAttributes = env.OTEL_RESOURCE_ATTRIBUTES || ''
  return {
    devTelemetry,
    otlpEndpoint,
    serviceName,
    hypHome,
    stateDir,
    devRunId,
    resourceAttributes,
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
