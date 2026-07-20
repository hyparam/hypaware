// @ts-check

import { createHash, randomBytes } from 'node:crypto'

import { isPlainObject } from 'hypaware/core/util'

/**
 * @import { OauthTokenGrant, SubscriptionOauthRecord } from './types.js'
 */

// The consumer sign-in surface Anthropic's own clients use. These
// endpoints and the public client id are not a published third-party
// integration contract: they can change without notice, which is why
// subscription mode is an informed opt-in rather than the fleet default.
// @ref LLP 0117#tos-open-question [constrained-by]: unsupported surface; do not harden claims about it either way without verified terms text
export const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
export const OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference'

/** Header a subscription OAuth bearer must ride beside on API calls. */
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20'

/**
 * @param {Buffer} buf
 * @returns {string}
 */
function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * PKCE S256 pair plus the CSRF state for one authorization attempt.
 *
 * @returns {{ verifier: string, challenge: string, state: string }}
 */
export function createAuthorizationAttempt() {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  const state = base64url(randomBytes(16))
  return { verifier, challenge, state }
}

/**
 * @param {{ challenge: string, state: string }} attempt
 * @returns {string}
 */
export function buildAuthorizeUrl(attempt) {
  const url = new URL(OAUTH_AUTHORIZE_URL)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', OAUTH_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI)
  url.searchParams.set('scope', OAUTH_SCOPES)
  url.searchParams.set('code_challenge', attempt.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', attempt.state)
  return url.toString()
}

/**
 * Parse what the user pastes back after authorizing. The callback page
 * displays `code#state`; be liberal and also accept a full redirect URL
 * with `?code=...&state=...`.
 *
 * @param {string} input
 * @returns {{ code: string, state: string }}
 */
export function parsePastedAuthorization(input) {
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new Error('empty authorization code')
  if (/^https?:\/\//.test(trimmed)) {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) throw new Error('URL is missing code or state')
    return { code, state }
  }
  const hash = trimmed.indexOf('#')
  if (hash <= 0 || hash === trimmed.length - 1) {
    throw new Error("expected the pasted value to look like 'code#state'")
  }
  return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) }
}

/**
 * Exchange the pasted authorization code for a token pair. Verifies the
 * echoed state before spending the code.
 *
 * @param {{
 *   code: string,
 *   state: string,
 *   attempt: { verifier: string, state: string },
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 * }} opts
 * @returns {Promise<SubscriptionOauthRecord>}
 */
export async function exchangeAuthorizationCode(opts) {
  if (opts.state !== opts.attempt.state) {
    throw new Error('authorization state mismatch: restart the sign-in')
  }
  const grant = await postTokenGrant({
    grant_type: 'authorization_code',
    code: opts.code,
    state: opts.state,
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    code_verifier: opts.attempt.verifier,
  }, opts.fetchImpl)
  return grantToRecord(grant, opts.now ?? Date.now)
}

/**
 * Refresh an expiring token pair. The upstream rotates the refresh
 * token, so the caller must persist the returned record (under the
 * store lock) or the old pair dies with this process.
 *
 * @param {{ refreshToken: string, fetchImpl?: typeof fetch, now?: () => number }} opts
 * @returns {Promise<SubscriptionOauthRecord>}
 */
export async function refreshSubscriptionToken(opts) {
  const grant = await postTokenGrant({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  }, opts.fetchImpl)
  return grantToRecord(grant, opts.now ?? Date.now)
}

/**
 * @param {Record<string, string>} body
 * @param {typeof fetch | undefined} fetchImpl
 * @returns {Promise<OauthTokenGrant>}
 */
async function postTokenGrant(body, fetchImpl) {
  const doFetch = fetchImpl ?? fetch
  const res = await doFetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    // Do not echo the response body wholesale: error pages are not a
    // credential but they are noise; keep the failure identifiable.
    throw new Error(`token endpoint returned ${res.status} for ${body.grant_type}`)
  }
  /** @type {unknown} */
  const json = await res.json()
  if (!isPlainObject(json)
    || typeof json.access_token !== 'string'
    || typeof json.refresh_token !== 'string'
    || typeof json.expires_in !== 'number') {
    throw new Error('token endpoint returned an unrecognized shape')
  }
  return /** @type {OauthTokenGrant} */ (json)
}

/**
 * @param {OauthTokenGrant} grant
 * @param {() => number} now
 * @returns {SubscriptionOauthRecord}
 */
function grantToRecord(grant, now) {
  const nowSec = Math.floor(now() / 1000)
  return {
    kind: 'subscription_oauth',
    access_token: grant.access_token,
    refresh_token: grant.refresh_token,
    expires_at: nowSec + Math.floor(grant.expires_in),
    obtained_at: nowSec,
    ...(typeof grant.scope === 'string' && grant.scope.length > 0
      ? { scopes: grant.scope.split(' ') }
      : {}),
  }
}
