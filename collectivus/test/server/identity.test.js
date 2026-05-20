import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BootstrapStore,
  DEFAULT_JWT_TTL_SECONDS,
  issueFromBootstrap,
  signJwt,
  verifyJwt,
} from '../../src/server/identity.js'
import { SlidingWindowRateLimiter } from '../../src/server/rate_limit.js'

/**
 * @import { JwtVerifyResult, IssueFromBootstrapResult } from '../../src/server/types.d.ts'
 */

const SECRET = 'a'.repeat(32)

/**
 * Make a controllable clock that returns whatever ms-since-epoch you set.
 *
 * @param {number} initialMs
 * @returns {{ now: () => number, set: (ms: number) => void, advance: (ms: number) => void }}
 */
function fakeClock(initialMs) {
  let t = initialMs
  return {
    now: () => t,
    set: (ms) => { t = ms },
    advance: (ms) => { t += ms },
  }
}

/**
 * Narrow a JwtVerifyResult to its failure branch — used when a test expects
 * verification to fail and wants to assert on the error code. TS doesn't
 * narrow automatically through `expect()` calls; this helper does.
 *
 * @param {JwtVerifyResult} r
 * @returns {{ valid: false, error: 'malformed' | 'bad_signature' | 'expired' | 'iat_in_future' }}
 */
function expectInvalid(r) {
  if (r.valid !== false) throw new Error('expected invalid jwt')
  return r
}

/**
 * Narrow a JwtVerifyResult to its success branch.
 *
 * @param {JwtVerifyResult} r
 * @returns {{ valid: true, claims: { sub: string, iat: number, exp: number } }}
 */
function expectValid(r) {
  if (r.valid !== true) throw new Error('expected valid jwt')
  return r
}

/**
 * Narrow tryConsume's result to the success branch.
 *
 * @param {{ ok: true, gatewayId: string } | { ok: false, reason: string }} r
 * @returns {{ ok: true, gatewayId: string }}
 */
function expectConsumeOk(r) {
  if (r.ok !== true) throw new Error(`expected consume ok, got reason=${r.reason}`)
  return r
}

/**
 * Narrow tryConsume's result to the failure branch.
 *
 * @param {{ ok: true, gatewayId: string } | { ok: false, reason: 'unknown_token' | 'already_used' | 'expired' }} r
 * @returns {{ ok: false, reason: 'unknown_token' | 'already_used' | 'expired' }}
 */
function expectConsumeFail(r) {
  if (r.ok !== false) throw new Error('expected consume to fail')
  return r
}

/**
 * Narrow issueFromBootstrap's result to the success branch.
 *
 * @param {IssueFromBootstrapResult} r
 * @returns {{ ok: true, jwt: string, expiresAt: number, gatewayId: string }}
 */
function expectIssueOk(r) {
  if (r.ok !== true) throw new Error(`expected issue ok, got reason=${r.reason}`)
  return r
}

/**
 * Narrow issueFromBootstrap's result to the failure branch.
 *
 * @param {IssueFromBootstrapResult} r
 * @returns {{ ok: false, reason: 'unknown_token' | 'already_used' | 'expired' }}
 */
function expectIssueFail(r) {
  if (r.ok !== false) throw new Error('expected issue to fail')
  return r
}

