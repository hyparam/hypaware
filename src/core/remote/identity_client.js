// @ts-check

import { Attr, getLogger } from '../observability/index.js'

/**
 * Plain JSON client for hypaware-server's identity surface
 * (`<origin>/v1/identity`), distinct from the MCP JSON-RPC `client.js`. It
 * speaks the two token grants the server exposes (LLP 0047 §the-server-
 * contract): `authorization_code` (browser login) and `refresh_token` (silent
 * refresh). The response field is `access_jwt` (not `access_token`) and
 * `expires_at` is an ISO timestamp; the JWT is hypaware-server's own
 * credential, so there is no external JWKS trust on the client.
 *
 * @import { OidcSession, RefreshedAccess } from '../../../src/core/remote/types.js'
 */

/**
 * Error thrown when the token endpoint rejects a refresh with
 * `invalid_grant` (the refresh row was revoked or expired). The attach path
 * turns this into the "re-run `hyp remote login`" guidance (LLP 0046 D5).
 */
export class InvalidGrantError extends Error {
  /** @param {string} [message] */
  constructor(message = 'refresh token was rejected (invalid_grant)') {
    super(message)
    this.name = 'InvalidGrantError'
    /** @type {'invalid_grant'} */
    this.code = 'invalid_grant'
  }
}

/**
 * The user-facing re-login guidance for an expired or revoked OIDC session
 * (LLP 0046 D5). Lives with {@link InvalidGrantError} so the wording has one
 * home, shared by the stdio proxy and the one-shot verb attach path.
 *
 * @param {string} target
 * @returns {string}
 */
export function sessionExpiredMessage(target) {
  return `remote session expired - re-run 'hyp remote login ${target}'`
}

/**
 * Exchange an authorization code for a session (the `authorization_code`
 * grant). Presents the held PKCE verifier.
 *
 * @param {{ identityBase: string, code: string, codeVerifier: string, fetchImpl?: typeof fetch }} args
 * @returns {Promise<OidcSession>}
 */
export async function exchangeCode({ identityBase, code, codeVerifier, fetchImpl }) {
  const body = { grant_type: 'authorization_code', code, code_verifier: codeVerifier }
  const json = await postToken({ identityBase, body, fetchImpl, operation: 'remote.exchange_code' })
  return {
    refreshToken: str(json.refresh_token, 'refresh_token'),
    accessJwt: str(json.access_jwt, 'access_jwt'),
    expiresAt: str(json.expires_at, 'expires_at'),
    org: str(json.org, 'org'),
  }
}

/**
 * Refresh an access JWT (the `refresh_token` grant). Throws
 * {@link InvalidGrantError} on a 401 `invalid_grant`.
 *
 * @param {{ identityBase: string, refreshToken: string, fetchImpl?: typeof fetch }} args
 * @returns {Promise<RefreshedAccess>}
 */
export async function refreshSession({ identityBase, refreshToken, fetchImpl }) {
  const body = { grant_type: 'refresh_token', refresh_token: refreshToken }
  const json = await postToken({ identityBase, body, fetchImpl, operation: 'remote.refresh' })
  return {
    accessJwt: str(json.access_jwt, 'access_jwt'),
    expiresAt: str(json.expires_at, 'expires_at'),
    // The refresh grant only has to re-mint the access JWT; `org` is fixed for
    // the life of the refresh token. Treat it as optional here and let the
    // caller keep the org it already stored, so a server that omits it on
    // refresh does not turn every silent refresh into a hard error.
    org: typeof json.org === 'string' ? json.org : '',
    // A rotated (one-time-use) refresh token, if the server issues one. Empty
    // when the server keeps the refresh token stable; the caller then retains
    // the token it already stored. Storing a stale token here would 401 on the
    // next refresh and force a full re-login every session.
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : '',
  }
}

/**
 * POST a JSON body to `<identityBase>/token` and parse the JSON response. A
 * non-2xx whose body carries `error: "invalid_grant"` becomes an
 * {@link InvalidGrantError} (regardless of the exact status: RFC 6749 uses 400,
 * some servers 401); any other non-2xx becomes a generic error. The refresh
 * token, access JWT, code, and verifier are never logged.
 *
 * @param {{ identityBase: string, body: Record<string, unknown>, fetchImpl?: typeof fetch, operation: string }} args
 * @returns {Promise<Record<string, any>>}
 */
async function postToken({ identityBase, body, fetchImpl, operation }) {
  const doFetch = fetchImpl ?? /** @type {typeof fetch | undefined} */ (globalThis.fetch)
  if (typeof doFetch !== 'function') {
    throw new Error('no fetch implementation available for the identity client')
  }
  const log = getLogger('remote')
  const url = `${trimSlash(identityBase)}/token`
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await safeText(res)
  /** @type {any} */
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`identity endpoint returned a non-JSON response (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const errCode = json && typeof json.error === 'string' ? json.error : undefined
    log.warn('remote.token_error', {
      [Attr.COMPONENT]: 'remote-oidc',
      [Attr.OPERATION]: operation,
      [Attr.STATUS]: 'failed',
      [Attr.ERROR_KIND]: errCode ?? `http_${res.status}`,
    })
    // Key the typed rejection on the OAuth error code, not the HTTP status:
    // RFC 6749 §5.2 returns 400 for `invalid_grant`, but some deployments use
    // 401. Either way a revoked/expired refresh row must reach the re-login
    // guidance, so trust the body's `error` field over the status code.
    if (errCode === 'invalid_grant') {
      throw new InvalidGrantError()
    }
    throw new Error(`identity endpoint rejected the grant (HTTP ${res.status}${errCode ? ` ${errCode}` : ''})`)
  }
  log.info('remote.token_ok', {
    [Attr.COMPONENT]: 'remote-oidc',
    [Attr.OPERATION]: operation,
    [Attr.STATUS]: 'ok',
  })
  return json && typeof json === 'object' ? json : {}
}

/** @param {unknown} v @param {string} field @returns {string} */
function str(v, field) {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`identity response missing '${field}'`)
  }
  return v
}

/**
 * Strip trailing slashes from an identity base so `${base}/token` never
 * double-slashes. Shared with the login orchestrator's start-URL builder.
 *
 * @param {string} base
 * @returns {string}
 */
export function trimSlash(base) {
  return base.replace(/\/+$/, '')
}

/** @param {any} res @returns {Promise<string>} */
async function safeText(res) {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
