import { randomBytes } from 'node:crypto'
import { SseParser, isSseHeaders } from './sse.js'

/**
 * @import { Sink, ClientInfo, ClaudeSessionContext, ExchangeResponse, ShouldDropPredicate } from './types.js'
 */

export { isSseHeaders }

/**
 * Headers redacted by default. Operators can extend this set per-config; this
 * list cannot be shrunk because these specifically carry credentials or
 * session state that must never appear verbatim in recordings.
 */
const DEFAULT_REDACT_HEADERS = [
  'authorization',
  'x-api-key',
  'anthropic-api-key',
  'cookie',
  'set-cookie',
]

/**
 * Recorder factory. Holds the redact configuration and the sink used to
 * persist rows. Per-exchange state lives on the {@link Exchange} instance
 * returned by {@link Recorder#startExchange}.
 */
export class Recorder {
  /**
   * @param {{
   *   sink: Sink,
   *   redactHeaders?: readonly string[] | undefined,
   *   shouldDrop?: ShouldDropPredicate,
   * }} options
   */
  constructor(options) {
    if (!options || !options.sink) throw new Error('Recorder: sink is required')
    /** @type {Sink} */
    this.sink = options.sink
    /** @type {Set<string>} */
    this.redactSet = buildRedactSet(options.redactHeaders)
    /** @type {Set<Exchange>} */
    this.active = new Set()
    /** @type {ShouldDropPredicate | undefined} */
    this.shouldDrop = options.shouldDrop
  }

  /**
   * Begin recording a new exchange. The returned object collects state and
   * writes the final `exchange` row when {@link Exchange#finish} is called.
   *
   * `shouldDrop` lets the caller (typically the proxy) attach a per-exchange
   * filter predicate that is consulted before any `sink.writeRow` call. When
   * absent, the recorder's constructor-level predicate is used instead, and
   * when both are absent, every exchange is recorded.
   *
   * @param {{
   *   upstream: string,
   *   client: ClientInfo,
   *   request: { method: string | undefined, path: string | undefined, headers: Record<string, string | string[] | undefined> },
   *   localContextForRequest?: (body: string) => ClaudeSessionContext | undefined,
   *   shouldDrop?: ShouldDropPredicate,
   * }} init
   * @returns {Exchange}
   */
  startExchange(init) {
    const exchange = new Exchange(this, init)
    this.active.add(exchange)
    return exchange
  }

  /**
   * Wait for in-flight exchanges to finalize. Called during shutdown so async
   * finalization paths — e.g. a gzip decoder still flushing decompressed SSE
   * bytes after the upstream connection closed — get a chance to write their
   * `exchange` row before the sink closes. Any exchange still pending after
   * the timeout is force-finalized so its row is not lost.
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async drain(timeoutMs = 5000) {
    if (this.active.size === 0) return
    const settled = Promise.all(
      [...this.active].map((e) => e.finishedSignal.catch(() => {}))
    )
    /** @type {Promise<'timeout'>} */
    const timeout = new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), timeoutMs)
      if (typeof t.unref === 'function') t.unref()
    })
    const outcome = await Promise.race([settled.then(() => 'done'), timeout])
    if (outcome === 'timeout') {
      for (const exchange of [...this.active]) {
        await exchange.finish().catch(() => {})
      }
    }
  }
}

/**
 * Mutable state for one in-flight request/response pair.
 */
