// @ts-check

import { SEARCHABLE_COLUMNS } from './searchable_columns.js'

/**
 * @import { GrepSearchMatcher } from '../../../src/core/search/types.js'
 */

/** Per matched column, the snippet window before the first match. */
export const SNIPPET_BEFORE = 80
/** Per matched column, the snippet window after the first match. */
export const SNIPPET_AFTER = 160
/** At most this many matched columns are reported per hit. */
export const MAX_MATCH_COLUMNS = 3
/**
 * Pattern-length cap. A caller-supplied pattern is compiled once and then
 * run against every searchable cell of every scanned row, so the pattern
 * is the one input whose size multiplies the walk. The cap bounds that;
 * it deliberately does NOT claim to make regex mode safe from
 * catastrophic backtracking, which V8 cannot interrupt (no deadline and
 * no abort signal can stop a regex that is already running).
 */
export const MAX_QUERY_LENGTH = 1024

/**
 * Escape a literal query so it can be compiled as a case-insensitive
 * regex. Literal mode runs through a regex rather than
 * `value.toLowerCase().includes(...)` for two reasons: the match offset
 * has to index the original value (a character whose lowercase form is
 * longer, `İ` for one, shifts every later offset and makes `makeSnippet`
 * cut mid-word), and lowercasing every cell copies the whole buffer on a
 * walk whose cells run to megabytes.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile a caller-supplied regex, refusing a malformed pattern with the
 * same shape as the other validation failures. Without this the raw
 * `SyntaxError` reaches the serving surface, which then cannot tell a bad
 * request from an internal fault and answers 500 to `grep --regex '('`.
 *
 * @param {string} query
 * @returns {RegExp}
 */
function compileRegex(query) {
  try {
    return new RegExp(query, 'i')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`query is not a valid regular expression: ${detail}`)
  }
}

/**
 * The compiled query: `hypQuery` feeds hypgrep's index pruning, `test`
 * is the per-cell predicate, `locate` finds the first match for the
 * snippet, `rowTest` the whole-row predicate the scan paths share.
 * Literal queries are case-insensitive substring matches (hypgrep's own
 * semantics); a regex is compiled case-insensitive to keep the two modes
 * consistent for the search box.
 *
 * Every entry point renders its argument through `cellText` first, so a
 * caller that hands `test`, `locate` or `makeSnippet` the same cell
 * `rowTest` accepted gets the same answer. Splitting that (a row
 * predicate that decodes a JSON cell beside a per-cell predicate that
 * does not) makes the obvious consumer loop report a hit with no matched
 * columns, or throw on `value.slice`, and this module exists so the two
 * repositories cannot write that loop differently.
 *
 * Validation lives here rather than in each caller so every serving
 * surface enforces the identical rule. An empty pattern is refused, not
 * treated as match-everything: the literal matcher would accept every
 * non-empty searchable cell while hypgrep's own `parquetFind` returns
 * nothing for a falsy query, so an empty query would answer from the
 * unindexed tier only, which is a wrong answer dressed as a full-table
 * dump.
 *
 * @ref LLP 0264#shared [implements]: the matcher is shared so a hit means the same thing locally and through `--remote`
 * @param {string} query
 * @param {boolean} regex
 * @returns {GrepSearchMatcher}
 */
export function compileMatcher(query, regex) {
  if (typeof query !== 'string' || query.length === 0) {
    throw new Error('query must be a non-empty string')
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`query must be at most ${MAX_QUERY_LENGTH} characters`)
  }
  const re = regex ? compileRegex(query) : new RegExp(escapeLiteral(query), 'i')
  // A cell the row predicate accepted through another column still has to
  // produce an offset, so a miss degrades to the head of the value. A
  // literal keeps its own length there; a regex has no fixed width.
  const missLength = regex ? 1 : query.length
  return {
    hypQuery: regex ? re : query,
    test: (value) => re.test(cellText(value)),
    locate: (value) => {
      const m = re.exec(cellText(value))
      return m ? { index: m.index, length: Math.max(m[0].length, 1) } : { index: 0, length: missLength }
    },
    rowTest: (row) => anySearchableCell(row, (value) => re.test(value)),
  }
}

