// @ts-check

import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

import { parseListen } from './config.js'
import { attachConnectFrontDoor, connectHostOf, connectPortOf, openUpstream } from './connect.js'
import { createNullExchange } from './recorder.js'

/**
 * @import { AiGatewayRouteInput } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { CompiledUpstream, ProxyOptions, StartedProxy, UpstreamConfig, UpstreamProxy } from './types.js'
 * @import { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
 * @import { Exchange } from './recorder.js'
 */

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
 * Routing is preset-driven: each compiled upstream is matched via
 * `match()` when supplied, otherwise via path-segment prefix. There
 * is no hardcoded Anthropic / OpenAI / Codex routing: adapter
 * plugins own provider matching by registering presets with their
 * own `match()`.
 *
 * @param {ProxyOptions} opts
 * @returns {Promise<StartedProxy>}
 */
export async function startProxy(opts) {
  const { host, port: requestedPort } = parseListen(opts.listen)
  const upstreams = compileUpstreams(opts.upstreams)
  // An empty routing table is a caller mistake everywhere except one: a
  // blind-tunnel-only listener has no routing to do. It exists because a client
  // attached in proxy mode sends ALL of its egress here, so the port has to go
  // on answering CONNECT even when there is nothing left to record.
  // @ref LLP 0233#degrade-to-blind-tunnels [constrained-by]: tunnel-only is the one start with nothing to route
  if (upstreams.length === 0 && !opts.tunnelOnly) {
    throw new Error('ai-gateway: at least one upstream must be configured before start')
  }
  /** @type {Set<Promise<void>>} */
  const pendingFinalizers = new Set()

  const server = http.createServer((req, res) => {
    handleRequest(upstreams, opts, pendingFinalizers, req, res)
  })

  // The second front door. Installed when proxy mode is serving, and also when
  // it merely *might* have a client pointed at it (`tunnelOnly`).
  //
  // That second case is the difference between a bad day and a broken machine.
  // A client attached in proxy mode has `HTTPS_PROXY` pointing here for ALL its
  // egress, so if the CA later goes missing or the operator turns `proxy_mode`
  // off, a listener that refuses CONNECT kills that client's authentication and
  // updates, not just its capture. Blind-tunnelling everything instead degrades
  // to unrecorded-but-working, which is the failure this feature is allowed to
  // have.
  // @ref LLP 0233#one-listener-two-front-doors [implements]: CONNECT and origin-form traffic share one port
  const interception = opts.interception
  const frontDoor = interception || opts.tunnelOnly
    ? attachConnectFrontDoor({
      server,
      // Without a CA there is nothing to terminate with, so every tunnel is
      // blind. `interceptsHost` is never consulted in that state.
      shouldIntercept: (host, port) =>
        Boolean(interception) && interceptsHost(upstreams, host, port),
      secureContextFor: (host) => {
        if (!interception) throw new Error('TLS interception is not available')
        return interception.secureContextFor(host)
      },
      upstreamProxy: opts.upstreamProxy,
      log: opts.log,
    })
    : undefined

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
      // Destroy hijacked tunnel sockets first: `server.close()` stops
      // accepting but waits on connections it knows about, and a CONNECT
      // socket is no longer one of them. Without this, stop() blocks until
      // every peer gives up.
      frontDoor?.close()
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve(undefined)))
      })
      await Promise.allSettled(Array.from(pendingFinalizers))
    },
  }
}

/**
 * Whether a CONNECT to `host` should be decrypted.
 *
 * The intercept set is derived from the routing table rather than configured
 * separately: a host is decrypted only when a registered upstream actually
 * names it. That keeps one fact in one place - adding an adapter widens
 * capture, and nothing else does - and makes the blind-tunnel default true by
 * construction for every other host the client talks to.
 *
 * @ref LLP 0234#intercept-set-is-the-routing-table [implements]
 * @param {CompiledUpstream[]} upstreams
 * @param {string} host
 * @returns {boolean}
 */
export function interceptsHost(upstreams, host, port = 443) {
  // Host AND port. The upstream names a specific endpoint, and terminating
  // `CONNECT api.anthropic.com:8443` would decrypt a tunnel and then forward it
  // to 443, silently sending the request somewhere the client did not ask for.
  // The hostname is lower-cased because a client may send any case and
  // `baseUrl.hostname` is already normalised.
  const wanted = host.toLowerCase()
  return upstreams.some((u) => u.baseUrl.hostname === wanted && upstreamPortOf(u) === port)
}

