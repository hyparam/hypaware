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
 * The compiled query: `hypQuery` feeds hypgrep's index pruning, `test`
 * is the per-cell predicate, `locate` finds the first match for the
 * snippet, `rowTest` the whole-row predicate the scan paths share.
 * Literal queries are case-insensitive substring matches (hypgrep's own
 * semantics); a regex is compiled case-insensitive to keep the two modes
 * consistent for the search box.
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
  if (regex) {
    const re = new RegExp(query, 'i')
    return {
      hypQuery: re,
      test: (value) => re.test(value),
      locate: (value) => {
        const m = re.exec(value)
        return m ? { index: m.index, length: Math.max(m[0].length, 1) } : { index: 0, length: 1 }
      },
      rowTest: (row) => anySearchableCell(row, (value) => re.test(value)),
    }
  }
  const lowered = query.toLowerCase()
  return {
    hypQuery: query,
    test: (value) => value.toLowerCase().includes(lowered),
    locate: (value) => {
      const index = value.toLowerCase().indexOf(lowered)
      return { index: Math.max(index, 0), length: Math.max(lowered.length, 1) }
    },
    rowTest: (row) => anySearchableCell(row, (value) => value.toLowerCase().includes(lowered)),
  }
}

/**
 * A bounded window around the first match, never the full column value:
 * a matched message body can be megabytes. The window is cut with the
 * shared constants above, so the two repositories render the same hit
 * the same way rather than each choosing its own excerpt.
 *
 * @param {string} value
 * @param {GrepSearchMatcher} matcher
 * @returns {string}
 */
export function makeSnippet(value, matcher) {
  const found = matcher.locate(value)
  const start = Math.max(0, found.index - SNIPPET_BEFORE)
  const end = Math.min(value.length, found.index + found.length + SNIPPET_AFTER)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < value.length ? '...' : ''
  return prefix + value.slice(start, end) + suffix
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
    const value = row[column]
    if (typeof value === 'string' && value !== '' && test(value)) return true
  }
  return false
}
