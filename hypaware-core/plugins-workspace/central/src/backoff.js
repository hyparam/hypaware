// @ts-check

/**
 * Retry/backoff for the central plugin's two HTTP loops: the config pull
 * ({@link ./config_client.js}) and the forward sink's ingest POSTs
 * ({@link ./sink.js}). Both face the same server contract: `429`/`503`
 * carry a `Retry-After` the client honors, and a linear ladder is the
 * fallback when the header is absent or garbage (proto.md, "Response 429 /
 * 503"). The generic primitives live in `src/core/util/backoff.js` and are
 * re-exported here; the operation lifetime and response cap are central's.
 */

import { abortReason, readBodyCapped } from '../../../../src/core/util/backoff.js'

export {
  RETRY_BACKOFF_SECONDS,
  abortableSleep,
  discardBody,
  parseRetryAfter,
  readBodyCapped,
} from '../../../../src/core/util/backoff.js'

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
