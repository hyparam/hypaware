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

/**
 * Content-block fields that vary between the channels a logical message
 * can arrive on (wire request, wire response, client transcript)
 * without changing its meaning: `cache_control` is a wire-only
 * prompt-cache breakpoint that moves between exchanges; `caller` is a
 * tool_use annotation present on the response stream and transcript but
 * absent from the request-input echo of the same turn.
 *
 * One canonical list: the ai-gateway fallback message id and the claude
 * plugin's transcript match key must strip the exact same set, or the
 * same block hashes to different identities depending on which channel
 * delivered it.
 */
export const VOLATILE_BLOCK_FIELDS = Object.freeze(['cache_control', 'caller'])

/**
 * Drop {@link VOLATILE_BLOCK_FIELDS} from each block of a content
 * array before canonical-JSON hashing. Only block-level keys are
 * stripped; block payloads and non-array content are untouched.
 *
 * @param {unknown} content
 * @returns {unknown}
 */
export function stripVolatileBlockFields(content) {
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (!isPlainObject(block) || !VOLATILE_BLOCK_FIELDS.some((field) => field in block)) return block
    const rest = { ...block }
    for (const field of VOLATILE_BLOCK_FIELDS) delete rest[field]
    return rest
  })
}
