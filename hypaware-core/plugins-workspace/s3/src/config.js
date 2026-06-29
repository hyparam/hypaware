// @ts-check

/**
 * Config validation for `@hypaware/s3` sink instances.
 *
 * The validator runs at config-load time. It returns a normalized config
 * object on success (trailing-slash-stripped prefix, defaulted booleans)
 * and a list of `s3_config_invalid` errors on failure. Sink-instance
 * config carries a `schedule` field too. The kernel-level validator
 * already enforces standard 5-field cron, so this module ignores it.
 */

/**
 * @import { JsonObject } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { S3ConfigValidationError, S3ConfigValidationResult, S3SinkConfig } from './types.js'
 */

const RECOGNIZED_STORAGE_CLASSES = new Set([
  'STANDARD',
  'STANDARD_IA',
  'INTELLIGENT_TIERING',
  'ONEZONE_IA',
  'GLACIER',
  'DEEP_ARCHIVE',
  'GLACIER_IR',
  'REDUCED_REDUNDANCY',
])

/**
 * Validate raw S3 sink config. Returns the normalized config on success
 * or a list of errors on failure. Caller is responsible for emitting
 * `config.validate.error` log rows; this function deliberately stays
 * dependency-free so it is callable from tests and the smoke harness
 * without spinning up observability.
 *
 * @param {unknown} value
 * @returns {S3ConfigValidationResult}
 */
export function validateS3SinkConfig(value) {
  /** @type {S3ConfigValidationError[]} */
  const errors = []

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({
      pointer: '',
      message: 's3 sink config must be an object',
      errorKind: 's3_config_invalid',
    })
    return { ok: false, errors }
  }

  const raw = /** @type {Record<string, unknown>} */ (value)

  const bucket = readString(raw, 'bucket', errors, { required: true })
  const prefix = readString(raw, 'prefix', errors)
  const region = readString(raw, 'region', errors)
  const profile = readString(raw, 'profile', errors)
  const storageClass = readString(raw, 'storage_class', errors)
  const sse = readString(raw, 'server_side_encryption', errors)
  const endpointUrl = readString(raw, 'endpoint_url', errors)
  const forcePathStyle = readBoolean(raw, 'force_path_style', errors)

  if (storageClass !== undefined && !RECOGNIZED_STORAGE_CLASSES.has(storageClass)) {
    errors.push({
      pointer: '/storage_class',
      message: `unknown storage_class '${storageClass}' (expected one of ${Array.from(RECOGNIZED_STORAGE_CLASSES).sort().join(', ')})`,
      errorKind: 's3_config_invalid',
    })
  }

  if (endpointUrl !== undefined) {
    try {
      const u = new URL(endpointUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        errors.push({
          pointer: '/endpoint_url',
          message: `endpoint_url must be http(s); got '${u.protocol}'`,
          errorKind: 's3_config_invalid',
        })
      }
    } catch {
      errors.push({
        pointer: '/endpoint_url',
        message: `endpoint_url is not a valid URL: '${endpointUrl}'`,
        errorKind: 's3_config_invalid',
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  // After error gathering above the required fields are present and the
  // optional fields are either strings/booleans or undefined.
  /** @type {S3SinkConfig} */
  const config = {
    bucket: /** @type {string} */ (bucket),
    prefix: normalizePrefix(prefix ?? ''),
  }
  if (region !== undefined) config.region = region
  if (profile !== undefined) config.profile = profile
  if (storageClass !== undefined) config.storage_class = storageClass
  if (sse !== undefined) config.server_side_encryption = sse
  if (endpointUrl !== undefined) config.endpoint_url = endpointUrl
  if (forcePathStyle !== undefined) config.force_path_style = forcePathStyle

  return { ok: true, config }
}

/**
 * Strip leading/trailing slashes so callers can compose a key as
 * `prefix + '/' + dataset + ...` without double-slashing. Empty input
 * stays empty.
 *
 * @param {string} prefix
 * @returns {string}
 */
export function normalizePrefix(prefix) {
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {S3ConfigValidationError[]} errors
 * @param {{ required?: boolean }} [opts]
 * @returns {string | undefined}
 */
function readString(raw, key, errors, opts = {}) {
  const v = raw[key]
  if (v === undefined) {
    if (opts.required) {
      errors.push({
        pointer: `/${key}`,
        message: `${key} is required`,
        errorKind: 's3_config_invalid',
      })
    }
    return undefined
  }
  if (typeof v !== 'string' || v.length === 0) {
    errors.push({
      pointer: `/${key}`,
      message: `${key} must be a non-empty string`,
      errorKind: 's3_config_invalid',
    })
    return undefined
  }
  return v
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {S3ConfigValidationError[]} errors
 * @returns {boolean | undefined}
 */
function readBoolean(raw, key, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') {
    errors.push({
      pointer: `/${key}`,
      message: `${key} must be a boolean`,
      errorKind: 's3_config_invalid',
    })
    return undefined
  }
  return v
}
