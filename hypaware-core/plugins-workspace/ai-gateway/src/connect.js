// @ts-check

import net from 'node:net'
import tls from 'node:tls'

import { isLoopbackHost } from '../../../../src/core/util/loopback.js'

/**
 * The CONNECT front door: the second way into the same listener.
 *
 * In reverse-proxy mode a client is pointed at the gateway by base URL and
 * sends ordinary origin-form requests. In proxy mode the client keeps talking
 * to its real host and reaches us via `HTTPS_PROXY`, which means every request
 * arrives as a `CONNECT host:443` tunnel instead. Both modes run on one
 * listener: `handleRequest` still serves reverse-proxy traffic, and this
 * handler serves tunnels. That is what lets Claude attach in proxy mode while
 * Codex stays on the base-URL mechanism, with no second port.
 *
 * Two dispositions per tunnel, and the split is the whole privacy story:
 *
 * - **Blind tunnel** (the default): bytes are piped between the client and the
 *   destination without being decrypted. We learn the host and the byte counts
 *   and nothing else. A proxy sees *all* client egress - telemetry, package
 *   registries, update checks - so anything we are not deliberately capturing
 *   must stay opaque.
 * - **Terminate**: only for hosts a registered upstream actually names. We
 *   present a leaf from the machine-local CA, then hand the decrypted socket to
 *   the existing HTTP server so `handleRequest` runs unchanged.
 *
 * @import { Server } from 'node:http'
 * @import { Duplex } from 'node:stream'
 * @import { ConnectFrontDoorOptions, ConnectFrontDoor, UpstreamProxy } from './types.js'
 */

/**
 * Marks a socket that arrived through a terminated CONNECT tunnel, carrying the
 * host the client asked for. `handleRequest` reads it to route by CONNECT
 * target rather than by path, and to tell proxy-mode traffic from everything
 * arriving on a plain socket.
 */
export const CONNECT_HOST = Symbol('hypaware.connectHost')

/**
 * The port half of the same CONNECT target.
 *
 * Separate from {@link CONNECT_HOST} because that symbol is also the
 * proxy-mode discriminator (`handleRequest` reads "is this defined?" to tell
 * the CONNECT front door from plain-socket traffic, which then splits by
 * request-line shape, LLP 0247), and folding a port into it would change what
 * an absent value means. The pair is what routing keys on: `interceptsHost` made
 * the trust decision on host AND port, so resolving the upstream on the host
 * alone could hand the decrypted request to an entry addressing a different
 * port on the same name.
 */
export const CONNECT_PORT = Symbol('hypaware.connectPort')

/**
 * How long to wait for a tunnel's far end before answering the client 502.
 *
 * Generous: this bounds a blackholed destination, not a slow one, and the
 * client has its own, shorter timeouts.
 */
const CONNECT_TIMEOUT_MS = 30_000

/**
 * Stamp the CONNECT target onto a terminated socket.
 *
 * @param {Duplex} socket
 * @param {string} host
 * @param {number} port
 */
function markConnectTarget(socket, host, port) {
  const bag = /** @type {Record<symbol, string | number>} */ (/** @type {unknown} */ (socket))
  bag[CONNECT_HOST] = host
  bag[CONNECT_PORT] = port
}

/**
 * The CONNECT target a request arrived through, or `undefined` for traffic
 * on a plain socket. This is how `handleRequest` tells the CONNECT front door
 * from the other two: a plain socket carries origin-form reverse-proxy
 * traffic or an absolute-form request-target (LLP 0247), split by the
 * request line, not by the socket.
 *
 * @param {Duplex | null | undefined} socket
 * @returns {string | undefined}
 */
export function connectHostOf(socket) {
  if (!socket) return undefined
  const bag = /** @type {Record<symbol, string | undefined>} */ (/** @type {unknown} */ (socket))
  return bag[CONNECT_HOST]
}

/**
 * The port of the CONNECT target a request arrived through, or `undefined` for
 * reverse-proxy traffic.
 *
 * @param {Duplex | null | undefined} socket
 * @returns {number | undefined}
 */
export function connectPortOf(socket) {
  if (!socket) return undefined
  const bag = /** @type {Record<symbol, number | undefined>} */ (/** @type {unknown} */ (socket))
  return bag[CONNECT_PORT]
}

/**
 * Install the CONNECT handler on an existing HTTP server.
 *
 * @ref LLP 0233#one-listener-two-front-doors [implements]: no second port; a terminated tunnel re-enters the same server
 * @param {ConnectFrontDoorOptions} opts
 * @returns {ConnectFrontDoor}
 */
