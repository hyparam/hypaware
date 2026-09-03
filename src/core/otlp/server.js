// @ts-check

import http from 'node:http'
import zlib from 'node:zlib'

import { isControlPath } from '../control/session_ignore.js'
import { Attr, getLogger } from '../observability/index.js'
import { isLoopbackHost } from '../util/loopback.js'

/**
 * @import { IncomingMessage, Server } from 'node:http'
 * @import { PluginLogger } from '../../../hypaware-plugin-kernel-types.js'
 * @import { OtlpJsonServerOptions, OtlpSignal } from '../../../src/core/otlp/types.js'
 */

const JSON_CT = { 'Content-Type': 'application/json' }

/**
 * The two wildcard binds, answered to as well when they arrive in `Host`.
 * A listener given `listen_host: "0.0.0.0"` (or `"::"`) advertises exactly
 * that string as its `listen_host` in the live status snapshot, so it is what
 * `hyp session ignore` and anything else that resolves a recorder's endpoint
 * from that snapshot address it by, over loopback. Answering costs nothing:
 * a numeric literal is not a name DNS can point somewhere else, so it never
 * carries the signal this check reads.
 */
const WILDCARD_BIND_NAMES = new Set(['0.0.0.0', '::'])

// A refusal costs the caller nothing, and the refused routes are reachable by
// the same browser page the check exists to turn away, so a line per refusal
// would trade blocked row injection for unbounded row growth in `logs`. That
// is the trade the neighbouring content-type gate already declined to make, so
// refusals are always counted and logged at most this often per listener.
const HOST_REFUSED_LOG_INTERVAL_MS = 60 * 1000
// The logged `Host` is caller-chosen and bounded only by Node's header budget;
// a real one is short.
const LOGGED_HOST_MAX_CHARS = 128
/**
 * Refusals so far, for the bound above, keyed by the server that refused them.
 *
 * Per server rather than per listener name, so the state lives exactly as long
 * as the listener that filled it in: a listener restarted inside the interval
 * accepts on a new server and so starts a fresh entry, rather than inheriting
 * the stopped one's `loggedAt` and swallowing its own first refusals, and
 * `refused_total` counts one listener's run. Two live listeners sharing a
 * name cannot reach each other's tally either.
 *
 * Weak, because the key is the whole live server: a strong module global would
 * pin every listener that ever refused, along with its request handler and
 * everything that closure captures. Nothing iterates this map, only looks an
 * entry up by its own server, so weakness costs nothing and spares the check a
 * lifecycle hook: an entry cannot outlive its server whether or not that
 * server ever emits `close` (a `stop()` that leaves a keep-alive socket open
 * defers that event indefinitely).
 *
 * @type {WeakMap<Server, { total: number, loggedAt: number }>}
 */
const HOST_REFUSALS = new WeakMap()

/**
 * The same tally for a refusal with no accepting server behind it: a direct
 * call to the check, or a request on a socket handed to a server by
 * `emit('connection')` rather than accepted by it. Keyed by listener name and
 * never cleared, so a restart inside the interval does inherit the stopped
 * run's clock. No listener here refuses on such a request today.
 *
 * @type {Map<string, { total: number, loggedAt: number }>}
 */
const HOST_REFUSALS_BY_NAME = new Map()

/**
 * The server that accepted `req`, or `undefined` for a request with none
 * behind it. Read off the request rather than threaded through the listener
 * API so it covers every host of this check, including the OpenCode listener,
 * which builds its own server and borrows this one function.
 *
 * @param {IncomingMessage} req
 * @returns {Server | undefined}
 */
function acceptingServer(req) {
  // Node sets the accepting server on every server-side socket but does not
  // declare it on `net.Socket`.
  return /** @type {{ server?: Server }} */ (req.socket).server
}

/**
 * One address in the single spelling a `Host` naming it would use:
 * lowercased, with the IPv4-mapped prefix off. libuv writes an address that
 * reached a dual-stack socket in the mapped form (`::ffff:198.51.100.7`), and
 * a client that copied its endpoint back out of such a tool writes that same
 * form in a `Host`. So every string the check below compares is read through
 * this: the arrival address, the bind, and the `Host` hostname. Otherwise one
 * address in two spellings collects two verdicts. A bind spelled that way
 * stops matching the address it is reached on, and an explicitly routable
 * listener loses the exemption it is configured for.
 *
 * @param {string} address
 * @returns {string}
 */