/**
 * The port an upstream's `base_url` addresses, defaulted by scheme.
 *
 * @param {CompiledUpstream} upstream
 * @returns {number}
 */
function upstreamPortOf(upstream) {
  if (upstream.baseUrl.port) return Number.parseInt(upstream.baseUrl.port, 10)
  return upstream.baseUrl.protocol === 'https:' ? 443 : 80
}

/**
 * Resolve the upstream for a proxy-mode request by the host the client asked
 * for in its CONNECT.
 *
 * Path matching is the wrong question here. In reverse-proxy mode the path is
 * all we have, because every client points at the same base URL. Under a
 * CONNECT the client already told us the destination, and honouring that is
 * both more accurate and the only way to forward a request whose path no
 * preset claims.
 *
 * Host AND port, matching {@link interceptsHost} exactly. The two have to agree
 * or the port check there is defeated: `interceptsHost` decides *whether* to
 * decrypt on the full authority, and this decides *where the decrypted request
 * then goes*. With two upstreams naming the same host on different ports (an
 * ordinary `upstreams` config, even though no shipping preset does it), a
 * hostname-only resolve returns whichever sorts first, and the request is
 * forwarded to a port the client never asked for - the precise outcome the
 * comment in `interceptsHost` says its port check exists to prevent. A miss is
 * impossible in practice: this is only ever reached on a tunnel
 * `interceptsHost` already matched, so an exact host+port entry exists.
 *
 * @ref LLP 0234#intercept-set-is-the-routing-table [implements]: the entry that authorised the interception is the entry the request is routed to
 * @param {CompiledUpstream[]} upstreams
 * @param {string} host
 * @param {number} [port]
 * @returns {CompiledUpstream | undefined}
 */
export function matchUpstreamByHost(upstreams, host, port = 443) {
  const wanted = host.toLowerCase()
  return upstreams.find((u) => u.baseUrl.hostname === wanted && upstreamPortOf(u) === port)
}

/**
 * Whether a proxy-mode exchange should be recorded.
 *
 * Recording is opt-in per path, and the opt-in is the upstream's declared
 * `path_prefix`. Reusing the routing matcher here would be wrong: the Anthropic
 * matcher deliberately accepts a request on an Anthropic bearer token alone so
 * reverse-proxy traffic routes even on an unfamiliar path, and under a CONNECT
 * that predicate is true of *every* request the client makes to the host,
 * including OAuth settings reads, MCP registry fetches and update checks. A
 * synthetic POST carrying a `messages` array to an unrelated path was observed
 * projecting stored rows through exactly that hole.
 *
 * A catch-all (`/`) or absent prefix records nothing. Failing closed is the
 * only safe default when the question is "should this be persisted", and a
 * silent widening is precisely the outcome the path anchor exists to prevent.
 *
 * @ref LLP 0234#recording-is-opt-in-per-path [implements]: the path anchor, not the routing matcher, decides persistence
 * @param {CompiledUpstream} upstream
 * @param {string} pathname
 * @returns {boolean}
 */
export function shouldRecordProxyExchange(upstream, pathname) {
  // The adapter's own anchor when it registered one, else the routing prefix.
  const anchor = upstream.recordPrefix ?? upstream.prefix
  if (!anchor || anchor === '/') return false
  return pathMatchesPrefix(pathname, anchor)
}

/**
 * An agent that reaches the upstream through a corporate proxy.
 *
 * Built only when `upstream_proxy` is configured. The intercepted leg has to
 * take the same route as a blind tunnel: pointing `HTTPS_PROXY` at us removes
 * the customer's own proxy from the client's path, so if we did not chain we
 * would have cut egress that used to work.
 *
 * @param {UpstreamProxy} upstreamProxy
 * @returns {https.Agent}
 */