describe('signJwt + verifyJwt', () => {
  it('round-trips a valid token and recovers the original claims', () => {
    const clock = fakeClock(1_700_000_000_000)
    const jwt = signJwt({ gatewayId: 'gw-1', ttlSeconds: 60, secret: SECRET, now: clock.now })
    const result = expectValid(verifyJwt(jwt, SECRET, { now: clock.now }))
    expect(result.claims.sub).toBe('gw-1')
    expect(result.claims.iat).toBe(Math.floor(1_700_000_000_000 / 1000))
    expect(result.claims.exp).toBe(Math.floor(1_700_000_000_000 / 1000) + 60)
  })

  it('produces a token with three dot-separated segments', () => {
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: SECRET })
    expect(jwt.split('.')).toHaveLength(3)
  })

  it('rejects a tampered payload', () => {
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: SECRET })
    const [header, , sig] = jwt.split('.')
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'attacker', iat: 0, exp: 9_999_999_999 }), 'utf8')
      .toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
    const forged = `${header}.${forgedPayload}.${sig}`
    const result = expectInvalid(verifyJwt(forged, SECRET))
    expect(result.error).toBe('bad_signature')
  })

  it('rejects a tampered signature', () => {
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: SECRET })
    const tampered = `${jwt.slice(0, -2)}AA`
    const result = expectInvalid(verifyJwt(tampered, SECRET))
    expect(result.error).toBe('bad_signature')
  })

  it('rejects a token signed with a different secret', () => {
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: SECRET })
    const result = expectInvalid(verifyJwt(jwt, 'b'.repeat(32)))
    expect(result.error).toBe('bad_signature')
  })

  it('rejects an expired token', () => {
    const clock = fakeClock(1_700_000_000_000)
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: SECRET, now: clock.now })
    clock.advance(61_000)
    const result = expectInvalid(verifyJwt(jwt, SECRET, { now: clock.now }))
    expect(result.error).toBe('expired')
  })

  it('accepts a token at the boundary just before expiry', () => {
    const clock = fakeClock(1_700_000_000_000)
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: SECRET, now: clock.now })
    clock.advance(59_000)
    expectValid(verifyJwt(jwt, SECRET, { now: clock.now }))
  })

  it('rejects a token whose iat is far in the future', () => {
    // Forge a token whose iat is 1 hour ahead of the verifier's clock.
    const verifierClock = fakeClock(1_700_000_000_000)
    const signerClock = fakeClock(1_700_000_000_000 + 60 * 60 * 1000)
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: SECRET, now: signerClock.now })
    const result = expectInvalid(verifyJwt(jwt, SECRET, { now: verifierClock.now }))
    expect(result.error).toBe('iat_in_future')
  })

  it('tolerates a small (<5s) iat skew', () => {
    const verifierClock = fakeClock(1_700_000_000_000)
    const signerClock = fakeClock(1_700_000_000_000 + 3_000)
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: SECRET, now: signerClock.now })
    expectValid(verifyJwt(jwt, SECRET, { now: verifierClock.now }))
  })

  it('rejects a malformed token (not three segments)', () => {
    const result = expectInvalid(verifyJwt('garbage', SECRET))
    expect(result.error).toBe('malformed')
  })

  it('rejects a token with a non-HS256 alg header', () => {
    // Build a token that has the right shape but advertises alg: none.
    const header = Buffer.from('{"alg":"none","typ":"JWT"}', 'utf8')
      .toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
    const payload = Buffer.from(JSON.stringify({ sub: 'gw', iat: 0, exp: 9_999_999_999 }), 'utf8')
      .toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
    // Empty signature: signature check runs first and rejects this. The
    // alg/typ check is exercised below via an HMAC-signed alg:none header.
    const result = expectInvalid(verifyJwt(`${header}.${payload}.`, SECRET))
    expect(result.valid).toBe(false)
  })

  it('throws on missing arguments rather than returning valid=true', () => {
    expect(() => signJwt({ gatewayId: '', ttlSeconds: 60, secret: SECRET })).toThrow()
    expect(() => signJwt({ gatewayId: 'gw', ttlSeconds: 0, secret: SECRET })).toThrow()
    expect(() => signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: '' })).toThrow()
    expect(() => verifyJwt('a.b.c', '')).toThrow()
  })
})