function hostSpelling(address) {
  const lower = address.toLowerCase()
  return lower.startsWith('::ffff:') ? lower.slice(7) : lower
}

/**
 * The address the server that accepted `req` is bound to, or `undefined`
 * when there is none to read: a request with no accepting server behind it, a
 * server that is not listening, or a pipe bind, which has no routable side.
 *
 * @param {IncomingMessage} req
 * @returns {string | undefined}
 */
function boundAddress(req) {
  const bound = acceptingServer(req)?.address()
  return typeof bound === 'object' && bound !== null ? hostSpelling(bound.address) : undefined
}

/**
 * Read the hostname out of a `Host` header, dropping the optional port
 * and the brackets an IPv6 literal is written in. Returns `undefined` for
 * a header no hostname can be read out of, which the caller refuses along
 * with the foreign ones.
 *
 * @param {string} value
 * @returns {string | undefined}
 */
function hostnameOfHostHeader(value) {
  const raw = value.trim().toLowerCase()
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end < 0) return undefined
    const port = raw.slice(end + 1)
    if (port !== '' && !/^:\d+$/.test(port)) return undefined
    return raw.slice(1, end)
  }
  const colon = raw.indexOf(':')
  if (colon < 0) return raw
  if (!/^:\d+$/.test(raw.slice(colon))) return undefined
  return raw.slice(0, colon)
}

/**
 * Should this request be refused because its `Host` names a host the
 * listener does not serve? Call it ahead of all routing, so one refusal
 * covers the control surface as well as the listener's own routes.
 *
 * A listener on the loopback interface answers to the loopback names and
 * to the wildcard binds. Anything else in `Host` means the request was
 * addressed to some other name that merely resolves here, which is what a
 * DNS-rebinding page's request looks like: the browser holds the
 * attacker's origin same-origin with this listener, so neither a preflight
 * nor a content-type gate stands in its way, and the `Host` it carries is
 * what tells the two apart.
 *
 * One connection is not judged: one that arrived on a routable address a
 * listener was bound to. Such a listener is reachable under whatever name
 * resolves to that address, and answering to that name is the point of
 * pointing it there. A wildcard bind is not that, and earns no exemption on
 * its routable side: it names no address to publish under, so what it
 * answers to there is the address the request arrived on, a literal no
 * resolver can point elsewhere. A request with no `Host` at all passes:
 * HTTP/1.0 clients omit it and a browser never does, so its absence is not
 * the signal.
 *
 * @param {IncomingMessage} req
 * @param {{ name: string, log?: Partial<PluginLogger> }} opts `name` identifies
 * the listener in the refusal log line; `log` lets a hosting plugin stamp its
 * own logger on it, the way the control handler does. Partial, because a
 * plugin may hold its logger under a type declaring only the methods it calls;
 * a logger with no `warn` still has its refusals counted.
 * @returns {boolean}
 */
