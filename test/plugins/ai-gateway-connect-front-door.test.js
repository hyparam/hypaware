// @ts-check

import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import tls from 'node:tls'

import {
  CONNECT_HOST,
  attachConnectFrontDoor,
  parseAuthority,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/connect.js'
import {
  compileConfig,
  compileUpstreamProxy,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/config.js'
import { createLeafStore, ensureLocalCa } from '../../src/core/tls/ca.js'

const HOST = 'api.anthropic.com'

/** @param {import('node:net').Server | http.Server} server */
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  return address && typeof address === 'object' ? address.port : 0
}

/**
 * Stand up the pieces a proxy-mode boot needs: a CA, a leaf store, an HTTP
 * server, and the CONNECT handler in front of it.
 *
 * @param {object} args
 * @param {(host: string, port: number) => boolean} args.shouldIntercept
 * @param {http.RequestListener} [args.onRequest]
 */
async function bootFrontDoor({ shouldIntercept, onRequest }) {
  const stateRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-connect-'))
  const ca = await ensureLocalCa({ stateRoot, hosts: [HOST] })
  const leaves = createLeafStore(ca)

  /** @type {{ url: string | undefined, host: string | undefined, connectHost: unknown }[]} */
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push({
      url: req.url,
      host: req.headers.host,
      connectHost: /** @type {Record<symbol, unknown>} */ (
        /** @type {unknown} */ (req.socket)
      )[CONNECT_HOST],
    })
    if (onRequest) return onRequest(req, res)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('handled')
  })
  const port = await listen(server)

  /** @type {{ message: string, fields: Record<string, unknown> | undefined }[]} */
  const warns = []
  const frontDoor = attachConnectFrontDoor({
    server,
    shouldIntercept,
    secureContextFor: (h) => leaves.secureContextFor(h),
    log: { warn: (message, fields) => warns.push({ message, fields }) },
  })

  return {
    ca,
    port,
    seen,
    warns,
    server,
    frontDoor,
    async cleanup() {
      frontDoor.close()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
      await fsp.rm(stateRoot, { recursive: true, force: true })
    },
  }
}

/**
 * Issue a CONNECT and return the raw socket once the tunnel is established.
 *
 * @param {number} proxyPort
 * @param {string} authority
 * @returns {Promise<{ socket: net.Socket, statusLine: string }>}
 */
function connectTunnel(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    /** @type {Buffer} */
    let buffered = Buffer.alloc(0)
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)])
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', onData)
      const statusLine = buffered.subarray(0, buffered.indexOf('\r\n')).toString('ascii')
      const rest = buffered.subarray(end + 4)
      if (rest.length > 0) socket.unshift(rest)
      resolve({ socket, statusLine })
    }
    socket.on('data', onData)
    socket.on('error', reject)
  })
}

// The seam the whole design rests on: a TLS socket terminated inside the
// CONNECT handler is handed to the existing HTTP server, which then serves it
// with no knowledge that a tunnel was ever involved.
// @ref LLP 0233#one-listener-two-front-doors [tests]
test('an intercepted tunnel is decrypted and served by the existing HTTP server', async (t) => {
  const rig = await bootFrontDoor({ shouldIntercept: (host) => host === HOST })
  t.after(() => rig.cleanup())

  const { socket, statusLine } = await connectTunnel(rig.port, `${HOST}:443`)
  assert.match(statusLine, /^HTTP\/1\.1 200 /)

  const body = await new Promise((resolve, reject) => {
    const secure = tls.connect(
      { socket, servername: HOST, ca: [rig.ca.certPem], ALPNProtocols: ['http/1.1'] },
      () => {
        assert.equal(secure.authorized, true, 'client trusts the minted leaf')
        secure.write(`GET /v1/messages HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`)
      }
    )
    /** @type {Buffer[]} */
    const chunks = []
    secure.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    secure.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    secure.on('error', reject)
  })

  assert.match(body, /^HTTP\/1\.1 200 /)
  assert.match(body, /\bhandled\b/)

  assert.equal(rig.seen.length, 1)
  assert.equal(rig.seen[0].url, '/v1/messages')
  assert.equal(rig.seen[0].host, HOST)
  // The routing key proxy-mode requests are resolved by.
  assert.equal(rig.seen[0].connectHost, HOST)
})

