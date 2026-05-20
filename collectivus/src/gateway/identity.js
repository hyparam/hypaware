import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * @import { CentralServerConfig } from '../types.js'
 * @import { AcquireSource, PersistedIdentity } from './types.d.ts'
 */

/**
 * Default location for the persisted gateway JWT when
 * `central_server.identity.persisted_path` is not set.
 *
 * Lives under `~/.hyp/collectivus/` so it shares a directory with the default
 * config / sink the walkthrough creates — operators only have to remember one
 * spot to back up or wipe.
 */
export const DEFAULT_PERSISTED_PATH = path.join(os.homedir(), '.hyp', 'collectivus', 'identity.json')

/**
 * Refresh the JWT eagerly when its remaining lifetime falls inside this window.
 *
 * The bead spec calls out 24h explicitly: "If valid + not within 24h of expiry,
 * use it. If within 24h of expiry, refresh." A larger window would refresh
 * unnecessarily; a smaller window risks the gateway running with a token that
 * expires mid-flight if the central server is briefly unreachable when refresh
 * is finally needed.
 */
export const REFRESH_WINDOW_SECONDS = 24 * 60 * 60

/**
 * IdentityClient holds the gateway's control-plane JWT in memory and manages
 * its full lifecycle: initial bootstrap, persistence, periodic refresh, and
 * lazy refresh when callers request the current token close to expiry.
 *
 * Construction is cheap and side-effect-free. Call `acquire()` exactly once at
 * gateway startup — it picks `bootstrap` vs `loadPersisted` based on whether
 * the persisted file already exists. Future epics (B config vending, C log
 * shipping) hold a reference to the client and call `getCurrentJwt()` for
 * every authenticated request.
 */
export class IdentityClient {
  /**
   * @param {CentralServerConfig} config
   * @param {{
   *   now?: () => number,
   *   fetchFn?: typeof fetch,
   *   persistedPath?: string,
   * }} [opts] Test hooks. `now` injects a fake clock into the expiry math.
   *   `fetchFn` substitutes a mock for the real `fetch`. `persistedPath`
   *   wins over `config.identity.persisted_path` so tests don't have to
   *   build a config just to override the file location.
   */
  constructor(config, opts = {}) {
    if (!config || typeof config.url !== 'string' || config.url.length === 0) {
      throw new Error('IdentityClient: central_server.url is required')
    }
    /** @type {CentralServerConfig} */
    this.config = config
    /** @type {() => number} */
    this.now = opts.now ?? Date.now
    /** @type {typeof fetch} */
    this.fetchFn = opts.fetchFn ?? fetch
    /** @type {string} */
    this.persistedPath = opts.persistedPath ?? config.identity.persisted_path ?? DEFAULT_PERSISTED_PATH
    /** @type {PersistedIdentity | undefined} */
    this.identity = undefined
    /**
     * Pending refresh promise. We serialize concurrent refresh calls so a
     * burst of `getCurrentJwt()` calls right at the expiry edge causes one
     * network call, not N. Not used during initial `bootstrap`/`loadPersisted`
     * — those run sequentially during boot.
     *
     * @type {Promise<void> | undefined}
     */
    this.refreshing = undefined
  }

  /**
   * Run the gateway-startup identity flow. Picks the right path based on
   * whether a persisted file already exists:
   *
   *  - persisted file present + token healthy   -> `loaded`
   *  - persisted file present + within refresh window -> `refreshed`
   *  - no persisted file                        -> `bootstrapped`
   *
   * Throws on any failure (network, server rejection, malformed persisted
   * file). The CLI catches and exits 1 with a clear error.
   *
   * @returns {Promise<AcquireSource>}
   */
  async acquire() {
    const persisted = readPersistedFile(this.persistedPath)
    if (persisted) {
      this.identity = persisted
      const remainingSec = persisted.expires_at - Math.floor(this.now() / 1000)
      if (remainingSec <= REFRESH_WINDOW_SECONDS) {
        await this.refresh()
        return 'refreshed'
      }
      return 'loaded'
    }
    await this.bootstrap()
    return 'bootstrapped'
  }