export function isMisdirectedHost(req, opts) {
  // The address this request arrived on, in the spelling the bind it is
  // compared against is read in too.
  const arrivedOn = hostSpelling(req.socket.localAddress ?? '')
  // The exemption, and only it: a routable arrival address the listener was
  // bound to. A wildcard bind never equals the address it was reached on, so
  // its routable side is judged like its loopback side. An address that cannot
  // be read, on either side, is judged instead of waved through: this check is
  // the whole barrier in front of these routes, so its unknown cases fail
  // closed.
  const routable = arrivedOn !== '' && !isLoopbackHost(arrivedOn)
  if (routable && arrivedOn === boundAddress(req)) return false
  const value = req.headers.host
  if (!value) return false
  const hostname = hostnameOfHostHeader(value)
  if (
    hostname !== undefined &&
    (isLoopbackHost(hostname) || WILDCARD_BIND_NAMES.has(hostname) || (routable && hostSpelling(hostname) === arrivedOn))
  ) {
    return false
  }
  const server = acceptingServer(req)
  let refusals = server ? HOST_REFUSALS.get(server) : HOST_REFUSALS_BY_NAME.get(opts.name)
  if (!refusals) {
    refusals = { total: 0, loggedAt: 0 }
    if (server) HOST_REFUSALS.set(server, refusals)
    else HOST_REFUSALS_BY_NAME.set(opts.name, refusals)
  }
  refusals.total += 1
  const now = Date.now()
  if (now - refusals.loggedAt >= HOST_REFUSED_LOG_INTERVAL_MS) {
    refusals.loggedAt = now
    const log = opts.log ?? getLogger('otlp')
    log.warn?.('listener.host_refused', {
      [Attr.COMPONENT]: 'sources',
      [Attr.OPERATION]: 'host_check',
      [Attr.STATUS]: 'skipped',
      [Attr.ERROR_KIND]: 'host_not_loopback',
      listener: opts.name,
      host: value.slice(0, LOGGED_HOST_MAX_CHARS),
      // Which side refused and under what bind, because the rule is no longer
      // 'loopback only' everywhere: a wildcard bind answers on its routable
      // side to the address the request arrived on and to no other routable
      // name. Without these, an operator whose name-based LAN exporter starts
      // refusing reads a line indistinguishable from a rebinding attempt on
      // the loopback side. Empty for an address that could not be read, the
      // case that is judged rather than exempted.
      arrived_on: arrivedOn,
      bind: boundAddress(req) ?? '',
      // Every refusal since this listener started, so a burst the interval
      // above swallowed is still legible from one line.
      refused_total: refusals.total,
    })
  }
  return true
}

/**
 * The base every listener parses its request target against. A constant,
 * because nothing downstream reads the authority (only `pathname` and
 * `searchParams`), and building one out of `Host` puts a caller-chosen
 * string into the parser below.
 */
const REQUEST_URL_BASE = 'http://localhost'

/**
 * The request target as a `URL`, or `undefined` when it is one Node's HTTP
 * parser accepted and `new URL` will not (`//[`, `http://[::1` and friends
 * all reach a handler as `req.url`). The caller answers those 400.
 *
 * The distinction matters more than a parse helper usually does: an
 * uncaught throw here leaves the request handler, and there is no
 * `uncaughtException` or `unhandledRejection` handler anywhere in this
 * repo, so one malformed request line would end the daemon.
 *
 * @param {IncomingMessage} req
 * @returns {URL | undefined}
 */
export function requestUrlOf(req) {
  try {
    return new URL(req.url ?? '/', REQUEST_URL_BASE)
  } catch {
    return undefined
  }
}

/** Path to signal, the OTLP/HTTP standard routes. */
const SIGNAL_ROUTES = /** @type {Record<string, OtlpSignal>} */ ({
  '/v1/logs': 'logs',
  '/v1/traces': 'traces',
  '/v1/metrics': 'metrics',
})

const ALL_SIGNALS = /** @type {readonly OtlpSignal[]} */ (['logs', 'traces', 'metrics'])

/** The success envelope OTLP requires per signal: nothing was rejected. */
const EMPTY_PARTIAL_SUCCESS = {
  logs: { partialSuccess: { rejectedLogRecords: 0 } },
  traces: { partialSuccess: { rejectedSpans: 0 } },
  metrics: { partialSuccess: { rejectedDataPoints: 0 } },
}

// @ref LLP 0257#registration [implements]: one OTLP http/json server, hosted by more than one plugin; payload interpretation stays behind the handler
/**
 * Create an OTLP/HTTP listener. The handler is invoked once per decoded
 * request with `{ signal, data, payloadBytes }`. Errors thrown by the
 * handler bubble up as HTTP 500; the caller (the source's `start`) is
 * responsible for wrapping that path in a receive span and translating
 * exception types to `error_kind` attributes.
 *
 * Only OTLP/JSON is accepted: an OTLP/protobuf decoder chain was left
 * out of V1 and can be added later without changing the handler shape.
 *
 * Everything this server knows is transport: routing, content type,
 * content encoding, and the `partialSuccess` envelope. It never reads
 * inside `data`, so a second plugin can host a listener with entirely
 * different payload semantics.
 *
 * @param {OtlpJsonServerOptions} options
 * @returns {http.Server}
 */
