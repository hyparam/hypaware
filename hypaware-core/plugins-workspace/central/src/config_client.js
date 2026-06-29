// @ts-check

import { RETRY_BACKOFF_SECONDS, parseRetryAfter } from './backoff.js'

/**
 * @import { ConfigControlFacade, PluginLogger } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { IdentityClient } from './identity_client.js'
 */

/**
 * Default pull cadence when `poll_interval_seconds` is not configured.
 * Mirrors the kernel apply engine's `DEFAULT_POLL_INTERVAL_SECONDS`
 * (it sizes the probation window from the same number).
 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 300

/**
 * Transport-level cap on a pulled config body. Mirrors the kernel's
 * `MAX_CONFIG_DOCUMENT_BYTES`: the apply engine enforces it again,
 * but an oversized body is dropped before it is buffered whole: an
 * oversized `Content-Length` is rejected without reading, and a
 * chunked body is read through a byte counter that cancels the stream
 * the moment it crosses the cap.
 */
export const MAX_CONFIG_DOCUMENT_BYTES = 1024 * 1024

/**
 * Hard deadline (seconds) on a single poll, covering the request and
 * the body read. Bounds how long `stop()` can wait on an in-flight
 * poll even when the caller's `fetchFn` ignores abort signals.
 */
export const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30

/**
 * How long `stop()` lets an in-flight poll drain before aborting it
 * (seconds). A healthy poll finishes in this window: a mid-flight
 * apply should commit rather than be cancelled, while a stalled
 * request is cut off so shutdown stays prompt.
 */
export const DEFAULT_STOP_GRACE_SECONDS = 1

/** Polite backoff (seconds) for the legacy 404 branch, per proto.md. */
const LEGACY_404_BACKOFF_SECONDS = 300

/**
 * The config pull loop: poll `GET /v1/config` with `If-None-Match` set
 * to the *running* config's etag, confirm successful polls to the
 * kernel (clearing post-apply probation), and hand 200 bodies to the
 * apply facade. Transport only: validation, persistence, restart,
 * probation, and rollback are all kernel-owned behind `configControl`.
 *
 * The loop is a self-rescheduling timeout rather than an interval so
 * backoff (404 / 429 / 503 / transport errors) can stretch a single
 * gap without skewing the steady cadence. Identity refresh needs no
 * timer of its own: every poll goes through `getCurrentJwt()`, which
 * eagerly refreshes inside the 24h window, and the poll cadence is
 * capped at one hour.
 *
 * Timers are deliberately *not* unref'd: in seed-config mode (central
 * sink only, no sources) this loop is the daemon's only live handle,
 * and that polling idle state is a legitimate steady state, not an
 * exit condition.
 *
 * Every poll runs under its own `AbortController` with a hard
 * deadline: a stalled config GET must not be able to wedge `stop()`,
 * and through it daemon shutdown or a staged restart, so a poll that
 * outlives the deadline is aborted, and `stop()` aborts an in-flight
 * poll after a short drain grace.
 *
 * @param {{
 *   centralUrl: string,
 *   identityClient: IdentityClient,
 *   configControl: ConfigControlFacade,
 *   pollIntervalSeconds?: number,
 *   requestTimeoutSeconds?: number,
 *   stopGraceSeconds?: number,
 *   log: PluginLogger,
 *   fetchFn?: typeof fetch,
 * }} args
 * @ref LLP 0025#config-pull-loop [implements]: immediate pull on bootstrap success, then a steady plugin-internal timer
 */
