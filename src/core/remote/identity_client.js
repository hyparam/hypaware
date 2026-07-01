// @ts-check

import { safeText } from '../http_text.js'
import { Attr, getLogger } from '../observability/index.js'

/**
 * Plain JSON client for hypaware-server's identity surface
 * (`<origin>/v1/identity`), distinct from the MCP JSON-RPC `client.js`. It
 * speaks the two token grants the server exposes (LLP 0059 §the-server-
 * contract): `authorization_code` (browser login) and `refresh_token` (silent
 * refresh). The response field is `access_jwt` (not `access_token`) and
 * `expires_at` is a Unix epoch-second (the JWT `exp`, matching the server's
 * bootstrap/refresh identity endpoints); this client normalizes it to an ISO
 * string internally, so the stored session and its refresh-decision stay
 * ISO-based. The JWT is hypaware-server's own credential, so there is no
 * external JWKS trust on the client.
 *
 * @import { LoginGatewayCredential, OidcSession, RefreshedAccess } from '../../../src/core/remote/types.js'
 */

/**
 * Upper bound on a single `/token` request. The stdio proxy refreshes on the
 * per-message hot path (resolveAccessJwt -> refreshSession), so a hung or very
 * slow identity endpoint must not block a forwarded JSON-RPC message forever.
 */
const TOKEN_TIMEOUT_MS = 30 * 1000

/**
 * Shared base wording for a missing global `fetch`, so every attach entrypoint
 * (the verb, the stdio proxy, this identity client) reports the same phrase with
 * its own context appended rather than three independently-drifting strings.
 */
export const NO_FETCH_MESSAGE = 'no fetch implementation available'

/**
 * Error thrown when the token endpoint rejects a refresh with
 * `invalid_grant` (the refresh row was revoked or expired). The attach path
 * turns this into the "re-run `hyp remote login`" guidance (LLP 0058 D5).
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
 * (LLP 0058 D5). Lives with {@link InvalidGrantError} so the wording has one
 * home, shared by the stdio proxy and the one-shot verb attach path.
 *
 * @param {string} target
 * @returns {string}
 */
export function sessionExpiredMessage(target) {
  return `remote session expired - re-run 'hyp remote login ${target}'`
}

/**
 * Classify a refresh failure so both attach paths report it the same way: a
 * typed `invalid_grant` (the refresh row was revoked or expired) is a session
 * expiry that maps to the re-login guidance; anything else surfaces its own
 * message. The one home for this decision, shared by the stdio proxy and the
 * verb attach path, so the two can never drift in what they tell the user.
 *
 * @param {unknown} err
 * @param {string} target
 * @returns {{ sessionExpired: boolean, message: string }}
 * @ref LLP 0058#d5 [implements]: invalid_grant -> re-login guidance, one home for both attach paths
 */
export function describeRefreshError(err, target) {
  if (err instanceof InvalidGrantError) {
    return { sessionExpired: true, message: sessionExpiredMessage(target) }
  }
  return { sessionExpired: false, message: err instanceof Error ? err.message : String(err) }
}

/**
 * Exchange an authorization code for a session (the `authorization_code`
 * grant). Presents the held PKCE verifier. `host` is the advisory machine
 * label the server folds into its login-gateway dedup key (LLP 0061 D6);
 * it is omitted from the body when empty.
 *
 * @param {{ identityBase: string, code: string, codeVerifier: string, host?: string, fetchImpl?: typeof fetch }} args
 * @returns {Promise<OidcSession>}
 */
export async function exchangeCode({ identityBase, code, codeVerifier, host, fetchImpl }) {
  const body = { grant_type: 'authorization_code', code, code_verifier: codeVerifier, ...(host ? { host } : {}) }
  const json = await postToken({ identityBase, body, fetchImpl, operation: 'remote.exchange_code' })
  /** @type {OidcSession} */
  const session = {
    refreshToken: str(json.refresh_token, 'refresh_token'),
    accessJwt: str(json.access_jwt, 'access_jwt'),
    expiresAt: expiryTimestamp(json.expires_at, 'expires_at'),
    org: str(json.org, 'org'),
  }
  const gateway = gatewayCredential(json)
  if (gateway) session.gateway = gateway
  return session
}

/**
 * Read the login-minted gateway credential off a token response (LLP 0061
 * D1). A server without login-gateway support omits all three `gateway_*`
 * fields and the session simply carries no gateway; a *partial* set is a
 * server contract violation and fails loudly, because silently dropping it
 * would break forwarding with no visible cause. The fields stay out of the
 * query-scoped record entirely; the login command routes them to the
 * central sink's forward store.
 *
 * @param {Record<string, any>} json
 * @returns {LoginGatewayCredential | undefined}
 * @ref LLP 0061#d1 [implements]: capture the gateway_* triple off the authorization_code response; absent fields mean no gateway, partial fields fail loudly
 */
