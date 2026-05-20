import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * @import {
 *   IdentityIssuerConfig,
 * } from '../types.js'
 * @import {
 *   BootstrapTokenInspection,
 *   BootstrapRecord,
 *   IssueFromBootstrapResult,
 *   JwtClaims,
 *   JwtVerifyResult,
 * } from './types.d.ts'
 */

/**
 * Default JWT TTL when `identity_issuer.jwt_ttl_seconds` is not set. 30 days
 * matches the bead spec ("returns a 30-day JWT") and aligns with how operators
 * are expected to refresh: rarely, before expiry.
 */
export const DEFAULT_JWT_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * Default TTL applied when registering a bootstrap token without explicit
 * `expiresAt`. 7 days is enough to install a gateway by hand without leaving
 * very long-lived single-use tokens lying around.
 */
export const DEFAULT_BOOTSTRAP_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * Allowed clock skew when verifying `iat`. RFC 7519 doesn't define this — we
 * pick 5s to absorb clock drift between server and operator-CLI hosts without
 * letting a tampered `iat` slide far into the future.
 */
const IAT_SKEW_TOLERANCE_SECONDS = 5

const JWT_HEADER_B64 = base64UrlEncode(Buffer.from('{"alg":"HS256","typ":"JWT"}', 'utf8'))

/**
 * Sign a control-plane JWT with HS256.
 *
 * The signing path is intentionally vanilla: a fixed header (cached above),
 * `{ sub, iat, exp }` claims, and an HMAC-SHA256 over `header.payload`. We
 * don't accept arbitrary header overrides — every JWT this server issues is
 * shaped identically, which keeps `verifyJwt` simple and rejects any token
 * shaped differently as a tamper signal.
 *
 * @param {{ gatewayId: string, ttlSeconds: number, secret: string, now?: () => number }} args
 * @returns {string} A compact-serialized JWT.
 */
export function signJwt(args) {
  const { gatewayId, ttlSeconds, secret } = args
  if (typeof gatewayId !== 'string' || gatewayId.length === 0) {
    throw new Error('signJwt: gatewayId is required')
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('signJwt: ttlSeconds must be a positive integer')
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('signJwt: secret is required')
  }
  const nowSec = Math.floor((args.now ? args.now() : Date.now()) / 1000)
  /** @type {JwtClaims} */
  const claims = { sub: gatewayId, iat: nowSec, exp: nowSec + ttlSeconds }
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(claims), 'utf8'))
  const signingInput = `${JWT_HEADER_B64}.${payloadB64}`
  const sigB64 = base64UrlEncode(crypto.createHmac('sha256', secret).update(signingInput).digest())
  return `${signingInput}.${sigB64}`
}

/**
 * Verify a control-plane JWT.
 *
 * Returns a discriminated `{ valid, claims?, error? }` rather than throwing —
 * the auth middleware always wants to convert the result into a 401 response,
 * never a 500. Failures bucket into a small set of stable error tokens so
 * callers can log/branch without parsing prose.
 *
 * @param {string} token
 * @param {string} secret
 * @param {{ now?: () => number }} [opts]
 * @returns {JwtVerifyResult}
 */
export function verifyJwt(token, secret, opts = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    return { valid: false, error: 'malformed' }
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('verifyJwt: secret is required')
  }
  const parts = token.split('.')
  if (parts.length !== 3) {
    return { valid: false, error: 'malformed' }
  }
  const [headerB64, payloadB64, sigB64] = parts
  const expectedSig = base64UrlEncode(
    crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest()
  )
  if (!constantTimeEqualB64(expectedSig, sigB64)) {
    return { valid: false, error: 'bad_signature' }
  }
  /** @type {unknown} */
  let header
  /** @type {unknown} */
  let claims
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'))
    claims = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'))
  } catch {
    return { valid: false, error: 'malformed' }
  }
  if (!isPlainObject(header) || header.alg !== 'HS256' || header.typ !== 'JWT') {
    return { valid: false, error: 'malformed' }
  }
  if (!isPlainObject(claims)) {
    return { valid: false, error: 'malformed' }
  }
  const { sub, iat, exp } = claims
  if (typeof sub !== 'string' || sub.length === 0) {
    return { valid: false, error: 'malformed' }
  }
  if (typeof iat !== 'number' || !Number.isInteger(iat)) {
    return { valid: false, error: 'malformed' }
  }
  if (typeof exp !== 'number' || !Number.isInteger(exp)) {
    return { valid: false, error: 'malformed' }
  }
  const nowSec = Math.floor((opts.now ? opts.now() : Date.now()) / 1000)
  if (iat > nowSec + IAT_SKEW_TOLERANCE_SECONDS) {
    return { valid: false, error: 'iat_in_future' }
  }
  if (exp <= nowSec) {
    return { valid: false, error: 'expired' }
  }
  return { valid: true, claims: { sub, iat, exp } }
}