export function createConfigPullLoop(args) {
  const { centralUrl, identityClient, configControl, log } = args
  const fetchFn = args.fetchFn ?? fetch
  const pollIntervalSeconds = args.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS
  const requestTimeoutSeconds = args.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS
  const stopGraceSeconds = args.stopGraceSeconds ?? DEFAULT_STOP_GRACE_SECONDS

  /** @type {NodeJS.Timeout | null} */
  let timer = null
  let stopped = false
  let consecutiveFailures = 0
  /** @type {Promise<void> | null} */
  let inFlight = null
  /** @type {AbortController | null} */
  let activeController = null

  /** @param {number} delaySeconds */
  function schedule(delaySeconds) {
    if (stopped) return
    timer = setTimeout(() => {
      timer = null
      inFlight = pollOnce().finally(() => { inFlight = null })
    }, delaySeconds * 1000)
  }

  /** @returns {Promise<void>} */
  async function pollOnce() {
    const controller = new AbortController()
    activeController = controller
    // Not unref'd (matching the loop's no-unref policy): the deadline
    // must be able to fire while a wedged poll is the only live
    // handle, and it is cleared as soon as the poll settles.
    const deadline = setTimeout(
      () => controller.abort(new Error(`config poll exceeded ${requestTimeoutSeconds}s`)),
      requestTimeoutSeconds * 1000
    )
    let nextDelay = pollIntervalSeconds
    try {
      const outcome = await pull(controller.signal)
      if (outcome === 'retry_backoff') {
        nextDelay = RETRY_BACKOFF_SECONDS[
          Math.min(consecutiveFailures, RETRY_BACKOFF_SECONDS.length) - 1
        ] ?? RETRY_BACKOFF_SECONDS[RETRY_BACKOFF_SECONDS.length - 1]
      } else if (outcome === 'legacy_404') {
        nextDelay = Math.max(LEGACY_404_BACKOFF_SECONDS, pollIntervalSeconds)
      } else if (typeof outcome === 'number') {
        nextDelay = outcome
      }
    } catch (err) {
      // An abort from stop() is the shutdown path, not a poll failure.
      if (!(stopped && controller.signal.aborted)) {
        consecutiveFailures += 1
        const message = err instanceof Error ? err.message : String(err)
        log.warn('central.config.poll_failed', {
          error_kind: 'config_poll_error',
          consecutive_failures: consecutiveFailures,
          message,
        })
        nextDelay = RETRY_BACKOFF_SECONDS[
          Math.min(consecutiveFailures, RETRY_BACKOFF_SECONDS.length) - 1
        ]
      }
    } finally {
      clearTimeout(deadline)
      activeController = null
    }
    schedule(nextDelay)
  }

  /**
   * One poll. Returns `'ok'`, `'retry_backoff'`, `'legacy_404'`, or an
   * explicit next-delay in seconds (server-provided `Retry-After`).
   *
   * @param {AbortSignal} signal
   * @returns {Promise<'ok' | 'retry_backoff' | 'legacy_404' | number>}
   */
  async function pull(signal) {
    const url = joinUrl(centralUrl, '/v1/config')
    const runningEtag = configControl.runningEtag()

    let response = await doFetch(url, runningEtag, signal)
    if (response.status === 401) {
      // One-shot refresh + retry; a second 401 escalates as an auth
      // failure (proto.md "Refresh window").
      await identityClient.refresh()
      response = await doFetch(url, runningEtag, signal)
      if (response.status === 401) {
        consecutiveFailures += 1
        log.error('central.config.poll_failed', {
          error_kind: 'config_poll_auth_failed',
          http_status: 401,
        })
        return 'retry_backoff'
      }
    }

    if (response.status === 304) {
      consecutiveFailures = 0
      configControl.confirmPoll()
      log.info('central.config.poll', {
        hyp_operation: 'config.pull',
        http_status: 304,
        status: 'ok',
      })
      return 'ok'
    }

    if (response.status === 200) {
      const etag = response.headers.get('etag')
      const read = await readBodyCapped(response, MAX_CONFIG_DOCUMENT_BYTES, signal)
      if (!read.ok) {
        consecutiveFailures += 1
        log.error('central.config.poll_failed', {
          error_kind: 'config_document_too_large',
          http_status: 200,
          body_bytes: read.bytesRead,
        })
        return 'retry_backoff'
      }
      const body = read.body
      if (!etag) {
        consecutiveFailures += 1
        log.error('central.config.poll_failed', {
          error_kind: 'config_missing_etag',
          http_status: 200,
        })
        return 'retry_backoff'
      }
      /** @type {unknown} */
      let document
      try {
        document = JSON.parse(body)
      } catch (err) {
        consecutiveFailures += 1
        log.error('central.config.poll_failed', {
          error_kind: 'config_invalid_json',
          http_status: 200,
          message: err instanceof Error ? err.message : String(err),
        })
        return 'retry_backoff'
      }
      consecutiveFailures = 0
      // The 200 itself is a successful authenticated poll: it clears
      // any active probation before the new revision stages its own.
      // A probation-clearing poll returning a newer revision chains
      // into the next apply by design.
      configControl.confirmPoll()
      const staged = await configControl.stage(document, etag)
      log.info('central.config.poll', {
        hyp_operation: 'config.pull',
        http_status: 200,
        config_etag: etag,
        apply_action: staged.ok ? staged.action : 'failed',
        ...(staged.ok ? {} : { error_kind: staged.errorKind }),
        status: staged.ok ? 'ok' : 'failed',
      })
      return 'ok'
    }

    if (response.status === 404) {
      // Legacy-only branch: servers that mint tokens without a config.
      if (consecutiveFailures === 0) {
        log.warn('central.config.poll', {
          hyp_operation: 'config.pull',
          http_status: 404,
          status: 'skipped',
          hyp_reason: 'no_config_registered_legacy',
        })
      }
      consecutiveFailures += 1
      return 'legacy_404'
    }

    if (response.status === 429 || response.status === 503) {
      consecutiveFailures += 1
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
      log.warn('central.config.poll_failed', {
        error_kind: 'config_poll_throttled',
        http_status: response.status,
        ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}),
      })
      // Honor only a *positive* Retry-After. A legal `0` or a past HTTP-date
      // parses to 0: rescheduling at 0s would re-poll immediately and spin;
      // fall through to the ladder ('retry_backoff') instead.
      return retryAfter ? retryAfter : 'retry_backoff'
    }

    consecutiveFailures += 1
    log.warn('central.config.poll_failed', {
      error_kind: 'config_poll_http_error',
      http_status: response.status,
    })
    return 'retry_backoff'
  }

  /**
   * @param {string} url
   * @param {string | undefined} runningEtag
   * @param {AbortSignal} signal
   */
  async function doFetch(url, runningEtag, signal) {
    const jwt = await identityClient.getCurrentJwt()
    return abortable(
      fetchFn(url, {
        method: 'GET',
        signal,
        headers: {
          authorization: `Bearer ${jwt}`,
          // If-None-Match always reflects the *running* config: the
          // server reads it as the fleet-convergence signal, so a
          // gateway mid-apply keeps presenting its old etag.
          ...(runningEtag ? { 'if-none-match': runningEtag } : {}),
        },
      }),
      signal
    )
  }

  return {
    /** Pull immediately, then settle into the steady cadence. */
    start() {
      if (stopped || timer || inFlight) return
      inFlight = pollOnce().finally(() => { inFlight = null })
    },
    /**
     * Stop polling. Lets an in-flight poll drain for a short grace
     * (a mid-flight apply should commit, not be cancelled), then
     * aborts it, so the wait is bounded even against a stalled
     * server or a `fetchFn` that ignores abort signals.
     */
    async stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (inFlight) {
        // Not unref'd: against a fetch wedged on the last live handle,
        // an unref'd grace timer would let the event loop drain before
        // it ever fired, leaving stop() hanging on the poll forever.
        const grace = setTimeout(() => {
          activeController?.abort(new Error('config pull loop stopped'))
        }, stopGraceSeconds * 1000)
        try {
          await inFlight
        } finally {
          clearTimeout(grace)
        }
      }
    },
  }
}

