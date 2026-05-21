// @ts-check

import { randomBytes } from 'node:crypto'

import { isSseHeaders, SseParser } from './sse.js'

/**
 * Headers always redacted in stored rows. Operators can extend the set
 * per-config (see `compileConfig.redactHeaders`) but cannot shrink it
 * because every name below carries a credential or session token that
 * must never appear verbatim in the cache.
 */
const DEFAULT_REDACT_HEADERS = Object.freeze([
  'authorization',
  'x-api-key',
  'anthropic-api-key',
  'cookie',
  'set-cookie',
  'chatgpt-account-id',
])

/**
 * @typedef {Object} ExchangeInit
 * @property {string} upstream
 * @property {string | undefined} method
 * @property {string | undefined} path
 * @property {Record<string, string | string[] | undefined>} requestHeaders
 *
 * @typedef {Object} ResponseStart
 * @property {number | undefined} status
 * @property {Record<string, string | string[] | undefined>} headers
 *
 * @typedef {Object} RecorderOptions
 * @property {readonly string[]} [redactHeaders]
 *
 * @typedef {Object} FinishedRow
 * @property {string} exchange_id
 * @property {string} ts_start
 * @property {string | null} ts_end
 * @property {number | null} duration_ms
 * @property {string} upstream
 * @property {string | null} method
 * @property {string | null} path
 * @property {number | null} status_code
 * @property {number | null} request_bytes
 * @property {number | null} response_bytes
 * @property {boolean | null} is_sse
 * @property {number | null} stream_event_count
 * @property {string | null} request_headers     JSON-stringified headers (post-redact)
 * @property {string | null} request_body
 * @property {string | null} response_headers
 * @property {string | null} response_body
 * @property {string | null} error
 * @property {string | null} metadata             JSON-stringified metadata (incl. dev_run_id)
 */

/**
 * Build a Recorder. The recorder owns the redact set so per-exchange
 * code doesn't have to recompute it; it does not own a sink — the
 * source layer hands each finished row to `appendRows` directly so it
 * can compose a span around the write.
 *
 * @param {RecorderOptions} [options]
 */
export function createRecorder(options = {}) {
  const redactSet = buildRedactSet(options.redactHeaders)
  /** @type {Set<Exchange>} */
  const active = new Set()

  return {
    redactSet,
    active,
    /**
     * @param {ExchangeInit} init
     */
    startExchange(init) {
      const exchange = new Exchange({ redactSet, init })
      active.add(exchange)
      return exchange
    },
    /** @returns {number} */
    inflightCount() {
      return active.size
    },
    /**
     * Best-effort drain. The source's stop() awaits this so exchanges
     * still in flight when the gateway is stopped get a chance to
     * write their final row before the listener closes. Any exchange
     * that hasn't finalized within `timeoutMs` is force-finished so
     * its row is not lost.
     *
     * @param {number} [timeoutMs]
     */
    async drain(timeoutMs = 5000) {
      if (active.size === 0) return
      const settled = Promise.all(
        Array.from(active).map((e) => e.finishedSignal.catch(() => undefined))
      )
      /** @type {Promise<'timeout'>} */
      const timeout = new Promise((resolve) => {
        const handle = setTimeout(() => resolve('timeout'), timeoutMs)
        if (typeof handle.unref === 'function') handle.unref()
      })
      const outcome = await Promise.race([settled.then(() => 'done'), timeout])
      if (outcome === 'timeout') {
        for (const exchange of Array.from(active)) {
          await exchange.finalize().catch(() => undefined)
        }
      }
    },
  }
}

/**
 * Per-exchange state. The caller (proxy listener) feeds in request and
 * response chunks and calls `finalize()` exactly once. The exchange
 * yields a `FinishedRow` ready for `ctx.storage.appendRows`.
 */
export class Exchange {
  /**
   * @param {{ redactSet: Set<string>, init: ExchangeInit }} args
   */
  constructor({ redactSet, init }) {
    this.redactSet = redactSet
    /** @type {string} */
    this.id = randomBytes(16).toString('hex')
    /** @type {number} */
    this.tsStartMs = Date.now()
    /** @type {string} */
    this.tsStart = new Date(this.tsStartMs).toISOString()
    /** @type {string} */
    this.upstream = init.upstream
    /** @type {string | undefined} */
    this.method = init.method
    /** @type {string | undefined} */
    this.path = init.path
    /** @type {Record<string, string | string[] | undefined>} */
    this.requestHeaders = redactHeaders(init.requestHeaders, redactSet)
    /** @type {Record<string, string | string[] | undefined>} */
    this._rawRequestHeaders = init.requestHeaders
    /** @type {Buffer[]} */
    this.requestChunks = []
    /** @type {number} */
    this.requestBytes = 0
    /** @type {ResponseStart | undefined} */
    this.response = undefined
    /** @type {Buffer[]} */
    this.responseChunks = []
    /** @type {number} */
    this.responseBytes = 0
    /** @type {boolean} */
    this.isSse = false
    /** @type {number} */
    this.streamEventCount = 0
    /** @type {string | undefined} */
    this.error = undefined
    /** @type {boolean} */
    this.finished = false
    /** @type {FinishedRow | undefined} */
    this._cachedRow = undefined
    /** @type {SseParser} */
    this.sseParser = new SseParser()
    /** @type {() => void} */
    this._resolveFinished = () => {}
    /** @type {Promise<void>} */
    this.finishedSignal = new Promise((resolve) => {
      this._resolveFinished = resolve
    })
  }

