import { describe, expect, it } from 'vitest'
import { createAdminAuth } from '../../src/server/admin_auth.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 */

const TOKEN = 'a'.repeat(32)

/**
 * @param {Record<string, string>} [headers]
 * @returns {IncomingMessage}
 */
function makeReq(headers = {}) {
  /** @type {Record<string, string>} */
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return /** @type {IncomingMessage} */ (/** @type {unknown} */ ({ headers: lower }))
}

/**
 * Minimal `ServerResponse` mock that captures both the status code and the
 * response headers passed to `writeHead`. The real middleware sets the
 * 401 challenge/cache headers via the second arg, so the test mock must
 * preserve them or the regression tests for `WWW-Authenticate` and
 * `Cache-Control` would silently pass.
 *
 * @returns {{
 *   res: ServerResponse,
 *   status: () => number,
 *   body: () => any,
 *   headers: () => Record<string, string>,
 * }}
 */
function makeRes() {
  let status = 0
  let body = ''
  /** @type {Record<string, string>} */
  const headers = {}
  /** @type {any} */
  const res = {
    /**
     * @param {number} s
     * @param {Record<string, string>} [h]
     * @returns {any}
     */
    writeHead(s, h) {
      status = s
      if (h && typeof h === 'object') {
        for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v)
      }
      return res
    },
    /**
     * @param {string} [chunk]
     * @returns {any}
     */
    end(chunk) {
      body = chunk ?? ''
      return res
    },
  }
  return {
    res: /** @type {ServerResponse} */ (res),
    status: () => status,
    body: () => body.length ? JSON.parse(body) : undefined,
    headers: () => headers,
  }
}

describe('createAdminAuth', () => {
  it('throws at construction if token is missing or empty', () => {
    expect(() => createAdminAuth(/** @type {any} */ ({}))).toThrow()
    expect(() => createAdminAuth({ token: '' })).toThrow()
    expect(() => createAdminAuth(/** @type {any} */ (undefined))).toThrow()
  })

  it('rejects with 401 when Authorization header is missing', () => {
    const authorize = createAdminAuth({ token: TOKEN })
    const { res, status, body, headers } = makeRes()
    expect(authorize(makeReq(), res)).toBe(false)
    expect(status()).toBe(401)
    expect(body()).toEqual({ error: 'unauthorized' })
    expect(headers()['www-authenticate']).toBe('Bearer')
    expect(headers()['cache-control']).toBe('no-store')
  })

  it('rejects with 401 when scheme is not Bearer', () => {
    const authorize = createAdminAuth({ token: TOKEN })
    const { res, status, body, headers } = makeRes()
    expect(authorize(makeReq({ Authorization: `Basic ${TOKEN}` }), res)).toBe(false)
    expect(status()).toBe(401)
    expect(body()).toEqual({ error: 'unauthorized' })
    expect(headers()['www-authenticate']).toBe('Bearer')
    expect(headers()['cache-control']).toBe('no-store')
  })

  it('rejects with 401 when bearer token is empty (whitespace only)', () => {
    const authorize = createAdminAuth({ token: TOKEN })
    const { res, status, body, headers } = makeRes()
    expect(authorize(makeReq({ Authorization: 'Bearer    ' }), res)).toBe(false)
    expect(status()).toBe(401)
    expect(body()).toEqual({ error: 'unauthorized' })
    expect(headers()['www-authenticate']).toBe('Bearer')
    expect(headers()['cache-control']).toBe('no-store')
  })

  it('rejects with 401 when token is wrong but has the correct length', () => {
    const authorize = createAdminAuth({ token: TOKEN })
    const wrong = 'b'.repeat(TOKEN.length)
    const { res, status, body, headers } = makeRes()
    expect(authorize(makeReq({ Authorization: `Bearer ${wrong}` }), res)).toBe(false)
    expect(status()).toBe(401)
    expect(body()).toEqual({ error: 'unauthorized' })
    expect(headers()['www-authenticate']).toBe('Bearer')
    expect(headers()['cache-control']).toBe('no-store')
  })

  it('rejects with 401 when token has the wrong length — short (no timing leak)', () => {
    // Regression: an early-return-on-length-mismatch implementation would
    // be detectably faster than the wrong-but-correct-length case. We can't
    // measure timing here, but we can assert the response shape and
    // headers are byte-identical so an attacker has nothing else to probe.
    const authorize = createAdminAuth({ token: TOKEN })
    const { res, status, body, headers } = makeRes()
    expect(authorize(makeReq({ Authorization: 'Bearer short' }), res)).toBe(false)
    expect(status()).toBe(401)
    expect(body()).toEqual({ error: 'unauthorized' })
    expect(headers()['www-authenticate']).toBe('Bearer')
    expect(headers()['cache-control']).toBe('no-store')
  })

  it('rejects with 401 when token has the wrong length — long (no timing leak)', () => {
    const authorize = createAdminAuth({ token: TOKEN })
    const { res, status, body, headers } = makeRes()
    expect(authorize(makeReq({ Authorization: `Bearer ${'a'.repeat(TOKEN.length * 2)}` }), res)).toBe(false)
    expect(status()).toBe(401)
    expect(body()).toEqual({ error: 'unauthorized' })
    expect(headers()['www-authenticate']).toBe('Bearer')
    expect(headers()['cache-control']).toBe('no-store')
  })

  it('accepts a request that presents the configured token', () => {
    const authorize = createAdminAuth({ token: TOKEN })
    const { res, status, headers } = makeRes()
    const req = makeReq({ Authorization: `Bearer ${TOKEN}` })
    expect(authorize(req, res)).toBe(true)
    expect(status()).toBe(0)
    expect(headers()['www-authenticate']).toBeUndefined()
    expect(headers()['cache-control']).toBeUndefined()
  })

  it('handles case-insensitive Bearer scheme', () => {
    const authorize = createAdminAuth({ token: TOKEN })
    const { res } = makeRes()
    expect(authorize(makeReq({ Authorization: `bEaRer ${TOKEN}` }), res)).toBe(true)
  })

  it('does not echo the presented token in the error body', () => {
    const authorize = createAdminAuth({ token: TOKEN })
    const presented = 'leakable-' + 'x'.repeat(TOKEN.length - 'leakable-'.length)
    const { res, body } = makeRes()
    authorize(makeReq({ Authorization: `Bearer ${presented}` }), res)
    const serialized = JSON.stringify(body())
    expect(serialized).not.toContain('leakable-')
    expect(serialized).not.toContain(presented)
  })

  it('accepts a `now` option for API symmetry without altering behavior', () => {
    const authorize = createAdminAuth({ token: TOKEN, now: () => 1_700_000_000_000 })
    const { res } = makeRes()
    expect(authorize(makeReq({ Authorization: `Bearer ${TOKEN}` }), res)).toBe(true)
  })
})
