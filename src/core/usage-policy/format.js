// @ts-check

/**
 * @import { UsageClass, ParseResult } from '../../../src/core/usage-policy/types.js'
 */

// V1 implements exactly the `ignore` class. The set grows additively when
// `local-only` ships (LLP 0051); until then any other token hits the fail-safe.
const IMPLEMENTED = new Set(['ignore'])

/**
 * Parse a `.hypignore` body into a usage class.
 *
 * Strip `#` comments and blank lines; the first remaining token names the
 * class. An empty or comment-only file means `ignore`, preserving the skill
 * notes' promise that an empty `.hypignore` opts the tree out. A token the
 * running version does not implement resolves to `ignore` (the most
 * restrictive class) and surfaces a `warn` string for the caller to log:
 * the safe failure for a privacy control is "suppress more", never
 * "record-and-export something the user flagged".
 *
 * Reserved in-file path patterns are parsed-but-ignored in V1: only the first
 * token of the first meaningful line is read.
 *
 * @ref LLP 0049#file-format [implements]: strip # comments and blanks; first token is the class; empty/comment-only => ignore
 * @ref LLP 0049#fail-safe [implements]: unknown/unimplemented class token => ignore (most restrictive) + warn
 * @param {string} body
 * @returns {ParseResult}
 */
export function parseHypignore(body) {
  const token = firstToken(body)
  if (token === null) return { class: 'ignore', declared: null }
  if (IMPLEMENTED.has(token)) {
    return { class: /** @type {UsageClass} */ (token), declared: token }
  }
  return {
    class: 'ignore',
    declared: token,
    warn: `unimplemented .hypignore usage class "${token}"; treating as "ignore" (most restrictive)`,
  }
}

/**
 * First non-comment, non-blank token of a `.hypignore` body, or null when the
 * body is empty or comment-only.
 *
 * @param {string} body
 * @returns {string|null}
 */
function firstToken(body) {
  for (const rawLine of String(body).split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (line === '') continue
    return line.split(/\s+/)[0]
  }
  return null
}

/**
 * Drop an inline `#` comment from a line.
 *
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  const hash = line.indexOf('#')
  return hash === -1 ? line : line.slice(0, hash)
}