// Everything we are not deliberately capturing has to stay opaque: a proxy sees
// all client egress, not just model traffic.
// @ref LLP 0234#blind-tunnel-by-default [tests]
test('a non-intercepted tunnel is piped through without decryption', async (t) => {
  const echo = net.createServer((socket) => socket.pipe(socket))
  const echoPort = await listen(echo)
  t.after(() => new Promise((resolve) => echo.close(() => resolve(undefined))))

  const rig = await bootFrontDoor({ shouldIntercept: () => false })
  t.after(() => rig.cleanup())

  const { socket, statusLine } = await connectTunnel(rig.port, `127.0.0.1:${echoPort}`)
  assert.match(statusLine, /^HTTP\/1\.1 200 /)

  const echoed = await new Promise((resolve, reject) => {
    socket.write('opaque bytes')
    socket.once('data', (chunk) => resolve(chunk.toString('utf8')))
    socket.once('error', reject)
  })

  assert.equal(echoed, 'opaque bytes')
  // Nothing reached the HTTP server: the bytes were never decrypted.
  assert.equal(rig.seen.length, 0)
  socket.destroy()
})

test('a tunnel to an unreachable host answers 502 rather than hanging', async (t) => {
  const rig = await bootFrontDoor({ shouldIntercept: () => false })
  t.after(() => rig.cleanup())

  // Port 1 on the loopback refuses immediately.
  const { statusLine, socket } = await connectTunnel(rig.port, '127.0.0.1:1')
  assert.match(statusLine, /^HTTP\/1\.1 502 /)
  assert.equal(rig.warns.some((w) => w.message === 'aigw.connect_tunnel_failed'), true)
  socket.destroy()
})

test('close() destroys the sockets the front door owns', async (t) => {
  const echo = net.createServer((socket) => socket.pipe(socket))
  const echoPort = await listen(echo)
  t.after(() => new Promise((resolve) => echo.close(() => resolve(undefined))))

  const rig = await bootFrontDoor({ shouldIntercept: () => false })
  const { socket } = await connectTunnel(rig.port, `127.0.0.1:${echoPort}`)
  assert.ok(rig.frontDoor.openCount() > 0)

  const closed = new Promise((resolve) => socket.on('close', () => resolve(undefined)))
  await rig.cleanup()
  await closed

  assert.equal(rig.frontDoor.openCount(), 0)
})

test('parseAuthority handles ports, defaults, and IPv6 literals', () => {
  assert.deepEqual(parseAuthority('api.anthropic.com:443'), { host: 'api.anthropic.com', port: 443 })
  assert.deepEqual(parseAuthority('example.com'), { host: 'example.com', port: 443 })
  assert.deepEqual(parseAuthority('[::1]:8443'), { host: '::1', port: 8443 })
  assert.equal(parseAuthority('example.com:0'), undefined)
  assert.equal(parseAuthority('example.com:notaport'), undefined)
  assert.equal(parseAuthority(''), undefined)
})

test('a malformed CONNECT target is refused', async (t) => {
  const rig = await bootFrontDoor({ shouldIntercept: () => true })
  t.after(() => rig.cleanup())

  const { statusLine, socket } = await connectTunnel(rig.port, 'example.com:0')
  assert.match(statusLine, /^HTTP\/1\.1 400 /)
  socket.destroy()
})

