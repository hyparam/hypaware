import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { ConfigError, validateCollectivusConfig } from '../config.js'

/**
 * @import { CentralServerConfig, CollectivusConfig } from '../types.js'
 * @import { ConfigChangedEvent, IdentitySource } from './types.d.ts'
 */

/**
 * Default poll interval applied when `central_server.poll_interval_seconds`
 * is omitted. The validator constrains a present value to [5, 3600].
 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 30

/**
 * Linear backoff schedule applied on consecutive transport failures (network
 * errors, 5xx). The last entry is the cap — once we land on it we stay on it
 * until a tick succeeds.
 */
export const NETWORK_BACKOFF_SCHEDULE_SECONDS = Object.freeze([30, 60, 120, 300])

/**
 * Backoff applied while the central server reports 404 — the operator hasn't
 * registered a config for this gateway yet. The bead spec calls out 5 minutes
 * explicitly: long enough that we don't hammer the server, short enough that
 * the operator sees their `collectivus config set` reflected without a manual
 * gateway restart.
 */
export const NOT_REGISTERED_BACKOFF_SECONDS = 5 * 60

/**
 * Background config-pull loop for `role: gateway`. Owns:
 *
 * - The current ETag (in memory and on disk, so a restart short-circuits to
 *   304 instead of re-pulling and re-validating the same config).
 * - A timer that ticks at `poll_interval_seconds` on success and falls back to
 *   linear backoff on transport / auth / config-not-registered failures.
 * - The `'config-changed'` EventEmitter signal that B.4 consumes for hot
 *   reload.
 *
 * Construction is cheap and side-effect-free. Start the loop via `start()`.
 * `stop()` is idempotent and safe to call from `cli.js#stopAll`.
 */
export class ConfigClient extends EventEmitter {
  /**
   * @param {CentralServerConfig} config
   * @param {IdentitySource} identityClient
   * @param {{
   *   now?: () => number,
   *   fetchFn?: typeof fetch,
   *   etagPath?: string,
   *   setTimeoutFn?: typeof setTimeout,
   *   clearTimeoutFn?: typeof clearTimeout,
   *   stderr?: { write: (s: string) => void },
   * }} [opts] Test hooks. `etagPath` overrides the on-disk sidecar location;
   *   the timer hooks let tests drive ticks without real-time delays;
   *   `stderr` captures the diagnostic lines we'd otherwise emit to
   *   `process.stderr` so the test runner stays quiet.
   */
  constructor(config, identityClient, opts = {}) {
    super()
    if (!config || typeof config.url !== 'string' || config.url.length === 0) {
      throw new Error('ConfigClient: central_server.url is required')
    }
    if (!identityClient) {
      throw new Error('ConfigClient: identityClient is required')
    }
    /** @type {CentralServerConfig} */
    this.config = config
    /** @type {IdentitySource} */
    this.identityClient = identityClient
    /** @type {() => number} */
    this.now = opts.now ?? Date.now
    /** @type {typeof fetch} */
    this.fetchFn = opts.fetchFn ?? fetch
    /** @type {typeof setTimeout} */
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout
    /** @type {typeof clearTimeout} */
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout
    /** @type {{ write: (s: string) => void }} */
    this.stderr = opts.stderr ?? process.stderr

    /** @type {number} */
    this.pollIntervalSeconds = config.poll_interval_seconds ?? DEFAULT_POLL_INTERVAL_SECONDS

    /** @type {string} */
    this.etagPath = opts.etagPath ?? deriveEtagPath(identityClient.persistedPath)

    /** @type {string | undefined} */
    this.etag = readPersistedEtag(this.etagPath)

    /**
     * Index into `NETWORK_BACKOFF_SCHEDULE_SECONDS`. Reset to 0 on any
     * successful tick (200 or 304). Capped at the last index on consecutive
     * failures so we don't drive it past the array.
     *
     * @type {number}
     */
    this.backoffIndex = 0

    /**
     * Tracks whether we've already logged "no config registered" for this
     * gateway. Re-emitted only after we transition out of the 404 state and
     * back in.
     *
     * @type {boolean}
     */
    this.notRegisteredLogged = false

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.timer = undefined
    /** @type {boolean} */
    this.stopped = false
    /**
     * Promise of the in-flight tick, exposed so tests can deterministically
     * await a tick without racing against the timer fire. Typed as
     * `Promise<unknown>` because `whenIdle()` only cares about completion,
     * not the per-tick `nextDelaySeconds` return value.
     *
     * @type {Promise<unknown> | undefined}
     */
    this.activeTick = undefined
  }