function gatewayCredential(json) {
  if (json.gateway_jwt === undefined && json.gateway_expires_at === undefined && json.gateway_id === undefined) {
    return undefined
  }
  return {
    jwt: str(json.gateway_jwt, 'gateway_jwt'),
    expiresAt: epochSecond(json.gateway_expires_at, 'gateway_expires_at'),
    gatewayId: str(json.gateway_id, 'gateway_id'),
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
    expiresAt: expiryTimestamp(json.expires_at, 'expires_at'),
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
    throw new Error(`${NO_FETCH_MESSAGE} for the identity client`)
  }
  const log = getLogger('remote')
  const url = `${trimSlash(identityBase)}/token`
  // Bound the whole request (connect + body read) so a hung endpoint can't wedge
  // the proxy hot path. clearTimeout in `finally` so a fast response doesn't keep
  // the timer (and the event loop) alive.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS)
  /** @type {Awaited<ReturnType<typeof doFetch>>} */
  let res
  /** @type {string} */
  let text
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    text = await safeText(res)
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`identity endpoint did not respond within ${TOKEN_TIMEOUT_MS / 1000}s`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
  // Parse failure is not fatal on its own: an error response may carry an empty
  // or non-JSON body, and we still want to classify it by status below. Only a
  // *successful* response with an empty or unparseable body is an error (we
  // can't read the tokens out of it) - see the post-status guards.
  /** @type {any} */
  let json = {}
  let parseFailed = false
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    parseFailed = true
  }
  if (!res.ok) {
    const errCode = json && typeof json.error === 'string' ? json.error : undefined
    log.warn('remote.token_error', {
      [Attr.COMPONENT]: 'remote-oidc',
      [Attr.OPERATION]: operation,
      [Attr.STATUS]: 'failed',
      [Attr.ERROR_KIND]: errCode ?? `http_${res.status}`,
    })
    // A revoked/expired refresh row must reach the re-login guidance even when
    // the body is empty or non-JSON: the only credential this endpoint
    // authenticates is the refresh token, so a 401 means re-login regardless of
    // whether an OAuth error object came back. RFC 6749 §5.2 returns 400 for
    // `invalid_grant`, so honor an explicit `invalid_grant` at any status too;
    // a different 400 (a malformed request) stays a generic error.
    if (errCode === 'invalid_grant' || res.status === 401) {
      // The authorization_code grant has no refresh token: a rejected code
      // (expired, replayed, or mis-scoped client) must not borrow the refresh
      // wording, or a first-time login reports a refresh token it never had.
      if (body.grant_type === 'authorization_code') {
        throw new Error('the authorization code was rejected (it may have expired or already been used) - run the login again')
      }
      throw new InvalidGrantError()
    }
    throw new Error(`identity endpoint rejected the grant (HTTP ${res.status}${errCode ? ` ${errCode}` : ''})`)
  }
  if (parseFailed) {
    throw new Error(`identity endpoint returned a non-JSON response (HTTP ${res.status})`)
  }
  if (text === '') {
    // safeText returns '' for both an empty body and a mid-body read failure
    // (a reset connection). On a 2xx that is a transient truncation, not a
    // contract violation, so fail with that framing rather than letting the
    // field extractors below report a misleading "missing 'access_jwt'".
    throw new Error(`identity endpoint returned an empty response (HTTP ${res.status}) - try again`)
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
 * Normalize the server's `expires_at` to an ISO string. The wire value is a
 * Unix epoch-second (the JWT `exp`); we convert it to ISO so the rest of the
 * client (storage, `isFresh`) keeps its ISO-based, millisecond comparison.
 * An ISO string is also accepted so older mocks/servers still parse. The stdio
 * proxy refreshes whenever the stored expiry is unparseable, so a value that is
 * neither a finite epoch-second nor a parseable date (e.g. epoch-seconds-as-a-
 * string) would make every forwarded message a fresh refresh that re-stores the
 * same bad value and never self-corrects. Fail loudly at parse time instead.
 *
 * @param {unknown} v @param {string} field @returns {string}
 */
function expiryTimestamp(v, field) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`identity response field '${field}' is not a valid timestamp`)
    }
    return new Date(v * 1000).toISOString()
  }
  const s = str(v, field)
  if (Number.isNaN(Date.parse(s))) {
    throw new Error(`identity response field '${field}' is not a valid timestamp`)
  }
  return s
}

/**
 * Normalize an expiry to a Unix epoch second. The inverse framing of
 * {@link expiryTimestamp}: the gateway credential seeds the central sink's
 * persisted `identity.json`, whose `expires_at` is an integer epoch second,
 * so here the epoch is the stored form and an ISO string (an older mock) is
 * converted down to it.
 *
 * @param {unknown} v @param {string} field @returns {number}
 */
function epochSecond(v, field) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`identity response field '${field}' is not a valid timestamp`)
    }
    return Math.floor(v)
  }
  const ms = Date.parse(str(v, field))
  if (Number.isNaN(ms)) {
    throw new Error(`identity response field '${field}' is not a valid timestamp`)
  }
  return Math.floor(ms / 1000)
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