export class Exchange {
  /**
   * @param {Recorder} recorder
   * @param {{
   *   upstream: string,
   *   client: ClientInfo,
   *   request: { method: string | undefined, path: string | undefined, headers: Record<string, string | string[] | undefined> },
   *   localContextForRequest?: (body: string) => ClaudeSessionContext | undefined,
   *   shouldDrop?: ShouldDropPredicate,
   * }} init
   */
  constructor(recorder, init) {
    /** @type {Recorder} */
    this.recorder = recorder
    /** @type {string} */
    this.id = randomBytes(16).toString('hex')
    /** @type {number} */
    this.tsStartMs = Date.now()
    /** @type {string} */
    this.tsStart = new Date(this.tsStartMs).toISOString()
    /** @type {string} */
    this.upstream = init.upstream
    /** @type {ClientInfo} */
    this.client = init.client
    /** @type {Buffer[]} */
    this.requestChunks = []
    /** @type {Record<string, string | string[] | undefined>} */
    this.requestHeaders = redactHeaders(init.request.headers, recorder.redactSet)
    /**
     * Pre-redaction request headers, kept in memory only for the lifetime
     * of the exchange so the ignore filter can inspect provider session
     * tokens that the persisted record would otherwise redact away. Never
     * written to a sink.
     * @type {Record<string, string | string[] | undefined>}
     */
    this._filterHeaders = init.request.headers
    /** @type {string | undefined} */
    this.requestMethod = init.request.method
    /** @type {string | undefined} */
    this.requestPath = init.request.path
    /** @type {((body: string) => ClaudeSessionContext | undefined) | undefined} */
    this.localContextForRequest = init.localContextForRequest
    /** @type {ShouldDropPredicate | undefined} */
    this.shouldDrop = init.shouldDrop
    /** @type {ExchangeResponse | undefined} */
    this.response = undefined
    /** @type {Buffer[]} */
    this.responseChunks = []
    /** @type {number} */
    this.streamEventCount = 0
    /** @type {string | undefined} */
    this.error = undefined
    /** @type {boolean} */
    this.finished = false
    /** @type {SseParser} */
    this.sseParser = new SseParser()
    /**
     * Cached result of {@link Exchange#_shouldDropExchange}. Set on the
     * first filter evaluation so the second checkpoint (stream-chunk vs.
     * finish) doesn't re-decode the request body or re-walk the filesystem.
     * @type {boolean | undefined}
     */
    this._dropDecision = undefined
    /** @type {() => void} */
    this._resolveFinished = () => {}
    /** @type {Promise<void>} */
    this.finishedSignal = new Promise((resolve) => {
      this._resolveFinished = resolve
    })
  }

  /**
   * Record a single chunk of the inbound request body. Called by the proxy
   * for every `data` event on the client request.
   *
   * @param {Buffer} chunk
   * @returns {void}
   */
  appendRequestChunk(chunk) {
    this.requestChunks.push(chunk)
  }

  /**
   * Record the response start. For non-streaming responses the proxy also
   * calls {@link Exchange#appendResponseChunk}; for SSE the chunks are fed
   * through {@link Exchange#consumeStreamChunk}.
   *
   * @param {{ status: number | undefined, headers: Record<string, string | string[] | undefined> }} init
   * @returns {void}
   */
  setResponseStart(init) {
    this.response = {
      status: init.status,
      headers: redactHeaders(init.headers, this.recorder.redactSet),
      body: '',
    }
    this.responseChunks = []
  }

  /**
   * Append a chunk of a non-streaming response body. The proxy collects
   * chunks here so the exchange row carries the full body.
   *
   * @param {Buffer} chunk
   * @returns {void}
   */
  appendResponseChunk(chunk) {
    if (!this.response) return
    if (this.response.body === undefined) return
    this.responseChunks.push(Buffer.from(chunk))
  }

  /**
   * Mark this exchange as a streaming exchange. Drops any non-streaming body
   * accumulator (we'll record per-event rows instead).
   *
   * @returns {void}
   */
  markStreaming() {
    if (!this.response) return
    this.response.body = undefined
    this.responseChunks = []
  }

  /**
   * Feed a chunk of an SSE response into the stream parser. Complete events
   * are emitted as `stream_event` rows. Returns the promise of the writes
   * scheduled by this chunk (rarely awaited; useful for tests).
   *
   * @param {Buffer} chunk
   * @returns {Promise<void>}
   */
  async consumeStreamChunk(chunk) {
    const events = this.sseParser.feed(chunk)
    if (events.length === 0) return
    // We still increment the event count for the final exchange row so a
    // dropped recording reports the same "streaming, N events" shape to any
    // consumer that asks. The actual JSONL writes are suppressed below.
    this.streamEventCount += events.length
    if (this._shouldDropExchange()) return
    /** @type {Promise<void>[]} */
    const writes = []
    for (const ev of events) {
      writes.push(this.recorder.sink.writeRow({
        exchange_id: this.id,
        kind: 'stream_event',
        t_ms: Date.now() - this.tsStartMs,
        event: ev.event,
        data: ev.data,
      }))
    }
    await Promise.all(writes)
  }

  /**
   * Mark this exchange as failed. Subsequent calls overwrite earlier errors
   * — the most recent failure typically carries the most useful context
   * (e.g. an upstream error after a partial response).
   *
   * @param {unknown} err
   * @returns {void}
   */
  setError(err) {
    if (err instanceof Error) {
      this.error = err.message || err.name || 'unknown error'
    } else if (typeof err === 'string') {
      this.error = err
    } else {
      this.error = String(err)
    }
  }

