// @ts-check

/**
 * Shared retry/backoff primitives for the central plugin's two HTTP
 * loops: the config pull ({@link ./config_client.js}) and the forward
 * sink's ingest POSTs ({@link ./sink.js}). Both face the same server
 * contract: `429`/`503` carry a `Retry-After` the client honors, and a
 * linear ladder is the fallback when the header is absent or garbage
 * (proto.md, "Response 429 / 503").
 */

/** Linear backoff ladder (seconds) for 429/503/transport failures, per proto.md. */
export const RETRY_BACKOFF_SECONDS = [30, 60, 120, 300]

/**
 * Parse a `Retry-After` header into whole seconds: delta-seconds or an
 * HTTP-date, anything unparseable → `undefined`. A literal `0` or a past
 * HTTP-date faithfully parses to `0`. Callers must treat any non-positive
 * (or `undefined`) result as "no useful pacing" and fall back to the
 * backoff ladder: never honor it as a zero-delay retry, which would spin
 * the retry loop.
 *
 * @param {string | null} value
 * @returns {number | undefined}
 */
export function parseRetryAfter(value) {
  if (!value) return undefined
  const seconds = Number.parseInt(value, 10)
  if (Number.isInteger(seconds) && seconds >= 0) return seconds
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, Math.round((date - Date.now()) / 1000))
  return undefined
}

/**
 * Sleep `ms`, but reject as soon as `signal` aborts, so an in-flight
 * backpressure wait inside `exportBatch` cannot wedge sink `close()` or,
 * through it, daemon shutdown. With no signal it is a plain timed sleep.
 * The timer is not unref'd: an export deliberately pausing for the
 * server to refill its budget is legitimate work, not an idle handle.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    /** @type {NodeJS.Timeout} */
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** @param {AbortSignal} [signal] */
function abortReason(signal) {
  const reason = signal?.reason
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'))
}
