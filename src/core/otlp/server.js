// @ts-check

import http from 'node:http'
import zlib from 'node:zlib'

import { isControlPath } from '../control/session_ignore.js'
import { Attr, getLogger } from '../observability/index.js'

/**
 * @import { IncomingMessage } from 'node:http'
 * @import { PluginLogger } from '../../../hypaware-plugin-kernel-types.js'
 * @import { OtlpJsonServerOptions, OtlpSignal } from '../../../src/core/otlp/types.js'
 */

const JSON_CT = { 'Content-Type': 'application/json' }

/**
 * The names a listener on the loopback interface answers to. Anything
 * else in `Host` means the request was addressed to some other name that
 * merely resolves here, which is what a DNS-rebinding page's request
 * looks like: the browser holds the attacker's origin same-origin with
 * this listener, so neither a preflight nor a content-type gate stands in
 * its way, and the `Host` it carries is what tells the two apart.
 */
const LOOPBACK_HOST_NAMES = new Set(['localhost', '::1'])

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
 * Refusals so far, per listener name, for the bound above.
 *
 * @type {Map<string, { total: number, loggedAt: number }>}
 */
const HOST_REFUSALS = new Map()

/** @param {string} hostname lowercased, with brackets and port removed */
function isLoopbackHostName(hostname) {
  if (LOOPBACK_HOST_NAMES.has(hostname)) return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname.replace(/^::ffff:/, ''))
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
 * Only connections that arrived over loopback are judged. A listener
 * given a routable `listen_host` is reachable under whatever name
 * resolves to that address, and answering to that name is the point of
 * configuring it. A request rebound at a loopback listener, which is the
 * default bind and the one this guards, always lands on loopback; an
 * operator who deliberately published the listener on a routable address
 * is outside that guarantee and outside this check. A request with no
 * `Host` at all passes: HTTP/1.0 clients omit it and a browser never
 * does, so its absence is not the signal.
 *
 * @param {IncomingMessage} req
 * @param {{ name: string, log?: PluginLogger }} opts `name` identifies the
 * listener in the refusal log line; `log` lets a hosting plugin stamp its
 * own logger on it, the way the control handler does.
 * @returns {boolean}
 */
export function isMisdirectedHost(req, opts) {
  // Only a local address that reads as a routable one earns the exemption. An
  // address that cannot be read at all is judged instead of waved through:
  // this check is the whole barrier in front of these routes, so its unknown
  // case fails closed.
  const localAddress = (req.socket.localAddress ?? '').toLowerCase()
  if (localAddress !== '' && !isLoopbackHostName(localAddress)) return false
  const value = req.headers.host
  if (!value) return false
  const hostname = hostnameOfHostHeader(value)
  if (hostname !== undefined && (isLoopbackHostName(hostname) || WILDCARD_BIND_NAMES.has(hostname))) return false
  const refusals = HOST_REFUSALS.get(opts.name) ?? { total: 0, loggedAt: 0 }
  refusals.total += 1
  HOST_REFUSALS.set(opts.name, refusals)
  const now = Date.now()
  if (now - refusals.loggedAt >= HOST_REFUSED_LOG_INTERVAL_MS) {
    refusals.loggedAt = now
    const log = opts.log ?? getLogger('otlp')
    log.warn('listener.host_refused', {
      [Attr.COMPONENT]: 'sources',
      [Attr.OPERATION]: 'host_check',
      [Attr.STATUS]: 'skipped',
      [Attr.ERROR_KIND]: 'host_not_loopback',
      listener: opts.name,
      host: value.slice(0, LOGGED_HOST_MAX_CHARS),
      // Every refusal since this process started, so a burst the interval
      // above swallowed is still legible from one line.
      refused_total: refusals.total,
    })
  }
  return true
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

    // A constant base. Nothing below reads the authority, only the path and
    // the query, and a `Host` no authority can be parsed out of throws here,
    // out of an `async` handler nothing catches, which takes the daemon with
    // it. The `Host` check above refuses such a header, but only on the
    // loopback binds it judges.
    const url = new URL(req.url ?? '/', 'http://localhost')
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