export function attachConnectFrontDoor(opts) {
  const { server, shouldIntercept, secureContextFor, upstreamProxy, log } = opts

  /**
   * Every socket this handler took ownership of. `server.close()` stops the
   * listener but knows nothing about hijacked sockets, so shutdown has to
   * destroy them itself or `stop()` hangs until the peer gives up.
   *
   * @type {Set<Duplex>}
   */
  const open = new Set()

  /** @param {Duplex} socket */
  function track(socket) {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {Duplex} clientSocket
   * @param {Buffer} head
   */
  function onConnect(req, clientSocket, head) {
    // A tunnel that dies mid-transfer is ordinary (the client navigated away,
    // the daemon is stopping). Without a listener it is an unhandled 'error'
    // that takes the process down.
    clientSocket.on('error', () => clientSocket.destroy())

    // The peer, not the bind. `listen` may legitimately be non-loopback for
    // reverse-proxy traffic, but a CONNECT relay that answers the network is an
    // open forward proxy into any host and port, so tunnels are only ever
    // opened for the machine's own processes. Attach writes
    // `http://127.0.0.1:<port>` regardless of the bind host, so the documented
    // client loses nothing.
    // @ref LLP 0233#loopback-peers-only [implements]: CONNECT from any peer that is not the machine itself is refused
    const peer = /** @type {net.Socket} */ (clientSocket).remoteAddress
    if (!isLoopbackHost(peer)) {
      log?.warn?.('aigw.connect_refused_remote_peer', { peer: peer ?? 'unknown' })
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }

    const target = parseAuthority(req.url ?? '')
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    track(clientSocket)

    let intercept = false
    try {
      intercept = shouldIntercept(target.host, target.port) === true
    } catch {
      intercept = false
    }

    if (intercept) {
      terminate(target, clientSocket, head)
    } else {
      tunnel(target, clientSocket, head)
    }
  }

  /**
   * Decrypt the tunnel and re-enter the normal request path.
   *
   * @param {{ host: string, port: number }} target
   * @param {Duplex} clientSocket
   * @param {Buffer} head
   */
  function terminate(target, clientSocket, head) {
    // Acknowledge before the handshake: the client will not send its
    // ClientHello until it sees the 200, so this has to reach the raw socket
    // while it is still a plain byte stream.
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    // Bytes that arrived with the CONNECT are the start of the client's TLS
    // record stream. They belong to the socket TLS is about to read, so push
    // them back rather than replaying them past the decryption layer.
    if (head && head.length > 0) clientSocket.unshift(head)

    /** @type {tls.TLSSocket} */
    let tlsSocket
    try {
      tlsSocket = new tls.TLSSocket(/** @type {net.Socket} */ (clientSocket), {
        isServer: true,
        // Offer HTTP/1.1 only. Claude Code will negotiate h2 when it is
        // offered, and the HTTP/1.1 server on the other side of this socket
        // cannot parse an h2 frame: the session would hang rather than fail.
        ALPNProtocols: ['http/1.1'],
        SNICallback: (servername, cb) => {
          try {
            cb(null, secureContextFor(servername || target.host))
          } catch (err) {
            cb(/** @type {Error} */ (err))
          }
        },
      })
    } catch (err) {
      log?.warn?.('aigw.connect_terminate_failed', {
        host: target.host,
        error: errorMessage(err),
      })
      clientSocket.destroy()
      return
    }

    track(tlsSocket)
    tlsSocket.on('error', () => tlsSocket.destroy())

    // The authority the client asked for, not the SNI name: this is what the
    // request path routes on, and it is the value we made a trust decision
    // about. The port travels with the host because the decision did.
    markConnectTarget(tlsSocket, target.host, target.port)

    // Hand the decrypted socket to the HTTP server. From here `handleRequest`
    // sees an ordinary req/res pair and needs no knowledge of tunnels.
    server.emit('connection', tlsSocket)
  }

  /**
   * Pipe bytes through without decrypting them.
   *
   * @ref LLP 0234#blind-tunnel-by-default [implements]: the disposition for every host no upstream names
   * @param {{ host: string, port: number }} target
   * @param {Duplex} clientSocket
   * @param {Buffer} head
   */
  function tunnel(target, clientSocket, head) {
    openUpstream(target, upstreamProxy, (err, upstream) => {
      if (err || !upstream) {
        log?.warn?.('aigw.connect_tunnel_failed', {
          host: target.host,
          port: target.port,
          error: err ? errorMessage(err) : 'no socket',
        })
        // 502 rather than a silent close, so a client that is going to fail
        // fails with a reason it can report.
        if (clientSocket.writable) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        return
      }
      track(upstream)
      upstream.on('error', () => {
        upstream.destroy()
        clientSocket.destroy()
      })
      clientSocket.on('close', () => upstream.destroy())

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
  }

  server.on('connect', onConnect)

  return {
    openCount: () => open.size,
    close() {
      server.off('connect', onConnect)
      for (const socket of open) socket.destroy()
      open.clear()
    },
  }
}

/**
 * Open a TCP path to `target`, either directly or through a corporate proxy.
 *
 * Customers may already run everything through an outbound proxy. Setting
 * `HTTPS_PROXY` to point at us takes that path away from the client, so if we
 * do not chain through their proxy we have silently cut their egress. The
 * connector is shared with the intercepted leg so both go the same way.
 *
 * @param {{ host: string, port: number }} target
 * @param {UpstreamProxy | undefined} via
 * @param {(err: Error | undefined, socket?: net.Socket) => void} cb
 */
export function openUpstream(target, via, cb) {
  // The callback reports the *outcome of connecting* and must fire exactly
  // once. Node's error listeners stay registered after a successful connect,
  // so without this latch a routine mid-session reset (an idle connection
  // dropped by the far end) called back a second time with an error, and the
  // caller wrote `HTTP/1.1 502 Bad Gateway` into an established, opaque TLS
  // tunnel. The client then sees plaintext where a TLS record belongs and
  // reports a decode error rather than a clean close.
  let settled = false
  /**
   * @param {Error | undefined} err
   * @param {net.Socket} [socket]
   */
  const settle = (err, socket) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    cb(err, socket)
  }

  // The socket currently being established, so a timeout can tear it down
  // rather than leaving it connecting in the background.
  /** @type {net.Socket | undefined} */
  let pending

  // A blackholed destination (a dropped SYN rather than a refusal) would
  // otherwise leave the client waiting on a tunnel that is never established
  // and never refused, for however long the OS takes to give up.
  const timer = setTimeout(() => {
    pending?.destroy()
    settle(new Error(`timed out connecting to ${target.host}:${target.port}`))
  }, CONNECT_TIMEOUT_MS)
  timer.unref()

  if (!via) {
    const direct = net.connect(target.port, target.host)
    pending = direct
    direct.once('connect', () => settle(undefined, direct))
    direct.once('error', (err) => settle(err))
    return
  }

  const hop = net.connect(via.port, via.host)
  pending = hop
  hop.once('error', (err) => settle(err))
  // A proxy that closes without answering the CONNECT would otherwise leave
  // the caller waiting forever with no 502 and no socket.
  hop.once('close', () => settle(new Error('upstream proxy closed before answering CONNECT')))
  hop.once('connect', () => {
    const authority = `${target.host}:${target.port}`
    /** @type {string[]} */
    const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`]
    if (via.authorization) lines.push(`Proxy-Authorization: ${via.authorization}`)
    hop.write(lines.join('\r\n') + '\r\n\r\n')

    /** @type {Buffer} */
    let buffered = Buffer.alloc(0)
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) {
        // A proxy that never finishes its response would otherwise buffer
        // without bound.
        if (buffered.length > 64 * 1024) {
          hop.removeListener('data', onData)
          hop.destroy()
          settle(new Error('upstream proxy sent an oversized CONNECT response'))
        }
        return
      }
      hop.removeListener('data', onData)
      const statusLine = buffered.subarray(0, buffered.indexOf('\r\n')).toString('ascii')
      const status = Number.parseInt(statusLine.split(' ')[1] ?? '', 10)
      if (status !== 200) {
        hop.destroy()
        settle(new Error(`upstream proxy refused CONNECT: ${statusLine}`))
        return
      }
      // Anything past the header belongs to the tunnel.
      const rest = buffered.subarray(end + 4)
      if (rest.length > 0) hop.unshift(rest)
      // The tunnel is up, so the 'close' latch above must stop meaning
      // "never answered".
      hop.removeAllListeners('close')
      settle(undefined, hop)
    }
    hop.on('data', onData)
  })
}

/**
 * Parse a CONNECT authority (`host:port`). The port is required by the method's
 * grammar, but default it rather than rejecting a client that omits it.
 *
 * IPv6 literals arrive bracketed (`[::1]:443`), so the host is split on the
 * last colon.
 *
 * @param {string} authority
 * @returns {{ host: string, port: number } | undefined}
 */
export function parseAuthority(authority) {
  if (typeof authority !== 'string' || authority.length === 0) return undefined

  // A bracketed IPv6 literal is split at the bracket, not at the last colon:
  // `[::1]` has colons inside the host, so `lastIndexOf(':')` would read it as
  // host `[:` on port 1.
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']')
    if (close === -1) return undefined
    const host = authority.slice(1, close)
    if (!host) return undefined
    const rest = authority.slice(close + 1)
    if (rest === '') return { host: host.toLowerCase(), port: 443 }
    if (!rest.startsWith(':')) return undefined
    const port = Number.parseInt(rest.slice(1), 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
    return { host: host.toLowerCase(), port }
  }

  const at = authority.lastIndexOf(':')
  if (at === -1) return { host: authority.toLowerCase(), port: 443 }

  const host = authority.slice(0, at)
  const port = Number.parseInt(authority.slice(at + 1), 10)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  // Lower-cased here, once, because this value is both the intercept decision
  // and the routing key: a client sending `API.ANTHROPIC.COM` would otherwise
  // never match an upstream and be silently blind-tunnelled.
  return { host: host.toLowerCase(), port }
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message || err.name : String(err)
}
