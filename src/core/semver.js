// @ts-check

/**
 * Minimal semver range matcher for the npm range grammar this repo meets:
 * `^X.Y.Z`, `~X.Y.Z`, `>=`, `>`, `<=`, `<`, exact and `*`, plus the range set
 * built out of them - `||` alternatives, space-separated compound ranges,
 * `x`-ranges (`1.29.x`, `1.29`, `1.x`) and hyphen ranges (`1.2.3 - 2.0.0`).
 * A shape outside that grammar answers `false` rather than guessing, so a
 * caller gating on the answer stays conservative, and we don't want a fresh
 * runtime dependency on `semver` just to cover what we use.
 *
 * Pre-release and build metadata parse but do not order; nothing here ships
 * one.
 *
 * @param {string} version
 * @param {string|undefined} range
 * @returns {boolean}
 */
export function matchesSemverRange(version, range) {
  if (range === undefined || range === null) return true
  const trimmed = String(range).trim()
  if (isWildcard(trimmed)) return true
  const v = parseSemver(version)
  if (!v) return false
  // One unreadable branch makes the whole range unreadable, which is what
  // `isValidRange` already says of it, so every branch is read before the
  // answer is given. Returning on the first branch that matches would answer
  // off the readable half alone, calling `^1.0.0 || file:../fork` satisfied
  // where npm rejects the range outright and the narrower matcher this
  // replaces answered `false`.
  let matched = false
  for (const alternative of trimmed.split('||')) {
    const comparators = comparatorsOf(alternative)
    if (comparators === null) return false
    if (!matched && comparators.every(c => satisfies(v, c))) matched = true
  }
  return matched
}

/**
 * True when `version` is a well-formed `X.Y.Z` semantic version
 * (optionally with a pre-release tag). Used by the plugin doctor to
 * validate manifest `version` fields.
 *
 * @param {unknown} version
 * @returns {boolean}
 */
export function isValidSemver(version) {
  return typeof version === 'string' && parseSemver(version) !== null
}

/**
 * True when `range` is a range this matcher understands. Mirrors the grammar
 * `matchesSemverRange` reads, so the doctor rejects manifest `hypaware_api`
 * ranges the kernel could never satisfy, and a caller that reports "cannot
 * judge" reports it for exactly the shapes the matcher cannot judge.
 *
 * @param {unknown} range
 * @returns {range is string}
 */
export function isValidRange(range) {
  if (typeof range !== 'string') return false
  const trimmed = range.trim()
  if (trimmed === '') return false
  if (isWildcard(trimmed)) return true
  return trimmed.split('||').every(alternative => comparatorsOf(alternative) !== null)
}

/**
 * The lowest version `range` admits, as `X.Y.Z`, or undefined when it is a
 * shape this matcher cannot read or one that is unbounded below (`*`,
 * `<2.0.0`, a `||` set with any such branch). Read off the comparators
 * `matchesSemverRange` matches against, so a caller asking whether a
 * declaration can only resolve at or above some version reads the same grammar
 * the satisfaction answer was given over.
 *
 * Pre-release versions do not order here, and nothing this reads ships one, so
 * an exclusive `>1.2.3` bottoms out at 1.2.4.
 *
 * @param {unknown} range
 * @returns {string|undefined}
 */
export function lowestVersion(range) {
  if (typeof range !== 'string') return undefined
  const trimmed = range.trim()
  if (isWildcard(trimmed)) return undefined
  let lowest
  for (const alternative of trimmed.split('||')) {
    const comparators = comparatorsOf(alternative)
    if (comparators === null) return undefined
    const low = lowerBound(comparators)
    // A branch with no lower bound admits everything below every other branch,
    // so it leaves the whole set unbounded.
    if (!low) return undefined
    if (!lowest || cmp(low, lowest) < 0) lowest = low
  }
  return lowest && `${lowest.major}.${lowest.minor}.${lowest.patch}`
}

/**
 * The lowest version one `||` branch admits: the highest of its lower bounds,
 * since every comparator in a branch has to hold. Undefined when it has none.
 *
 * @param {{ op: string, v: { major: number, minor: number, patch: number } }[]} comparators
 * @returns {{ major: number, minor: number, patch: number }|undefined}
 */
function lowerBound(comparators) {
  let low
  for (const c of comparators) {
    let v
    if (c.op === '>=' || c.op === '=') v = c.v
    else if (c.op === '>') v = { major: c.v.major, minor: c.v.minor, patch: c.v.patch + 1 }
    else continue
    if (!low || cmp(v, low) > 0) low = v
  }
  return low
}

/**
 * @param {string} range
 * @returns {boolean}
 */
function isWildcard(range) {
  return range === '' || range === '*' || range === 'x' || range === 'X'
}

/** One simple range: an optional operator and a possibly partial version. */
const SIMPLE = /^(>=|<=|>|<|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*])(?:\.(\d+|[xX*])(?:[-+][\w.-]+)?)?)?$/

/** The space between an operator and its version, which is not a token break. */
const OPERATOR_SPACE = /([<>=^~]+)\s+/g

/**
 * Every primitive comparator a `||` branch expands to, or null when any part
 * of it is a shape this matcher does not know. An empty array is a branch that
 * admits everything (`*`).
 *
 * @param {string} alternative
 * @returns {{ op: string, v: { major: number, minor: number, patch: number } }[] | null}
 */