/**
 * File-backed store of bootstrap tokens.
 *
 * Tokens are recorded by their sha256 hash so a leaked store file does not
 * give an attacker tokens they could replay against `/v1/identity/bootstrap`.
 * The store is small (a handful of pending tokens at any time) so the whole
 * file is rewritten on every mutation — no append log, no compaction.
 *
 * Concurrency: writes use `fs.writeFileSync` to a tmp sibling then `rename`,
 * which is atomic on POSIX. There is no inter-process locking; the operator
 * CLI (Epic B) and the running server are expected to share this file via
 * cooperative use, not under contention. If both try to mutate at once the
 * last writer wins — acceptable because token registration is rare.
 */
export class BootstrapStore {
  /**
   * @param {{ path: string, now?: () => number }} opts
   */
  constructor(opts) {
    if (typeof opts?.path !== 'string' || opts.path.length === 0) {
      throw new Error('BootstrapStore: path is required')
    }
    /** @type {string} */
    this.path = opts.path
    /** @type {() => number} */
    this.now = opts.now ?? Date.now
    /** @type {Map<string, BootstrapRecord>} */
    this.records = new Map()
    this.load()
  }

  /**
   * Load records from disk. Missing file is treated as an empty store.
   *
   * @returns {void}
   */
  load() {
    let raw
    try {
      raw = fs.readFileSync(this.path, 'utf8')
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
      if (code === 'ENOENT') {
        this.records = new Map()
        return
      }
      throw err
    }
    /** @type {unknown} */
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`BootstrapStore: invalid JSON in ${this.path}: ${msg}`)
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`BootstrapStore: expected array in ${this.path}`)
    }
    /** @type {Map<string, BootstrapRecord>} */
    const records = new Map()
    for (const entry of parsed) {
      if (!isPlainObject(entry)) continue
      const { tokenHash, gatewayId, expiresAt, used } = entry
      if (typeof tokenHash !== 'string' || tokenHash.length === 0) continue
      if (typeof gatewayId !== 'string' || gatewayId.length === 0) continue
      if (typeof expiresAt !== 'number' || !Number.isInteger(expiresAt)) continue
      if (typeof used !== 'boolean') continue
      records.set(tokenHash, { tokenHash, gatewayId, expiresAt, used })
    }
    this.records = records
  }

  /**
   * Persist the in-memory map to disk via tmp+rename for atomic replacement.
   *
   * @returns {void}
   */
  flush() {
    const dir = path.dirname(this.path)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}`
    const rows = Array.from(this.records.values())
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.path)
  }

  /**
   * Register a new bootstrap token. Stores its sha256 hash and metadata.
   * The plaintext token is returned to the caller (operator CLI) and never
   * persisted — once it leaves this method, the only copy lives wherever the
   * operator hands it off to the gateway.
   *
   * @param {{ gatewayId: string, ttlSeconds?: number, token?: string }} args
   * @returns {{ token: string, expiresAt: number }}
   */
  register(args) {
    this.load()
    const { gatewayId } = args
    if (typeof gatewayId !== 'string' || gatewayId.length === 0) {
      throw new Error('BootstrapStore.register: gatewayId is required')
    }
    const ttl = args.ttlSeconds ?? DEFAULT_BOOTSTRAP_TTL_SECONDS
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new Error('BootstrapStore.register: ttlSeconds must be a positive integer')
    }
    const token = args.token ?? crypto.randomBytes(32).toString('hex')
    if (typeof token !== 'string' || token.length < 32) {
      throw new Error('BootstrapStore.register: token must be ≥32 chars')
    }
    const tokenHash = sha256Hex(token)
    const nowSec = Math.floor(this.now() / 1000)
    const expiresAt = nowSec + ttl
    this.records.set(tokenHash, { tokenHash, gatewayId, expiresAt, used: false })
    this.flush()
    return { token, expiresAt }
  }

  /**
   * Atomically consume a bootstrap token. On success: marks the record `used`,
   * persists, and returns `{ ok: true, gatewayId }`. On failure: returns
   * `{ ok: false, reason }` and leaves disk unchanged.
   *
   * Reasons:
   *   - `unknown_token`  — no matching hash
   *   - `already_used`   — record exists but `used` is true
   *   - `expired`        — record exists but `expiresAt` is in the past
   *
   * @param {string} token
   * @returns {{ ok: true, gatewayId: string } | { ok: false, reason: 'unknown_token' | 'already_used' | 'expired' }}
   */
  tryConsume(token) {
    this.load()
    const lookedUp = this.lookup(token)
    if (lookedUp.ok === false) return lookedUp
    const { tokenHash, record } = lookedUp
    const updated = { ...record, used: true }
    this.records.set(tokenHash, updated)
    this.flush()
    return { ok: true, gatewayId: record.gatewayId }
  }

  /**
   * Inspect a bootstrap token without consuming it. This is used by the
   * setup-config endpoint: fetching the config URL must not burn the one-shot
   * token before the gateway can exchange it at `/v1/identity/bootstrap`.
   *
   * @param {string} token
   * @returns {BootstrapTokenInspection}
   */
  inspect(token) {
    this.load()
    const lookedUp = this.lookup(token)
    if (lookedUp.ok === false) return lookedUp
    return {
      ok: true,
      gatewayId: lookedUp.record.gatewayId,
      expiresAt: lookedUp.record.expiresAt,
    }
  }

  /**
   * Drop every unused bootstrap token whose `gatewayId` matches `gatewayId`.
   * Returns the count removed. Used tokens are left in place so the audit
   * trail (and the `already_used` reason on replay) survives a revoke. The
   * operator CLI calls this when retiring a stuck enrollment.
   *
   * @param {string} gatewayId
   * @returns {number}
   */
  revokeUnusedForGateway(gatewayId) {
    this.load()
    if (typeof gatewayId !== 'string' || gatewayId.length === 0) {
      throw new Error('BootstrapStore.revokeUnusedForGateway: gatewayId is required')
    }
    /** @type {string[]} */
    const toDelete = []
    for (const [hash, record] of this.records) {
      if (record.gatewayId === gatewayId && !record.used) toDelete.push(hash)
    }
    if (toDelete.length === 0) return 0
    for (const hash of toDelete) this.records.delete(hash)
    this.flush()
    return toDelete.length
  }

  /**
   * Number of records currently held. Test-only.
   *
   * @returns {number}
   */
  size() {
    return this.records.size
  }

  /**
   * Lookup against the currently loaded records map.
   *
   * @param {string} token
   * @returns {{ ok: true, tokenHash: string, record: BootstrapRecord } | { ok: false, reason: 'unknown_token' | 'already_used' | 'expired' }}
   */
  lookup(token) {
    if (typeof token !== 'string' || token.length === 0) {
      return { ok: false, reason: 'unknown_token' }
    }
    const tokenHash = sha256Hex(token)
    const record = this.records.get(tokenHash)
    if (!record) return { ok: false, reason: 'unknown_token' }
    const nowSec = Math.floor(this.now() / 1000)
    if (record.expiresAt <= nowSec) return { ok: false, reason: 'expired' }
    if (record.used) return { ok: false, reason: 'already_used' }
    return { ok: true, tokenHash, record }
  }
}

/**
 * Exchange a bootstrap token for a long-lived gateway JWT. Wraps
 * `BootstrapStore.tryConsume` + `signJwt` so the control-plane handler is
 * just I/O.
 *
 * @param {string} token
 * @param {BootstrapStore} store
 * @param {IdentityIssuerConfig} issuer
 * @param {{ now?: () => number }} [opts]
 * @returns {IssueFromBootstrapResult}
 */
export function issueFromBootstrap(token, store, issuer, opts = {}) {
  const consumed = store.tryConsume(token)
  if (consumed.ok === false) {
    const { reason } = consumed
    return { ok: false, reason }
  }
  const { gatewayId } = consumed
  const ttlSeconds = issuer.jwt_ttl_seconds ?? DEFAULT_JWT_TTL_SECONDS
  const now = opts.now ?? Date.now
  const jwt = signJwt({ gatewayId, ttlSeconds, secret: issuer.secret, now })
  const expiresAt = Math.floor(now() / 1000) + ttlSeconds
  return { ok: true, jwt, expiresAt, gatewayId }
}

/**
 * @param {string} input
 * @returns {string}
 */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}

/**
 * @param {Buffer} buf
 * @returns {string}
 */
function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/**
 * @param {string} s
 * @returns {Buffer}
 */
function base64UrlDecode(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - s.length % 4) % 4)
  return Buffer.from(padded, 'base64')
}

/**
 * Constant-time equality over base64url strings. We compare the underlying
 * bytes so length differences don't short-circuit; we also accept the case
 * where decoded lengths differ and return false without timing variance.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEqualB64(a, b) {
  const aBuf = base64UrlDecode(a)
  const bBuf = base64UrlDecode(b)
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
