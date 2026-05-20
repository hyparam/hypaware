/**
 * Compile include / exclude glob patterns into a single predicate. A template
 * is captured when SOME include pattern matches AND NO exclude pattern matches.
 * Empty / undefined include defaults to `['**']` (capture-all). Empty exclude
 * is the no-suppression default.
 *
 * Pattern grammar — minimal POSIX-glob-like:
 *   `**`  matches any sequence (including `/`)
 *   `*`   matches any sequence except `/`
 *   `?`   matches one character except `/`
 *   any other character matches itself
 *
 * The predicate is null-safe: an undefined or empty template falls through to
 * the include check, which `**` matches by definition.
 *
 * @param {string[] | undefined} include
 * @param {string[] | undefined} exclude
 * @returns {(template: string | undefined) => boolean}
 */
export function compileFilter(include, exclude) {
  const inc = (include === undefined || include.length === 0) ? ['**'] : include
  const exc = exclude ?? []
  const incRegexes = inc.map(globToRegex)
  const excRegexes = exc.map(globToRegex)
  return function matches(template) {
    const t = template ?? ''
    for (const re of excRegexes) {
      if (re.test(t)) return false
    }
    for (const re of incRegexes) {
      if (re.test(t)) return true
    }
    return false
  }
}

/**
 * Translate a glob pattern into an anchored regex. Uses a small state machine
 * over the pattern characters so `**`, `*`, `?` are handled before regex-meta
 * characters get escaped.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function globToRegex(pattern) {
  let re = '^'
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i += 2
      } else {
        re += '[^/]*'
        i += 1
      }
    } else if (ch === '?') {
      re += '[^/]'
      i += 1
    } else if (REGEX_META.has(ch)) {
      re += `\\${ch}`
      i += 1
    } else {
      re += ch
      i += 1
    }
  }
  re += '$'
  return new RegExp(re)
}

const REGEX_META = new Set(['.', '+', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\'])