  /**
   * Record dev_run_id (and any future request-scoped metadata that the
   * row will carry). Stored as a flat record because the schema's
   * `metadata` column is a JSON variant — we stringify at finalize.
   *
   * @returns {string | undefined}
   */
  devRunIdFromHeaders() {
    return headerValue(this._rawRequestHeaders, 'x-hyp-dev-run-id')
  }

  /**
   * Feed one chunk of the inbound request body. Bytes are stored both
   * to count `request_bytes` and to serialize as `request_body` on the
   * finalized row.
   *
   * @param {Buffer | Uint8Array} chunk
   */
  appendRequestChunk(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.requestChunks.push(buf)
    this.requestBytes += buf.byteLength
  }

  /**
   * Record the response head. For SSE responses the proxy follows up
   * with `consumeStreamChunk`; for non-SSE responses it calls
   * `appendResponseChunk`.
   *
   * @param {ResponseStart} init
   */
  setResponseStart(init) {
    this.response = {
      status: init.status,
      headers: redactHeaders(init.headers, this.redactSet),
    }
    this.isSse = isSseHeaders(init.headers)
  }

  /**
   * Append a chunk of a non-streaming response body.
   *
   * @param {Buffer | Uint8Array} chunk
   */
  appendResponseChunk(chunk) {
    if (this.isSse) return
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.responseChunks.push(buf)
    this.responseBytes += buf.byteLength
  }

  /**
   * Feed an SSE chunk through the parser. Each completed `event:` /
   * `data:` block bumps `stream_event_count`. The bytes are also
   * counted toward `response_bytes` so the size metric on the
   * finalized row matches what flowed over the wire.
   *
   * @param {Buffer | Uint8Array} chunk
   */
  consumeStreamChunk(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.responseBytes += buf.byteLength
    const events = this.sseParser.feed(buf)
    this.streamEventCount += events.length
  }

  /**
   * Record a final error. Overwriting is allowed — the most recent
   * error usually carries the most useful diagnostic.
   *
   * @param {unknown} err
   */
  setError(err) {
    if (err && typeof err === 'object' && Array.isArray(/** @type {{ errors?: unknown[] }} */ (err).errors)) {
      this.error = /** @type {{ errors: unknown[] }} */ (err).errors
        .map((e) => e instanceof Error ? (e.message || e.name) : String(e))
        .filter((message) => message.length > 0)
        .join('; ') || 'AggregateError'
    } else if (err instanceof Error) {
      this.error = err.message || err.name || 'unknown error'
    } else if (typeof err === 'string') {
      this.error = err
    } else {
      this.error = String(err)
    }
  }

  /**
   * Build the row to be written into `ai_gateway_messages`. Idempotent
   * — once `finished` is true subsequent calls return the cached row.
   *
   * The schema's JSON-typed columns (`request_headers`,
   * `response_headers`, `metadata`) are pre-stringified here. The
   * storage layer treats STRING vs JSON the same on append; the
   * difference shows up at query time when callers use
   * `JSON_VALUE(metadata, '$.dev_run_id')`.
   *
   * @returns {FinishedRow}
   */
  finalize() {
    if (this.finished && this._cachedRow) return this._cachedRow
    this.finished = true

    const tsEndMs = Date.now()
    const requestBody = Buffer.concat(this.requestChunks).toString('utf8')
    const responseBody = this.isSse
      ? null
      : Buffer.concat(this.responseChunks).toString('utf8')
    const devRunId = this.devRunIdFromHeaders()
    /** @type {Record<string, unknown>} */
    const metadata = {}
    if (devRunId) metadata.dev_run_id = devRunId

    /** @type {FinishedRow} */
    const row = {
      exchange_id: this.id,
      ts_start: this.tsStart,
      ts_end: new Date(tsEndMs).toISOString(),
      duration_ms: tsEndMs - this.tsStartMs,
      upstream: this.upstream,
      method: this.method ?? null,
      path: this.path ?? null,
      status_code: this.response?.status ?? null,
      request_bytes: this.requestBytes,
      response_bytes: this.responseBytes,
      is_sse: this.isSse,
      stream_event_count: this.isSse ? this.streamEventCount : null,
      request_headers: JSON.stringify(this.requestHeaders),
      request_body: requestBody.length > 0 ? requestBody : null,
      response_headers: this.response ? JSON.stringify(this.response.headers) : null,
      response_body: responseBody && responseBody.length > 0 ? responseBody : null,
      error: this.error ?? null,
      metadata: JSON.stringify(metadata),
    }
    this._cachedRow = row
    this._resolveFinished()
    return row
  }
}

/**
 * @param {readonly string[] | undefined} extra
 */
function buildRedactSet(extra) {
  const out = new Set(DEFAULT_REDACT_HEADERS)
  if (extra) {
    for (const name of extra) {
      if (typeof name === 'string' && name.length > 0) out.add(name.toLowerCase())
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
 * @param {string | string[]} value
 */
function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactString)
  return redactString(value)
}

/**
 * @param {string} value
 */
function redactString(value) {
  if (typeof value !== 'string') return 'REDACTED:'
  const tail = value.length >= 4 ? value.slice(-4) : value
  return `REDACTED:${tail}`
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {string} name
 */
function headerValue(headers, name) {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value)) {
      const found = value.find((v) => typeof v === 'string' && v.length > 0)
      if (typeof found === 'string') return found
    }
  }
  return undefined
}
