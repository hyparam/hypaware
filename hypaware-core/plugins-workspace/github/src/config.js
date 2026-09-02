// @ts-check

/**
 * Config validation for the `[github]` section. Pure and dependency-free
 * (mirrors the enrich / embedder / vector-search validators): returns a
 * normalized config or a list of `github_config_invalid` errors.
 *
 * @import { GithubConfig, GithubConfigError, GithubConfigResult } from './types.js'
 */

export const CONFIG_DEFAULTS = Object.freeze({
  // The env-var NAME the token is read from at call time - never the token
  // itself. Config carries only the name; the value is resolved in the client
  // and never logged (LLP 0360 / LLP 0028 credential posture).
  token_env: 'GITHUB_TOKEN',
  // Local capture runs unattended once the plugin is installed. A daily
  // interval bounds GitHub API work while the source's short initial delay
  // prevents daemon restarts from postponing capture for a full day.
  poll_interval: '24h',
  // @ref LLP 0360#inventory [implements]: session repositories are the safe default; full visibility is explicit
  inventory: 'session_repos',
})

const CONFIG_KEYS = new Set(['ignore', 'poll_interval', 'inventory', 'token_env'])

/** `owner/repo` - exactly one slash, non-empty halves, no whitespace. */
const REPO_SLUG = /^[^/\s]+\/[^/\s]+$/
/** A POSIX env-var name (what `token_env` holds - the NAME, not the secret). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** A duration like `10m`, `30s`, `1h`, `500ms`. */
const DURATION = /^(\d+)(ms|s|m|h)$/
export const MIN_POLL_INTERVAL_MS = 5 * 60_000

/**
 * @param {unknown} value
 * @returns {GithubConfigResult}
 */
export function validateGithubConfig(value) {
  /** @type {GithubConfigError[]} */
  const errors = []

  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    errors.push(invalid('', 'github config must be an object'))
    return { ok: false, errors }
  }
  const raw = /** @type {Record<string, unknown>} */ (value ?? {})

  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) errors.push(invalid(`/${key}`, `unknown github config key "${key}"`))
  }

  const ignore = readSlugArray(raw, 'ignore', errors) ?? []
  const token_env = readEnvName(raw, 'token_env', errors) ?? CONFIG_DEFAULTS.token_env
  const poll_interval = readDuration(raw, 'poll_interval', errors) ?? CONFIG_DEFAULTS.poll_interval
  const inventory = readInventory(raw, 'inventory', errors) ?? CONFIG_DEFAULTS.inventory

  if (errors.length > 0) return { ok: false, errors }

  /** @type {GithubConfig} */
  const config = {
    ignore,
    token_env,
    poll_interval,
    inventory,
  }
  return { ok: true, config }
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {GithubConfigError[]} errors
 * @returns {'session_repos' | 'all_visible' | undefined}
 */
function readInventory(raw, key, errors) {
  const value = raw[key]
  if (value === undefined) return undefined
  if (value !== 'session_repos' && value !== 'all_visible') {
    errors.push(invalid(`/${key}`, `${key} must be "session_repos" or "all_visible"`))
    return undefined
  }
  return value
}

/**
 * Parse a duration string (`10m`) to milliseconds. Returns null on a malformed
 * value. The source uses this to schedule its poll; validation uses it to
 * reject bad `poll_interval`s up front.
 *
 * @param {string} value
 * @returns {number | null}
 */
export function parseInterval(value) {
  const m = DURATION.exec(value)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2]
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000
  return n * mult
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {GithubConfigError[]} errors
 * @returns {string[] | undefined}
 */
function readSlugArray(raw, key, errors) {
  const arr = readArray(raw, key, errors)
  if (arr === undefined) return undefined
  /** @type {string[]} */
  const out = []
  for (const entry of arr) {
    if (typeof entry !== 'string' || !REPO_SLUG.test(entry)) {
      errors.push(invalid(`/${key}`, `${key} entries must be "owner/repo" strings`))
      return undefined
    }
    out.push(entry)
  }
  return out
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {GithubConfigError[]} errors
 * @returns {unknown[] | undefined}
 */
function readArray(raw, key, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (!Array.isArray(v)) {
    errors.push(invalid(`/${key}`, `${key} must be an array`))
    return undefined
  }
  return v
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {GithubConfigError[]} errors
 * @returns {string | undefined}
 */
function readEnvName(raw, key, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || !ENV_NAME.test(v)) {
    errors.push(invalid(`/${key}`, `${key} must be an environment variable NAME (e.g. "GITHUB_TOKEN"), not a token`))
    return undefined
  }
  return v
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {GithubConfigError[]} errors
 * @returns {string | undefined}
 */
function readDuration(raw, key, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') {
    errors.push(invalid(`/${key}`, `${key} must be a duration of at least "5m"`))
    return undefined
  }
  const interval = parseInterval(v)
  if (interval === null || interval < MIN_POLL_INTERVAL_MS) {
    errors.push(invalid(`/${key}`, `${key} must be a duration of at least "5m"`))
    return undefined
  }
  return v
}

/**
 * @param {string} pointer
 * @param {string} message
 * @returns {GithubConfigError}
 */
function invalid(pointer, message) {
  return { pointer, message, errorKind: 'github_config_invalid' }
}
