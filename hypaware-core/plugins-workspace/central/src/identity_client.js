// @ts-check

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * @import { AcquireSource, IdentityResponse, PersistedIdentity } from './types.js'
 */

/**
 * Fingerprint a bootstrap token for the persisted identity's
 * re-enrollment guard. A hash, never the raw token, so the persisted
 * file (and any log of it) cannot leak the credential.
 *
 * @param {string} token
 * @returns {string}
 */
function fingerprintToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Eagerly refresh when the remaining lifetime falls inside this window
 * (24h). Matches the donor `collectivus/src/gateway/identity.js`
 * contract: see proto.md "Refresh window".
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
      // Re-enrollment guard: when a bootstrap token is configured (a
      // fresh `hyp join` wrote one into the seed) and it (or the central
      // URL) differs from what minted the persisted identity, the host is
      // being re-pointed at a different tenant/server. Reusing the old
      // gateway JWT would file the new tenant's data under the old
      // gateway_id, so re-bootstrap with the new token instead. In steady
      // state no bootstrap token is configured (the seed is retired after
      // first apply), so this never fires and the persisted JWT is reused.
      // @ref LLP 0031#physical-layout [implements]: re-join re-bootstraps a fresh gateway identity; clearing config slots alone leaves identity.json shadowing the new token
      if (this.bootstrapToken && mintChanged(persisted, this.centralUrl, this.bootstrapToken)) {
        await this.bootstrap()
        return 'bootstrapped'
      }
      // No bootstrap token to re-mint with, but the persisted identity was
      // minted by a different central URL: the host has been re-pointed at
      // another server without re-joining. Reusing the old gateway JWT would
      // file this server's data under the other server's gateway_id, a
      // cross-tenant leak. Refuse rather than silently mis-route; the
      // operator must re-run `hyp join` against the new server.
      // @ref LLP 0031#physical-layout [implements]: a re-point with no token cannot safely reuse the old identity, so loading is refused
      if (persisted.central_url !== undefined && persisted.central_url !== this.centralUrl) {
        // A login-seeded identity re-enrolls with a fresh login, not a join
        // token (LLP 0061 D3): point the operator at the seam that minted it.
        const remedy = persisted.origin === 'login'
          ? 'Re-run `hyp remote login` against the new server to enroll this host'
          : `Run \`hyp join ${this.centralUrl} <token>\` to enroll this host with the new server`
        throw new Error(
          `identity central URL mismatch: persisted identity was minted by ${persisted.central_url} but the configured central server is ${this.centralUrl}. ${remedy}`
        )
      }
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
      throw new Error(
        'identity bootstrap failed: identity.bootstrap_token is not set. Run `hyp join <central-url> <token>` to enroll this host, or remove the central sink if you only capture locally'
      )
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
    // Stamp what minted this identity so a later re-join with a different
    // token/URL is detected (see acquire()).
    identity.central_url = this.centralUrl
    identity.bootstrap_token_fp = fingerprintToken(token)
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
    // Preserve the mint provenance across refresh; the bootstrap token is
    // typically absent in steady state, so re-derive it from the prior
    // persisted identity rather than recomputing.
    identity.central_url = this.identity.central_url
    identity.bootstrap_token_fp = this.identity.bootstrap_token_fp
    if (this.identity.origin !== undefined) identity.origin = this.identity.origin
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
      throw new Error('identity not acquired - call acquire() first')
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
  const { jwt, expires_at, gateway_id, central_url, bootstrap_token_fp, origin } =
    /** @type {Record<string, unknown>} */ (parsed)
  if (typeof jwt !== 'string' || jwt.length === 0) {
    throw new Error(`persisted identity ${filePath}: missing or invalid jwt`)
  }
  if (typeof expires_at !== 'number' || !Number.isInteger(expires_at)) {
    throw new Error(`persisted identity ${filePath}: missing or invalid expires_at`)
  }
  if (typeof gateway_id !== 'string' || gateway_id.length === 0) {
    throw new Error(`persisted identity ${filePath}: missing or invalid gateway_id`)
  }
  /** @type {PersistedIdentity} */
  const identity = { jwt, expires_at, gateway_id }
  if (typeof central_url === 'string') identity.central_url = central_url
  if (typeof bootstrap_token_fp === 'string') identity.bootstrap_token_fp = bootstrap_token_fp
  if (origin === 'login') identity.origin = origin
  return identity
}

/**
 * Whether a persisted identity was minted by a different bootstrap token
 * or central URL than the ones now configured (i.e. a re-enrollment).
 * An identity written by an older build (no stamp) cannot be proven to
 * match, so it counts as changed whenever a bootstrap token is set; that
 * forces one safe re-bootstrap rather than reusing a possibly-stale JWT.
 *
 * @param {PersistedIdentity} persisted
 * @param {string} centralUrl
 * @param {string} bootstrapToken
 * @returns {boolean}
 */
function mintChanged(persisted, centralUrl, bootstrapToken) {
  if (persisted.central_url !== undefined && persisted.central_url !== centralUrl) {
    return true
  }
  // A login-seeded identity was minted by a human login, not by any bootstrap
  // token, so its missing token fingerprint is not a mint mismatch. With the
  // URL matching (above), a configured bootstrap token coexists with the login
  // seed rather than re-bootstrapping over it on every daemon start.
  // @ref LLP 0061#d3 [implements]: the origin marker keeps the re-enrollment guard from reading a login seed as a swapped bootstrap token
  if (persisted.origin === 'login') {
    return false
  }
  return persisted.bootstrap_token_fp !== fingerprintToken(bootstrapToken)
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
    // best effort: rename already replaced the file
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
 * The gateway trusts the TLS connection for authenticity: it has no
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
      // plain text body: fall through
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

/** @param {unknown} err */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