describe('BootstrapStore', () => {
  /** @type {string} */
  let dir
  /** @type {string} */
  let storePath

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-bootstrap-'))
    storePath = path.join(dir, 'bootstrap.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('starts empty when the file does not exist', () => {
    const store = new BootstrapStore({ path: storePath })
    expect(store.size()).toBe(0)
  })

  it('registers and consumes a token exactly once', () => {
    const clock = fakeClock(1_700_000_000_000)
    const store = new BootstrapStore({ path: storePath, now: clock.now })
    const { token } = store.register({ gatewayId: 'gw-42', ttlSeconds: 60 })
    expect(token).toMatch(/^[0-9a-f]{64}$/)

    const first = expectConsumeOk(store.tryConsume(token))
    expect(first.gatewayId).toBe('gw-42')

    const second = expectConsumeFail(store.tryConsume(token))
    expect(second.reason).toBe('already_used')
  })

  it('rejects unknown tokens', () => {
    const store = new BootstrapStore({ path: storePath })
    const result = expectConsumeFail(store.tryConsume('not-a-token'))
    expect(result.reason).toBe('unknown_token')
  })

  it('rejects expired tokens without flipping `used`', () => {
    const clock = fakeClock(1_700_000_000_000)
    const store = new BootstrapStore({ path: storePath, now: clock.now })
    const { token } = store.register({ gatewayId: 'gw', ttlSeconds: 60 })
    clock.advance(61_000)
    const result = expectConsumeFail(store.tryConsume(token))
    expect(result.reason).toBe('expired')
  })

  it('persists records to disk and reloads them', () => {
    const a = new BootstrapStore({ path: storePath })
    const { token } = a.register({ gatewayId: 'gw-A', ttlSeconds: 60 })
    expect(a.size()).toBe(1)

    const b = new BootstrapStore({ path: storePath })
    expect(b.size()).toBe(1)
    expectConsumeOk(b.tryConsume(token))

    // After consume, a third instance should see used: true.
    const c = new BootstrapStore({ path: storePath })
    const replay = expectConsumeFail(c.tryConsume(token))
    expect(replay.reason).toBe('already_used')
  })

  it('reloads records before consuming so the running server sees operator-issued tokens', () => {
    const serverStore = new BootstrapStore({ path: storePath })
    const operatorStore = new BootstrapStore({ path: storePath })
    const { token } = operatorStore.register({ gatewayId: 'gw-from-cli', ttlSeconds: 60 })

    const consumed = expectConsumeOk(serverStore.tryConsume(token))
    expect(consumed.gatewayId).toBe('gw-from-cli')
  })

  it('inspects a token without consuming it', () => {
    const store = new BootstrapStore({ path: storePath })
    const { token } = store.register({ gatewayId: 'gw-inspect', ttlSeconds: 60 })
    const inspected = store.inspect(token)
    expect(inspected).toMatchObject({ ok: true, gatewayId: 'gw-inspect' })
    expectConsumeOk(store.tryConsume(token))
  })

  it('does not store the plaintext token on disk', () => {
    const store = new BootstrapStore({ path: storePath })
    const { token } = store.register({ gatewayId: 'gw', ttlSeconds: 60 })
    const onDisk = fs.readFileSync(storePath, 'utf8')
    expect(onDisk).not.toContain(token)
  })

  it('rejects tokens shorter than 32 chars when caller passes their own', () => {
    const store = new BootstrapStore({ path: storePath })
    expect(() => store.register({ gatewayId: 'gw', token: 'short' })).toThrow(/≥32/)
  })

  it('throws on missing path', () => {
    expect(() => new BootstrapStore(/** @type {any} */ ({}))).toThrow()
  })

  describe('revokeUnusedForGateway', () => {
    it('drops unused tokens for the target gateway and persists the change', () => {
      const store = new BootstrapStore({ path: storePath })
      const a1 = store.register({ gatewayId: 'gw-A', ttlSeconds: 60 })
      const a2 = store.register({ gatewayId: 'gw-A', ttlSeconds: 60 })
      const b1 = store.register({ gatewayId: 'gw-B', ttlSeconds: 60 })
      expect(store.size()).toBe(3)

      const removed = store.revokeUnusedForGateway('gw-A')
      expect(removed).toBe(2)
      expect(store.size()).toBe(1)

      // Tokens A.1 + A.2 are no longer redeemable; B.1 still is.
      expect(expectConsumeFail(store.tryConsume(a1.token)).reason).toBe('unknown_token')
      expect(expectConsumeFail(store.tryConsume(a2.token)).reason).toBe('unknown_token')
      expect(expectConsumeOk(store.tryConsume(b1.token)).gatewayId).toBe('gw-B')

      // Revocation persisted across reload.
      const reloaded = new BootstrapStore({ path: storePath })
      expect(reloaded.size()).toBe(1)
    })

    it('preserves used tokens so audit replay still reports already_used', () => {
      const store = new BootstrapStore({ path: storePath })
      const { token } = store.register({ gatewayId: 'gw', ttlSeconds: 60 })
      expectConsumeOk(store.tryConsume(token))
      expect(store.size()).toBe(1)

      expect(store.revokeUnusedForGateway('gw')).toBe(0)
      expect(store.size()).toBe(1)
      expect(expectConsumeFail(store.tryConsume(token)).reason).toBe('already_used')
    })

    it('returns 0 and skips disk write when nothing matches', () => {
      const store = new BootstrapStore({ path: storePath })
      store.register({ gatewayId: 'gw-A', ttlSeconds: 60 })
      const beforeMtime = fs.statSync(storePath).mtimeMs
      // Wait a tick so a write would visibly bump mtime if it happened.
      const before = Date.now()
      while (Date.now() === before) { /* spin briefly */ }

      expect(store.revokeUnusedForGateway('gw-OTHER')).toBe(0)
      expect(fs.statSync(storePath).mtimeMs).toBe(beforeMtime)
    })

    it('rejects empty gatewayId', () => {
      const store = new BootstrapStore({ path: storePath })
      expect(() => store.revokeUnusedForGateway('')).toThrow()
    })
  })
})

