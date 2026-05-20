import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { BANNER, BANNER_HEADERS } from './banner.js'
import { isSseHeaders } from './sse.js'

/**
 * @import { Server, IncomingMessage, ServerResponse, IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
 * @import { ProxyConfig, UpstreamConfig, CompiledUpstream, ClientInfo, ClaudeSessionContext } from './types.js'
 * @import { Recorder, Exchange } from './recorder.js'
 * @import { IgnoreFilter } from './ignore.js'
 */

/**
 * Hop-by-hop headers per RFC 7230 §6.1. These are scoped to a single transport
 * connection and must not be forwarded by intermediaries.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const SESSION_CONTEXT_PATH = '/_collectivus/session-context'
const SESSION_CONTEXT_MAX_BYTES = 64 * 1024
const IGNORE_SESSION_PATH = '/_collectivus/ignore/session'
const IGNORE_SESSION_MAX_BYTES = 16 * 1024

/**
 * Reverse-proxy listener that forwards matched requests to a configured upstream.
 *
 * Pass-through plus optional recording: when constructed with a `recorder`,
 * each exchange is captured (request, response or stream events) and written
 * to the recorder's sink. Recording is purely observational — failures inside
 * the recorder must not break the proxy hot path.
 */
export class Proxy {
  /**
   * @param {ProxyConfig} config
   * @param {{ recorder?: Recorder, ignoreFilter?: IgnoreFilter }} [options]
   */
  constructor(config, options = {}) {
    /** @type {ProxyConfig} */
    this.config = config
    const { host, port } = parseListen(config.listen)
    /** @type {string} */
    this.host = host
    /** @type {number} */
    this.port = port
    /** @type {CompiledUpstream[]} */
    this.upstreams = compileUpstreams(config.upstreams)
    /** @type {Recorder | undefined} */
    this.recorder = options.recorder
    /** @type {IgnoreFilter | undefined} */
    this.ignoreFilter = options.ignoreFilter
    /** @type {Map<string, ClaudeSessionContext>} */
    this.sessionContexts = new Map()
    /** @type {Server | undefined} */
    this.server = undefined
  }

  /**
   * Bind the proxy listener. Rejects with the bind error (e.g. EADDRINUSE)
   * rather than emitting an unhandled `error` event, so the CLI can fail
   * fast instead of hanging on `await start()`.
   * @returns {Promise<void>}
   */
  start() {
    const { upstreams, recorder, sessionContexts, ignoreFilter } = this
    const server = http.createServer((req, res) => {
      handleRequest(upstreams, recorder, sessionContexts, ignoreFilter, req, res)
    })
    this.server = server
    return new Promise((resolve, reject) => {
      /** @param {Error} err */
      function onError(err) {
        server.off('listening', onListening)
        reject(err)
      }
      function onListening() {
        server.off('error', onError)
        resolve(undefined)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.port, this.host)
    })
  }

  /**
   * Close the proxy listener. Resolves once the underlying server is closed.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve, reject) => {
      const { server } = this
      if (!server) {
        resolve(undefined)
        return
      }
      server.close((err) => {
        if (err) {
          reject(err)
        } else {
          this.server = undefined
          resolve(undefined)
        }
      })
    })
  }
}

/**
 * Parse a `host:port` listen address. IPv6 literals may be wrapped in `[]`.
 *
 * @param {string} listen
 * @returns {{ host: string, port: number }}
 */
function parseListen(listen) {
  if (typeof listen !== 'string' || listen.length === 0) {
    throw new Error(`invalid listen address: ${listen}`)
  }
  const idx = listen.lastIndexOf(':')
  if (idx === -1) {
    throw new Error(`invalid listen address (missing port): ${listen}`)
  }
  const rawHost = listen.slice(0, idx)
  const portStr = listen.slice(idx + 1)
  const port = Number.parseInt(portStr, 10)
  if (Number.isNaN(port) || port < 0 || port > 65535 || String(port) !== portStr) {
    throw new Error(`invalid port in listen address: ${listen}`)
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost
  if (host.length === 0) {
    throw new Error(`invalid listen address (missing host): ${listen}`)
  }
  return { host, port }
}

/**
 * Validate and pre-parse upstream URLs at startup so requests do not pay the
 * cost on every hop. Iterates in declaration order — first-prefix-hit wins
 * at request time.
 *
 * @param {UpstreamConfig[]} upstreams
 * @returns {CompiledUpstream[]}
 */
function compileUpstreams(upstreams) {
  /** @type {CompiledUpstream[]} */
  const out = []
  for (const u of upstreams) {
    let baseUrl
    try {
      baseUrl = new URL(u.base_url)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`invalid base_url for upstream "${u.name}": ${msg}`)
    }
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new Error(
        `upstream "${u.name}" must use http:// or https://, got: ${baseUrl.protocol}`
      )
    }
    out.push({ name: u.name, baseUrl, prefix: u.match.path_prefix })
  }
  return out
}

