import { SseParser, isSseHeaders } from '../sse.js'

/**
 * @import { SseEvent } from '../types.js'
 */

const DEFAULT_INITIAL_BACKOFF_MS = 1000
const DEFAULT_MAX_BACKOFF_MS = 30000

/**
 * Open an SSE stream against `url` and run a reconnect loop. Each connection
 * attempt uses `Last-Event-ID` (when set) so the server can resume; on a
 * disconnect the loop sleeps with exponential backoff (capped by
 * `maxBackoffMs`) and tries again. The loop exits cleanly when `signal` is
 * aborted.
 *
 * The caller's `onEvent` is awaited so the stream applies natural backpressure
 * across slow consumers; an awaited rejection is treated as a stream-fatal
 * error and surfaces through `onError` (the loop continues to reconnect).
 *
 * `lastEventId` is updated by this function as events come in, so a reconnect
 * attempt sends the most recent id observed even if the consumer has not
 * persisted it yet (the consumer's persistence cadence is independent).
 *
 * @param {{
 *   url: string,
 *   signal: AbortSignal,
 *   onEvent: (event: SseEvent) => void | Promise<void>,
 *   onError?: (msg: string) => void,
 *   onConnect?: () => void,
 *   initialLastEventId?: string,
 *   initialBackoffMs?: number,
 *   maxBackoffMs?: number,
 *   fetchFn?: typeof fetch,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
 * }} opts
 * @returns {Promise<void>} Resolves when `signal` aborts.
 */
export async function streamSse(opts) {
  const {
    url,
    signal,
    onEvent,
    onError = noop,
    onConnect = noop,
    initialBackoffMs = DEFAULT_INITIAL_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    fetchFn = globalThis.fetch,
    sleep = defaultSleep,
  } = opts
  let lastEventId = opts.initialLastEventId
  let attempt = 0
  while (!signal.aborted) {
    /** @type {Record<string, string>} */
    const headers = { accept: 'text/event-stream' }
    if (lastEventId !== undefined) {
      headers['Last-Event-ID'] = lastEventId
    }
    /** @type {Response} */
    let response
    try {
      response = await fetchFn(url, { headers, signal })
    } catch (err) {
      if (signal.aborted) return
      onError(`gascity: SSE connect failed for ${url}: ${formatError(err)}`)
      await sleepWithBackoff(sleep, computeBackoff(attempt, initialBackoffMs, maxBackoffMs), signal)
      attempt += 1
      continue
    }
    if (!response.ok) {
      onError(`gascity: SSE upstream returned HTTP ${response.status} for ${url}`)
      await drainBody(response)
      await sleepWithBackoff(sleep, computeBackoff(attempt, initialBackoffMs, maxBackoffMs), signal)
      attempt += 1
      continue
    }
    if (!isSseHeaders(headersToRecord(response.headers))) {
      const ct = response.headers.get('content-type') ?? '<missing>'
      onError(`gascity: SSE upstream sent non-event-stream content-type ${ct} for ${url}`)
      await drainBody(response)
      await sleepWithBackoff(sleep, computeBackoff(attempt, initialBackoffMs, maxBackoffMs), signal)
      attempt += 1
      continue
    }
    onConnect()
    attempt = 0
    try {
      lastEventId = await consumeStream(response, onEvent, lastEventId)
    } catch (err) {
      if (signal.aborted) return
      onError(`gascity: SSE stream error for ${url}: ${formatError(err)}`)
    }
    if (signal.aborted) return
    // Stream ended without an abort — backoff and reconnect.
    await sleepWithBackoff(sleep, computeBackoff(attempt, initialBackoffMs, maxBackoffMs), signal)
    attempt += 1
  }
}

/**
 * Read the response body, parse SSE chunks, and drive `onEvent`. Returns the
 * most recent `id:` value observed (or whatever was passed in) so the caller
 * can use it for the next reconnect.
 *
 * @param {Response} response
 * @param {(event: SseEvent) => void | Promise<void>} onEvent
 * @param {string | undefined} initialLastEventId
 * @returns {Promise<string | undefined>}
 */
async function consumeStream(response, onEvent, initialLastEventId) {
  if (!response.body) return initialLastEventId
  const reader = response.body.getReader()
  const parser = new SseParser()
  let lastEventId = initialLastEventId
  while (true) {
    const { value, done } = await reader.read()
    if (done) return lastEventId
    const events = parser.feed(Buffer.from(value))
    for (const ev of events) {
      if (ev.id !== undefined) lastEventId = ev.id
      await onEvent(ev)
    }
  }
}

/**
 * Compute the backoff delay for `attempt`. Doubles per attempt, capped by
 * `maxBackoffMs`. Adds a small jitter so a fleet of subscribers reconnecting
 * after a supervisor bounce doesn't thunder back at the exact same instant.
 *
 * @param {number} attempt
 * @param {number} initial
 * @param {number} max
 * @returns {number}
 */
export function computeBackoff(attempt, initial = DEFAULT_INITIAL_BACKOFF_MS, max = DEFAULT_MAX_BACKOFF_MS) {
  const base = Math.min(initial * 2 ** attempt, max)
  // Jitter ±10% to spread reconnects.
  const jitter = base * 0.1 * (Math.random() * 2 - 1)
  return Math.max(0, Math.round(base + jitter))
}

/**
 * @param {(ms: number, signal: AbortSignal) => Promise<void>} sleep
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
async function sleepWithBackoff(sleep, ms, signal) {
  if (signal.aborted) return
  try {
    await sleep(ms, signal)
  } catch {
    // Aborted during sleep is the normal shutdown path; the outer while
    // loop's `signal.aborted` check will pick it up on the next iteration.
  }
}

/**
 * Default sleep that respects an AbortSignal — resolves on timeout, rejects on
 * abort. Tests inject their own to step through reconnect cycles
 * deterministically.
 *
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function defaultSleep(ms, signal) {
  return new Promise(function(resolve, reject) {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(function() {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Discard a response body so the connection is released back to the pool.
 *
 * @param {Response} response
 * @returns {Promise<void>}
 */
async function drainBody(response) {
  if (!response.body) return
  try {
    const reader = response.body.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) return
    }
  } catch {
    // Best effort; the connection may already be closed.
  }
}

/**
 * @param {Headers} headers
 * @returns {Record<string, string>}
 */
function headersToRecord(headers) {
  /** @type {Record<string, string>} */
  const out = {}
  headers.forEach(function(value, key) {
    out[key] = value
  })
  return out
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * @returns {void}
 */
function noop() {}
