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

// @ref LLP 0471#chunk-lifetime [implements]: one elapsed deadline owns auth, fetch, body and retry wait
export const CENTRAL_OPERATION_TIMEOUT_MS = 330_000
// Reuse the existing central config transport bound. Identity fixtures carry a
// small JWT/expiry object; ingest/registration acknowledgements need no body.
export const MAX_CENTRAL_RESPONSE_BYTES = 1024 * 1024

/** @param {AbortSignal | undefined} parent @param {string} operation */
export function centralLifetime(parent, operation) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(abortReason(parent))
  parent?.addEventListener('abort', onAbort, { once: true })
  if (parent?.aborted) onAbort()
  const timer = setTimeout(() => controller.abort(new Error(`${operation} exceeded 330s`)), CENTRAL_OPERATION_TIMEOUT_MS)
  return {
    signal: controller.signal,
    /** @param {unknown} reason */
    abort(reason) { controller.abort(reason) },
    dispose() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

/** @param {Response} response */
export async function discardBody(response) {
  try { await response.body?.cancel() } catch { /* already settled */ }
}

/**
 * A native fetch has already received its owner's signal. The reader is also
 * cancelled explicitly on abort, and cleanup is awaited before releasing bytes.
 * No loser fetch/read is left running behind a timeout receipt.
 * @param {Response} response
 * @param {number} maxBytes
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: true, body: string } | { ok: false, bytesRead: number }>}
 */
export async function readBodyCapped(response, maxBytes, signal) {
  signal?.throwIfAborted()
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await discardBody(response)
    return { ok: false, bytesRead: contentLength }
  }
  if (!response.body?.getReader) {
    // Non-streaming test doubles only. Native responses always take the reader.
    const body = await response.text()
    signal?.throwIfAborted()
    const bytesRead = Buffer.byteLength(body, 'utf8')
    return bytesRead > maxBytes ? { ok: false, bytesRead } : { ok: true, body }
  }
  const reader = response.body.getReader()
  /** @type {Uint8Array[]} */
  const chunks = []
  let total = 0
  let ended = false
  /** @type {Promise<void> | undefined} */
  let cancellation
  const cancel = () => {
    cancellation ??= reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (signal?.aborted) cancel()
    for (;;) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) { ended = true; break }
      total += value.byteLength
      if (total > maxBytes) return { ok: false, bytesRead: total }
      chunks.push(value)
    }
    return { ok: true, body: Buffer.concat(chunks, total).toString('utf8') }
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (!ended) cancel()
    await cancellation
    chunks.length = 0
    reader.releaseLock()
  }
}

/** @param {Response} response @param {AbortSignal} [signal] */
export async function readCentralJson(response, signal) {
  const result = await readBodyCapped(response, MAX_CENTRAL_RESPONSE_BYTES, signal)
  if (!result.ok) throw new Error('central response exceeds 1MiB')
  try { return JSON.parse(result.body) } catch { throw new Error('central response invalid JSON') }
}

/**
 * Retain status, never an unfiltered server body that may echo private payload.
 * Read under the transport cap so stalled/error responses obey the same lifetime.
 * @param {Response} response
 * @param {AbortSignal} [signal]
 */
export async function readErrorDetail(response, signal) {
  await readBodyCapped(response, MAX_CENTRAL_RESPONSE_BYTES, signal)
  return `HTTP ${response.status}`
}