  /**
   * Write the final `exchange` row. Idempotent — calling twice is a no-op so
   * the proxy can call it from multiple completion paths (response end,
   * client abort, upstream error) without double-writing.
   *
   * @returns {Promise<void>}
   */
  async finish() {
    if (this.finished) return
    this.finished = true
    this.recorder.active.delete(this)

    const tsEndMs = Date.now()
    const requestBody = Buffer.concat(this.requestChunks).toString('utf8')
    const response = this.finalizeResponseBody()
    const localContext = this.localContextForRequest?.(requestBody)

    if (this._shouldDropExchange(requestBody)) {
      this._resolveFinished()
      return
    }

    const row = {
      exchange_id: this.id,
      kind: 'exchange',
      ts_start: this.tsStart,
      ts_end: new Date(tsEndMs).toISOString(),
      duration_ms: tsEndMs - this.tsStartMs,
      upstream: this.upstream,
      client: this.client,
      request: {
        method: this.requestMethod,
        path: this.requestPath,
        headers: this.requestHeaders,
        body: requestBody,
      },
      response,
      stream_event_count: this.streamEventCount,
      error: this.error,
      ...(localContext?.cwd ? { cwd: localContext.cwd } : {}),
      ...(localContext?.git_branch ? { git_branch: localContext.git_branch } : {}),
    }
    try {
      await this.recorder.sink.writeRow(row)
    } finally {
      this._resolveFinished()
    }
  }

  /**
   * Ask the recorder's filter whether this exchange should be suppressed.
   * The decision is cached on first call so streaming exchanges don't re-run
   * the body-decode + filesystem walk for every event. The cached value is
   * also reused by `finish()` so the precedence-matched answer is consistent
   * between checkpoints.
   *
   * The filter receives the accumulated request body so it can extract the
   * provider session id; for streaming responses the request body is fully
   * received before the first SSE event is forwarded, so the body is
   * complete by the time `consumeStreamChunk` first asks.
   *
   * @param {string} [precomputedBody] Reuse the body decode already done by
   *   `finish()` so we don't pay the UTF-8 cost twice.
   * @returns {boolean}
   */
  _shouldDropExchange(precomputedBody) {
    if (this._dropDecision !== undefined) return this._dropDecision
    const predicate = this.shouldDrop ?? this.recorder.shouldDrop
    if (!predicate) {
      this._dropDecision = false
      return false
    }
    const body = precomputedBody ?? Buffer.concat(this.requestChunks).toString('utf8')
    /** @type {boolean} */
    let drop = false
    try {
      drop = Boolean(predicate({
        requestHeaders: this._filterHeaders,
        requestBody: body,
      }))
    } catch {
      // Filter errors must never break recording — fall back to "record".
      drop = false
    }
    this._dropDecision = drop
    return drop
  }

  /**
   * Decode non-streaming response bytes once at the end so multi-byte UTF-8
   * sequences split across transport chunks are not replaced.
   *
   * @returns {ExchangeResponse | undefined}
   */
  finalizeResponseBody() {
    if (!this.response) return undefined
    if (this.response.body === undefined) return this.response
    this.response.body = Buffer.concat(this.responseChunks).toString('utf8')
    return this.response
  }
}

/**
 * @param {readonly string[] | undefined} extra
 * @returns {Set<string>}
 */
function buildRedactSet(extra) {
  const out = new Set(DEFAULT_REDACT_HEADERS)
  if (extra) {
    for (const name of extra) {
      if (typeof name === 'string' && name.length > 0) {
        out.add(name.toLowerCase())
      }
    }
  }
  return out
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {Set<string>} redactSet
 * @returns {Record<string, string | string[] | undefined>}
 */
function redactHeaders(headers, redactSet) {
  /** @type {Record<string, string | string[] | undefined>} */
  const out = {}
  for (const key of Object.keys(headers)) {
    const value = headers[key]
    if (value === undefined) continue
    if (redactSet.has(key.toLowerCase())) {
      out[key] = redactValue(value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Replace a header value with `REDACTED:<last4>`. Arrays (e.g. multi-value
 * `Set-Cookie`) are mapped element-wise so each entry is independently
 * recoverable by its tail without leaking the full value.
 *
 * @param {string | string[]} value
 * @returns {string | string[]}
 */
function redactValue(value) {
  if (Array.isArray(value)) return value.map((v) => redactString(v))
  return redactString(value)
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactString(value) {
  if (typeof value !== 'string') return 'REDACTED:'
  const tail = value.length >= 4 ? value.slice(-4) : value
  return `REDACTED:${tail}`
}