export function createOtlpJsonServer(options) {
  const { name, handler } = options
  const served = new Set(options.signals ?? ALL_SIGNALS)

  return http.createServer(async (req, res) => {
    if (isMisdirectedHost(req, { name })) {
      req.resume()
      respondJsonError(res, 421, 7, 'Misdirected request: Host is not a loopback name')
      return
    }

    const url = requestUrlOf(req)
    if (!url) {
      req.resume()
      respondJsonError(res, 400, 3, 'Invalid request target')
      return
    }
    const route = url.pathname

    // The reserved `/_hypaware/` prefix is a LOCAL control surface, exactly
    // as it is on the gateway proxy: short-circuited before any OTLP
    // routing, so a control request is never read as an export and an
    // OTLP path can never shadow a control route. Hosts that register no
    // handler keep the old behavior (the paths fall through and 404 as
    // unknown OTLP routes below).
    // @ref LLP 0256#control-route-on-listener [implements]: the listener serves
    // the same control surface the proxy serves, through the same handler
    if (isControlPath(route) && typeof options.onControlRequest === 'function') {
      options.onControlRequest(req, res, url)
      return
    }

    if (req.method === 'GET' && route === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`${name} OTLP listener\n`)
      return
    }

    if (req.method !== 'POST') {
      respondJsonError(res, 405, 12, 'Method not allowed')
      return
    }

    const signal = SIGNAL_ROUTES[route]
    if (!signal || !served.has(signal)) {
      respondJsonError(res, 404, 5, 'Not found')
      return
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      respondJsonError(
        res,
        415,
        3,
        `Unsupported Content-Type: expected application/json, got '${contentType || 'none'}'`
      )
      return
    }

    const encoding = (req.headers['content-encoding'] || '').toLowerCase()
    /** @type {AsyncIterable<Buffer>} */
    let stream = req
    if (encoding === 'gzip') {
      stream = req.pipe(zlib.createGunzip())
    } else if (encoding === 'deflate') {
      stream = req.pipe(zlib.createInflate())
    } else if (encoding && encoding !== 'identity') {
      respondJsonError(res, 415, 3, `Unsupported Content-Encoding: ${encoding}`)
      return
    }

    /** @type {Buffer[]} */
    const chunks = []
    try {
      for await (const chunk of stream) chunks.push(chunk)
    } catch (err) {
      respondJsonError(res, 400, 3, err instanceof Error ? err.message : String(err))
      return
    }

    const body = Buffer.concat(chunks)
    let data
    try {
      data = body.length > 0 ? JSON.parse(body.toString('utf8')) : {}
    } catch {
      respondJsonError(res, 400, 3, 'Invalid JSON')
      return
    }

    try {
      await handler.handle({ signal, data, payloadBytes: body.length })
    } catch (err) {
      respondJsonError(res, 500, 13, err instanceof Error ? err.message : String(err))
      return
    }

    res.writeHead(200, JSON_CT)
    res.end(JSON.stringify(EMPTY_PARTIAL_SUCCESS[signal]))
  })
}

/**
 * @param {http.ServerResponse} res
 * @param {number} httpStatus
 * @param {number} code
 * @param {string} message
 */
function respondJsonError(res, httpStatus, code, message) {
  res.writeHead(httpStatus, JSON_CT)
  res.end(JSON.stringify({ code, message }))
}

/**
 * Listen on `host:port` and resolve with the actually bound `{ host, port }`.
 * Wraps the awkward `server.listen` callback / `address()` shape so a
 * source's `start` reads as a straight-line coroutine, and so a listener
 * asking for port `0` learns the port it actually got.
 *
 * @param {http.Server} server
 * @param {string} host
 * @param {number} port
 * @param {string} [name] listener name, used only in the failure message
 * @returns {Promise<{ host: string, port: number }>}
 */
export function listenAndResolve(server, host, port, name = 'hypaware') {
  return new Promise((resolve, reject) => {
    /** @param {Error} err */
    function onError(err) {
      server.off('listening', onListening)
      reject(err)
    }
    function onListening() {
      server.off('error', onError)
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        resolve({ host: addr.address, port: addr.port })
      } else {
        reject(new Error(`${name}: server.address() returned no AddressInfo`))
      }
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}
