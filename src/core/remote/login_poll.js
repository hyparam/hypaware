// @ts-check

import { Attr, getLogger } from '../observability/index.js'
import { NO_FETCH_MESSAGE, trimSlash } from './identity_client.js'

/**
 * Poll-based login completion (LLP 0337). The client prints/opens the
 * `/login/start` URL and *pulls* the outcome from the server instead of
 * listening for a loopback redirect: the flight parks when the browser opens
 * the start URL, the callback holds the one-time code (or the D7 refusal) on
 * the flight, and `GET /login/poll?state=` hands it over exactly once. This
 * replaced the ephemeral 127.0.0.1 receiver, whose redirect only delivered
 * when the browser and the CLI shared a loopback interface (broken over SSH).
 *
 * Exposes the same `{ waitForCode, close }` seam the loopback receiver did,
 * so `loginWithBrowser` swaps delivery mechanisms without changing shape.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_INTERVAL_MS = 2000

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Start the login poller. `waitForCode()` polls the identity base's
 * `/login/poll` until the flight settles: it resolves `{ code }` on
 * `status: complete`, rejects with a `callbackError`-carrying error on
 * `status: failed` (the D7 code the redirect's `error=` used to carry), and
 * rejects on timeout or on a server that predates the poll endpoint.
 *
 * `unknown_state` is NOT terminal: the flight parks only when the browser
 * opens the start URL, so every poll before the user clicks legitimately
 * answers 404 unknown_state, and the poller keeps going to the deadline. A
 * stale server is told apart by the *shape* of its 404: the generic
 * `unknown_path` (or anything that is not `unknown_state`), which no
 * poll-capable server returns on this path.
 *
 * Transient trouble (a network error, a 5xx, a 429) never fails the login:
 * the poller keeps polling to the deadline, honoring `retry-after` on a 429
 * so it cannot poll itself into the limiter's escalating lockout.
 *
 * @param {{
 *   identityBase: string,
 *   state: string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 * }} args
 * @returns {{ waitForCode: () => Promise<{ code: string }>, close: () => void }}
 * @ref LLP 0337#d3 [implements]: 2s cadence, 5-minute budget, single delivery consumed on pickup; the token exchange downstream is untouched
 */
export function startLoginPoller({
  identityBase,
  state,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  fetchImpl,
  sleep = defaultSleep,
}) {
  const log = getLogger('remote')
  const doFetch = fetchImpl ?? /** @type {typeof fetch | undefined} */ (globalThis.fetch)
  let closed = false

  const pollUrl = new URL(`${trimSlash(identityBase)}/login/poll`)
  pollUrl.searchParams.set('state', state)

  /** @param {string} message @param {string} kind @param {string} [callbackError] */
  function fail(message, kind, callbackError) {
    log.warn('remote.login_poll_error', {
      [Attr.COMPONENT]: 'remote-oidc',
      [Attr.OPERATION]: 'remote.login_poll',
      [Attr.STATUS]: 'failed',
      [Attr.ERROR_KIND]: kind,
      smoke_step: 'login_poll',
    })
    const err = new Error(message)
    if (callbackError) Object.assign(err, { callbackError })
    return err
  }

  return {
    async waitForCode() {
      if (typeof doFetch !== 'function') throw new Error(NO_FETCH_MESSAGE)
      log.info('remote.login_poll_start', {
        [Attr.COMPONENT]: 'remote-oidc',
        [Attr.OPERATION]: 'remote.login_poll',
        [Attr.STATUS]: 'ok',
        smoke_step: 'login_poll_start',
      })
      const deadline = Date.now() + timeoutMs
      for (;;) {
        if (closed) throw new Error('login poller closed before a code arrived')

        /** @type {Response | undefined} */
        let response
        /** @type {any} */
        let body
        try {
          response = await doFetch(pollUrl.toString(), { headers: { accept: 'application/json' } })
          body = JSON.parse(await response.text())
        } catch {
          // A network error or an unparseable body is transient: keep polling
          // to the deadline rather than failing a login the human may be
          // mid-completing in the browser.
          body = undefined
        }

        // Honor the limiter's hint before anything else: polling through a
        // 429 would walk the source into the escalating lockout.
        let delayMs = intervalMs
        if (response) {
          if (response.status === 200 && body?.status === 'complete' && typeof body.code === 'string') {
            log.info('remote.login_poll_complete', {
              [Attr.COMPONENT]: 'remote-oidc',
              [Attr.OPERATION]: 'remote.login_poll',
              [Attr.STATUS]: 'ok',
              smoke_step: 'login_poll_complete',
            })
            return { code: body.code }
          }
          if (response.status === 200 && body?.status === 'failed') {
            // The D7 refusal, riding the poll body where the redirect's
            // `error=` used to carry it. Bound it before it reaches the error
            // message, the log ERROR_KIND, and the terminal.
            const safeError = sanitizeErrorCode(typeof body.error === 'string' ? body.error : '')
            throw fail(`login failed: ${safeError}`, safeError, safeError)
          }
          if (response.status === 404 && body?.error !== 'unknown_state') {
            // A poll-capable server answers this path with unknown_state or a
            // flight status, never the generic unknown_path 404: this server
            // predates poll login (LLP 0337#d2). Fail loudly, not by timeout.
            throw fail("this server does not support poll login yet - upgrade hypaware-server (or pass a static token with --token-file <path>)", 'no_poll_endpoint')
          }
          if (response.status === 429) {
            const retryAfter = Number(response.headers?.get?.('retry-after'))
            if (Number.isFinite(retryAfter) && retryAfter > 0) delayMs = Math.max(delayMs, retryAfter * 1000)
          }
          // 200 pending, 404 unknown_state (the browser has not opened the
          // start URL yet), and transient 5xx all just keep polling.
        }

        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw fail('timed out waiting for the browser login to complete', 'timeout')
        }
        // Floor at 1ms so a non-positive intervalMs (test seam) cannot
        // busy-spin; cap at the remaining budget so we never oversleep it.
        await sleep(Math.max(1, Math.min(delayMs, remaining)))
      }
    },

    close() {
      closed = true
    },
  }
}

/**
 * Reduce a server-reported login error to a bounded, log-safe token. RFC 6749
 * error codes are `%x20-21 / %x23-5B / %x5D-7E`; we keep that printable range,
 * drop control chars (newlines especially), and cap the length so a hostile
 * response can't inject lines into logs or the terminal.
 *
 * @param {string} error
 * @returns {string}
 */
function sanitizeErrorCode(error) {
  const cleaned = error.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '').trim().slice(0, 80)
  return cleaned || 'unknown_error'
}