/**
 * @param {CompiledUpstream[]} upstreams
 * @param {Recorder | undefined} recorder
 * @param {Map<string, ClaudeSessionContext>} sessionContexts
 * @param {IgnoreFilter | undefined} ignoreFilter
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
function handleRequest(upstreams, recorder, sessionContexts, ignoreFilter, req, res) {
  const requestUrl = req.url ?? '/'
  const url = new URL(requestUrl, 'http://placeholder')
  if (url.pathname === SESSION_CONTEXT_PATH) {
    handleSessionContext(sessionContexts, req, res)
    return
  }
  if (url.pathname === IGNORE_SESSION_PATH) {
    handleIgnoreSession(ignoreFilter, req, res)
    return
  }

  const upstream = matchUpstream(upstreams, url.pathname)
  if (!upstream) {
    req.resume()
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, BANNER_HEADERS)
      res.end(BANNER)
      return
    }
    sendJson(res, 404, { error: 'no upstream matches path', path: url.pathname })
    return
  }

  const isHttps = upstream.baseUrl.protocol === 'https:'
  const lib = isHttps ? https : http
  const upstreamHost = upstream.baseUrl.host
  const upstreamPort = upstream.baseUrl.port
    ? Number.parseInt(upstream.baseUrl.port, 10)
    : isHttps ? 443 : 80

  const headers = forwardHeaders(req.headers, upstreamHost)

  // Per-request ignore predicate. When configured, the recorder consults
  // this before any sink.writeRow to drop recordings whose `cwd` lives under
  // a registered ignore path, whose ancestor has `.ctvsignore`, or whose
  // session id is in the temporary in-memory set.
  const shouldDrop = ignoreFilter
    ? buildIgnorePredicate(ignoreFilter, sessionContexts)
    : undefined

  const exchange = recorder?.startExchange({
    upstream: upstream.name,
    client: clientInfo(req),
    request: {
      method: req.method,
      path: requestUrl,
      headers: req.headers,
    },
    localContextForRequest: (body) => localContextForRequest(req.headers, body, sessionContexts),
    ...(shouldDrop ? { shouldDrop } : {}),
  })

  const upstreamReq = lib.request({
    method: req.method,
    protocol: upstream.baseUrl.protocol,
    hostname: upstream.baseUrl.hostname,
    port: upstreamPort,
    path: url.pathname + url.search,
    headers,
  }, (upstreamRes) => {
    const responseHeaders = sanitizeResponseHeaders(upstreamRes.headers)
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders)
    if (exchange) {
      exchange.setResponseStart({
        status: upstreamRes.statusCode,
        headers: upstreamRes.headers,
      })
      const streaming = isSseHeaders(upstreamRes.headers)
      if (streaming) exchange.markStreaming()

      // The recorder needs decoded bytes to parse SSE events and capture body
      // text. The client-facing pipe below forwards the original bytes —
      // `content-encoding` is preserved end-to-end.
      const decoder = decoderFor(upstreamRes.headers)
      const recorderSource = decoder ?? upstreamRes
      if (decoder) {
        upstreamRes.pipe(decoder)
        decoder.on('error', (err) => {
          exchange.setError(err)
          finishSafely(exchange)
        })
      }
      if (streaming) {
        recorderSource.on('data', (chunk) => {
          // Recorder runs alongside the proxy hot path; failures here must
          // not break the response stream the client is consuming.
          exchange.consumeStreamChunk(chunk).catch((err) => exchange.setError(err))
        })
      } else {
        recorderSource.on('data', (chunk) => {
          exchange.appendResponseChunk(chunk)
        })
      }
      upstreamRes.on('end', () => {
        upstreamEnded = true
      })
      recorderSource.on('end', () => {
        finishSafely(exchange)
      })
      upstreamRes.on('error', (err) => {
        exchange.setError(err)
        finishSafely(exchange)
      })
    }
    upstreamRes.pipe(res)
  })

  // Set when the upstream stream ends cleanly. The `res.on('close')` watchdog
  // below uses this to distinguish a real client abort (upstream still in
  // flight) from a decoder still flushing decompressed bytes after the client
  // has finished reading (in which case finalization happens asynchronously
  // via the decoder's 'end' event).
  let upstreamEnded = false
  let failed = false
  upstreamReq.on('error', (err) => {
    failed = true
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'upstream connection failed', detail: err.message })
    } else {
      res.destroy(err)
    }
    req.resume()
    if (exchange) {
      if (!exchange.response) {
        exchange.setResponseStart({ status: 502, headers: {} })
      }
      exchange.setError(err)
      finishSafely(exchange)
    }
  })

  req.on('error', (err) => {
    upstreamReq.destroy()
    if (exchange) {
      exchange.setError(err)
      finishSafely(exchange)
    }
  })
  res.on('close', () => {
    if (!failed && !upstreamReq.destroyed) upstreamReq.destroy()
    if (exchange && !exchange.finished && !upstreamEnded) {
      // Client gave up before the response completed — cancel upstream and
      // record what we have. The error sentinel is `client_aborted` per the
      // proxy contract so consumers can match on a stable machine-readable
      // value rather than a free-form Error.message string.
      // When `upstreamEnded` is true the decoder may still be flushing; the
      // recorder will finalize via the decoder's 'end' event.
      exchange.setError('client_aborted')
      finishSafely(exchange)
    }
  })

  if (exchange) {
    req.on('data', (chunk) => exchange.appendRequestChunk(chunk))
  }
  req.pipe(upstreamReq)
}

/**
 * Capture client metadata once at exchange start so it survives socket
 * teardown later in the lifecycle.
 *
 * @param {IncomingMessage} req
 * @returns {ClientInfo}
 */
