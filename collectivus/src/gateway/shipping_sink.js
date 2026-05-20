/**
 * @import { Sink } from '../types.js'
 * @import { IngestSignal } from '../server/types.d.ts'
 * @import { ShippingSinkOptions } from './types.d.ts'
 */

/**
 * Default per-signal flush thresholds. The triple — 1000 rows OR 1 MB OR 5
 * seconds (whichever first) — comes from the bead spec. Tuned against the
 * server-side ingest endpoint's 16 MB body cap (16x headroom) and the typical
 * proxy row size of a few KB.
 */
export const DEFAULT_MAX_ROWS = 1000
export const DEFAULT_MAX_BYTES = 1024 * 1024
export const DEFAULT_MAX_SECONDS = 5

/**
 * Gateway-side `Sink` that batches rows by signal and ships them to the
 * central server's `POST /v1/ingest/<signal>` endpoint. v0 buffers each batch
 * fully in memory (capped at 1 MB) and posts via `fetch`; the durable on-disk
 * outbox lands in C.4 as a wrapper around this class.
 *
 * Construction is cheap and side-effect-free. Per-signal accumulators are
 * created lazily on the first matching `writeRow`. A flush is triggered as
 * soon as any one of (rows, bytes, time-since-first-row) hits its threshold.
 *
 * Concurrency: the synchronous segments of `writeRow` and `scheduleFlush` are
 * structured so that the size check + snapshot + reset run atomically (no
 * `await` between push and reset). A second concurrent `writeRow` either lands
 * in the same batch (before the threshold hit) or starts a fresh one (after
 * the snapshot/reset). Per-signal ships are serialized via a promise chain so
 * the server sees batches in submission order.
 *
 * @implements {Sink}
 */
export class ShippingSink {
  /**
   * @param {ShippingSinkOptions & {
   *   fetchFn?: typeof fetch,
   *   setTimeoutFn?: (handler: () => void, ms: number) => unknown,
   *   clearTimeoutFn?: (handle: unknown) => void,
   *   now?: () => number,
   * }} opts Test hooks let tests drive the sink deterministically without
   *   real timers or sockets. The timer hooks intentionally take a structural
   *   `(fn, ms) => handle` shape so a fake can return a plain number — the
   *   built-in `setTimeout` typedef requires extra fields (`__promisify__`)
   *   that fakes shouldn't have to implement.
   */
  constructor(opts) {
    if (!opts || typeof opts.centralUrl !== 'string' || opts.centralUrl.length === 0) {
      throw new Error('ShippingSink: centralUrl is required')
    }
    if (!opts.identityClient) {
      throw new Error('ShippingSink: identityClient is required')
    }
    /** @type {string} */
    this.centralUrl = opts.centralUrl
    /** @type {{ getCurrentJwt(): Promise<string>, refresh(): Promise<void> }} */
    this.identityClient = opts.identityClient
    /** @type {IngestSignal} */
    this.signal = opts.signal ?? 'proxy'
    const batch = opts.batch ?? {}
    /** @type {number} */
    this.maxRows = batch.maxRows ?? DEFAULT_MAX_ROWS
    /** @type {number} */
    this.maxBytes = batch.maxBytes ?? DEFAULT_MAX_BYTES
    /** @type {number} */
    this.maxSeconds = batch.maxSeconds ?? DEFAULT_MAX_SECONDS
    /** @type {typeof fetch} */
    this.fetchFn = opts.fetchFn ?? fetch
    /** @type {(handler: () => void, ms: number) => unknown} */
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout
    /** @type {(handle: unknown) => void} */
    this.clearTimeoutFn = opts.clearTimeoutFn ?? /** @type {(handle: unknown) => void} */ (clearTimeout)
    /** @type {() => number} */
    this.now = opts.now ?? Date.now

    /**
     * Per-signal accumulator state. The shape is preserved for forward-
     * compatibility with multi-signal sinks even though v0 only writes to
     * `this.signal`.
     *
     * @type {Map<string, { lines: string[], bytes: number, timer: unknown }>}
     */
    this.batches = new Map()
    /**
     * Per-signal ship-promise chains. Concurrent flushes for the same signal
     * are serialized so the server sees batches in submission order and a
     * size-flush can't race with the close-time drain.
     *
     * @type {Map<string, Promise<void>>}
     */
    this.shipChains = new Map()
    /**
     * Set of in-flight ship promises (the rejecting variant — chains store the
     * swallowed variant). `whenIdle` and `close` use this to drain.
     *
     * @type {Set<Promise<void>>}
     */
    this.activeShips = new Set()
    /** @type {boolean} */
    this.closed = false
  }

  /**
   * Append a row to the current batch for `this.signal`. Resolves immediately
   * after the row is enqueued — the row is not yet on the wire. Use `close()`
   * (or `whenIdle()` in tests) to wait for in-flight ships to settle.
   *
   * Triggers a flush synchronously when the row pushes the batch over any
   * threshold. The flush itself runs as a fire-and-forget chain — `writeRow`
   * does not await it so a slow server can't backpressure individual writes.
   *
   * @param {unknown} obj
   * @returns {Promise<void>}
   */
  async writeRow(obj) {
    if (this.closed) throw new Error('ShippingSink: writeRow after close')
    const line = JSON.stringify(obj)
    if (typeof line !== 'string') {
      // JSON.stringify returns undefined for `undefined`/functions/symbols;
      // surface that as an explicit error rather than writing the literal
      // string "undefined" into the NDJSON stream.
      throw new Error('ShippingSink: writeRow value is not JSON-serializable')
    }
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1
    const signal = this.signal
    const b = this.ensureBatch(signal)
    b.lines.push(line)
    b.bytes += lineBytes

    if (b.lines.length === 1 && b.timer === undefined) {
      // Time-based countdown anchors on the first row of THIS batch — once a
      // size flush rotates the batch, the next row starts a fresh clock.
      const handle = this.setTimeoutFn(() => {
        b.timer = undefined
        this.scheduleFlush(signal)
      }, this.maxSeconds * 1000)
      if (handle && typeof handle === 'object' && 'unref' in handle && typeof handle.unref === 'function') {
        handle.unref()
      }
      b.timer = handle
    }

    if (b.lines.length >= this.maxRows || b.bytes >= this.maxBytes) {
      this.scheduleFlush(signal)
    }
  }

