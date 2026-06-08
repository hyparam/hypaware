// @ts-check

import { randomBytes } from 'node:crypto'
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'

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
 * @import { ExchangeInit, FinishedRow, RecorderOptions, ResponseStart } from './types.d.ts'
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
          try { exchange.finalize() } catch { /* swallow */ }
        }
      }
    },
  }
}

/**
 * Per-exchange state. The caller (proxy listener) feeds in request and
 * response chunks and calls `finalize()` exactly once. The exchange
 * yields a `FinishedRow` ready to be handed to a registered exchange
 * projector.
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
    this.provider = init.provider
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
    /**
     * Raw upstream `content-encoding`, captured before header redaction so
     * body decoding still works when an operator redacts that header.
     * @type {string | string[] | undefined}
     */
    this.responseContentEncoding = undefined
    /** @type {Buffer[]} */
    this.responseChunks = []
    /** @type {number} */
    this.responseBytes = 0
    /** @type {boolean} */
    this.isSse = false
    /** @type {number} */
    this.streamEventCount = 0
    /** @type {Array<{ kind: 'stream_event', exchange_id: string, t_ms: number, event: string, data: string, id?: string }>} */
    this.streamEvents = []
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
    this.responseContentEncoding = headerValue(init.headers, 'content-encoding')
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
    for (const event of events) {
      this.streamEvents.push({
        kind: 'stream_event',
        exchange_id: this.id,
        t_ms: Date.now() - this.tsStartMs,
        event: event.event,
        data: event.data,
        ...(event.id !== undefined ? { id: event.id } : {}),
      })
    }
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
   * Build the row to be handed to the exchange-projector dispatcher.
   * Idempotent — once `finished` is true subsequent calls return the
   * cached row.
   *
   * The JSON-shaped fields (`request_headers`, `response_headers`,
   * `metadata`) are pre-stringified here so any downstream consumer
   * can drop them into a JSON column unchanged. The dispatcher will
   * parse them back as needed.
   *
   * @returns {FinishedRow}
   */
  finalize() {
    if (this.finished && this._cachedRow) return this._cachedRow
    this.finished = true

    const tsEndMs = Date.now()
    // The proxy is a pass-through, so a body carries whatever
    // `content-encoding` the upstream (or client) applied. Decode it
    // before stringifying or a gzip/br/deflate body lands in the cache
    // as mojibake that no downstream projector can parse as JSON.
    const requestBody = decodeBody(
      Buffer.concat(this.requestChunks),
      headerValue(this._rawRequestHeaders, 'content-encoding')
    )
    const responseBody = this.isSse
      ? null
      : decodeBody(Buffer.concat(this.responseChunks), this.responseContentEncoding)
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
      provider: this.provider ?? null,
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
      stream_events: this.streamEvents,
    }
    this._cachedRow = row
    this._resolveFinished()
    return row
  }
}

/**
 * Reverse the `content-encoding` applied to a captured body and decode
 * it as UTF-8. Best-effort: an empty buffer yields `''`, an unknown or
 * undecodable encoding falls back to the raw bytes so a (possibly
 * garbled) row is still written rather than the exchange being dropped.
 *
 * @param {Buffer} buf
 * @param {string | string[] | undefined} encodingHeader
 * @returns {string}
 */
function decodeBody(buf, encodingHeader) {
  if (buf.byteLength === 0) return ''
  const encodings = parseEncodings(encodingHeader)
  if (encodings.length === 0) return buf.toString('utf8')
  let current = buf
  // `content-encoding` lists transforms in the order they were applied;
  // decode in reverse to undo them.
  for (let i = encodings.length - 1; i >= 0; i--) {
    const enc = encodings[i]
    try {
      if (enc === 'gzip' || enc === 'x-gzip') current = gunzipSync(current)
      else if (enc === 'br') current = brotliDecompressSync(current)
      else if (enc === 'deflate') current = inflateOrRaw(current)
      else return current.toString('utf8') // unknown codec — stop, keep what we have
    } catch {
      return buf.toString('utf8') // undecodable — fall back to the raw bytes
    }
  }
  return current.toString('utf8')
}

/**
 * Some servers emit raw DEFLATE without the zlib header. Try the
 * conformant decoder first, then the headerless variant.
 *
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function inflateOrRaw(buf) {
  try {
    return inflateSync(buf)
  } catch {
    return inflateRawSync(buf)
  }
}

/**
 * Normalize a `content-encoding` header into an ordered list of lowercase
 * codec tokens, dropping `identity` and empties.
 *
 * @param {string | string[] | undefined} header
 * @returns {string[]}
 */
function parseEncodings(header) {
  if (header === undefined) return []
  const raw = Array.isArray(header) ? header.join(',') : header
  return raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0 && token !== 'identity')
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