function comparatorsOf(alternative) {
  const trimmed = alternative.trim()
  // npm resolves an empty branch to `*`, so a stray leading or trailing `||`
  // widens the set rather than voiding it.
  if (trimmed === '') return []
  // `>= 1.2.3` is one comparator, not two tokens, so the space after an
  // operator closes up before the compound range splits on whitespace.
  const parts = trimmed.replace(OPERATOR_SPACE, '$1').split(/\s+/)
  if (parts.length === 3 && parts[1] === '-') return hyphenComparators(parts[0], parts[2])
  const comparators = []
  for (const part of parts) {
    const simple = simpleComparators(part)
    if (simple === null) return null
    comparators.push(...simple)
  }
  return comparators
}

/**
 * @param {string} part one simple range
 * @returns {{ op: string, v: { major: number, minor: number, patch: number } }[] | null}
 */
function simpleComparators(part) {
  const p = parseSimple(part)
  if (!p) return null
  // An `x` in the major position names no version. npm reads that as `*` for
  // the bare and caret/tilde forms; a relational operator has nothing to
  // compare against, so it is a shape this matcher declines to judge.
  if (p.major === undefined) return p.op === '' || p.op === '=' || p.op === '^' || p.op === '~' ? [] : null
  const low = { major: p.major, minor: p.minor ?? 0, patch: p.patch ?? 0 }
  if (p.op === '>=') return [{ op: '>=', v: low }]
  if (p.op === '<') return [{ op: '<', v: low }]
  const ceiling = exclusiveCeiling(p.op, p.major, p.minor, p.patch)
  // A partial version bounds a whole span, so `>1.29` is everything after that
  // span rather than everything after 1.29.0, and `<=1.29` is everything
  // before the span ends.
  if (p.op === '>') return ceiling ? [{ op: '>=', v: ceiling }] : [{ op: '>', v: low }]
  if (p.op === '<=') return ceiling ? [{ op: '<', v: ceiling }] : [{ op: '<=', v: low }]
  return ceiling ? [{ op: '>=', v: low }, { op: '<', v: ceiling }] : [{ op: '=', v: low }]
}

/**
 * The two comparators a hyphen range expands to. The upper endpoint is
 * inclusive of everything the partial version names, so `1.2.3 - 2.0` ends
 * after 2.0.x.
 *
 * @param {string} from
 * @param {string} to
 * @returns {{ op: string, v: { major: number, minor: number, patch: number } }[] | null}
 */
function hyphenComparators(from, to) {
  const lo = parseSimple(from)
  const hi = parseSimple(to)
  if (!lo || !hi || lo.op !== '' || hi.op !== '') return null
  if (lo.major === undefined || hi.major === undefined) return null
  const low = { op: '>=', v: { major: lo.major, minor: lo.minor ?? 0, patch: lo.patch ?? 0 } }
  const ceiling = exclusiveCeiling('', hi.major, hi.minor, hi.patch)
  if (ceiling) return [low, { op: '<', v: ceiling }]
  return [low, { op: '<=', v: { major: hi.major, minor: hi.minor ?? 0, patch: hi.patch ?? 0 } }]
}

/**
 * The lowest version a simple range excludes above itself, or undefined when
 * it names one exact version and so bounds nothing on its own.
 *
 * @param {string} op
 * @param {number} major
 * @param {number|undefined} minor
 * @param {number|undefined} patch
 * @returns {{ major: number, minor: number, patch: number }|undefined}
 */
function exclusiveCeiling(op, major, minor, patch) {
  if (op === '^') {
    if (major !== 0) return { major: major + 1, minor: 0, patch: 0 }
    if (minor === undefined) return { major: 1, minor: 0, patch: 0 }
    if (minor !== 0) return { major: 0, minor: minor + 1, patch: 0 }
    if (patch === undefined) return { major: 0, minor: 1, patch: 0 }
    return { major: 0, minor: 0, patch: patch + 1 }
  }
  if (op === '~') {
    if (minor === undefined) return { major: major + 1, minor: 0, patch: 0 }
    return { major, minor: minor + 1, patch: 0 }
  }
  if (minor === undefined) return { major: major + 1, minor: 0, patch: 0 }
  if (patch === undefined) return { major, minor: minor + 1, patch: 0 }
  return undefined
}

/**
 * @param {string} part
 * @returns {{ op: string, major: number|undefined, minor: number|undefined, patch: number|undefined }|null}
 */
function parseSimple(part) {
  const m = SIMPLE.exec(part)
  if (!m) return null
  // A wildcard swallows every position below it: npm reads `1.x.2` as `1.x.x`,
  // so a concrete patch under a wildcard minor must not survive as a bound.
  const major = partNumber(m[2])
  const minor = major === undefined ? undefined : partNumber(m[3])
  const patch = minor === undefined ? undefined : partNumber(m[4])
  return { op: m[1] ?? '', major, minor, patch }
}

/**
 * @param {string|undefined} part
 * @returns {number|undefined} undefined for an absent or wildcard position
 */
function partNumber(part) {
  if (part === undefined || part === 'x' || part === 'X' || part === '*') return undefined
  return +part
}

/**
 * @param {{ major: number, minor: number, patch: number }} v
 * @param {{ op: string, v: { major: number, minor: number, patch: number } }} c
 * @returns {boolean}
 */
function satisfies(v, c) {
  const d = cmp(v, c.v)
  switch (c.op) {
    case '>=': return d >= 0
    case '>': return d > 0
    case '<=': return d <= 0
    case '<': return d < 0
    default: return d === 0
  }
}

/**
 * @param {string} s
 * @returns {{ major: number, minor: number, patch: number, pre: string }|null}
 */
function parseSemver(s) {
  if (typeof s !== 'string') return null
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(s.trim())
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' }
}

/**
 * @param {{ major: number, minor: number, patch: number }} a
 * @param {{ major: number, minor: number, patch: number }} b
 */
function cmp(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}
