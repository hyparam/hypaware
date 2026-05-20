/**
 * Single-quote a value for safe inclusion in a POSIX shell command. Existing
 * single quotes inside the value are closed, escaped, and reopened so the
 * result remains a single shell word: `'…'`, `'\''`, `'…'` concatenated.
 *
 * @param {string} value
 * @returns {string}
 */
export function shellSingleQuote(value) {
  const quote = '\''
  return quote + value.replace(/'/g, quote + '\\' + quote + quote) + quote
}

/**
 * Trim one or more trailing `/` characters from a URL so the result can be
 * combined with a path suffix without producing `//` in the middle of the URL.
 * Returns the value unchanged when no trailing slash is present.
 *
 * @param {string} value
 * @returns {string}
 */
export function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, '')
}