  /**
   * Start the poll loop. Schedules an immediate first tick — `start()` itself
   * is synchronous and never awaits the first network call so the gateway
   * lifecycle isn't blocked on an unreachable server.
   *
   * @returns {void}
   */
  start() {
    this.stopped = false
    this.scheduleNext(0)
  }

  /**
   * Stop the poll loop. Idempotent. The current in-flight tick (if any) is
   * allowed to settle; await `whenIdle()` before tearing down dependencies if
   * the caller needs to be sure no further events fire.
   *
   * @returns {void}
   */
  stop() {
    this.stopped = true
    if (this.timer !== undefined) {
      this.clearTimeoutFn(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Resolve once the current in-flight tick finishes. Useful for shutdown
   * paths that want to ensure no further `'config-changed'` events fire.
   *
   * @returns {Promise<void>}
   */
  async whenIdle() {
    if (this.activeTick) await this.activeTick
  }

  /**
   * Run a single fetch tick. Public so tests can drive the loop deterministically
   * without juggling timers; production calls it via `scheduleNext()`.
   *
   * Returns the next delay in seconds the loop should wait before the next
   * tick. The return value is informational for tests — the scheduler reads
   * the same value off `this.nextDelaySeconds`.
   *
   * @returns {Promise<number>}
   */
  async tick() {
    const promise = this.runTick()
    this.activeTick = promise.finally(() => {
      this.activeTick = undefined
    })
    return promise
  }

  /**
   * @returns {Promise<number>}
   */
  async runTick() {
    /** @type {string} */
    let jwt
    try {
      jwt = await this.identityClient.getCurrentJwt()
    } catch (err) {
      this.logWarning(`config poll: identity unavailable: ${formatError(err)}`)
      return this.recordNetworkFailure()
    }

    let response
    try {
      response = await this.fetchOnce(jwt)
    } catch (err) {
      this.logWarning(`config poll: failed to reach ${this.config.url}: ${formatError(err)}`)
      return this.recordNetworkFailure()
    }

    if (response.status === 401) {
      // The current JWT was rejected. Refresh once, then retry — a single
      // pass is enough for the common case (clock skew, server-side rotation
      // catching a stale token); a second 401 means the issuer secret is
      // wrong and back-pressure won't help.
      try {
        await this.identityClient.refresh()
      } catch (err) {
        this.logWarning(`config poll: 401 from server, refresh failed: ${formatError(err)}`)
        return this.recordNetworkFailure()
      }
      try {
        const newJwt = await this.identityClient.getCurrentJwt()
        response = await this.fetchOnce(newJwt)
      } catch (err) {
        this.logWarning(`config poll: 401 retry failed: ${formatError(err)}`)
        return this.recordNetworkFailure()
      }
      if (response.status === 401) {
        this.logWarning('config poll: 401 even after JWT refresh; check server secret')
        return this.recordNetworkFailure()
      }
    }

    return this.handleResponse(response)
  }

  /**
   * Issue a single GET /v1/config request with the current ETag (if any) and
   * the supplied bearer JWT. Returns the raw `Response` so callers can branch
   * on status.
   *
   * @param {string} jwt
   * @returns {Promise<Response>}
   */
  async fetchOnce(jwt) {
    /** @type {Record<string, string>} */
    const headers = { authorization: `Bearer ${jwt}` }
    if (this.etag !== undefined) headers['if-none-match'] = this.etag
    const url = joinUrl(this.config.url, '/v1/config')
    return this.fetchFn(url, { method: 'GET', headers })
  }

  /**
   * Branch on the final response status (after any 401 retry). Translates the
   * status into an event emission + persisted-etag update + backoff decision.
   *
   * @param {Response} response
   * @returns {Promise<number>}
   */
  async handleResponse(response) {
    if (response.status === 304) {
      this.recordSuccess()
      return this.pollIntervalSeconds
    }
    if (response.status === 200) {
      const serverEtag = readEtagHeader(response)
      let parsed
      try {
        parsed = await response.json()
      } catch (err) {
        this.logWarning(`config poll: 200 with invalid JSON: ${formatError(err)}`)
        return this.recordNetworkFailure()
      }
      try {
        validateCollectivusConfig(parsed)
      } catch (err) {
        // Invalid configs are NOT a transport failure — the server might be
        // serving a buggy entry that we don't want to back off about. Log
        // and discard, keep the old etag so we don't update to something
        // unusable, and stay on the normal poll cadence (the operator's
        // next correction will arrive on the next tick).
        const detail = err instanceof ConfigError ? err.message : formatError(err)
        this.logWarning(`config poll: server returned invalid config: ${detail}`)
        this.recordSuccess()
        return this.pollIntervalSeconds
      }
      const newConfig = parsed
      const etag = serverEtag ?? this.etag ?? ''
      this.etag = etag
      writePersistedEtag(this.etagPath, etag)
      const fetchedAt = new Date(this.now()).toISOString()
      /** @type {ConfigChangedEvent} */
      const event = { newConfig, etag, fetchedAt }
      this.emit('config-changed', event)
      this.recordSuccess()
      return this.pollIntervalSeconds
    }
    if (response.status === 404) {
      // Operator hasn't registered a config yet. Log once so the gateway
      // doesn't fill stderr with the same line every five minutes.
      if (!this.notRegisteredLogged) {
        this.logWarning(`config poll: ${this.config.url} reports no config registered for this gateway`)
        this.notRegisteredLogged = true
      }
      // 404 isn't a transport problem, so don't escalate the network backoff
      // index — but slow down the poll cadence so we're not chatty about an
      // unprovisioned gateway.
      this.backoffIndex = 0
      return NOT_REGISTERED_BACKOFF_SECONDS
    }
    if (response.status >= 500 && response.status < 600) {
      this.logWarning(`config poll: server returned ${response.status}`)
      return this.recordNetworkFailure()
    }
    // Unexpected status (3xx that isn't 304, 4xx that isn't 401/404). Log
    // and treat as a transport failure — backoff is the safe move when the
    // server is replying with something we don't know how to interpret.
    this.logWarning(`config poll: unexpected status ${response.status}`)
    return this.recordNetworkFailure()
  }

  /**
   * Record a successful tick: reset network backoff and clear the
   * "no config registered" log-once flag so a future 404 will re-log.
   *
   * @returns {void}
   */
  recordSuccess() {
    this.backoffIndex = 0
    this.notRegisteredLogged = false
  }

  /**
   * Record a transport-class failure and return the backoff in seconds. The
   * index advances up to the last entry of the schedule and then sticks
   * there until a tick succeeds.
   *
   * @returns {number}
   */
  recordNetworkFailure() {
    const idx = Math.min(this.backoffIndex, NETWORK_BACKOFF_SCHEDULE_SECONDS.length - 1)
    const delay = NETWORK_BACKOFF_SCHEDULE_SECONDS[idx]
    if (this.backoffIndex < NETWORK_BACKOFF_SCHEDULE_SECONDS.length - 1) {
      this.backoffIndex++
    }
    return delay
  }

  /**
   * Schedule the next tick. `delaySeconds === 0` means "now-ish" (next
   * macrotask) — we still go through `setTimeout` so `start()` returns to the
   * caller before the first network call begins.
   *
   * @param {number} delaySeconds
   * @returns {void}
   */
  scheduleNext(delaySeconds) {
    if (this.stopped) return
    if (this.timer !== undefined) {
      this.clearTimeoutFn(this.timer)
      this.timer = undefined
    }
    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined
      this.tick()
        .then((nextDelay) => {
          this.scheduleNext(nextDelay)
        })
        .catch((err) => {
          // tick() handles its own error paths; reaching this branch means
          // an unexpected throw escaped the response-handling code. Log and
          // re-arm with a network backoff so a transient bug doesn't kill
          // the whole loop.
          this.logWarning(`config poll: tick threw: ${formatError(err)}`)
          this.scheduleNext(this.recordNetworkFailure())
        })
    }, Math.max(0, delaySeconds * 1000))
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer
        && typeof this.timer.unref === 'function') {
      // Don't keep the event loop alive solely for the next config tick —
      // the gateway exits cleanly on shutdown when the actual listeners
      // close, and an unref'd timer is dropped automatically.
      this.timer.unref()
    }
  }