function clientInfo(req) {
  const remoteAddress = req.socket?.remoteAddress
  const ua = req.headers['user-agent']
  return {
    ip: typeof remoteAddress === 'string' ? remoteAddress : undefined,
    user_agent: typeof ua === 'string' ? ua : Array.isArray(ua) ? ua[0] : undefined,
  }
}

/**
 * Call `exchange.finish()` and swallow rejections — recording errors must not
 * propagate as unhandled rejections that could crash the process.
 *
 * @param {Exchange} exchange
 * @returns {void}
 */
function finishSafely(exchange) {
  exchange.finish().catch(() => {})
}

/**
 * Path-segment prefix match. `/v1/messages` matches `/v1/messages` and
 * `/v1/messages/anything`, but not `/v1/messagesfoo`. A `/` prefix is a
 * catch-all.
 *
 * @param {CompiledUpstream[]} upstreams
 * @param {string} pathname
 * @returns {CompiledUpstream | undefined}
 */
function matchUpstream(upstreams, pathname) {
  for (const u of upstreams) {
    if (pathMatchesPrefix(pathname, u.prefix)) {
      return u
    }
  }
  return undefined
}

/**
 * @param {string} pathname
 * @param {string} prefix
 * @returns {boolean}
 */
export function pathMatchesPrefix(pathname, prefix) {
  if (prefix === '/') return true
  return pathname === prefix || pathname.startsWith(prefix + '/')
}

/**
 * Build outbound headers from inbound headers. Strips hop-by-hop headers and
 * the inbound `Host`, then injects the upstream `Host`.
 *
 * @param {IncomingHttpHeaders} reqHeaders
 * @param {string} upstreamHost
 * @returns {OutgoingHttpHeaders}
 */