export function createChainedAgent(upstreamProxy) {
  const agent = new https.Agent({ keepAlive: true })
  // Node's Agent supports a callback form of `createConnection` that its
  // published types do not describe, so the assignment is made through an
  // untyped view of the agent rather than suppressed at each call.
  const untyped = /** @type {{ createConnection: Function }} */ (/** @type {unknown} */ (agent))
  /**
   * @param {{ host?: string, port?: number | string }} options
   * @param {(err: Error | null, socket?: import('node:net').Socket) => void} cb
   */
  untyped.createConnection = (options, cb) => {
    const host = String(options.host)
    const port = Number(options.port) || 443
    openUpstream({ host, port }, upstreamProxy, (err, socket) => {
      if (err || !socket) {
        cb(err ?? new Error('upstream proxy did not return a socket'))
        return
      }
      const secure = tls.connect({ socket, servername: host }, () => cb(null, secure))
      secure.on('error', (tlsErr) => cb(tlsErr))
    })
  }
  return agent
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

  // Which front door this request came through. Proxy-mode requests arrive on
  // a socket the CONNECT handler terminated and stamped with the host the
  // client asked for; reverse-proxy requests arrive on a plain socket.
  const connectHost = connectHostOf(req.socket)
  const proxyMode = connectHost !== undefined

  // @ref LLP 0066#control-path [implements]: the reserved `/_hypaware/`
  // prefix is a LOCAL control surface: handled in-process, never matched
  // against upstreams, never proxied, and it starts NO exchange (no
  // `startExchange`, no row). Checked BEFORE matchUpstream so a catch-all
  // upstream (`path_prefix: "/"`) cannot leak a control request to a
  // provider. The handler owns the request lifecycle (body + response); an
  // unregistered handler drains the body and 404s locally.
  //
  // Scoped to the direct origin. A tunnelled request is addressed to a third
  // party, so answering `https://api.anthropic.com/_hypaware/...` locally would
  // both swallow a path that is not ours and expose the unauthenticated control
  // surface to anything that can make the client fetch a URL. `hyp session
  // ignore` talks to `http://127.0.0.1:<port>` directly and is unaffected.
  if (!proxyMode && isControlPath(parsedUrl.pathname)) {
    if (typeof opts.onControlRequest === 'function') {
      opts.onControlRequest(req, res, parsedUrl)
      return
    }
    req.resume()
    sendJson(res, 404, { error: 'no control handler registered', path: parsedUrl.pathname })
    return
  }

  const upstream = proxyMode
    ? matchUpstreamByHost(upstreams, connectHost, connectPortOf(req.socket))
    : matchUpstream(upstreams, req.method ?? 'GET', parsedUrl.pathname, req.headers)
  if (!upstream) {
    req.resume()
    // Under a CONNECT the client named a host we agreed to decrypt, so failing
    // to resolve it is our bug, not a routing miss: say so rather than
    // reporting a path that was never the question.
    if (proxyMode) {
      // The port is named too: it is half of both the trust decision and the
      // routing key, so a report that omits it cannot describe this miss.
      sendJson(res, 502, {
        error: 'no upstream matches connect host',
        host: connectHost,
        port: connectPortOf(req.socket) ?? 443,
      })
      return
    }
    sendJson(res, 404, { error: 'no upstream matches path', path: parsedUrl.pathname })
    return
  }

  // Reverse-proxy traffic was routed here by a client we attached, so all of it
  // is in scope. Proxy-mode traffic is everything the client sends to the host,
  // so it is recorded only where an upstream's path anchor claims it.
  const recording = !proxyMode || shouldRecordProxyExchange(upstream, parsedUrl.pathname)

  const isHttps = upstream.baseUrl.protocol === 'https:'
  const lib = isHttps ? https : http
  const upstreamHost = upstream.baseUrl.host
  const upstreamPort = upstream.baseUrl.port
    ? Number.parseInt(upstream.baseUrl.port, 10)
    : isHttps ? 443 : 80

  const forwardedHeaders = forwardHeaders(req.headers, upstreamHost)
  const exchange = recording
    ? opts.startExchange({
      upstream: upstream.name,
      provider: upstream.provider,
      method: req.method,
      path: requestUrl,
      requestHeaders: req.headers,
    })
    : createNullExchange()

  let upstreamEnded = false
  let failed = false
  let finalized = false
  function finalizeOnce() {
    if (finalized) return
    finalized = true
    // A pass-through exchange produced no row and was never handed to the
    // recorder, so there is nothing to settle.
    if (!recording) return
    // The guard above is the narrowing: only a real recorder exchange reaches
    // here, so the null stand-in is never handed to the settle path.
    const recorded = /** @type {Exchange} */ (exchange)
    const pending = Promise.resolve(opts.onExchangeFinished(recorded))
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
    ...(isHttps && opts.chainedAgent ? { agent: opts.chainedAgent } : {}),
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
 * Pick the upstream for an inbound request. Upstreams are pre-sorted
 * by descending priority then registration order; the first one
 * whose `match()` returns true wins. Upstreams without a `match()`
 * fall back to path-segment prefix matching.
 *
 * @param {CompiledUpstream[]} upstreams
 * @param {string} method
 * @param {string} pathname
 * @param {IncomingHttpHeaders} headers
 */
export function matchUpstream(upstreams, method, pathname, headers) {
  const routeInput = buildRouteInput(method, pathname, headers)
  for (const u of upstreams) {
    if (typeof u.match === 'function') {
      let matched
      try {
        matched = u.match(routeInput) === true
      } catch {
        matched = false
      }
      if (matched) return u
      continue
    }
    if (u.prefix && pathMatchesPrefix(pathname, u.prefix)) return u
  }
  return undefined
}

/**
 * @param {string} method
 * @param {string} pathname
 * @param {IncomingHttpHeaders} headers
 * @returns {AiGatewayRouteInput}
 */
function buildRouteInput(method, pathname, headers) {
  /** @type {Record<string, string[]>} */
  const flatHeaders = {}
  for (const key of Object.keys(headers)) {
    const value = headers[key]
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (Array.isArray(value)) {
      flatHeaders[lower] = value.filter((entry) => typeof entry === 'string')
    } else {
      flatHeaders[lower] = [value]
    }
  }
  return { method, path: pathname, headers: flatHeaders }
}

/**
 * Recognize the reserved `/_hypaware/` local control prefix. Uses the same
 * segment-boundary discipline as `pathMatchesPrefix`: `/_hypaware` itself
 * and any `/_hypaware/...` sub-path match, but `/_hypawarefoo` does not, so
 * a look-alike upstream path is never mistaken for a control request.
 *
 * @ref LLP 0066#control-path [implements]
 * @param {string} pathname
 */
export function isControlPath(pathname) {
  return pathname === '/_hypaware' || pathname.startsWith('/_hypaware/')
}

/**
 * Path-segment prefix match. `/v1/messages` matches `/v1/messages` and
 * `/v1/messages/anything`, but not `/v1/messagesfoo`. A `/` prefix is
 * a catch-all so the simplest valid config (one upstream at `/`)
 * routes every request.
 *
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
export function compileUpstreams(upstreams) {
  /** @type {CompiledUpstream[]} */
  const out = []
  let seq = 0
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
    const compiled = {
      name: u.name,
      baseUrl,
      prefix: u.path_prefix,
      priority: typeof u.priority === 'number' ? u.priority : 0,
      seq: seq++,
      match: typeof u.match === 'function' ? u.match : undefined,
    }
    if (u.provider) compiled.provider = u.provider
    if (u.record_prefix) compiled.recordPrefix = u.record_prefix
    out.push(compiled)
  }
  return out.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    const aRank = prefixRank(a.prefix)
    const bRank = prefixRank(b.prefix)
    if (aRank !== bRank) return bRank - aRank
    return a.seq - b.seq
  })
}

/** @param {string | undefined} prefix */
function prefixRank(prefix) {
  if (!prefix) return -1
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
export function forwardHeaders(reqHeaders, upstreamHost) {
  /** @type {OutgoingHttpHeaders} */
  const out = {}
  for (const key of Object.keys(reqHeaders)) {
    const lower = key.toLowerCase()
    if (lower === 'host') continue
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    // `x-hypaware-*` request headers are gateway-local metadata that
    // client adapters inject for projector matching (e.g. OpenClaw's
    // `x-hypaware-client` and its `x-hypaware-marker` undo record).
    // They are stripped here, AFTER the exchange recorder captured the
    // original request headers, so projectors still see them but no
    // provider ever does.
    // @ref LLP 0109#consequences [implements]: inert metadata, never forwarded upstream
    if (lower.startsWith('x-hypaware-')) continue
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