  /**
   * Exchange the configured bootstrap token for a long-lived JWT and persist
   * the result. Throws an error whose message starts with the documented
   * `identity bootstrap failed: ...` or `failed to reach central server ...`
   * prefix so the CLI can write the exact stderr line in the bead spec.
   *
   * @returns {Promise<void>}
   */
  async bootstrap() {
    const token = this.config.identity.bootstrap_token
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('identity bootstrap failed: central_server.identity.bootstrap_token is not set')
    }
    const url = joinUrl(this.config.url, '/v1/identity/bootstrap')
    const body = JSON.stringify({ bootstrap_token: token })

    let response
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`failed to reach central server ${this.config.url}: ${msg}`)
    }

    if (!response.ok) {
      const detail = await readErrorDetail(response)
      throw new Error(`identity bootstrap failed: ${detail}`)
    }

    const parsed = await readJsonResponse(response, 'bootstrap')
    const identity = identityFromPayload(parsed)
    this.identity = identity
    writePersistedFile(this.persistedPath, identity)
  }

  /**
   * Read the persisted JWT into memory without touching the network. Returns
   * the loaded record so callers can inspect it before deciding to refresh.
   *
   * Throws if the file exists but is unreadable or malformed — that's a real
   * problem, not a "missing identity" condition. Missing file returns
   * `undefined`.
   *
   * @returns {PersistedIdentity | undefined}
   */
  loadPersisted() {
    const persisted = readPersistedFile(this.persistedPath)
    if (persisted) this.identity = persisted
    return persisted
  }

  /**
   * Use the current JWT to obtain a fresh one and persist it. Concurrent
   * callers share the same in-flight request — only one network call is made.
   *
   * @returns {Promise<void>}
   */
  async refresh() {
    if (this.refreshing) {
      await this.refreshing
      return
    }
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = undefined
    })
    await this.refreshing
  }

  /**
   * @returns {Promise<void>}
   */
  async doRefresh() {
    if (!this.identity) {
      throw new Error('identity refresh failed: no current JWT to refresh')
    }
    const url = joinUrl(this.config.url, '/v1/identity/refresh')
    let response
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.identity.jwt}` },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`failed to reach central server ${this.config.url}: ${msg}`)
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response)
      throw new Error(`identity refresh failed: ${detail}`)
    }
    const parsed = await readJsonResponse(response, 'refresh')
    const identity = identityFromPayload(parsed, this.identity.gateway_id)
    this.identity = identity
    writePersistedFile(this.persistedPath, identity)
  }

  /**
   * Return the current JWT, refreshing in-place if it's within the refresh
   * window. Future epics call this for every authenticated request, so the
   * common path (token healthy) MUST be a single in-memory check.
   *
   * @returns {Promise<string>}
   */
  async getCurrentJwt() {
    if (!this.identity) {
      throw new Error('identity not acquired — call acquire() first')
    }
    const remainingSec = this.identity.expires_at - Math.floor(this.now() / 1000)
    if (remainingSec <= REFRESH_WINDOW_SECONDS) {
      await this.refresh()
    }
    if (!this.identity) {
      // refresh() throws on failure, so this branch is only hit if a future
      // edit accidentally clears `this.identity`. Surface as an explicit
      // error rather than returning `undefined` and confusing callers.
      throw new Error('identity refresh did not produce a JWT')
    }
    return this.identity.jwt
  }
}

/**
 * Read and parse the persisted-identity file. Missing file -> `undefined`.
 * Any other error (permissions, malformed JSON, missing fields) throws so the
 * caller doesn't silently fall through to `bootstrap()` and burn the token.
 *
 * @param {string} filePath
 * @returns {PersistedIdentity | undefined}
 */
function readPersistedFile(filePath) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    if (code === 'ENOENT') return undefined
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to read persisted identity ${filePath}: ${msg}`)
  }
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to parse persisted identity ${filePath}: ${msg}`)
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`persisted identity ${filePath} must be an object`)
  }
  const { jwt, expires_at, gateway_id } = parsed
  if (typeof jwt !== 'string' || jwt.length === 0) {
    throw new Error(`persisted identity ${filePath}: missing or invalid jwt`)
  }
  if (typeof expires_at !== 'number' || !Number.isInteger(expires_at)) {
    throw new Error(`persisted identity ${filePath}: missing or invalid expires_at`)
  }
  if (typeof gateway_id !== 'string' || gateway_id.length === 0) {
    throw new Error(`persisted identity ${filePath}: missing or invalid gateway_id`)
  }
  return { jwt, expires_at, gateway_id }
}

/**
 * Persist the identity record atomically: tmp+rename so a crash mid-write can
 * never leave a half-finished file in place. Mode 0600 because the JWT is the
 * gateway's only credential against the central server.
 *
 * @param {string} filePath
 * @param {PersistedIdentity} identity
 * @returns {void}
 */
function writePersistedFile(filePath, identity) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  const json = JSON.stringify(identity, null, 2)
  fs.writeFileSync(tmp, json, { mode: 0o600 })
  fs.renameSync(tmp, filePath)
  // `writeFileSync` only sets mode at create time — if the file already
  // existed we tightened the permissions via the rename of a fresh tmp file,
  // but be explicit so a previously over-permissive file is corrected.
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // fs.renameSync already replaced the file; chmod is best-effort here.
  }
}

/**
 * Pull `{ jwt, expires_at, gateway_id }` out of a server response. The
 * bootstrap response only carries `{ jwt, expires_at }` — the gateway_id is
 * recovered by decoding the JWT's `sub` claim. We don't verify the signature
 * here because the gateway doesn't have the issuer secret; we trust the TLS
 * connection for authenticity.
 *
 * @param {unknown} parsed
 * @param {string} [fallbackGatewayId] When provided (e.g. on refresh) and the
 *   payload lacks a JWT we can decode, use this as the gateway_id.
 * @returns {PersistedIdentity}
 */
function identityFromPayload(parsed, fallbackGatewayId) {
  if (!isPlainObject(parsed)) {
    throw new Error('central server response is not an object')
  }
  const { jwt, expires_at } = parsed
  if (typeof jwt !== 'string' || jwt.length === 0) {
    throw new Error('central server response missing jwt')
  }
  if (typeof expires_at !== 'number' || !Number.isInteger(expires_at)) {
    throw new Error('central server response missing expires_at')
  }
  const decoded = decodeJwtSub(jwt) ?? fallbackGatewayId
  if (typeof decoded !== 'string' || decoded.length === 0) {
    throw new Error('central server response missing gateway identity (sub claim)')
  }
  return { jwt, expires_at, gateway_id: decoded }
}

/**
 * Decode the `sub` claim from a JWT without verifying the signature. The
 * gateway has no way to verify (it doesn't share the issuer secret) but it
 * trusts the TLS connection — we just need the identity for logging and
 * persistence.
 *
 * @param {string} jwt
 * @returns {string | undefined}
 */
function decodeJwtSub(jwt) {
  const parts = jwt.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'))
    if (isPlainObject(payload) && typeof payload.sub === 'string' && payload.sub.length > 0) {
      return payload.sub
    }
  } catch {
    return undefined
  }
  return undefined
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
 * Join a base URL and path, allowing the base URL to optionally include a
 * trailing slash. Uses the WHATWG URL parser so query strings or an embedded
 * port survive intact.
 *
 * @param {string} base
 * @param {string} suffix
 * @returns {string}
 */
function joinUrl(base, suffix) {
  // Ensure the base contributes a path of `/` so URL resolution doesn't
  // strip the last segment of an explicit base path.
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`
  return new URL(suffix.replace(/^\//, ''), baseWithSlash).toString()
}

/**
 * @param {Response} response
 * @param {'bootstrap' | 'refresh'} kind
 * @returns {Promise<unknown>}
 */
async function readJsonResponse(response, kind) {
  let parsed
  try {
    parsed = await response.json()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`identity ${kind} failed: invalid JSON in server response: ${msg}`)
  }
  return parsed
}

/**
 * Pull a useful one-liner out of a non-2xx control-plane response. Falls back
 * to "<status> <statusText>" when the server returned no parseable body.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readErrorDetail(response) {
  let body
  try {
    body = await response.text()
  } catch {
    body = ''
  }
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body)
      if (isPlainObject(parsed)) {
        const error = typeof parsed.error === 'string' ? parsed.error : undefined
        const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined
        if (error && reason) return `${response.status} ${error} (${reason})`
        if (error) return `${response.status} ${error}`
      }
    } catch {
      // Plain-text or non-JSON error body — fall through.
    }
    return `${response.status} ${body.trim().slice(0, 200)}`
  }
  return `${response.status} ${response.statusText || ''}`.trim()
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