function forwardHeaders(reqHeaders, upstreamHost) {
  /** @type {OutgoingHttpHeaders} */
  const out = {}
  for (const key of Object.keys(reqHeaders)) {
    const lower = key.toLowerCase()
    if (lower === 'host') continue
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    const value = reqHeaders[key]
    if (value === undefined) continue
    out[key] = value
  }
  out.host = upstreamHost
  return out
}

/**
 * Local-only endpoint used by Claude Code hooks installed by `ctvs attach`.
 * The hook posts `{ session_id, cwd, git_branch }`; later Messages API
 * exchanges with the same Claude session id are enriched before JSONL write.
 *
 * @param {Map<string, ClaudeSessionContext>} sessionContexts
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @returns {void}
 */
function handleSessionContext(sessionContexts, req, res) {
  if (!isLoopback(req.socket.remoteAddress)) {
    req.resume()
    sendJson(res, 403, { error: 'session context endpoint is local-only' })
    return
  }
  if (req.method !== 'POST') {
    req.resume()
    res.writeHead(405, { 'content-type': 'application/json', 'allow': 'POST' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }

  /** @type {Buffer[]} */
  const chunks = []
  let bytes = 0
  let tooLarge = false
  req.on('data', (chunk) => {
    bytes += chunk.byteLength
    if (bytes > SESSION_CONTEXT_MAX_BYTES) {
      tooLarge = true
      req.destroy()
      return
    }
    chunks.push(Buffer.from(chunk))
  })
  req.on('end', () => {
    if (tooLarge) return
    let payload
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' })
      return
    }
    if (!payload || typeof payload !== 'object') {
      sendJson(res, 400, { error: 'body must be an object' })
      return
    }
    const obj = /** @type {Record<string, unknown>} */ (payload)
    const sessionId = stringValue(obj.session_id)
    if (!sessionId) {
      sendJson(res, 400, { error: 'session_id is required' })
      return
    }
    const cwd = stringValue(obj.cwd) ?? stringValue(obj.new_cwd)
    const gitBranch = stringValue(obj.git_branch) ?? stringValue(obj.gitBranch)
    sessionContexts.set(sessionId, {
      ...(cwd ? { cwd } : {}),
      ...(gitBranch ? { git_branch: gitBranch } : {}),
    })
    sendJson(res, 200, { ok: true })
  })
  req.on('error', () => {
    if (!res.headersSent) sendJson(res, 400, { error: 'failed to read request body' })
  })
}

/**
 * Build the per-exchange filter predicate handed to `recorder.startExchange`.
 * Closes over the ignore filter and the live session-context map so each
 * call resolves the request's session id, looks up its `cwd`, and asks the
 * filter for a verdict.
 *
 * @param {IgnoreFilter} ignoreFilter
 * @param {Map<string, ClaudeSessionContext>} sessionContexts
 * @returns {(args: { requestHeaders: IncomingHttpHeaders, requestBody: string }) => boolean}
 */
function buildIgnorePredicate(ignoreFilter, sessionContexts) {
  return function shouldDropExchange(args) {
    const sessionId = sessionIdFromBody(args.requestBody)
      ?? headerValue(args.requestHeaders, 'x-claude-code-session-id')
    const cwd = sessionId ? sessionContexts.get(sessionId)?.cwd : undefined
    return ignoreFilter.shouldDrop({ sessionId, cwd, conversationId: sessionId })
  }
}

/**
 * Local-only endpoint that manages the in-memory temporary session-ignore
 * set on the running daemon. Three verbs:
 *
 *   POST /_collectivus/ignore/session   { session_id } -> { ok, total }
 *   DELETE /_collectivus/ignore/session { session_id } -> { ok, removed, total }
 *   GET /_collectivus/ignore/session                   -> { ignored, total }
 *
 * Bound to loopback so a remote attacker cannot toggle recording for a user
 * session by guessing the path; the same loopback check shields the existing
 * session-context endpoint above.
 *
 * @param {IgnoreFilter | undefined} ignoreFilter
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @returns {void}
 */
function handleIgnoreSession(ignoreFilter, req, res) {
  if (!isLoopback(req.socket.remoteAddress)) {
    req.resume()
    sendJson(res, 403, { error: 'ignore endpoint is local-only' })
    return
  }
  if (!ignoreFilter) {
    req.resume()
    sendJson(res, 503, { error: 'ignore filter is not configured' })
    return
  }
  if (req.method === 'GET') {
    req.resume()
    const ignored = ignoreFilter.listIgnoredSessions()
    sendJson(res, 200, { ignored, total: ignored.length })
    return
  }
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    req.resume()
    res.writeHead(405, { 'content-type': 'application/json', 'allow': 'GET, POST, DELETE' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }

  /** @type {Buffer[]} */
  const chunks = []
  let bytes = 0
  let tooLarge = false
  req.on('data', (chunk) => {
    bytes += chunk.byteLength
    if (bytes > IGNORE_SESSION_MAX_BYTES) {
      tooLarge = true
      req.destroy()
      return
    }
    chunks.push(Buffer.from(chunk))
  })
  req.on('end', () => {
    if (tooLarge) return
    /** @type {unknown} */
    let payload
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' })
      return
    }
    if (!payload || typeof payload !== 'object') {
      sendJson(res, 400, { error: 'body must be an object' })
      return
    }
    const sessionId = stringValue(/** @type {Record<string, unknown>} */ (payload).session_id)
    if (!sessionId) {
      sendJson(res, 400, { error: 'session_id is required' })
      return
    }
    if (req.method === 'POST') {
      const { total } = ignoreFilter.addIgnoredSession(sessionId)
      sendJson(res, 200, { ok: true, total })
      return
    }
    // DELETE
    const { removed, total } = ignoreFilter.removeIgnoredSession(sessionId)
    sendJson(res, 200, { ok: true, removed, total })
  })
  req.on('error', () => {
    if (!res.headersSent) sendJson(res, 400, { error: 'failed to read request body' })
  })
}

/**
 * @param {IncomingHttpHeaders} headers
 * @param {string} body
 * @param {Map<string, ClaudeSessionContext>} sessionContexts
 * @returns {ClaudeSessionContext | undefined}
 */
function localContextForRequest(headers, body, sessionContexts) {
  const sessionId = sessionIdFromBody(body) ?? headerValue(headers, 'x-claude-code-session-id')
  if (!sessionId) return undefined
  return sessionContexts.get(sessionId)
}

/**
 * @param {string} body
 * @returns {string | undefined}
 */
function sessionIdFromBody(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const meta = /** @type {Record<string, unknown>} */ (parsed).metadata
  if (!meta || typeof meta !== 'object') return undefined
  const userId = /** @type {Record<string, unknown>} */ (meta).user_id
  const decoded = parseMaybeJson(userId)
  if (!decoded || typeof decoded !== 'object') return undefined
  return stringValue(/** @type {Record<string, unknown>} */ (decoded).session_id)
}

/**
 * @param {IncomingHttpHeaders} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function headerValue(headers, name) {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value)) {
      const found = value.find((entry) => typeof entry === 'string' && entry.length > 0)
      if (typeof found === 'string') return found
    }
  }
  return undefined
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {string | undefined} address
 * @returns {boolean}
 */
function isLoopback(address) {
  if (!address) return false
  return address === '::1' ||
    address === '127.0.0.1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
}

/**
 * Build a decompression Transform for the upstream's `content-encoding`, or
 * return undefined for identity / missing / unrecognized encodings. The
 * decoder is consumed by the recorder only — the client-facing pipe forwards
 * the original encoded bytes unchanged.
 *
 * @param {IncomingHttpHeaders} headers
 * @returns {import('node:stream').Transform | undefined}
 */
function decoderFor(headers) {
  const ce = headers['content-encoding']
  const value = Array.isArray(ce) ? ce[0] : ce
  if (typeof value !== 'string') return undefined
  const encoding = value.toLowerCase().trim()
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.createGunzip()
  if (encoding === 'deflate') return zlib.createInflate()
  if (encoding === 'br') return zlib.createBrotliDecompress()
  return undefined
}

/**
 * Strip hop-by-hop headers from an upstream response before forwarding.
 *
 * @param {IncomingHttpHeaders} headers
 * @returns {OutgoingHttpHeaders}
 */
function sanitizeResponseHeaders(headers) {
  /** @type {OutgoingHttpHeaders} */
  const out = {}
  for (const key of Object.keys(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue
    const value = headers[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
