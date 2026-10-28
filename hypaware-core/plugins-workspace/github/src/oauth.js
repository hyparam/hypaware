// @ts-check

import { setTimeout as delay } from 'node:timers/promises'

/** @import { GithubOAuthOptions, GithubOAuthTokens, HypError } from '../../../../hypaware-core/plugins-workspace/github/src/types.js' */

export const GITHUB_CLIENT_ID = 'Ov23liHrANQp9z8TxjyB'
export const GITHUB_VERIFICATION_URI = 'https://github.com/login/device'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 64 * 1024

/** @param {string} kind @param {string} message @returns {HypError} */
export function authError(kind, message) {
  const error = /** @type {HypError} */ (new Error(`GitHub authentication: ${message}`))
  error.hypErrorKind = `github_auth_${kind}`
  return error
}

/** @param {unknown} code @returns {HypError} */
function protocolError(code) {
  const messages = {
    access_denied: 'authorization denied; run `hyp github login` to try again',
    expired_token: 'device code expired; run `hyp github login` again',
    device_flow_disabled: 'Device Flow is disabled for HypAware Local; enable it in the GitHub OAuth App settings',
    incorrect_client_credentials: 'the HypAware Local OAuth client is not recognized by GitHub',
    incorrect_device_code: 'GitHub refused the device code; run `hyp github login` again',
    invalid_grant: 'session expired or revoked; run `hyp github login` again',
    bad_refresh_token: 'refresh token expired or revoked; run `hyp github login` again',
    unsupported_grant_type: 'GitHub does not support this OAuth grant',
    unsupported_scope: 'GitHub refused the requested scope',
  }
  const key = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'protocol'
  return authError(key, messages[key] ?? 'GitHub refused the OAuth request; run `hyp github login` again')
}

/**
 * Read only a bounded JSON response; never retain server error bodies, causes,
 * URLs with parameters, or fetch errors that may contain request credentials.
 * Call sites supply fixed GitHub endpoints. Redirects are forbidden.
 * @param {string} url
 * @param {RequestInit} init
 * @param {GithubOAuthOptions} opts
 * @returns {Promise<Record<string, any>>}
 */
export async function githubAuthJson(url, init, opts = {}) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  try {
    const response = await (opts.fetchImpl ?? fetch)(url, { ...init, redirect: 'error', signal })
    if (!response.ok) {
      await response.body?.cancel()
      throw authError(`http_${response.status}`, `GitHub returned HTTP ${response.status}; check access or run \`hyp github login\` again`)
    }
    const reader = response.body?.getReader()
    if (!reader) throw protocolError(null)
    const chunks = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_RESPONSE_BYTES) throw protocolError(null)
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw protocolError(null)
    return data
  } catch (err) {
    if (opts.signal?.aborted) throw authError('cancelled', 'login cancelled')
    if (timeout.aborted) throw authError('timeout', 'GitHub request timed out; try again')
    if (/** @type {HypError} */ (err)?.hypErrorKind) throw err
    throw authError('network', 'GitHub request failed or returned invalid data; try again')
  }
}

/** @param {string} url @param {Record<string, string>} fields @param {GithubOAuthOptions} opts */
function post(url, fields, opts) {
  return githubAuthJson(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GITHUB_CLIENT_ID, ...fields }).toString(),
  }, opts)
}

/** @param {unknown} value @returns {value is string} */
function tokenString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/\s/.test(value)
}

/** @param {unknown} value @returns {value is number} */
function positiveSeconds(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 366 * 86400
}