// An upstream that resets an established tunnel is routine (an idle connection
// dropped by the far end). It must not produce a second callback, because the
// failure branch writes a plaintext 502 into what is by then an opaque TLS
// stream, and the client reports a protocol decode error instead of a close.
test('a mid-tunnel upstream reset injects nothing into the tunnel', async (t) => {
  /** @type {import('node:net').Socket[]} */
  const accepted = []
  const flaky = net.createServer((socket) => {
    accepted.push(socket)
    socket.on('error', () => {})
  })
  const flakyPort = await listen(flaky)
  t.after(() => new Promise((resolve) => flaky.close(() => resolve(undefined))))

  const rig = await bootFrontDoor({ shouldIntercept: () => false })
  t.after(() => rig.cleanup())

  const { socket, statusLine } = await connectTunnel(rig.port, `127.0.0.1:${flakyPort}`)
  assert.match(statusLine, /^HTTP\/1\.1 200 /)

  /** @type {Buffer[]} */
  const afterEstablished = []
  socket.on('data', (chunk) => afterEstablished.push(Buffer.from(chunk)))

  // Send a byte so the tunnel is genuinely carrying traffic, then have the far
  // end reset it the way a real host drops an idle connection.
  socket.write('x')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(accepted.length, 1, 'the tunnel reached the far end')
  accepted[0].resetAndDestroy()
  await new Promise((resolve) => setTimeout(resolve, 100))

  const injected = Buffer.concat(afterEstablished).toString('utf8')
  assert.equal(injected, '', `nothing may be written into an established tunnel, got ${JSON.stringify(injected)}`)
  socket.destroy()
})

// ---------------------------------------------------------------------------
// Corporate proxy chaining
//
// Pointing `HTTPS_PROXY` at the gateway takes the customer's own egress proxy
// out of the client's path, so `upstream_proxy` is what keeps that path
// working. It had no coverage at all: neither the URL compiler nor the CONNECT
// hop was exercised by any test.
// ---------------------------------------------------------------------------

/**
 * A minimal CONNECT relay standing in for a corporate proxy.
 *
 * @param {object} [opts]
 * @param {string} [opts.refuseWith] answer every CONNECT with this status line instead of relaying
 */
async function bootCorporateProxy(opts = {}) {
  /** @type {{ authority: string, authorization: string | undefined }[]} */
  const seen = []
  const server = net.createServer((client) => {
    /** @type {Buffer} */
    let buffered = Buffer.alloc(0)
    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)])
      const end = buffered.indexOf('\r\n\r\n')
      if (end === -1) return
      client.removeListener('data', onData)
      const lines = buffered.subarray(0, end).toString('ascii').split('\r\n')
      const authority = lines[0].split(' ')[1] ?? ''
      const auth = lines.slice(1)
        .find((l) => l.toLowerCase().startsWith('proxy-authorization:'))
      seen.push({ authority, authorization: auth?.slice(auth.indexOf(':') + 1).trim() })
      if (opts.refuseWith) {
        client.end(`HTTP/1.1 ${opts.refuseWith}\r\n\r\n`)
        return
      }
      const [host, port] = authority.split(':')
      const hop = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const rest = buffered.subarray(end + 4)
        if (rest.length > 0) hop.write(rest)
        hop.pipe(client)
        client.pipe(hop)
      })
      hop.on('error', () => client.destroy())
    }
    client.on('data', onData)
    client.on('error', () => client.destroy())
  })
  const port = await listen(server)
  return {
    port,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}

// A mistyped credential must not be able to take the gateway down. `URL` leaves
// an invalid percent-escape in place and `decodeURIComponent` throws on it, so
// this used to propagate out of `compileConfig` and abort the source start,
// which is the one thing the compiler's contract promises it will not do.
test('a malformed upstream_proxy compiles to undefined rather than throwing', () => {
  assert.equal(compileUpstreamProxy('http://user:p%zz@proxy.corp:8080'), undefined)
  assert.equal(compileUpstreamProxy('http://us%er@proxy.corp:8080'), undefined)
  assert.equal(compileConfig({ upstream_proxy: 'http://user:p%zz@proxy.corp:8080' }).upstreamProxy, undefined)
  assert.equal(compileUpstreamProxy('not a url'), undefined)
  assert.equal(compileUpstreamProxy('ftp://proxy.corp:8080'), undefined)
  assert.equal(compileUpstreamProxy(''), undefined)
  assert.equal(compileUpstreamProxy(undefined), undefined)
})

