// @ts-check

import fs from 'node:fs'
import { centralLifetime, readCentralJson, readErrorDetail, readStopCode } from './backoff.js'

import { atomicWriteJsonSync, canonicalOrigin, isPlainObject, readKeptServiceToken, serviceTokenPath, sha256Hex, writeKeptServiceToken } from 'hypaware/core/util'

/**
 * @import fsp from 'node:fs/promises'
 * @import { AcquireSource, PersistedIdentity, RefreshLease, RefreshOperation } from '../../../../hypaware-core/plugins-workspace/central/src/types.js'
 * @import { KeptServiceToken } from '../../../../src/core/remote/types.js'
 * @import { PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * The sink stopped sending on a service credential: the server refused it
 * permanently (`service_token_revoked`, `service_account_disabled`), or the
 * kept record could not be read (`service_token_unreadable`). Never retried;
 * the remedy is a new `hyp join`.
 */
export class ServiceCredentialStopped extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ServiceCredentialStopped'
    /** @type {string} */
    this.code = code
  }
}

/** @param {string} code @returns {string} */
function stoppedMessage(code) {
  const what = code === 'service_account_disabled' ? 'the service account is disabled' : 'the service token was revoked'
  return `central stopped: ${what}. Create a new token in HypAware and run \`hyp join\` again`
}

/**
 * Fingerprint a bootstrap token for the persisted identity's
 * re-enrollment guard. A hash, never the raw token, so the persisted
 * file (and any log of it) cannot leak the credential.
 *
 * @param {string} token
 * @returns {string}
 */
function fingerprintToken(token) {
  return sha256Hex(token)
}

