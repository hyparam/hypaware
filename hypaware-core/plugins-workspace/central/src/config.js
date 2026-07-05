// @ts-check

import { isPlainObject } from 'hypaware/core/util'

/**
 * @import { CentralSinkConfig } from './types.js'
 */

const MIN_POLL_INTERVAL = 5
const MAX_POLL_INTERVAL = 3600

/**
 * Validate the sink-instance config block at
 * `HypAwareV2Config.sinks.<name>.config`. The kernel passes the raw
 * value untouched; this is the central plugin's owned validation.
 *
 * @param {unknown} value
 * @returns {{ ok: true, config: CentralSinkConfig } | { ok: false, message: string }}
 */
export function validateCentralConfig(value) {
  if (!isPlainObject(value)) {
    return invalid('central sink config must be an object')
  }
  const cfg = /** @type {Record<string, unknown>} */ (value)

  if (typeof cfg.url !== 'string' || cfg.url.length === 0) {
    return invalid('central.url is required')
  }
  try {
    const parsed = new URL(cfg.url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return invalid(`central.url must be http(s); got ${parsed.protocol}`)
    }
  } catch {
    return invalid(`central.url is not a valid URL: ${cfg.url}`)
  }

  if (!isPlainObject(cfg.identity)) {
    return invalid('central.identity is required')
  }
  const identity = /** @type {Record<string, unknown>} */ (cfg.identity)
  if (identity.bootstrap_token !== undefined && typeof identity.bootstrap_token !== 'string') {
    return invalid('central.identity.bootstrap_token must be a string when set')
  }
  if (identity.persisted_path !== undefined && typeof identity.persisted_path !== 'string') {
    return invalid('central.identity.persisted_path must be a string when set')
  }

  if (cfg.schedule !== undefined && typeof cfg.schedule !== 'string') {
    return invalid('central.schedule must be a string when set')
  }

  if (cfg.poll_interval_seconds !== undefined) {
    const n = cfg.poll_interval_seconds
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
      return invalid('central.poll_interval_seconds must be an integer')
    }
    if (n < MIN_POLL_INTERVAL || n > MAX_POLL_INTERVAL) {
      return invalid(`central.poll_interval_seconds must be between ${MIN_POLL_INTERVAL} and ${MAX_POLL_INTERVAL}`)
    }
  }

  return { ok: true, config: /** @type {CentralSinkConfig} */ (/** @type {unknown} */ (cfg)) }
}

/** @param {string} message */
function invalid(message) {
  return /** @type {const} */ ({ ok: false, message })
}

