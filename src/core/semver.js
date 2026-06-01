// @ts-check

/**
 * Minimal semver range matcher for the small set of operators Phase 1
 * exercises: `^X.Y.Z`, `~X.Y.Z`, `>=`, `>`, `<=`, `<`, exact, and `*`.
 * Plugin manifests don't use the full npm grammar (no `||`, no
 * hyphen ranges, no pre-release fences), and we don't want a fresh
 * runtime dependency on `semver` just to cover what we use.
 *
 * @param {string} version
 * @param {string|undefined} range
 * @returns {boolean}
 */
export function matchesSemverRange(version, range) {
  if (range === undefined || range === null) return true
  const trimmed = String(range).trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X') return true
  const v = parseSemver(version)
  if (!v) return false

  if (trimmed.startsWith('^')) {
    const r = parseSemver(trimmed.slice(1))
    if (!r) return false
    if (r.major === 0) {
      if (r.minor === 0) {
        return v.major === 0 && v.minor === 0 && v.patch === r.patch
      }
      return v.major === 0 && v.minor === r.minor && cmp(v, r) >= 0
    }
    return v.major === r.major && cmp(v, r) >= 0
  }

  if (trimmed.startsWith('~')) {
    const r = parseSemver(trimmed.slice(1))
    if (!r) return false
    return v.major === r.major && v.minor === r.minor && cmp(v, r) >= 0
  }

  if (trimmed.startsWith('>=')) {
    const r = parseSemver(trimmed.slice(2))
    return r ? cmp(v, r) >= 0 : false
  }
  if (trimmed.startsWith('<=')) {
    const r = parseSemver(trimmed.slice(2))
    return r ? cmp(v, r) <= 0 : false
  }
  if (trimmed.startsWith('>')) {
    const r = parseSemver(trimmed.slice(1))
    return r ? cmp(v, r) > 0 : false
  }
  if (trimmed.startsWith('<')) {
    const r = parseSemver(trimmed.slice(1))
    return r ? cmp(v, r) < 0 : false
  }
  if (trimmed.startsWith('=')) {
    const r = parseSemver(trimmed.slice(1))
    return r ? cmp(v, r) === 0 : false
  }

  const r = parseSemver(trimmed)
  return r ? cmp(v, r) === 0 : false
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
 * True when `range` is a range this matcher understands: `*`/`x`, an
 * exact/`=` version, or one of the `^ ~ >= <= > <` operators applied to
 * a parseable `X.Y.Z`. Mirrors the operator set in `matchesSemverRange`
 * so the doctor rejects manifest `hypaware_api` ranges the kernel could
 * never satisfy.
 *
 * @param {unknown} range
 * @returns {boolean}
 */
export function isValidRange(range) {
  if (typeof range !== 'string') return false
  const trimmed = range.trim()
  if (trimmed === '') return false
  if (trimmed === '*' || trimmed === 'x' || trimmed === 'X') return true
  const body = /^[\^~]/.test(trimmed)
    ? trimmed.slice(1)
    : /^(>=|<=)/.test(trimmed)
      ? trimmed.slice(2)
      : /^[<>=]/.test(trimmed)
        ? trimmed.slice(1)
        : trimmed
  return parseSemver(body) !== null
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
