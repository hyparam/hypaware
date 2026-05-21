// @ts-check

import http from 'node:http'
import https from 'node:https'

import { parseListen } from './config.js'

/** @typedef {import('./config.js').UpstreamConfig} UpstreamConfig */
/** @typedef {import('./recorder.js').Exchange} Exchange */
/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {import('node:http').IncomingHttpHeaders} IncomingHttpHeaders */
/** @typedef {import('node:http').OutgoingHttpHeaders} OutgoingHttpHeaders */

/**
 * Hop-by-hop headers per RFC 7230 §6.1. These are scoped to one
 * transport connection and must not be forwarded by intermediaries.
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

/**
 * @typedef {Object} CompiledUpstream
 * @property {string} name
 * @property {string} [provider]
 * @property {URL} baseUrl
 * @property {string} prefix
 *
 * @typedef {Object} ProxyOptions
 * @property {string} listen
 * @property {UpstreamConfig[]} upstreams
 * @property {(exchange: Exchange) => void | Promise<void>} onExchangeFinished
 * @property {(init: { upstream: string, provider: string | undefined, method: string | undefined, path: string | undefined, requestHeaders: IncomingHttpHeaders }) => Exchange} startExchange
 *
 * @typedef {Object} StartedProxy
 * @property {string} host
 * @property {number} port
 * @property {Promise<void>} stopped
 * @property {() => Promise<void>} stop
 */

/**
 * Start the HTTP proxy listener. Returns the bound host/port and a
 * `stop()` to close it. The proxy is purely a pass-through; observation
 * happens through the recorder hooks (`startExchange` /
 * `onExchangeFinished`) handed in by the source layer so the network
 * code stays single-purpose.
 *
 * Resolves once the listener is bound (so callers know the chosen
 * port when `listen: "127.0.0.1:0"`); rejects with the bind error
 * (e.g. EADDRINUSE) instead of emitting an unhandled `error` event.
 *
 * @param {ProxyOptions} opts
 * @returns {Promise<StartedProxy>}
 */
export async function startProxy(opts) {
  const { host, port: requestedPort } = parseListen(opts.listen)
  const upstreams = compileUpstreams(opts.upstreams)
  if (upstreams.length === 0) {
    throw new Error('ai-gateway: at least one upstream must be configured before start')
  }
  /** @type {Set<Promise<void>>} */
  const pendingFinalizers = new Set()

  const server = http.createServer((req, res) => {
    handleRequest(upstreams, opts, pendingFinalizers, req, res)
  })

  /** @type {(value: void) => void} */
  let resolveStopped = () => {}
  /** @type {Promise<void>} */
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve
  })
  server.on('close', () => resolveStopped())

  await new Promise((resolve, reject) => {
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
    server.listen(requestedPort, host)
  })

  const address = server.address()
  const boundPort = address && typeof address === 'object' ? address.port : requestedPort
  return {
    host,
    port: boundPort,
    stopped,
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve(undefined)))
      })
      await Promise.allSettled(Array.from(pendingFinalizers))
    },
  }
}

/**
 * @param {CompiledUpstream[]} upstreams
 * @param {ProxyOptions} opts
 * @param {Set<Promise<void>>} pendingFinalizers
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
function handleRequest(upstreams, opts, pendingFinalizers, req, res) {
  const requestUrl = req.url ?? '/'
  const parsedUrl = new URL(requestUrl, 'http://placeholder')
  const upstream = matchUpstream(upstreams, parsedUrl.pathname, req.headers)
  if (!upstream) {
    req.resume()
    sendJson(res, 404, { error: 'no upstream matches path', path: parsedUrl.pathname })
    return
  }

  const isHttps = upstream.baseUrl.protocol === 'https:'
  const lib = isHttps ? https : http
  const upstreamHost = upstream.baseUrl.host
  const upstreamPort = upstream.baseUrl.port
    ? Number.parseInt(upstream.baseUrl.port, 10)
    : isHttps ? 443 : 80

  const forwardedHeaders = forwardHeaders(req.headers, upstreamHost)
  const exchange = opts.startExchange({
    upstream: upstream.name,
    provider: upstream.provider,
    method: req.method,
    path: requestUrl,
    requestHeaders: req.headers,
  })

  let upstreamEnded = false
  let failed = false
  let finalized = false
  function finalizeOnce() {
    if (finalized) return
    finalized = true
    const pending = Promise.resolve(opts.onExchangeFinished(exchange))
      .catch(() => undefined)
      .finally(() => {
        pendingFinalizers.delete(pending)
      })
    pendingFinalizers.add(pending)
  }

  const upstreamReq = lib.request({
    method: req.method,
    protocol: upstream.baseUrl.protocol,
    hostname: upstream.baseUrl.hostname,
    port: upstreamPort,
    path: parsedUrl.pathname + parsedUrl.search,
    headers: forwardedHeaders,
    family: 4,
  }, (upstreamRes) => {
    const responseHeaders = sanitizeResponseHeaders(upstreamRes.headers)
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders)
    exchange.setResponseStart({ status: upstreamRes.statusCode, headers: upstreamRes.headers })
    upstreamRes.on('data', (chunk) => {
      if (exchange.isSse) exchange.consumeStreamChunk(chunk)
      else exchange.appendResponseChunk(chunk)
    })
    upstreamRes.on('end', () => {
      upstreamEnded = true
      finalizeOnce()
    })
    upstreamRes.on('error', (err) => {
      exchange.setError(err)
      finalizeOnce()
    })
    upstreamRes.pipe(res)
  })

  upstreamReq.on('error', (err) => {
    failed = true
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'upstream connection failed', detail: errorDetail(err) })
    } else {
      res.destroy(err)
    }
    req.resume()
    if (!exchange.response) {
      exchange.setResponseStart({ status: 502, headers: {} })
    }
    exchange.setError(err)
    finalizeOnce()
  })

  req.on('error', (err) => {
    upstreamReq.destroy()
    exchange.setError(err)
    finalizeOnce()
  })
  res.on('close', () => {
    if (!failed && !upstreamReq.destroyed) upstreamReq.destroy()
    if (!finalized && !upstreamEnded) {
      exchange.setError('client_aborted')
      finalizeOnce()
    }
  })

  req.on('data', (chunk) => exchange.appendRequestChunk(chunk))
  req.pipe(upstreamReq)
}

/**
 * Path-segment prefix match. `/v1/messages` matches `/v1/messages` and
 * `/v1/messages/anything`, but not `/v1/messagesfoo`. A `/` prefix is
 * a catch-all so the simplest valid config (one upstream at `/`)
 * routes every request.
 *
 * @param {CompiledUpstream[]} upstreams
 * @param {string} pathname
 * @param {IncomingHttpHeaders} headers
 */