  /**
   * @param {string} message
   * @returns {void}
   */
  logWarning(message) {
    this.stderr.write(`warning: ${message}\n`)
  }
}

/**
 * Derive the on-disk etag-cache path from the persisted JWT path. Lives in
 * the same directory as identity.json so the operator only has one
 * "credentials/state" location to back up or wipe.
 *
 * @param {string} identityPath
 * @returns {string}
 */
function deriveEtagPath(identityPath) {
  return path.join(path.dirname(identityPath), 'config-etag.json')
}

/**
 * @param {string} filePath
 * @returns {string | undefined}
 */
function readPersistedEtag(filePath) {
  /** @type {string} */
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    if (code === 'ENOENT') return undefined
    // A malformed sidecar shouldn't crash the gateway — it just means we
    // pull a fresh 200 next tick and rewrite the file. Log nothing here;
    // the caller will surface a warning if it cares.
    return undefined
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof parsed.etag === 'string') {
      return parsed.etag
    }
  } catch {
    // Fall through to "no etag" — we'll rewrite the file on the next 200.
  }
  return undefined
}

/**
 * Persist the etag using the same tmp+rename atomic-write pattern the
 * identity client uses, so a crash mid-write can never leave a half-finished
 * file in place. Mode 0600 because this lives next to the JWT and we don't
 * want it to inherit a broader umask.
 *
 * @param {string} filePath
 * @param {string} etag
 * @returns {void}
 */
function writePersistedEtag(filePath, etag) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  const json = JSON.stringify({ etag })
  fs.writeFileSync(tmp, json, { mode: 0o600 })
  fs.renameSync(tmp, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Best-effort, same as identity.js — rename already replaced the file.
  }
}

/**
 * Pull the ETag header off a response, normalizing the `W/"..."` and `"..."`
 * wrappings the spec allows. Server-side `control_plane.js` only emits bare
 * hex strings, so the wrappers are defense-in-depth.
 *
 * @param {Response} response
 * @returns {string | undefined}
 */
function readEtagHeader(response) {
  const raw = response.headers.get('etag')
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let tag = raw
  if (tag.startsWith('W/')) tag = tag.slice(2)
  if (tag.length >= 2 && tag.startsWith('"') && tag.endsWith('"')) {
    tag = tag.slice(1, -1)
  }
  return tag.length > 0 ? tag : undefined
}

/**
 * @param {string} base
 * @param {string} suffix
 * @returns {string}
 */
function joinUrl(base, suffix) {
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`
  return new URL(suffix.replace(/^\//, ''), baseWithSlash).toString()
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return `${err.code}: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
