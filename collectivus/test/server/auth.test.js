import { describe, expect, it } from 'vitest'
import { createBearerAuth, getClaims } from '../../src/server/auth.js'
import { signJwt } from '../../src/server/identity.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 */

const SECRET = 'a'.repeat(32)

/**
 * Minimal mock of `IncomingMessage` carrying just the bits the middleware
 * touches. We avoid spinning up a real http.Server so each assertion stays
 * synchronous and free of network-port flakiness.
 *
 * @param {Record<string, string>} [headers]
 * @returns {IncomingMessage}
 */
function makeReq(headers = {}) {
  /** @type {Record<string, string>} */
  const lower = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return /** @type {IncomingMessage} */ (/** @type {unknown} */ ({ headers: lower }))
}

/** @returns {{ res: ServerResponse, status: () => number, body: () => any }} */
function makeRes() {
  let status = 0
  let body = ''
  /** @type {any} */
  const res = {
    /**
     * @param {number} s
     * @returns {any}
     */
    writeHead(s) {
      status = s
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
  }
}

/**
 * @param {number} initialMs
 * @returns {{ now: () => number, advance: (ms: number) => void }}
 */
function fakeClock(initialMs) {
  let t = initialMs
  return {
    now: () => t,
    advance: (ms) => { t += ms },
  }
}

describe('createBearerAuth', () => {
  it('throws at construction if the secret is missing', () => {
    expect(() => createBearerAuth(/** @type {any} */ ({}))).toThrow()
    expect(() => createBearerAuth({ secret: '' })).toThrow()
  })

  it('rejects requests without an Authorization header', () => {
    const authorize = createBearerAuth({ secret: SECRET })
    const { res, status, body } = makeRes()
    const req = makeReq()
    expect(authorize(req, res)).toBe(false)
    expect(status()).toBe(401)
    expect(body()).toEqual({ error: 'unauthorized', reason: 'missing Authorization header' })
  })

  it('rejects non-Bearer Authorization schemes', () => {
    const authorize = createBearerAuth({ secret: SECRET })
    const { res, status } = makeRes()
    expect(authorize(makeReq({ Authorization: 'Basic abc' }), res)).toBe(false)
    expect(status()).toBe(401)
  })

  it('rejects empty Bearer tokens (whitespace only)', () => {
    const authorize = createBearerAuth({ secret: SECRET })
    const { res, status } = makeRes()
    expect(authorize(makeReq({ Authorization: 'Bearer    ' }), res)).toBe(false)
    expect(status()).toBe(401)
  })

  it('rejects malformed JWTs', () => {
    const authorize = createBearerAuth({ secret: SECRET })
    const { res, status, body } = makeRes()
    expect(authorize(makeReq({ Authorization: 'Bearer not-a-jwt' }), res)).toBe(false)
    expect(status()).toBe(401)
    expect(body()).toMatchObject({ error: 'unauthorized' })
  })

  it('accepts a valid JWT and exposes claims via getClaims', () => {
    const clock = fakeClock(1_700_000_000_000)
    const jwt = signJwt({ gatewayId: 'gw-x', ttlSeconds: 60, secret: SECRET, now: clock.now })
    const authorize = createBearerAuth({ secret: SECRET }, { now: clock.now })
    const { res, status } = makeRes()
    const req = makeReq({ Authorization: `Bearer ${jwt}` })
    expect(authorize(req, res)).toBe(true)
    expect(status()).toBe(0) // middleware did not write a response
    const claims = getClaims(req)
    expect(claims).toBeDefined()
    expect(claims?.sub).toBe('gw-x')
  })

  it('rejects a JWT signed with a different secret', () => {
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: 'b'.repeat(32) })
    const authorize = createBearerAuth({ secret: SECRET })
    const { res, status, body } = makeRes()
    expect(authorize(makeReq({ Authorization: `Bearer ${jwt}` }), res)).toBe(false)
    expect(status()).toBe(401)
    expect(body()).toMatchObject({ reason: 'invalid token signature' })
  })

  it('rejects an expired JWT', () => {
    const clock = fakeClock(1_700_000_000_000)
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: SECRET, now: clock.now })
    clock.advance(61_000)
    const authorize = createBearerAuth({ secret: SECRET }, { now: clock.now })
    const { res, status, body } = makeRes()
    expect(authorize(makeReq({ Authorization: `Bearer ${jwt}` }), res)).toBe(false)
    expect(status()).toBe(401)
    expect(body()).toMatchObject({ reason: 'token expired' })
  })

  it('handles case-insensitive Bearer scheme', () => {
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: SECRET })
    const authorize = createBearerAuth({ secret: SECRET })
    const { res } = makeRes()
    expect(authorize(makeReq({ Authorization: `bEARER ${jwt}` }), res)).toBe(true)
  })

  it('does not attach claims when verification fails', () => {
    const authorize = createBearerAuth({ secret: SECRET })
    const { res } = makeRes()
    const req = makeReq({ Authorization: 'Bearer not-a-jwt' })
    authorize(req, res)
    expect(getClaims(req)).toBeUndefined()
  })

  it('getClaims returns undefined for a request that never ran through the middleware', () => {
    const req = makeReq()
    expect(getClaims(req)).toBeUndefined()
  })
})