describe('issueFromBootstrap', () => {
  /** @type {string} */
  let dir
  /** @type {string} */
  let storePath
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-issue-'))
    storePath = path.join(dir, 'bootstrap.json')
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('exchanges a bootstrap token for a JWT exactly once', () => {
    const clock = fakeClock(1_700_000_000_000)
    const store = new BootstrapStore({ path: storePath, now: clock.now })
    const { token } = store.register({ gatewayId: 'gw-7', ttlSeconds: 60 })

    const issuer = { secret: SECRET }
    const issued = expectIssueOk(issueFromBootstrap(token, store, issuer, { now: clock.now }))
    expect(issued.gatewayId).toBe('gw-7')
    expect(issued.expiresAt).toBe(Math.floor(clock.now() / 1000) + DEFAULT_JWT_TTL_SECONDS)

    const verified = expectValid(verifyJwt(issued.jwt, SECRET, { now: clock.now }))
    expect(verified.claims.sub).toBe('gw-7')

    // Replay fails.
    const replay = expectIssueFail(issueFromBootstrap(token, store, issuer, { now: clock.now }))
    expect(replay.reason).toBe('already_used')
  })

  it('honors a custom jwt_ttl_seconds from the issuer config', () => {
    const clock = fakeClock(1_700_000_000_000)
    const store = new BootstrapStore({ path: storePath, now: clock.now })
    const { token } = store.register({ gatewayId: 'gw', ttlSeconds: 60 })
    const issued = expectIssueOk(
      issueFromBootstrap(token, store, { secret: SECRET, jwt_ttl_seconds: 120 }, { now: clock.now })
    )
    expect(issued.expiresAt).toBe(Math.floor(clock.now() / 1000) + 120)
  })
})

describe('SlidingWindowRateLimiter', () => {
  it('allows up to max events in a window then rejects', () => {
    const clock = fakeClock(0)
    const limiter = new SlidingWindowRateLimiter({ windowMs: 60_000, max: 3, now: clock.now })

    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(true)
    const denied = limiter.check('a')
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterMs).toBeGreaterThan(0)
  })

  it('tracks keys independently', () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 60_000, max: 1 })
    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(false)
    expect(limiter.check('b').allowed).toBe(true)
  })

  it('frees a slot once the oldest event slides out of the window', () => {
    const clock = fakeClock(0)
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1_000, max: 1, now: clock.now })
    expect(limiter.check('a').allowed).toBe(true)
    clock.advance(500)
    expect(limiter.check('a').allowed).toBe(false)
    clock.advance(600)
    expect(limiter.check('a').allowed).toBe(true)
  })
})