  /**
   * Snapshot the current batch and chain a ship behind any in-flight ship for
   * the same signal. Synchronous up to the chain mutation; the actual POST
   * runs in the returned promise.
   *
   * Idempotent and race-free: a second call before the first has cleared the
   * batch (impossible in v0 because the snapshot+reset is synchronous) would
   * still produce a non-overlapping snapshot.
   *
   * @param {string} signal
   * @returns {void}
   */
  scheduleFlush(signal) {
    const b = this.batches.get(signal)
    if (!b || b.lines.length === 0) return

    const snapshot = b.lines
    b.lines = []
    b.bytes = 0
    if (b.timer !== undefined) {
      this.clearTimeoutFn(b.timer)
      b.timer = undefined
    }

    const previous = this.shipChains.get(signal) ?? Promise.resolve()
    const next = previous.then(() => this.shipBatch(signal, snapshot))
    // Park a swallowed copy on the chain so the next caller can `then` off it
    // without inheriting our rejection. The original `next` still rejects for
    // tests / `close()` via `activeShips`.
    this.shipChains.set(signal, next.catch(() => {}))
    this.activeShips.add(next)
    next.catch(() => {}).finally(() => {
      this.activeShips.delete(next)
    })
  }

  /**
   * Ship a single batch to `<centralUrl>/v1/ingest/<signal>`. On 401, refresh
   * the JWT exactly once and retry — a single pass covers the common cases
   * (clock skew, server-side rotation catching a stale token); a second 401
   * means the issuer secret is wrong and additional retries won't help. Other
   * non-2xx statuses throw — C.4's durable outbox + backoff handles retry.
   *
   * @param {string} signal
   * @param {string[]} lines
   * @returns {Promise<void>}
   */
  async shipBatch(signal, lines) {
    if (lines.length === 0) return
    const url = joinUrl(this.centralUrl, `/v1/ingest/${signal}`)
    const body = lines.join('\n') + '\n'
    let jwt = await this.identityClient.getCurrentJwt()
    let response = await this.postBatch(url, jwt, body)
    if (response.status === 401) {
      await this.identityClient.refresh()
      jwt = await this.identityClient.getCurrentJwt()
      response = await this.postBatch(url, jwt, body)
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response)
      throw new Error(`ingest failed: ${detail}`)
    }
  }

  /**
   * Issue a single POST against the ingest endpoint with the supplied JWT.
   *
   * @param {string} url
   * @param {string} jwt
   * @param {string} body
   * @returns {Promise<Response>}
   */
  async postBatch(url, jwt, body) {
    return this.fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/x-ndjson',
      },
      body,
    })
  }

  /**
   * Resolve once every in-flight ship has settled (success or failure). Loops
   * because an in-flight ship may itself trigger another via the time-based
   * flush as it completes.
   *
   * @returns {Promise<void>}
   */
  async whenIdle() {
    while (this.activeShips.size > 0) {
      const snapshot = [...this.activeShips]
      await Promise.allSettled(snapshot)
    }
  }

  /**
   * Flush any pending batches and wait for in-flight ships to settle. Marks
   * the sink closed; subsequent `writeRow` calls reject. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.closed) return
    this.closed = true
    for (const signal of [...this.batches.keys()]) {
      this.scheduleFlush(signal)
    }
    await this.whenIdle()
  }

  /**
   * Lazily create the per-signal accumulator. Extracted so future multi-signal
   * variants can subclass without rewriting `writeRow`.
   *
   * @param {string} signal
   * @returns {{ lines: string[], bytes: number, timer: unknown }}
   */
  ensureBatch(signal) {
    let b = this.batches.get(signal)
    if (b === undefined) {
      b = { lines: [], bytes: 0, timer: undefined }
      this.batches.set(signal, b)
    }
    return b
  }
}

/**
 * Join a base URL and path, allowing the base URL to optionally include a
 * trailing slash. Mirrors the helper in `gateway/identity.js` so the URL
 * composition rules stay consistent across all gateway -> central calls.
 *
 * @param {string} base
 * @param {string} suffix
 * @returns {string}
 */
function joinUrl(base, suffix) {
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`
  return new URL(suffix.replace(/^\//, ''), baseWithSlash).toString()
}

/**
 * Pull a useful one-liner out of a non-2xx ingest response. Falls back to
 * `<status> <statusText>` when the server returned no parseable body.
 *
 * @param {Response} response
 * @returns {Promise<string>}
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
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const error = typeof parsed.error === 'string' ? parsed.error : undefined
        if (error) return `${response.status} ${error}`
      }
    } catch {
      // Plain-text or non-JSON error body — fall through.
    }
    return `${response.status} ${body.trim().slice(0, 200)}`
  }
  return `${response.status} ${response.statusText || ''}`.trim()
}