/**
 * Eagerly refresh when the remaining lifetime falls inside this window
 * (24h). Must match the central server's refresh-window contract: see
 * proto.md "Refresh window".
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
   *   log?: PluginLogger,
   *   fs?: typeof fsp,
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
    /** @type {RefreshOperation | undefined} */
    this.refreshing = undefined
    /** @type {PluginLogger | undefined} */
    this.log = opts.log
    /** @type {typeof fsp | undefined} */
    this.keptFs = opts.fs
    /** @type {string} */
    this.keptPath = serviceTokenPath(opts.persistedPath)
    /** @type {KeptServiceToken | undefined} */
    this.kept = undefined
    /** @type {string | undefined} */
    this.stopped = undefined
    /** @type {Promise<unknown> | undefined} */
    this.stopWrite = undefined
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
    // @ref LLP 0547#activation-stop [implements]: the kept record is read before identity.json or any request; rows 0, 1, 4 and 7 refuse with no request
    const read = await readKeptServiceToken(this.keptPath, this.keptFs ? { fs: this.keptFs } : undefined)
    if (read.state === 'unreadable') {
      this.stopped = 'service_token_unreadable'
      this.logService('warn', 'central.identity.service_token_unreadable', { status: 'stopped', error_kind: 'service_token_unreadable', reason: read.reason })
      throw new ServiceCredentialStopped('service_token_unreadable',
        `central stopped: the kept service token ${this.keptPath} cannot be read (${read.reason}). Run \`hyp join\` again`)
    }
    const kept = read.state === 'ok' ? read.record : undefined
    this.kept = kept
    if (this.bootstrapToken && kept?.stopped_code && this.keptNames(fingerprintToken(this.bootstrapToken), this.centralUrl)) {
      throw this.refuseStopped(kept.stopped_code)
    }
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
      if (persisted.central_url !== undefined && !sameCentral(persisted.central_url, this.centralUrl)) {
        // A login-seeded identity re-enrolls with a fresh login, not a join
        // token (LLP 0061 D3): point the operator at the seam that minted it.
        const remedy = persisted.origin === 'login'
          ? `Run \`hyp remote login <name>\` for a remote that points at ${this.centralUrl} to enroll this host (register one with \`hyp remote add <name> ${this.centralUrl}\`)`
          : `Run \`hyp join ${this.centralUrl} <token>\` to enroll this host with the new server`
        throw new Error(
          `identity central URL mismatch: persisted identity was minted by ${persisted.central_url} but the configured central server is ${this.centralUrl}. ${remedy}`
        )
      }
      if (!this.bootstrapToken && kept?.stopped_code && this.keptNames(persisted.bootstrap_token_fp, persisted.central_url, persisted.origin)) {
        throw this.refuseStopped(kept.stopped_code)
      }
      this.identity = persisted
      const remainingSec = persisted.expires_at - Math.floor(this.now() / 1000)
      if (remainingSec <= REFRESH_WINDOW_SECONDS) {
        await this.refresh()
        return 'refreshed'
      }
      return 'loaded'
    }
    if (!this.bootstrapToken && kept) {
      // @ref LLP 0547#rebootstrap [implements]: a lost identity recovers from the record only at the record's own destination
      if (!sameCentral(kept.central_url, this.centralUrl)) {
        throw new Error(
          `identity bootstrap failed: this collector is enrolled with ${kept.central_url} but the configured central server is ${this.centralUrl}. Run \`hyp join ${this.centralUrl} -\` with a service token from that server`
        )
      }
      if (kept.stopped_code) throw this.refuseStopped(kept.stopped_code)
      await this.bootstrap(kept.secret)
      return 'bootstrapped'
    }
    await this.bootstrap()
    return 'bootstrapped'
  }

  /**
   * Whether the kept record names this credential: the same secret, at the
   * same destination, and never a login identity.
   *
   * @param {string | undefined} fingerprint
   * @param {string | undefined} centralUrl
   * @param {PersistedIdentity['origin']} [origin]
   * @returns {boolean}
   */
  keptNames(fingerprint, centralUrl, origin) {
    const kept = this.kept
    return kept !== undefined && origin !== 'login' && fingerprint === kept.fingerprint &&
      centralUrl !== undefined && sameCentral(kept.central_url, centralUrl)
  }

  /**
   * Hold a stop for the life of the client and return the error to throw.
   *
   * @param {string} code
   * @returns {ServiceCredentialStopped}
   */
  refuseStopped(code) {
    this.stopped = code
    this.logService('warn', 'central.identity.stopped', { status: 'stopped', error_kind: code })
    return new ServiceCredentialStopped(code, stoppedMessage(code))
  }

  /**
   * The server refused a service credential permanently. Stop sending at
   * once, and write the stop into the record when the record names the
   * refused credential so a restart refuses before any request.
   *
   * @ref LLP 0547#rebootstrap [implements]: a stored stop is never wrong because revocation and disable are permanent
   * @param {string} code
   * @param {{ fingerprint: string | undefined, centralUrl: string | undefined, origin?: PersistedIdentity['origin'] }} credential
   * @returns {Promise<ServiceCredentialStopped>}
   */
  async stop(code, credential) {
    // Publish the stop before the record write is awaited, so no caller is
    // handed the refused bearer while the write is pending.
    this.stopped = code
    const kept = this.kept
    if (!kept || !this.keptNames(credential.fingerprint, credential.centralUrl, credential.origin)) {
      this.logService('warn', 'central.identity.stop_not_persisted', { status: 'stopped', error_kind: 'service_stop_not_persisted' })
      return this.refuseStopped(code)
    }
    if (kept.stopped_code === code) return this.refuseStopped(code)
    // Concurrent refusals share the one write rather than each publishing.
    if (this.stopWrite) {
      await this.stopWrite
      return this.refuseStopped(code)
    }
    /** @type {KeptServiceToken} */
    const record = { ...kept, stopped_code: code }
    // A join or leave since this client read the record may have replaced or
    // retired it: the stop is written only over the exact record it read.
    const write = writeKeptServiceToken(this.keptPath, record, { expected: kept, ...this.keptFs ? { fs: this.keptFs } : {} })
    this.stopWrite = write
    const wrote = await write
    if (wrote.outcome === 'written' || wrote.outcome === 'visible') {
      this.kept = record
    } else {
      this.logService('warn', 'central.identity.stop_not_persisted', { status: 'stopped', error_kind: 'service_stop_not_persisted', write_outcome: wrote.outcome })
    }
    return this.refuseStopped(code)
  }

  /**
   * Stop on a refusal the sink saw on upload or registration, for the
   * identity it was using.
   *
   * @param {string} code
   * @returns {Promise<ServiceCredentialStopped>}
   */
  stopCurrent(code) {
    return this.stop(code, {
      fingerprint: this.identity?.bootstrap_token_fp,
      centralUrl: this.identity?.central_url,
      origin: this.identity?.origin,
    })
  }

  /**
   * @param {'info' | 'warn'} level
   * @param {string} event
   * @param {Record<string, unknown>} attrs
   */
  logService(level, event, attrs) {
    this.log?.[level](event, { component: 'central', credential_kind: 'service_token', ...attrs })
  }

  /**
   * Exchange the configured bootstrap token for a long-lived JWT and
   * persist it. Required on first run; the operator issues bootstrap
   * tokens out-of-band.
   *
   * @param {string | undefined} [token] the kept service secret on recovery
   * @param {AbortSignal} [signal] the refresh lifetime on a 401 recovery
   * @returns {Promise<void>}
   */
  async bootstrap(token = this.bootstrapToken, signal) {
    if (this.stopped) throw new ServiceCredentialStopped(this.stopped, stoppedMessage(this.stopped))
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
        signal,
        headers: { 'content-type': 'application/json' },
        body,
      })
    } catch (err) {
      signal?.throwIfAborted()
      throw new Error(`failed to reach central server ${this.centralUrl}: ${formatError(err)}`)
    }

    if (response.status === 403) {
      const code = await readStopCode(response, signal)
      if (code) throw await this.stop(code, { fingerprint: fingerprintToken(token), centralUrl: this.centralUrl })
      throw new Error('identity bootstrap failed: HTTP 403')
    }
    if (!response.ok) {
      throw new Error(`identity bootstrap failed: ${await readErrorDetail(response, signal)}`)
    }

    const parsed = await readJsonResponse(response, 'bootstrap', signal)
    const identity = identityFromPayload(parsed)
    // Stamp what minted this identity so a later re-join with a different
    // token/URL is detected (see acquire()).
    identity.central_url = this.centralUrl
    identity.bootstrap_token_fp = fingerprintToken(token)
    signal?.throwIfAborted()
    this.identity = identity
    writePersistedFile(this.persistedPath, identity)
  }

  /**
   * Refresh the JWT. Concurrent callers share the in-flight request so
   * a burst of `getCurrentJwt()` calls right at the expiry edge causes
   * one network call, not N.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  refresh(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.refreshing?.lifetime.signal.aborted) {
      return Promise.reject(new Error('identity refresh closing; retry after settlement'))
    }
    if (!this.refreshing) {
      /** @type {RefreshOperation} */
      const operation = { lifetime: centralLifetime(undefined, 'identity refresh'), consumers: new Set() }
      this.refreshing = operation
      /** @param {unknown} [error] */
      const settle = (error) => {
        operation.lifetime.dispose()
        if (this.refreshing === operation) this.refreshing = undefined
        for (const lease of operation.consumers) lease.finish(error)
        operation.consumers.clear()
        operation.cancelled?.finish(operation.lifetime.signal.reason)
        operation.cancelled = undefined
      }
      // @ref LLP 0471#shared-auth [implements]: one resource settlement handler; cancelled leases detach without shared-promise reactions
      this.doRefresh(operation.lifetime.signal).then(() => settle(), settle)
    }
    const operation = this.refreshing
    return new Promise((resolve, reject) => {
      let finished = false
      /** @type {RefreshLease} */
      const lease = { finish(error) {
        if (finished) return
        finished = true
        signal?.removeEventListener('abort', cancel)
        operation.consumers.delete(lease)
        if (error !== undefined) reject(error)
        else resolve()
      } }
      const cancel = () => {
        signal?.removeEventListener('abort', cancel)
        operation.consumers.delete(lease)
        if (operation.consumers.size) lease.finish(signal?.reason)
        else {
          operation.cancelled = lease
          operation.lifetime.abort(signal?.reason)
        }
      }
      operation.consumers.add(lease)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
    })
  }

  /** @param {AbortSignal} signal @returns {Promise<void>} */
  async doRefresh(signal) {
    if (this.stopped) throw new ServiceCredentialStopped(this.stopped, stoppedMessage(this.stopped))
    if (!this.identity) {
      throw new Error('identity refresh failed: no current JWT to refresh')
    }
    const url = joinUrl(this.centralUrl, '/v1/identity/refresh')
    let response
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        signal,
        headers: { authorization: `Bearer ${this.identity.jwt}` },
      })
    } catch {
      signal.throwIfAborted()
      throw new Error('identity refresh failed: transport unavailable')
    }
    if (response.status === 403) {
      const code = await readStopCode(response, signal)
      if (code) throw await this.stopCurrent(code)
      throw new Error('identity refresh failed: HTTP 403')
    }
    // @ref LLP 0547#rebootstrap [implements]: a 401 recovers once from the record that enrolled this identity, never for a login identity or a stopped record
    const current = this.identity
    if (response.status === 401 && this.kept && !this.kept.stopped_code &&
      sameCentral(this.kept.central_url, this.centralUrl) && this.keptNames(current.bootstrap_token_fp, current.central_url, current.origin)) {
      await readErrorDetail(response, signal)
      this.logService('info', 'central.identity.service_token_recover', { status: 'started' })
      await this.bootstrap(this.kept.secret, signal)
      return
    }
    if (!response.ok) {
      throw new Error(`identity refresh failed: ${await readErrorDetail(response, signal)}`)
    }
    const parsed = await readCentralJson(response, signal)
    const identity = identityFromPayload(parsed, this.identity.gateway_id)
    // Preserve the mint provenance across refresh; the bootstrap token is
    // typically absent in steady state, so re-derive it from the prior
    // persisted identity rather than recomputing.
    identity.central_url = this.identity.central_url
    identity.bootstrap_token_fp = this.identity.bootstrap_token_fp
    if (this.identity.origin !== undefined) identity.origin = this.identity.origin
    signal.throwIfAborted()
    this.identity = identity
    writePersistedFile(this.persistedPath, identity)
  }

  /**
   * Return the current JWT, lazily refreshing if it sits inside the
   * refresh window. Hot path is a single in-memory check.
   *
   * @param {AbortSignal} [signal]
   * @returns {Promise<string>}
   */
  async getCurrentJwt(signal) {
    signal?.throwIfAborted()
    if (this.stopped) throw new ServiceCredentialStopped(this.stopped, stoppedMessage(this.stopped))
    if (!this.identity) {
      throw new Error('identity not acquired - call acquire() first')
    }
    const remainingSec = this.identity.expires_at - Math.floor(this.now() / 1000)
    if (remainingSec <= REFRESH_WINDOW_SECONDS) {
      await this.refresh(signal)
      // A stop that landed while the refresh was in flight refuses its JWT too.
      if (this.stopped) throw new ServiceCredentialStopped(this.stopped, stoppedMessage(this.stopped))
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
 * Whether two central URLs name the same target. The origins must match after
 * folding a moved built-in's old host into its new one, and the paths must
 * match too: a path-scoped `central.url` is a distinct target on a shared host,
 * so origin equality alone would reuse one tenant's gateway identity for
 * another. Trailing slashes are ignored, as `joinUrl` ignores them.
 *
 * @ref LLP 0062#builtin [constrained-by]: BUILTIN_ORIGIN_ALIASES folds the built-in's old host into its new one
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameCentral(a, b) {
  if (a === b) return true
  const origin = canonicalOrigin(a)
  return origin !== null && origin === canonicalOrigin(b) && centralPath(a) === centralPath(b)
}

/**
 * The part of a parseable central URL after its origin, without trailing slashes.
 *
 * @param {string} url
 * @returns {string}
 */
function centralPath(url) {
  const { pathname, search } = new URL(url)
  return `${pathname.replace(/\/+$/, '')}${search}`
}

/**
 * Whether a persisted identity was minted by a different bootstrap token
 * or central target than the ones now configured (i.e. a re-enrollment).
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
  if (persisted.central_url !== undefined && !sameCentral(persisted.central_url, centralUrl)) {
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
  atomicWriteJsonSync(filePath, identity, { mode: 0o600, dirMode: 0o700 })
  try {
    // Re-assert in case the write mode was masked by a permissive umask.
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
 * Redundant trailing slashes in the base collapse, so a url an operator typed
 * as `https://host//` reaches the same single-slash route product telemetry's
 * `safeDestination` targets, not the doubled-slash path the receiver will not
 * route.
 *
 * @param {string} base
 * @param {string} suffix
 */
function joinUrl(base, suffix) {
  const baseWithSlash = `${base.replace(/\/+$/, '')}/`
  return new URL(suffix.replace(/^\//, ''), baseWithSlash).toString()
}

/**
 * @param {Response} response
 * @param {'bootstrap' | 'refresh'} kind
 * @param {AbortSignal} [signal]
 */
async function readJsonResponse(response, kind, signal) {
  try {
    return await readCentralJson(response, signal)
  } catch (err) {
    signal?.throwIfAborted()
    throw new Error(`identity ${kind} failed: invalid JSON in server response: ${formatError(err)}`)
  }
}

/** @param {unknown} err */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