/**
 * The searchable text of one cell. Most searchable columns hold STRING,
 * but `tool_args` is a JSON column (iceberg `variant`), so it reads back
 * from parquet as an object. Without this coercion a column named in the
 * allowlist could never produce a hit: a `typeof value === 'string'` gate
 * drops the object form, so searching for a file path or a shell command
 * inside a tool call answers zero while the indexed tier, which reads the
 * column's own text, answers otherwise. That split is precisely the drift
 * the shared module exists to prevent.
 *
 * A decoded object is rendered as its keys and primitive leaves, one per
 * line, rather than as `JSON.stringify` text. Serialized text carries the
 * escapes, not the characters: `C:\Users\me` is stored as `C:\\Users\\me`
 * and a shell command's newline as the two characters `\n`, so a literal
 * query for a Windows path or for a multi-line command would miss the
 * very cell it names. The leaf rendering searches what the user sees.
 *
 * A cell that arrives already serialized (the paths that carry `tool_args`
 * verbatim, as `parseMaybeJson` handles elsewhere in the contract) is
 * matched as the text it is: nothing here knows the column, so parsing
 * every JSON-looking string would change what a `content_text` holding a
 * JSON document matches. That asymmetry is bounded (it only shows up for
 * a query containing a JSON escape) and is for the scan paths in T4/T5 to
 * settle with the server, which is the only place the column name is in
 * hand.
 *
 * @ref LLP 0264#shared [implements]: every allowlisted column is really searchable on every tier, including the JSON one
 * @param {unknown} value
 * @returns {string}
 */
export function cellText(value) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return ''
  /** @type {string[]} */
  const parts = []
  collectLeaves(value, parts, new Set())
  return parts.join('\n')
}

/**
 * Walk a decoded JSON cell, pushing each key and each primitive leaf.
 * `seen` guards a cycle: a self-referential cell yields the leaves it can
 * reach rather than costing the whole cell, which is what a serializer
 * throwing mid-render would do.
 *
 * @param {unknown} value
 * @param {string[]} out
 * @param {Set<object>} seen
 * @returns {void}
 */
function collectLeaves(value, out, seen) {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    out.push(String(value))
    return
  }
  if (typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectLeaves(item, out, seen)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    out.push(key)
    collectLeaves(item, out, seen)
  }
}

/**
 * A bounded window around the first match, never the full column value:
 * a matched message body can be megabytes. The window is cut with the
 * shared constants above, so the two repositories render the same hit
 * the same way rather than each choosing its own excerpt.
 *
 * The matched run is clamped to `SNIPPET_AFTER` before the window opens.
 * A regex match has no bounded width (`.*needle.*` matches the whole
 * cell, and that is what an rg-trained user types), so without the clamp
 * the "bounded window" is the megabyte buffer, serialized into the hit
 * and printed to a terminal once per matched column.
 *
 * The window edges are nudged off a surrogate pair, because a hit is
 * serialized to JSON and rendered in a terminal: cutting an emoji in half
 * would show the reader a replacement glyph at the snippet's edge.
 *
 * @param {unknown} value
 * @param {GrepSearchMatcher} matcher
 * @returns {string}
 */
export function makeSnippet(value, matcher) {
  const text = cellText(value)
  const found = matcher.locate(text)
  const matchLength = Math.min(found.length, SNIPPET_AFTER)
  let start = Math.max(0, found.index - SNIPPET_BEFORE)
  let end = Math.min(text.length, found.index + matchLength + SNIPPET_AFTER)
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start += 1
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end -= 1
  const prefix = start > 0 ? '...' : ''
  const suffix = end < text.length ? '...' : ''
  return prefix + text.slice(start, end) + suffix
}

/**
 * @param {number} code
 * @returns {boolean}
 */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * The whole-row predicate every match path shares: an unindexed brute
 * scan, `parquetFind`'s row filter over an indexed file, and the
 * fallback scan of a file whose sidecar is missing all match through
 * this one function, so the column exclusion cannot hold on one tier and
 * leak on another.
 *
 * @ref LLP 0264#shared [implements]: only searchable columns are tested, on every tier; an excluded column (system_text, tools, attributes, ...) cannot match here even when an older all-column sidecar proposes the row
 * @param {Record<string, unknown>} row
 * @param {(value: string) => boolean} test
 * @returns {boolean}
 */
function anySearchableCell(row, test) {
  for (const column of SEARCHABLE_COLUMNS) {
    const value = cellText(row[column])
    if (value !== '' && test(value)) return true
  }
  return false
}
