import { verifyJwt } from './identity.js'
import { writeJson } from './http.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 * @import { IdentityIssuerConfig } from '../types.js'
 * @import { JwtClaims } from './types.d.ts'
 */

/**
 * Side-table mapping verified requests to their JWT claims. A WeakMap keeps
 * the request out of the public property space (so handlers can't be tricked
 * by a client header into seeing claims) and lets the entry be GC'd when
 * the request goes away.
 *
 * @type {WeakMap<IncomingMessage, JwtClaims>}
 */
const CLAIMS = new WeakMap()

/**
 * Build a Bearer-token middleware for the server-mode control plane.
 *
 * Extracts `Authorization: Bearer <jwt>`, verifies the JWT against
 * `issuer.secret`, and on success records the claims on a side-table that
 * handlers read via `getClaims(req)`. On any failure the middleware writes
 * a 401 JSON response itself and returns false; the caller must NOT touch
 * the response on a `false` return.
 *
 * @param {IdentityIssuerConfig} issuer
 *   Validated for presence here as a layered defense against a misconfigured
 *   caller (the schema validator already requires a 32-char minimum at
 *   config-load time).
 * @param {{ now?: () => number }} [opts]
 *   `now` is injectable for tests that need to drive token expiry.
 * @returns {(req: IncomingMessage, res: ServerResponse) => boolean}
 */
export function createBearerAuth(issuer, opts = {}) {
  if (typeof issuer?.secret !== 'string' || issuer.secret.length === 0) {
    throw new Error('createBearerAuth: identity_issuer.secret is required')
  }
  const { secret } = issuer
  const verifyOpts = opts.now ? { now: opts.now } : {}
  return function authorize(req, res) {
    const header = req.headers['authorization']
    if (typeof header !== 'string') {
      writeUnauthorized(res, 'missing Authorization header')
      return false
    }
    if (!/^bearer\s+/i.test(header)) {
      writeUnauthorized(res, 'expected "Authorization: Bearer <token>"')
      return false
    }
    const token = header.replace(/^bearer\s+/i, '').trim()
    if (token.length === 0) {
      writeUnauthorized(res, 'empty bearer token')
      return false
    }
    const result = verifyJwt(token, secret, verifyOpts)
    if (result.valid === false) {
      writeUnauthorized(res, errorReason(result.error))
      return false
    }
    CLAIMS.set(req, result.claims)
    return true
  }
}

/**
 * Read verified claims off a request. Returns undefined when the request
 * never went through `createBearerAuth` or auth failed.
 *
 * @param {IncomingMessage} req
 * @returns {JwtClaims | undefined}
 */
export function getClaims(req) {
  return CLAIMS.get(req)
}

/**
 * Map a verifyJwt error code to a stable, terse 401 reason string. The
 * caller should not rely on exact wording — these are diagnostic, not
 * machine-actionable. Code is the machine signal (always 401).
 *
 * @param {'malformed' | 'bad_signature' | 'expired' | 'iat_in_future'} code
 * @returns {string}
 */
function errorReason(code) {
  switch (code) {
  case 'expired': return 'token expired'
  case 'bad_signature': return 'invalid token signature'
  case 'iat_in_future': return 'token issued-at is in the future'
  case 'malformed': return 'malformed token'
  }
}

/**
 * @param {ServerResponse} res
 * @param {string} reason
 */
function writeUnauthorized(res, reason) {
  writeJson(res, 401, { error: 'unauthorized', reason })
}
