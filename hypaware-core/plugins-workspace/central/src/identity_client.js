// @ts-check

import fs from 'node:fs'
import path from 'node:path'

/** @typedef {import('./types.d.ts').PersistedIdentity} PersistedIdentity */
/** @typedef {import('./types.d.ts').IdentityResponse} IdentityResponse */
/** @typedef {'loaded' | 'refreshed' | 'bootstrapped'} AcquireSource */

/**
 * Eagerly refresh when the remaining lifetime falls inside this window
 * (24h). Matches the donor `collectivus/src/gateway/identity.js`
 * contract — see proto.md "Refresh window".
 */
export const REFRESH_WINDOW_SECONDS = 24 * 60 * 60

/**
 * Holds the gateway's long-lived JWT in memory and manages its full
 * lifecycle: bootstrap → persist → refresh-on-window → refresh-on-401.
 *
 * Construction is side-effect free. Call `acquire()` once at sink
 * creation; subsequent `getCurrentJwt()` calls return the cached JWT
 * and lazily refresh when it falls inside the 24h window.
 */
export class IdentityClient {
  /**
   * @param {{
   *   centralUrl: string,
   *   bootstrapToken?: string,
   *   persistedPath: string,
   *   fetchFn?: typeof fetch,
   *   now?: () => number,
   * }} opts
   */
  constructor(opts) {
    if (!opts || typeof opts.centralUrl !== 'string' || opts.centralUrl.length === 0) {
      throw new Error('IdentityClient: centralUrl is required')
    }
    if (typeof opts.persistedPath !== 'string' || opts.persistedPath.length === 0) {
      throw new Error('IdentityClient: persistedPath is required')
    }
    /** @type {string} */
    this.centralUrl = opts.centralUrl
    /** @type {string | undefined} */
    this.bootstrapToken = opts.bootstrapToken
    /** @type {string} */
    this.persistedPath = opts.persistedPath
    /** @type {typeof fetch} */
    this.fetchFn = opts.fetchFn ?? fetch
    /** @type {() => number} */
    this.now = opts.now ?? Date.now
    /** @type {PersistedIdentity | undefined} */
    this.identity = undefined
    /** @type {Promise<void> | undefined} */
    this.refreshing = undefined
  }

  /**
   * Bootstrap if no persisted file is present; otherwise reload (and
   * refresh if the JWT is inside the 24h window). Throws on any
   * failure with a `identity bootstrap failed: ...` or `identity refresh
   * failed: ...` prefix the caller can surface verbatim.
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
   * Exchange the configured bootstrap token for a long-lived JWT and
   * persist it. Required on first run; the operator issues bootstrap
   * tokens out-of-band.
   *
   * @returns {Promise<void>}
   */
  async bootstrap() {
    const token = this.bootstrapToken
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('identity bootstrap failed: identity.bootstrap_token is not set')
    }
    const url = joinUrl(this.centralUrl, '/v1/identity/bootstrap')
    const body = JSON.stringify({ bootstrap_token: token })

    let response
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
    } catch (err) {
      throw new Error(`failed to reach central server ${this.centralUrl}: ${formatError(err)}`)
    }

    if (!response.ok) {
      throw new Error(`identity bootstrap failed: ${await readErrorDetail(response)}`)
    }

    const parsed = await readJsonResponse(response, 'bootstrap')
    const identity = identityFromPayload(parsed)
    this.identity = identity
    writePersistedFile(this.persistedPath, identity)
  }

  /**
   * Refresh the JWT. Concurrent callers share the in-flight request so
   * a burst of `getCurrentJwt()` calls right at the expiry edge causes
   * one network call, not N.
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

  /** @returns {Promise<void>} */
  async doRefresh() {
    if (!this.identity) {
      throw new Error('identity refresh failed: no current JWT to refresh')
    }
    const url = joinUrl(this.centralUrl, '/v1/identity/refresh')
    let response
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.identity.jwt}` },
      })
    } catch (err) {
      throw new Error(`failed to reach central server ${this.centralUrl}: ${formatError(err)}`)
    }
    if (!response.ok) {
      throw new Error(`identity refresh failed: ${await readErrorDetail(response)}`)
    }
    const parsed = await readJsonResponse(response, 'refresh')
    const identity = identityFromPayload(parsed, this.identity.gateway_id)
    this.identity = identity
    writePersistedFile(this.persistedPath, identity)
  }

  /**
   * Return the current JWT, lazily refreshing if it sits inside the
   * refresh window. Hot path is a single in-memory check.
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
      throw new Error('identity refresh did not produce a JWT')
    }
    return this.identity.jwt
  }
}

/**
 * @param {string} filePath
 * @returns {PersistedIdentity | undefined}
 */
function readPersistedFile(filePath) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return undefined
    }
    throw new Error(`failed to read persisted identity ${filePath}: ${formatError(err)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`failed to parse persisted identity ${filePath}: ${formatError(err)}`)
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`persisted identity ${filePath} must be an object`)
  }
  const { jwt, expires_at, gateway_id } = /** @type {Record<string, unknown>} */ (parsed)
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
 * Atomic tmp+rename write at mode 0600. The JWT is the gateway's only
 * credential against the central server, so a crash mid-write must
 * never leave a half-finished file in place.
 *
 * @param {string} filePath
 * @param {PersistedIdentity} identity
 */
function writePersistedFile(filePath, identity) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // best effort — rename already replaced the file
  }
}

/**
 * @param {unknown} parsed
 * @param {string} [fallbackGatewayId]
 * @returns {PersistedIdentity}
 */
function identityFromPayload(parsed, fallbackGatewayId) {
  if (!isPlainObject(parsed)) {
    throw new Error('central server response is not an object')
  }
  const { jwt, expires_at } = /** @type {Record<string, unknown>} */ (parsed)
  if (typeof jwt !== 'string' || jwt.length === 0) {
    throw new Error('central server response missing jwt')
  }
  if (typeof expires_at !== 'number' || !Number.isInteger(expires_at)) {
    throw new Error('central server response missing expires_at')
  }
  const gateway_id = decodeJwtSub(jwt) ?? fallbackGatewayId
  if (typeof gateway_id !== 'string' || gateway_id.length === 0) {
    throw new Error('central server response missing gateway identity (sub claim)')
  }
  return { jwt, expires_at, gateway_id }
}

/**
 * Decode the `sub` claim from a JWT without verifying the signature.
 * The gateway trusts the TLS connection for authenticity — it has no
 * way to verify the JWT (it doesn't share the issuer secret).
 *
 * @param {string} jwt
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
 * @param {string} base
 * @param {string} suffix
 */
function joinUrl(base, suffix) {
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`
  return new URL(suffix.replace(/^\//, ''), baseWithSlash).toString()
}

/**
 * @param {Response} response
 * @param {'bootstrap' | 'refresh'} kind
 */
async function readJsonResponse(response, kind) {
  try {
    return await response.json()
  } catch (err) {
    throw new Error(`identity ${kind} failed: invalid JSON in server response: ${formatError(err)}`)
  }
}

/**
 * @param {Response} response
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
        if (error) return `${response.status} ${error}`
      }
    } catch {
      // plain text body — fall through
    }
    return `${response.status} ${body.trim().slice(0, 200)}`
  }
  return `${response.status} ${response.statusText || ''}`.trim()
}

/** @param {unknown} v */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** @param {unknown} err */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