/** @param {Record<string, any>} data @param {number} now @returns {GithubOAuthTokens} */
function tokensOf(data, now) {
  if (data.error) throw protocolError(data.error)
  if (!tokenString(data.access_token) || String(data.token_type).toLowerCase() !== 'bearer') throw protocolError(null)
  const scope = typeof data.scope === 'string' ? data.scope.split(/[ ,]+/).filter(Boolean) : []
  if (!scope.includes('repo')) throw authError('scope', 'repository permission was not granted; run `hyp github login` again')
  if (data.expires_in !== undefined && !positiveSeconds(data.expires_in)) throw protocolError(null)
  if (data.refresh_token !== undefined && !tokenString(data.refresh_token)) throw protocolError(null)
  if (data.refresh_token_expires_in !== undefined && !positiveSeconds(data.refresh_token_expires_in)) throw protocolError(null)
  return {
    access_token: data.access_token,
    ...(data.expires_in !== undefined ? { expires_at: now + data.expires_in * 1000 } : {}),
    ...(data.refresh_token !== undefined ? { refresh_token: data.refresh_token } : {}),
    ...(data.refresh_token_expires_in !== undefined ? { refresh_expires_at: now + data.refresh_token_expires_in * 1000 } : {}),
  }
}

/**
 * @param {GithubOAuthOptions & { onCode: (code: string, uri: string) => void | Promise<void> }} opts
 * @returns {Promise<GithubOAuthTokens>}
 */
// @ref LLP 0409#authentication [implements]: public-client device grant with bounded, cancellable polling
export async function deviceLogin(opts) {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms) => delay(ms, undefined, { signal: opts.signal }))
  const started = now()
  const device = await post('https://github.com/login/device/code', { scope: 'repo' }, opts)
  if (device.error) throw protocolError(device.error)
  if (!tokenString(device.device_code) || !/^[A-Z0-9-]{4,32}$/.test(device.user_code) ||
      device.verification_uri !== GITHUB_VERIFICATION_URI || !positiveSeconds(device.expires_in) ||
      device.expires_in > 900 || (device.interval !== undefined && !positiveSeconds(device.interval))) throw protocolError(null)
  const deadline = started + device.expires_in * 1000
  let interval = (device.interval ?? 5) * 1000
  await opts.onCode(device.user_code, GITHUB_VERIFICATION_URI)
  for (;;) {
    if (opts.signal?.aborted) throw authError('cancelled', 'login cancelled')
    const remaining = deadline - now()
    if (remaining <= 0) throw protocolError('expired_token')
    try { await sleep(Math.min(interval, remaining)) } catch {
      throw authError('cancelled', 'login cancelled')
    }
    if (opts.signal?.aborted) throw authError('cancelled', 'login cancelled')
    if (now() >= deadline) throw protocolError('expired_token')
    const expiry = AbortSignal.timeout(Math.max(1, deadline - now()))
    let data
    try {
      data = await post(TOKEN_URL, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code,
      }, { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, expiry]) : expiry })
    } catch (err) {
      if (!opts.signal?.aborted && (expiry.aborted || now() >= deadline)) throw protocolError('expired_token')
      throw err
    }
    if (data.error === 'authorization_pending') continue
    if (data.error === 'slow_down') {
      interval = Math.max(interval + 5000, positiveSeconds(data.interval) ? data.interval * 1000 : 0)
      continue
    }
    if (now() >= deadline) throw protocolError('expired_token')
    return tokensOf(data, now())
  }
}

/** @param {string} refreshToken @param {GithubOAuthOptions} [opts] */
export async function refreshGithubToken(refreshToken, opts = {}) {
  const data = await post(TOKEN_URL, { grant_type: 'refresh_token', refresh_token: refreshToken }, opts)
  const tokens = tokensOf(data, (opts.now ?? Date.now)())
  if (!tokens.refresh_token) throw protocolError(null)
  return tokens
}

/** @param {string} token @param {GithubOAuthOptions} [opts] @returns {Promise<{ login: string, id: number }>} */
export async function githubIdentity(token, opts = {}) {
  const data = await githubAuthJson('https://api.github.com/user', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HypAware', Authorization: `Bearer ${token}` },
  }, opts)
  if (typeof data.login !== 'string' || !/^[a-zA-Z0-9-]{1,39}$/.test(data.login) || !Number.isSafeInteger(data.id) || data.id <= 0) throw protocolError(null)
  return { login: data.login, id: data.id }
}
