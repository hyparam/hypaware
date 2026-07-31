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
 * Default ceiling for a display label lifted off captured data. Long
 * enough that no real client surface is truncated (`local-agent`,
 * `codex-tui`, `Codex Desktop` are all well under it), short enough that
 * a status file holding a bounded number of them stays small.
 */
export const MAX_LABEL_CHARS = 120

// C0 and C1 control characters, plus the Unicode line/paragraph
// separators. Kept as one class so a label can never move the cursor,
// erase a line, open an escape sequence, or split into a second line.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g

/**
 * Make a captured string safe to write into a status file and print to a
 * terminal: strip control characters and clamp the length.
 *
 * Values like `entrypoint` are captured verbatim from whatever the client
 * put on the wire or wrote into a transcript file on disk, so they carry
 * no guarantee of being short, printable, or single-line. A raw value
 * reaching a TTY lets a client repaint the operator's screen (an `ESC`
 * sequence, or a newline that forges a plausible extra status line), and
 * an arbitrarily long one bloats every file the label lands in. Neither
 * is a hypothetical: transcript-sourced values are ordinary JSON strings
 * with no parser bounding them.
 *
 * The truncation marker is a plain ASCII ellipsis so the result stays
 * single-byte-safe in a terminal.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string | undefined} Cleaned non-empty string, else `undefined`.
 */
export function sanitizeLabel(value, max = MAX_LABEL_CHARS) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const stripped = value.replace(CONTROL_CHARS, '')
  if (stripped.length === 0) return undefined
  return stripped.length > max ? `${stripped.slice(0, max)}...` : stripped
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
 * Walk a dotted path of plain literal segments through nested plain
 * objects. Segments split on `.` with no escaping: a segment may
 * contain any character except a dot (e.g. `x-hypaware-marker`), so a
 * key that itself contains a dot cannot be addressed. Returns the value
 * at the leaf, or `undefined` when any intermediate step is not a plain
 * object or a key is absent.
 *
 * @param {unknown} root
 * @param {string} dottedPath
 * @returns {unknown}
 */
export function getAtDottedPath(root, dottedPath) {
  /** @type {unknown} */
  let current = root
  for (const segment of dottedPath.split('.')) {
    if (!isPlainObject(current)) return undefined
    current = current[segment]
  }
  return current
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