function matchUpstream(upstreams, pathname, headers) {
  const hintedProvider = detectProvider(pathname, headers)
  if (hintedProvider) {
    const hinted = upstreams.find((u) => u.provider === hintedProvider || u.name === hintedProvider)
    if (hinted) return hinted
  }
  for (const u of upstreams) {
    if (pathMatchesPrefix(pathname, u.prefix)) return u
  }
  return undefined
}

/**
 * Anthropic and OpenAI both use `/v1/...` paths. Prefer explicit
 * request-shape hints before falling back to path-prefix routing so a
 * mixed Claude+Codex gateway does not send one client's traffic to the
 * other provider.
 *
 * @param {string} pathname
 * @param {IncomingHttpHeaders} headers
 * @returns {string | undefined}
 */
function detectProvider(pathname, headers) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith('anthropic-')) return 'anthropic'
  }
  if (pathname === '/v1/messages' || pathname.startsWith('/v1/messages/')) return 'anthropic'
  if (
    pathname === '/backend-api/codex/responses' ||
    pathname.startsWith('/backend-api/codex/responses/') ||
    pathname === '/backend-api/codex/models' ||
    pathname.startsWith('/backend-api/codex/models/') ||
    pathname === '/backend-api/responses' ||
    pathname.startsWith('/backend-api/responses/') ||
    pathname === '/backend-api/models' ||
    pathname.startsWith('/backend-api/models/')
  ) {
    return 'chatgpt'
  }
  if (
    pathname === '/v1/responses' ||
    pathname.startsWith('/v1/responses/') ||
    pathname === '/v1/chat/completions' ||
    pathname.startsWith('/v1/chat/completions/') ||
    pathname === '/v1/models' ||
    pathname.startsWith('/v1/models/')
  ) {
    return 'openai'
  }
  return undefined
}

/**
 * @param {string} pathname
 * @param {string} prefix
 */
export function pathMatchesPrefix(pathname, prefix) {
  if (prefix === '/') return true
  return pathname === prefix || pathname.startsWith(prefix + '/')
}

/**
 * @param {UpstreamConfig[]} upstreams
 * @returns {CompiledUpstream[]}
 */
function compileUpstreams(upstreams) {
  /** @type {CompiledUpstream[]} */
  const out = []
  for (const u of upstreams) {
    /** @type {URL} */
    let baseUrl
    try {
      baseUrl = new URL(u.base_url)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`ai-gateway: invalid base_url for upstream "${u.name}": ${msg}`)
    }
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new Error(
        `ai-gateway: upstream "${u.name}" must use http:// or https://, got: ${baseUrl.protocol}`
      )
    }
    /** @type {CompiledUpstream} */
    const compiled = { name: u.name, baseUrl, prefix: u.path_prefix }
    if (u.provider) compiled.provider = u.provider
    out.push(compiled)
  }
  return out.sort((a, b) => prefixRank(b.prefix) - prefixRank(a.prefix))
}

/** @param {string} prefix */
function prefixRank(prefix) {
  return prefix === '/' ? 0 : prefix.length
}

/** @param {unknown} err */
function errorDetail(err) {
  if (err && typeof err === 'object' && Array.isArray(/** @type {{ errors?: unknown[] }} */ (err).errors)) {
    return /** @type {{ errors: unknown[] }} */ (err).errors
      .map((e) => {
        if (e instanceof Error) return e.message || e.name
        return String(e)
      })
      .filter((message) => message.length > 0)
      .join('; ')
  }
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

/**
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