/**
 * Read a response body under a hard byte cap without ever buffering
 * past it: an oversized `Content-Length` is rejected before any read,
 * and a chunked body is streamed through a byte counter that cancels
 * the moment it crosses the cap. Responses without a readable stream
 * (e.g. test doubles) fall back to `text()` with a post-hoc check.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @param {AbortSignal} signal
 * @returns {Promise<{ ok: true, body: string } | { ok: false, bytesRead: number }>}
 */
async function readBodyCapped(response, maxBytes, signal) {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    if (response.body) await response.body.cancel().catch(() => {})
    return { ok: false, bytesRead: contentLength }
  }
  if (!response.body) {
    const text = await abortable(response.text(), signal)
    const bytes = Buffer.byteLength(text, 'utf8')
    return bytes > maxBytes ? { ok: false, bytesRead: bytes } : { ok: true, body: text }
  }
  const reader = response.body.getReader()
  /** @type {Uint8Array[]} */
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await abortable(reader.read(), signal)
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      reader.cancel().catch(() => {})
      return { ok: false, bytesRead: total }
    }
    chunks.push(value)
  }
  return { ok: true, body: Buffer.concat(chunks).toString('utf8') }
}

/**
 * Await `promise`, but reject as soon as `signal` aborts, even when
 * the underlying promise never settles. A misbehaving `fetchFn` (or a
 * server that stalls mid-body) must not be able to wedge `stop()`,
 * and through it daemon shutdown.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

/** @param {AbortSignal} signal */
function abortReason(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted'))
}

/**
 * @param {string} base
 * @param {string} suffix
 */
function joinUrl(base, suffix) {
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`
  return new URL(suffix.replace(/^\//, ''), baseWithSlash).toString()
}
