import crypto from 'node:crypto'
import { writeJson } from './http.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 */

/**
 * Build a Bearer-token middleware for the operator-facing admin API.
 *
 * Validates `Authorization: Bearer <token>` against a configured admin
 * token using a constant-time compare so an attacker can't probe for the
 * token via timing differences. Length mismatches are not short-circuited:
 * the middleware burns the same CPU as a real compare against a fixed-length
 * scratch buffer so wall-clock response time stays uniform across the
 * wrong-length and wrong-value cases.
 *
 * On any failure the middleware writes a 401 JSON response itself with
 * `WWW-Authenticate: Bearer` and `Cache-Control: no-store`, then returns
 * false; the caller must NOT touch the response on a `false` return.
 *
 * On success the caller is responsible for setting `Cache-Control: no-store`
 * on its own response so authenticated admin responses are not cached by
 * intermediaries.
 *
 * The token value is never logged or echoed in error bodies. Failure responses
 * deliberately omit a reason string — unlike JWT auth, the admin token has no
 * useful diagnostic shape to surface.
 *
 * @param {{ token: string, now?: () => number }} opts
 *   `now` is accepted for API symmetry with sibling auth middlewares but is
 *   unused — admin-token compare has no time-dependent behavior.
 * @returns {(req: IncomingMessage, res: ServerResponse) => boolean}
 */
export function createAdminAuth(opts) {
  if (!opts || typeof opts.token !== 'string' || opts.token.length === 0) {
    throw new Error('createAdminAuth: token is required')
  }
  const canonical = Buffer.from(opts.token, 'utf8')
  const dummy = Buffer.alloc(canonical.length, 0)
  return function authorize(req, res) {
    const header = req.headers['authorization']
    if (typeof header !== 'string') {
      writeUnauthorized(res)
      return false
    }
    if (!/^bearer\s+/i.test(header)) {
      writeUnauthorized(res)
      return false
    }
    const presented = header.replace(/^bearer\s+/i, '').trim()
    if (presented.length === 0) {
      writeUnauthorized(res)
      return false
    }
    const presentedBuf = Buffer.from(presented, 'utf8')
    if (presentedBuf.length !== canonical.length) {
      crypto.timingSafeEqual(dummy, canonical)
      writeUnauthorized(res)
      return false
    }
    if (!crypto.timingSafeEqual(presentedBuf, canonical)) {
      writeUnauthorized(res)
      return false
    }
    return true
  }
}

/**
 * @param {ServerResponse} res
 */
function writeUnauthorized(res) {
  writeJson(res, 401, { error: 'unauthorized' }, {
    'www-authenticate': 'Bearer',
    'cache-control': 'no-store',
  })
}
