// @ts-check

/**
 * Generic retry/backoff primitives for HTTP loops that face a server which
 * paces clients with `Retry-After` on `429`/`503` and expects a linear ladder
 * when the header is absent or garbage. The central plugin's config pull and
 * forward sink were the first users (central `proto.md`, "Response 429 /
 * 503"); its operation lifetime and response cap stay in
 * `hypaware-core/plugins-workspace/central/src/backoff.js`.
 */

/** Linear backoff ladder (seconds) for 429/503/transport failures. */
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
 * backpressure wait cannot wedge its owner's `close()` or, through it,
 * daemon shutdown. With no signal it is a plain timed sleep. The timer is
 * not unref'd: an export deliberately pausing for the server to refill its
 * budget is legitimate work, not an idle handle.
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

/**
 * The signal's reason as an `Error`, wrapping a non-Error reason.
 *
 * @param {AbortSignal} [signal]
 */
export function abortReason(signal) {
  const reason = signal?.reason
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'))
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
