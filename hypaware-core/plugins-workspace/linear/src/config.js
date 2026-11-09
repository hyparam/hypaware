// @ts-check

/** @import { LinearConfig } from '../../../../hypaware-core/plugins-workspace/linear/src/types.js' */

export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:19264/callback'
export const NO_TEAMS_MESSAGE = 'No Linear teams selected, so nothing is collected. Add team keys (like ENG) to `teams` in the @hypaware/linear plugin config.'
const KEYS = new Set(['teams', 'poll_interval', 'token_env', 'client_id', 'redirect_uri'])

/** @param {unknown} value */
export function isLoopbackRedirect(value) {
  if (typeof value !== 'string') return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) &&
      Number(u.port) > 0 && !u.username && !u.password && !u.search && !u.hash && u.pathname !== '/'
  } catch { return false }
}

/** @param {string} value */
export function parseInterval(value) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value)
  if (!match) return null
  const ms = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]] ?? 0)
  return Number.isSafeInteger(ms) && ms <= 2147483647 ? ms : null
}

/** @param {unknown} value */
// @ref LLP 0592#scope [implements]: no teams means no outbound capture; config contains names, never credentials
export function validateLinearConfig(value) {
  const errors = []
  const invalid = (pointer, message) => errors.push({ pointer, message, errorKind: 'linear_config_invalid' })
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    invalid('', 'linear config must be an object')
    return { ok: false, errors }
  }
  const raw = /** @type {Record<string, unknown>} */ (value ?? {})
  for (const key of Object.keys(raw)) if (!KEYS.has(key)) invalid(`/${key}`, `unknown linear config key "${key}"`)
  const teams = raw.teams ?? []
  if (!Array.isArray(teams) || teams.length > 100 || teams.some(t => typeof t !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(t))) {
    invalid('/teams', 'teams must be an array of at most 100 team keys or UUIDs')
  }
  const poll_interval = raw.poll_interval ?? '24h'
  if (typeof poll_interval !== 'string' || (parseInterval(poll_interval) ?? 0) < 300000) invalid('/poll_interval', 'poll_interval must be a duration from 5m to 596h')
  const token_env = raw.token_env ?? 'LINEAR_API_KEY'
  if (typeof token_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token_env) || /^lin_(api|oauth|refresh)_/i.test(token_env)) {
    invalid('/token_env', 'token_env must be an environment variable NAME, not a token')
  }
  const client_id = raw.client_id ?? ''
  if (typeof client_id !== 'string' || !/^[a-zA-Z0-9_-]{0,128}$/.test(client_id) || /^lin_/i.test(client_id)) invalid('/client_id', 'client_id must be the public OAuth app client ID')
  const redirect_uri = raw.redirect_uri ?? DEFAULT_REDIRECT_URI
  if (!isLoopbackRedirect(redirect_uri)) invalid('/redirect_uri', 'redirect_uri must be an HTTP localhost or 127.0.0.1 callback with an explicit port, path and no query or fragment')
  const config = /** @type {LinearConfig} */ ({
    teams: Array.isArray(teams) ? [...new Set(teams.map(t => String(t).toLowerCase()))].sort() : [],
    poll_interval, token_env, client_id, redirect_uri,
  })
  return errors.length ? { ok: false, errors } : { ok: true, config }
}
