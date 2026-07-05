// @ts-check

// Shared value-inspection and canonical-JSON helpers. These were
// hand-copied into a dozen-plus core and plugin files before being
// hoisted here; import them instead of re-typing them.

import { createHash } from 'node:crypto'

/**
 * True for non-null, non-array objects. Arrays are excluded because
 * every caller uses this to gate `Record`-style key access.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The string itself when `value` is a non-empty string, else `undefined`.
 *
 * @param {unknown} value
 */
export function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Parse `value` as JSON when it is a string, falling back to the
 * original value when it is not a string or does not parse. Projectors
 * use this for fields that may arrive either encoded or already
 * structured.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * Deep-copy with object keys sorted recursively, so two structurally
 * equal values serialize identically.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
    return out
  }
  return value
}

/**
 * Key-order-independent serialization, for content hashing and dedup
 * identity.
 *
 * @param {unknown} value
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

/** @param {string} input */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * The error's string `code` (e.g. `'ENOENT'`), or `undefined` when the
 * value is not an error-like object carrying one.
 *
 * @param {unknown} err
 * @returns {string | undefined}
 */
export function errCode(err) {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined
  const code = Reflect.get(err, 'code')
  return typeof code === 'string' ? code : undefined
}
