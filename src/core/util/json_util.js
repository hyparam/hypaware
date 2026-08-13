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

// Everything a captured value may contain that either drives the terminal
// or occupies no width on it. Three groups, named separately because two
// different policies are built out of them (strip, in `sanitizeLabel`;
// escape, in `escapeForDisplay`), and a second hand-written character class
// would be a second chance for the two to disagree about what "unsafe"
// means.
//
// @ref LLP 0224#one-vocabulary: one class, two policies over its named groups

//   C0/DEL/C1 and the Unicode line/paragraph separators, so a value can
//   never move the cursor, erase a line, open an escape sequence, or split
//   into a second line.
const TERMINAL_CONTROL_CHARS = '\\u0000-\\u001F\\u007F-\\u009F\\u2028-\\u2029'

//   Bidirectional formatting (embeddings, overrides, isolates, marks).
//   These print nothing but reorder what follows, and an unterminated one
//   keeps reordering past the end of the value into the rest of the line. A
//   value that renders as a different string than the one it stores defeats
//   the point of showing it at all.
const BIDI_FORMATTING_CHARS = '\\u061C\\u200E-\\u200F\\u202A-\\u202E\\u2066-\\u2069'

//   Zero-width and default-ignorable formatting (ZWSP/ZWNJ/ZWJ, word
//   joiner, BOM, soft hyphen, variation selectors). These render as
//   nothing, so keeping them lets two labels be distinct map keys while
//   being indistinguishable on screen, which is what would otherwise dilute
//   the tracker's eviction cap.
const INVISIBLE_FORMATTING_CHARS = '\\u00AD\\u180E\\u200B-\\u200D\\u2060-\\u2064\\uFE00-\\uFE0F\\uFEFF'

// Confusables are deliberately out of scope: this bounds what a value
// *does*, not what it looks like. Two labels built from different but
// similar-looking real letters stay distinct, as they must.
const UNSAFE_LABEL_CHARS = new RegExp(
  `[${TERMINAL_CONTROL_CHARS}${BIDI_FORMATTING_CHARS}${INVISIBLE_FORMATTING_CHARS}]`,
  'g'
)

// What a rendered cell may not contain: a strict subset of
// `UNSAFE_LABEL_CHARS` holding only the characters that drive or reorder a
// terminal. The zero-width group is deliberately left alone here, unlike in
// a label, for two reasons. A query cell is prose, not a map key, so nothing
// downstream is diluted by two cells looking alike. And ZWJ and the
// variation selectors are load-bearing inside ordinary emoji (a family emoji
// is a ZWJ sequence), so escaping them would visibly corrupt legitimate
// captured text on a large fraction of real rows, to defend against a
// character that cannot repaint anything.
//
// @ref LLP 0224#escape-class [implements]: display escapes control and bidi, not zero-width
const DISPLAY_UNSAFE_CHARS = new RegExp(`[${TERMINAL_CONTROL_CHARS}${BIDI_FORMATTING_CHARS}]`, 'g')

// The three C0 characters an operator reads more easily by name than by code
// point. Everything else in the class falls through to a `\uXXXX` escape.
const DISPLAY_NAMED_ESCAPES = new Map([
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
])

// A high surrogate left stranded by the clamp below. Slicing counts UTF-16
// code units, so a cut can land between the halves of an astral character
// and leave behind a string that is not well-formed.
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/

const TRUNCATION_MARKER = '...'

/**
 * Make a captured string safe to write into a status file and print to a
 * terminal: strip control and invisible formatting characters, and clamp
 * the length.
 *
 * Values like `entrypoint` are captured verbatim from whatever the client
 * put on the wire or wrote into a transcript file on disk, so they carry
 * no guarantee of being short, printable, or single-line. A raw value
 * reaching a TTY lets a client repaint the operator's screen (an `ESC`
 * sequence, or a newline that forges a plausible extra status line),
 * reorder it (a bidi override), or hide inside it (a zero-width run), and
 * an arbitrarily long one bloats every file the label lands in. None of
 * this is hypothetical: transcript-sourced values are ordinary JSON
 * strings with no parser bounding them.
 *
 * The result is at most `max` characters *including* the truncation
 * marker, which is a plain ASCII ellipsis so the result stays
 * single-byte-safe in a terminal. `max` counts UTF-16 code units, not
 * bytes: a label of astral characters is still roughly 4x `max` bytes
 * once encoded, which is why callers cap the count of labels too.
 *
 * Sibling policy: `escapeForDisplay`, for the places where the value *is*
 * the payload rather than a name for one, and losing bytes would be worse
 * than showing them.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string | undefined} Cleaned non-empty string, else `undefined`.
 */
export function sanitizeLabel(value, max = MAX_LABEL_CHARS) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const stripped = value.replace(UNSAFE_LABEL_CHARS, '')
  if (stripped.length === 0) return undefined
  if (stripped.length <= max) return stripped
  const head = stripped
    .slice(0, Math.max(0, max - TRUNCATION_MARKER.length))
    .replace(TRAILING_HIGH_SURROGATE, '')
  return head.length === 0 ? undefined : `${head}${TRUNCATION_MARKER}`
}

/**
 * Make a captured string safe to *print* without losing any of it: replace
 * every character that drives or reorders a terminal with a visible escape,
 * and change nothing else.
 *
 * This is the display-plane sibling of `sanitizeLabel`, over the same
 * character vocabulary but under a different policy, because the two have
 * different jobs. A label *names* a surface, so a stripped name is still a
 * usable name and the shortest safe answer is to drop the bytes. A rendered
 * cell *is* the captured payload the operator asked to see, so silently
 * dropping bytes turns a query into a lie about what was captured: the row
 * must stay honest about the ESC that was there. Hence escape, not strip,
 * and hence no truncation and no `undefined` for empty (a cell that held an
 * empty string is a cell, and the caller has already applied its own
 * `--max-cell` clip).
 *
 * Escapes are the familiar JavaScript spellings: `\n`, `\r`, `\t`, and
 * `\uXXXX` for everything else. The output is pure ASCII, one column per
 * character, so a caller that pads to a computed column width stays aligned.
 * A backslash already in the value is deliberately *not* doubled: captured
 * data is full of Windows paths, regexes and JSON blobs, and mangling every
 * one of them to disambiguate a literal two-character `\n` from an escaped
 * newline would cost far more legibility than the ambiguity does. The
 * ambiguity is cosmetic; neither spelling can move a cursor.
 *
 * @ref LLP 0224#escape-not-strip [implements]: the display plane escapes where the label plane strips
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeForDisplay(value) {
  return value.replace(DISPLAY_UNSAFE_CHARS, (ch) => {
    return DISPLAY_NAMED_ESCAPES.get(ch) ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
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