test('upstream_proxy compiles host, defaulted port and pre-encoded credentials', () => {
  assert.deepEqual(compileUpstreamProxy('http://proxy.corp:8080'), { host: 'proxy.corp', port: 8080 })
  assert.deepEqual(compileUpstreamProxy('http://proxy.corp'), { host: 'proxy.corp', port: 80 })
  assert.deepEqual(compileUpstreamProxy('http://u%40b:p%3Aw@proxy.corp:3128'), {
    host: 'proxy.corp',
    port: 3128,
    // The userinfo is percent-decoded before base64, so `u@b:p:w` round-trips.
    authorization: `Basic ${Buffer.from('u@b:p:w').toString('base64')}`,
  })
})

// The hop itself: a blind tunnel through a configured corporate proxy reaches
// the destination and carries the credentials the URL named.
test('a blind tunnel chains through the configured corporate proxy', async (t) => {
  const corporate = await bootCorporateProxy()
  const echo = net.createServer((socket) => socket.pipe(socket))
  const echoPort = await listen(echo)
  const rig = await bootFrontDoor({ shouldIntercept: () => false })
  rig.frontDoor.close()

  const via = compileUpstreamProxy(`http://alice:s3cret@127.0.0.1:${corporate.port}`)
  assert.ok(via)
  const chained = attachConnectFrontDoor({
    server: /** @type {never} */ (rig.server),
    shouldIntercept: () => false,
    secureContextFor: () => { throw new Error('not intercepting') },
    upstreamProxy: via,
  })

  const { socket, statusLine } = await connectTunnel(rig.port, `127.0.0.1:${echoPort}`)
  // One ordered hook, not four: every `close()` here resolves only once its
  // connections have ended, so the tunnel this test opened has to be torn down
  // before any of the three servers is asked to close.
  t.after(async () => {
    socket.destroy()
    chained.close()
    await rig.cleanup()
    await corporate.close()
    await new Promise((resolve) => echo.close(() => resolve(undefined)))
  })
  assert.match(statusLine, /^HTTP\/1\.1 200 /)

  socket.write('ping')
  const echoed = await new Promise((resolve) => socket.once('data', (c) => resolve(c.toString())))
  assert.equal(echoed, 'ping')

  assert.equal(corporate.seen.length, 1)
  assert.equal(corporate.seen[0].authority, `127.0.0.1:${echoPort}`)
  assert.equal(
    corporate.seen[0].authorization,
    `Basic ${Buffer.from('alice:s3cret').toString('base64')}`
  )
})

// A corporate proxy that refuses is a 502 to the client, not a hang and not a
// silent close.
test('a corporate proxy refusing CONNECT surfaces as 502', async (t) => {
  const corporate = await bootCorporateProxy({ refuseWith: '407 Proxy Authentication Required' })
  const rig = await bootFrontDoor({ shouldIntercept: () => false })
  rig.frontDoor.close()

  const chained = attachConnectFrontDoor({
    server: /** @type {never} */ (rig.server),
    shouldIntercept: () => false,
    secureContextFor: () => { throw new Error('not intercepting') },
    upstreamProxy: { host: '127.0.0.1', port: corporate.port },
  })

  const { socket, statusLine } = await connectTunnel(rig.port, 'example.invalid:443')
  t.after(async () => {
    socket.destroy()
    chained.close()
    await rig.cleanup()
    await corporate.close()
  })
  assert.match(statusLine, /^HTTP\/1\.1 502 /)
})
