// @ts-check

import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'

import { isControlPath } from '../../../../src/core/control/session_ignore.js'
import { isMisdirectedHost } from '../../../../src/core/otlp/server.js'
import { isIpLiteralHost } from '../../../../src/core/tls/x509.js'
import { isLoopbackHost } from '../../../../src/core/util/loopback.js'
import { drainRequestBody } from '../../../../src/core/util/reject_body.js'
import { parseListen } from './config.js'
import { attachConnectFrontDoor, connectHostOf, connectPortOf, openUpstream } from './connect.js'
import { createNullExchange } from './recorder.js'

export { isControlPath }

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
    // The listener itself. Tests inject sockets here when they need a peer
    // address a loopback connect cannot produce; nothing else should reach
    // past `host`/`port`/`stop`.
    server,
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
  // An IP-literal authority is never intercepted, however the routing table
  // reads. The local CA can only mint `dNSName` leaves, which a client that
  // connected to an IP does not match against, so terminating such a tunnel
  // ends in a leaf mint that refuses the host - after the `200 Connection
  // Established` has already gone out, which kills the client's egress rather
  // than only its capture. `prepareInterception` drops an IP-literal upstream
  // from the CA host list, but the compiled routing table still carries it (it
  // is a real upstream in reverse-proxy mode), so the decision has to be made
  // here as well. This is what makes that skip's promise true: such an upstream
  // is tunnelled blind and unrecorded, exactly as an unconfigured host is. It
  // also covers an install upgraded from a build that did mint the IP into its
  // CA, where the host set alone would still say yes.
  // @ref LLP 0275#ip-literals-are-refused [implements]: an IP-literal CONNECT is tunnelled, never terminated
  if (isIpLiteralHost(wanted)) return false
  // A rewriting upstream is skipped on the same terms `matchUpstreamByHost`
  // skips it, and the two must agree or the pair inverts. Terminating a
  // tunnel on an entry routing cannot then resolve answers
  // `502 no upstream matches connect host` AFTER the
  // `200 Connection Established` has gone out, which kills that client's
  // egress to the host rather than only its capture - the precise outcome
  // the blind-tunnel degrade contract exists to prevent. Where a
  // non-rewriting entry also names the host (the ordinary case: `openai`
  // beside `openai-codex`) this changes nothing, because that entry still
  // matches here.
  // @ref LLP 0313#the-rewrite-is-declarative-data [constrained-by]: a rewrite claims no host, so it authorises no interception either
  // @ref LLP 0233#degrade-to-blind-tunnels [constrained-by]: a host we cannot route is tunnelled blind, never terminated and refused
  return upstreams.some((u) =>
    !u.rewrite && u.baseUrl.hostname === wanted && upstreamPortOf(u) === port)
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
 * Host AND port, on the same key {@link interceptsHost} uses. The two have to
 * agree on the key or the port check there is defeated: `interceptsHost` decides *whether* to
 * decrypt on the full authority, and this decides *where the decrypted request
 * then goes*. With two upstreams naming the same host on different ports (an
 * ordinary `upstreams` config, even though no shipping preset does it), a
 * hostname-only resolve returns whichever sorts first, and the request is
 * forwarded to a port the client never asked for - the precise outcome the
 * comment in `interceptsHost` says its port check exists to prevent. On the
 * tunnel path a miss is impossible in practice: it is only reached on a tunnel
 * `interceptsHost` already matched, so an exact host+port entry exists. The
 * absolute-form caller has no such guarantee: there a miss is expected, and it
 * means the named host is refused (LLP 0247 #refuse-hosts-nobody-registered).
 *
 * `interceptsHost` is strictly the narrower predicate, not the identical one:
 * it additionally refuses an IP-literal authority, which cannot be terminated
 * (LLP 0275#ip-literals-are-refused). That direction is the one the argument
 * above needs, and that particular difference must not be copied here - an
 * IP-literal upstream is still routable and still recorded on the
 * absolute-form door, where no certificate is involved. Every OTHER filter
 * this function grows has to be added to `interceptsHost` as well, or the
 * pair inverts and a terminated tunnel ends in a 502 the client cannot
 * recover from.
 *
 * An upstream declaring a `rewrite` is skipped here, however it sorts, and
 * `interceptsHost` skips it in step for exactly that reason. Such an entry
 * exists to translate a foreign inbound prefix into the host's own path
 * shape, which is a reverse-proxy concern: on these two doors the client
 * addressed the real host itself and is already speaking its native paths, so
 * there is nothing to translate. Routing to it would apply a swap nobody asked
 * for and, worse, hand `shouldRecordProxyExchange` the wrong record anchor,
 * silently dropping capture for every path the host really serves. The
 * non-rewriting entry for the same host is the one that owns it; where there
 * is none, the host is not intercepted at all and its tunnel stays blind.
 *
 * @ref LLP 0313#the-rewrite-is-declarative-data [constrained-by]: a rewrite is a reverse-proxy door's rule, not a claim on the host
 * @ref LLP 0234#intercept-set-is-the-routing-table [implements]: the entry that authorised the interception is the entry the request is routed to
 * @param {CompiledUpstream[]} upstreams
 * @param {string} host
 * @param {number} [port]
 * @returns {CompiledUpstream | undefined}
 */
export function matchUpstreamByHost(upstreams, host, port = 443) {
  const wanted = host.toLowerCase()
  return upstreams.find((u) =>
    !u.rewrite && u.baseUrl.hostname === wanted && upstreamPortOf(u) === port)
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
  // client asked for; a plain socket carries origin-form reverse-proxy
  // traffic or, on a listener that also serves the forward-proxy front door,
  // the absolute-form shape decided just below.
  const connectHost = connectHostOf(req.socket)
  const proxyMode = connectHost !== undefined

  // The third front door: an absolute-form request-target on a plain socket
  // (`POST https://api.anthropic.com/... HTTP/1.1`). Claude Code's Remote
  // Control bridge sends this shape instead of opening a CONNECT tunnel, and
  // RFC 9112 requires proxies to accept it. `new URL` above parsed the
  // absolute URL as-is (the placeholder base loses), so `parsedUrl` already
  // carries the authority the client named.
  //
  // The door exists only where the CONNECT front door does: a client sends
  // absolute-form because something proxy-pointed it here, and gating on the
  // same condition keeps a pure reverse-proxy listener behaving exactly as it
  // always has (LLP 0233 #proxy-mode-is-explicit).
  // @ref LLP 0247#only-forward-proxy-listeners-serve-it [implements]: absolute-form is served beside CONNECT or not at all
  const forwardProxyDoor = Boolean(opts.interception) || Boolean(opts.tunnelOnly)
  // The shape, held apart from the door. A request line carrying an absolute
  // URL names its own destination whatever this listener then does with it, so
  // the `Host` beside it is that destination's name and not a claim about us.
  // The door decides whether we route by that name; the barrier below only
  // needs to know the claim was never made.
  const absoluteFormShape = !proxyMode && /^https?:\/\//i.test(requestUrl)
  // @ref LLP 0247#route-by-the-named-host [implements]: the request line names the destination, so routing is by host, not path
  const absoluteForm = absoluteFormShape && forwardProxyDoor
  if (absoluteForm) {
    // An absolute-form request is addressed to a third party, so serving it
    // to non-loopback peers would relay for the network: the same rule, for
    // the same reason, as the CONNECT front door.
    // @ref LLP 0247#loopback-peers-only [implements]
    const peer = req.socket.remoteAddress
    if (!isLoopbackHost(peer)) {
      opts.log?.warn?.('aigw.absolute_form_refused_remote_peer', { peer: peer ?? 'unknown' })
      rejectJson(req, res, 403, { error: 'absolute-form is served to loopback peers only' })
      return
    }
  }

  // The rebinding barrier. A direct origin-form request is the one shape here
  // addressed to this listener itself, so a `Host` naming anything else names
  // something that merely resolves here: what a DNS-rebound page sends, which
  // the browser holds same-origin with this port, so no preflight stands in
  // its way. Refused ahead of both things it can reach: the unauthenticated
  // `/_hypaware/` route below, and a catch-all upstream, where a rebound POST
  // becomes a row.
  //
  // Scoped to the direct origin. The other two front doors are addressed to a
  // third party by design, so their `Host` is that party's name and never this
  // listener's; what contains them is the loopback-peers-only check above and
  // the routing table.
  //
  // The absolute-form arm is scoped by SHAPE, not by the door the control
  // check below is scoped by. A pure reverse-proxy listener opens no such
  // door, yet it still answers the shape, by letting it fall through to path
  // routing exactly as it always has (LLP 0247
  // #only-forward-proxy-listeners-serve-it, LLP 0233 #proxy-mode-is-explicit).
  // Judging a `Host` the client never aimed at this listener would turn that
  // promise into a 421. Nothing is given up: a browser cannot put an absolute
  // URL on a request line, so the shape is out of reach of the rebinding this
  // refuses.
  if (!proxyMode && !absoluteFormShape && isMisdirectedHost(req, { name: '@hypaware/ai-gateway', log: opts.log })) {
    rejectJson(req, res, 421, { error: 'misdirected request' })
    return
  }

  // @ref LLP 0066#control-path [implements]: the reserved `/_hypaware/`
  // prefix is a LOCAL control surface: handled in-process, never matched
  // against upstreams, never proxied, and it starts NO exchange (no
  // `startExchange`, no row). Checked BEFORE matchUpstream so a catch-all
  // upstream (`path_prefix: "/"`) cannot leak a control request to a
  // provider. The handler owns the request lifecycle (body + response); an
  // unregistered handler drains the body and 404s locally.
  //
  // Scoped to the direct origin. A tunnelled or absolute-form request is
  // addressed to a third party, so answering
  // `https://api.anthropic.com/_hypaware/...` locally would both swallow a
  // path that is not ours and expose the unauthenticated control surface to
  // anything that can make the client fetch a URL. `hyp session ignore` talks
  // to `http://127.0.0.1:<port>` directly and is unaffected.
  // @ref LLP 0247#the-control-surface-never-answers-absolute-form [implements]
  if (!proxyMode && !absoluteForm && isControlPath(parsedUrl.pathname)) {
    if (typeof opts.onControlRequest === 'function') {
      opts.onControlRequest(req, res, parsedUrl)
      return
    }
    rejectJson(req, res, 404, { error: 'no control handler registered', path: parsedUrl.pathname })
    return
  }

  // Absolute-form routes by the authority the request line names, like a
  // terminated tunnel does, with the port defaulted by scheme.
  const absoluteFormPort = parsedUrl.port
    ? Number.parseInt(parsedUrl.port, 10)
    : parsedUrl.protocol === 'https:' ? 443 : 80
  const upstream = proxyMode
    ? matchUpstreamByHost(upstreams, connectHost, connectPortOf(req.socket))
    : absoluteForm
      ? matchUpstreamByHost(upstreams, parsedUrl.hostname, absoluteFormPort)
      : matchUpstream(upstreams, req.method ?? 'GET', parsedUrl.pathname, req.headers)
  if (!upstream) {
    // Under a CONNECT the client named a host we agreed to decrypt, so failing
    // to resolve it is our bug, not a routing miss: say so rather than
    // reporting a path that was never the question.
    if (proxyMode) {
      // The port is named too: it is half of both the trust decision and the
      // routing key, so a report that omits it cannot describe this miss.
      rejectJson(req, res, 502, {
        error: 'no upstream matches connect host',
        host: connectHost,
        port: connectPortOf(req.socket) ?? 443,
      })
      return
    }
    // An absolute-form miss is a refusal, not a failure: forwarding only ever
    // reaches hosts the routing table names, so the listener never becomes a
    // general absolute-form relay.
    // @ref LLP 0247#refuse-hosts-nobody-registered [implements]
    if (absoluteForm) {
      opts.log?.warn?.('aigw.absolute_form_refused_host', {
        host: parsedUrl.hostname,
        port: absoluteFormPort,
      })
      rejectJson(req, res, 403, {
        error: 'no upstream matches absolute-form host',
        host: parsedUrl.hostname,
        port: absoluteFormPort,
      })
      return
    }
    rejectJson(req, res, 404, { error: 'no upstream matches path', path: parsedUrl.pathname })
    return
  }

  // Reverse-proxy traffic was routed here by a client we attached, so all of it
  // is in scope. Proxy-mode and absolute-form traffic is everything the client
  // sends to the host, so it is recorded only where an upstream's path anchor
  // claims it. On a degraded listener (tunnelOnly, no live interception) even
  // the anchor is off for absolute-form: the CONNECT door beside it is blind,
  // and the degrade contract is unrecorded-but-working, not
  // captured-where-possible.
  // @ref LLP 0247#degraded-listeners-forward-it-blind [implements]: no live interception means no capture, matching the blind tunnels beside it
  const absoluteFormBlind = absoluteForm && !opts.interception
  const recording = !absoluteFormBlind && ((!proxyMode && !absoluteForm)
    || shouldRecordProxyExchange(upstream, parsedUrl.pathname))

  const isHttps = upstream.baseUrl.protocol === 'https:'
  const lib = isHttps ? https : http
  const upstreamHost = upstream.baseUrl.host
  const upstreamPort = upstream.baseUrl.port
    ? Number.parseInt(upstream.baseUrl.port, 10)
    : isHttps ? 443 : 80

  const forwardedHeaders = forwardHeaders(req.headers, upstreamHost)
  // The door the request arrived at and the wire it leaves on are two
  // different facts once an upstream declares a rewrite. Only the outbound
  // path moves; the recorded `path` below stays the inbound one, because a
  // projector reads it to decide the body shape the CLIENT built, which the
  // gateway's choice of destination does not change.
  // @ref LLP 0313#the-row-records-where-the-request-was-sent [implements]: the outbound path is a separate recorded fact, not a replacement for the inbound one
  const outboundPathname = applyPathRewrite(parsedUrl.pathname, upstream.rewrite)
  const rewritten = outboundPathname !== parsedUrl.pathname
  if (rewritten) {
    // Pathnames only, never `search` and never a header: the credential is
    // what selected this route and must not be what the log line carries.
    opts.log?.info?.('aigw.path_rewritten', {
      upstream: upstream.name,
      from: parsedUrl.pathname,
      to: outboundPathname,
    })
  }
  const exchange = recording
    ? opts.startExchange({
      upstream: upstream.name,
      provider: upstream.provider,
      method: req.method,
      // Origin-form for absolute-form requests, so projectors see the same
      // path shape from all three front doors.
      path: absoluteForm ? parsedUrl.pathname + parsedUrl.search : requestUrl,
      requestHeaders: req.headers,
      ...(rewritten ? { upstreamPath: outboundPathname + parsedUrl.search } : {}),
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
    path: outboundPathname + parsedUrl.search,
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
      // The forward is over, so the rest of the upload is read for one reason
      // only: to get this 502 to a caller still sending. The `else` needs no
      // drain at all, because destroying the response destroys the socket.
      rejectJson(req, res, 502, { error: 'upstream connection failed', detail: errorDetail(err) })
    } else {
      res.destroy(err)
    }
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
 * Apply an upstream's declarative path rewrite to one inbound pathname.
 *
 * A single path-segment prefix swap: a pathname under `from` gets `from`
 * replaced by `to` and keeps the rest verbatim; anything else is returned
 * unchanged. The rule is data the gateway applies, not a plugin callback it
 * forwards the result of, so the whole routing decision stays printable and
 * is validated once at compile rather than per request.
 *
 * @ref LLP 0313#the-rewrite-is-declarative-data [implements]: core owns and applies the swap
 * @param {string} pathname
 * @param {{ from: string, to: string } | undefined} rewrite
 * @returns {string}
 */
export function applyPathRewrite(pathname, rewrite) {
  if (!rewrite) return pathname
  if (!pathMatchesPrefix(pathname, rewrite.from)) return pathname
  // `rest` is either empty or starts with '/', because `pathMatchesPrefix`
  // matches on segment boundaries. A `to` of '/' therefore carries the
  // separator the rest already has, and concatenating would double it.
  const rest = pathname.slice(rewrite.from.length)
  if (rewrite.to === '/') return rest.length > 0 ? rest : '/'
  return rewrite.to + rest
}

/**
 * Validate one preset-declared rewrite at compile time. A callback could
 * return anything (an absolute URL, a `..` escape, a glued-on query
 * string) and the gateway would forward it verbatim; a data rule can be
 * checked once, here, and then trusted on the hot path.
 *
 * @ref LLP 0313#the-rewrite-is-declarative-data [implements]: the rule is validated at registration
 * @param {string} name
 * @param {unknown} rewrite
 * @param {string | undefined} pathPrefix
 * @returns {{ from: string, to: string }}
 */
function compileRewrite(name, rewrite, pathPrefix) {
  if (!rewrite || typeof rewrite !== 'object' || Array.isArray(rewrite)) {
    throw new Error(`ai-gateway: upstream "${name}" has a non-object rewrite`)
  }
  const from = /** @type {{ from?: unknown }} */ (rewrite).from
  const to = /** @type {{ to?: unknown }} */ (rewrite).to
  for (const [field, value] of [['from', from], ['to', to]]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`ai-gateway: upstream "${name}" rewrite.${field} must be a non-empty string`)
    }
    if (!value.startsWith('/')) {
      throw new Error(`ai-gateway: upstream "${name}" rewrite.${field} must start with '/': ${value}`)
    }
    if (/[?#]/.test(value) || value.split('/').includes('..')) {
      throw new Error(`ai-gateway: upstream "${name}" rewrite.${field} is not a plain path prefix: ${value}`)
    }
    if (value.length > 1 && value.endsWith('/')) {
      throw new Error(`ai-gateway: upstream "${name}" rewrite.${field} must not end with '/': ${value}`)
    }
  }
  const fromPath = /** @type {string} */ (from)
  const toPath = /** @type {string} */ (to)
  // '/' passes every check above (leading slash, non-empty, no query, and
  // the trailing-slash rule skips a single character) and then matches every
  // path while slicing away the leading separator: '/responses' under
  // { from: '/', to: '/v1' } would leave as '/v1responses'. A `from` is a
  // prefix to strip, and the whole path is not one.
  if (fromPath === '/') {
    throw new Error(`ai-gateway: upstream "${name}" rewrite.from must name a prefix, not '/'`)
  }
  // `from` has to be a prefix this upstream actually owns, or the rule
  // would move paths the upstream was never routed for.
  if (pathPrefix && !pathMatchesPrefix(fromPath, pathPrefix)) {
    throw new Error(
      `ai-gateway: upstream "${name}" rewrite.from '${fromPath}' is outside its path_prefix '${pathPrefix}'`
    )
  }
  return { from: fromPath, to: toPath }
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
    if (u.rewrite) compiled.rewrite = compileRewrite(u.name, u.rewrite, u.path_prefix)
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
 * Answer a request this listener will not forward, discarding whatever body it
 * carries under the shared cap in `drainRequestBody`. The drain runs before
 * the answer is written, because it is what decides whether this connection
 * can be answered as a reusable one.
 *
 * The upstream-failure site is the one here that refuses a request already
 * handed to a pipe, and it still arrives flowing: the pipe tears down first,
 * because `stream.pipe()` registers its dest-`error` handler with
 * `prependListener`. So the drain's resume finds nothing paused to undo.
 *
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function rejectJson(req, res, status, body) {
  drainRequestBody(req, res)
  sendJson(res, status, body)
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
