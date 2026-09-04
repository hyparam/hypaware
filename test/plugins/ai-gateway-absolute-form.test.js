// @ts-check

import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'

import { startProxy } from '../../hypaware-core/plugins-workspace/ai-gateway/src/proxy.js'

// The third front door (LLP 0247): a client that ignores HTTPS_PROXY CONNECT
// semantics and writes absolute-form plaintext straight to the listener port.
// Claude Code's Remote Control bridge is the shipping example (LLP 0246), so
// these tests replay its exact wire shape rather than going through an HTTP
// client library that would normalise the request line.

const HOST = 'localhost'

/**
 * A gateway in front of a fake upstream. Absolute-form arrives on a plain
 * socket, so no tunnel is ever terminated, but the door only opens on a
 * listener that serves the forward-proxy front door at all
 * (LLP 0247 #only-forward-proxy-listeners-serve-it). The default rig boots
 * with interception hooks - the shape of a live proxy-mode listener - whose
 * `secureContextFor` is never reached because nothing here handshakes TLS.
 * `degraded` boots `tunnelOnly` (a proxy-pointed listener without a CA), and
 * `reverse-proxy` boots neither flag.
 *
 * @param {{ mode?: 'intercepting' | 'degraded' | 'reverse-proxy' }} [options]
 */
async function bootGateway({ mode = 'intercepting' } = {}) {
  /** @type {string[]} */
  const upstreamHits = []
  const upstream = http.createServer((req, res) => {
    upstreamHits.push(req.url ?? '')
    const body = JSON.stringify({ ok: true, path: req.url })
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)))
  const upstreamAddress = upstream.address()
  const upstreamPort =
    upstreamAddress && typeof upstreamAddress === 'object' ? upstreamAddress.port : 0

  /** @type {{ path: string | undefined }[]} */
  const started = []
  /** @type {URL[]} */
  const controlCalls = []
  /** @type {{ message: string, fields: Record<string, unknown> }[]} */
  const warns = []

  const proxy = await startProxy({
    listen: '127.0.0.1:0',
    ...(mode === 'intercepting'
      ? {
        interception: {
          /** @returns {never} */
          secureContextFor: () => { throw new Error('no TLS on a plain socket') },
        },
      }
      : {}),
    ...(mode === 'degraded' ? { tunnelOnly: true } : {}),
    log: { warn: (message, fields) => { warns.push({ message, fields: fields ?? {} }) } },
    upstreams: [{
      name: 'fake-anthropic',
      base_url: `http://${HOST}:${upstreamPort}`,
      path_prefix: '/v1/messages',
      provider: 'anthropic',
    }],
    startExchange: (init) => {
      started.push({ path: init.path })
      return /** @type {never} */ ({
        isSse: false,
        response: undefined,
        appendRequestChunk() {},
        setResponseStart() {},
        appendResponseChunk() {},
        consumeStreamChunk() {},
        setError() {},
      })
    },
    onExchangeFinished: () => {},
    onControlRequest: (req, res, url) => {
      controlCalls.push(url)
      res.writeHead(204)
      res.end()
    },
  })

  return {
    proxy,
    started,
    controlCalls,
    upstreamHits,
    upstreamPort,
    warns,
    async cleanup() {
      await proxy.stop()
      await new Promise((resolve) => upstream.close(() => resolve(undefined)))
    },
  }
}

/**
 * Write one raw HTTP/1.1 request to the listener and return the full response
 * text. `target` is used verbatim as the request-target, so a caller controls
 * the exact request-line shape on the wire.
 *
 * @param {{ port: number, method?: string, target: string, host: string, body?: string }} args
 * @returns {Promise<string>}
 */
function rawRequest({ port, method = 'POST', target, host, body = '{}' }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `${method} ${target} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Connection: close\r\n' +
        '\r\n' +
        body
      )
    })
    /** @type {Buffer[]} */
    const chunks = []
    socket.on('data', (c) => chunks.push(Buffer.from(c)))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('error', reject)
  })
}

// The Remote Control regression: the bridge's registration call, replayed in
// its one-piece wire shape, must reach the upstream instead of a local 404
// that Claude Code misreads as "not available for your account".
// @ref LLP 0247#route-by-the-named-host [tests]
test('an absolute-form request to an intercepted host is forwarded', async (t) => {
  const rig = await bootGateway()
  t.after(() => rig.cleanup())

  const authority = `${HOST}:${rig.upstreamPort}`
  const body = await rawRequest({
    port: rig.proxy.port,
    target: `https://${authority}/v1/environments/bridge`,
    host: authority,
  })

  assert.match(body, /^HTTP\/1\.1 200 /)
  assert.match(body, /"ok":true/)
  assert.deepEqual(rig.upstreamHits, ['/v1/environments/bridge'])
  // Outside the path anchor: proxied faithfully, never recorded.
  assert.equal(rig.started.length, 0)
})

// Recording follows the same per-path opt-in as proxy mode, and the recorded
// path is origin-form so projectors see one shape from all three front doors.
// @ref LLP 0234#recording-is-opt-in-per-path [tests]
test('an absolute-form request inside the path anchor is recorded origin-form', async (t) => {
  const rig = await bootGateway()
  t.after(() => rig.cleanup())

  const authority = `${HOST}:${rig.upstreamPort}`
  const body = await rawRequest({
    port: rig.proxy.port,
    target: `https://${authority}/v1/messages?beta=true`,
    host: authority,
  })

  assert.match(body, /^HTTP\/1\.1 200 /)
  assert.deepEqual(rig.upstreamHits, ['/v1/messages?beta=true'])
  assert.deepEqual(rig.started, [{ path: '/v1/messages?beta=true' }])
})

// The containment half of the decision: a host the routing table does not
// name is refused, so the listener is not a general absolute-form relay.
// @ref LLP 0247#refuse-hosts-nobody-registered [tests]
test('an absolute-form request to an unregistered host is refused', async (t) => {
  const rig = await bootGateway()
  t.after(() => rig.cleanup())

  const body = await rawRequest({
    port: rig.proxy.port,
    target: 'https://evil.example/v1/messages',
    host: 'evil.example',
  })

  assert.match(body, /^HTTP\/1\.1 403 /)
  assert.match(body, /no upstream matches absolute-form host/)
  assert.deepEqual(rig.upstreamHits, [])
  assert.equal(rig.started.length, 0)
})

// An absolute-form target is addressed to a third party, so the local control
// surface must not answer it: it routes like any other absolute-form path.
// @ref LLP 0247#the-control-surface-never-answers-absolute-form [tests]
test('an absolute-form control path is forwarded, not answered locally', async (t) => {
  const rig = await bootGateway()
  t.after(() => rig.cleanup())

  const authority = `${HOST}:${rig.upstreamPort}`
  const body = await rawRequest({
    port: rig.proxy.port,
    target: `https://${authority}/_hypaware/session/ignore`,
    host: authority,
  })

  assert.match(body, /^HTTP\/1\.1 200 /)
  assert.deepEqual(rig.controlCalls, [])
  assert.deepEqual(rig.upstreamHits, ['/_hypaware/session/ignore'])
})

// Origin-form routing is untouched: the same path without an absolute URL on
// the request line still misses the path-routed table.
test('an origin-form request outside every prefix still 404s by path', async (t) => {
  const rig = await bootGateway()
  t.after(() => rig.cleanup())

  const body = await rawRequest({
    port: rig.proxy.port,
    target: '/v1/environments/bridge',
    host: `${HOST}:${rig.upstreamPort}`,
  })

  assert.match(body, /^HTTP\/1\.1 404 /)
  assert.match(body, /no upstream matches path/)
  assert.deepEqual(rig.upstreamHits, [])
})

// The peer containment: an absolute-form request is addressed to a third
// party, so serving one to a LAN peer would relay for the network. Tests can
// only ever connect from loopback, so the peer address is overridden on a
// real socket pair and the gateway-facing end is handed to the listener, the
// same technique the CONNECT front door tests use.
// @ref LLP 0247#loopback-peers-only [tests]
test('an absolute-form request from a non-loopback peer is refused', async (t) => {
  const rig = await bootGateway()
  t.after(() => rig.cleanup())

  const pair = net.createServer()
  await new Promise((resolve) => pair.listen(0, '127.0.0.1', () => resolve(undefined)))
  const pairAddress = pair.address()
  const pairPort = pairAddress && typeof pairAddress === 'object' ? pairAddress.port : 0
  const accepted = new Promise((resolve) => pair.once('connection', resolve))
  const client = net.connect(pairPort, '127.0.0.1')
  const gatewaySide = /** @type {net.Socket} */ (await accepted)
  t.after(() => {
    client.destroy()
    gatewaySide.destroy()
    pair.close()
  })
  Object.defineProperty(gatewaySide, 'remoteAddress', { value: '192.168.1.50' })
  rig.proxy.server.emit('connection', gatewaySide)

  const authority = `${HOST}:${rig.upstreamPort}`
  const requestBody = '{}'
  client.write(
    `POST https://${authority}/v1/messages HTTP/1.1\r\n` +
    `Host: ${authority}\r\n` +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(requestBody)}\r\n` +
    'Connection: close\r\n' +
    '\r\n' +
    requestBody
  )
  const response = await new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    client.on('data', (c) => chunks.push(Buffer.from(c)))
    client.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    client.on('error', reject)
  })

  assert.match(response, /^HTTP\/1\.1 403 /)
  assert.match(response, /loopback peers only/)
  assert.ok(rig.warns.some((w) => w.message === 'aigw.absolute_form_refused_remote_peer'))
  assert.deepEqual(rig.upstreamHits, [])
  assert.equal(rig.started.length, 0)
})

// The door only exists beside the CONNECT front door: a pure reverse-proxy
// listener has no proxy-pointed clients, and LLP 0233 promises it behaves
// exactly as it always has, so the same wire shape falls through to path
// routing there.
// @ref LLP 0247#only-forward-proxy-listeners-serve-it [tests]
test('a reverse-proxy-only listener leaves absolute-form to path routing', async (t) => {
  const rig = await bootGateway({ mode: 'reverse-proxy' })
  t.after(() => rig.cleanup())

  const authority = `${HOST}:${rig.upstreamPort}`
  const body = await rawRequest({
    port: rig.proxy.port,
    target: `https://${authority}/v1/environments/bridge`,
    host: authority,
  })

  assert.match(body, /^HTTP\/1\.1 404 /)
  assert.match(body, /no upstream matches path/)
  assert.deepEqual(rig.upstreamHits, [])
  assert.equal(rig.started.length, 0)
})

// The degrade contract is unrecorded-but-working: a tunnel-only listener (a
// proxy-pointed port without a live CA) still forwards absolute-form to a
// registered host so the stranded client's Remote Control keeps working, but
// records nothing, even inside the path anchor, like the blind tunnels
// beside it.
// @ref LLP 0247#degraded-listeners-forward-it-blind [tests]
test('a degraded tunnel-only listener forwards absolute-form unrecorded', async (t) => {
  const rig = await bootGateway({ mode: 'degraded' })
  t.after(() => rig.cleanup())

  const authority = `${HOST}:${rig.upstreamPort}`
  const body = await rawRequest({
    port: rig.proxy.port,
    target: `https://${authority}/v1/messages?beta=true`,
    host: authority,
  })

  assert.match(body, /^HTTP\/1\.1 200 /)
  assert.deepEqual(rig.upstreamHits, ['/v1/messages?beta=true'])
  assert.equal(rig.started.length, 0)
})

// The rebinding barrier on the third loopback listener (issue #1238). A direct
// origin-form request is the one shape here addressed to this listener itself,
// so a `Host` naming anything else is what a DNS-rebound page's request
// carries, and it must not reach the unauthenticated control surface.
test('a direct origin-form request carrying a foreign Host is refused ahead of the control route', async (t) => {
  const rig = await bootGateway()
  t.after(() => rig.cleanup())

  const body = await rawRequest({
    port: rig.proxy.port,
    target: '/_hypaware/ignore/session',
    host: 'attacker.example',
  })

  assert.match(body, /^HTTP\/1\.1 421 /)
  assert.deepEqual(rig.controlCalls, [])
  const refusal = rig.warns.find((w) => w.message === 'listener.host_refused')
  assert.ok(refusal, 'the refusal is observable')
  assert.equal(refusal?.fields?.error_kind, 'host_not_loopback')
  assert.equal(refusal?.fields?.listener, '@hypaware/ai-gateway')
})

// The other half of the same request: routing, where a catch-all upstream
// (`path_prefix: "/"`) turns a rebound POST into a row in
// `ai_gateway_messages`. The refusal lands ahead of the match.
test('a direct origin-form request carrying a foreign Host never reaches an upstream', async (t) => {
  const rig = await bootGateway()
  t.after(() => rig.cleanup())

  const body = await rawRequest({
    port: rig.proxy.port,
    target: '/v1/messages',
    host: 'attacker.example',
  })

  assert.match(body, /^HTTP\/1\.1 421 /)
  assert.deepEqual(rig.upstreamHits, [])
  assert.equal(rig.started.length, 0)
})

// The traffic the barrier must not touch: an attached client addresses the
// listener by a loopback name, on both the control surface and the routed
// paths.
test('loopback-named origin-form traffic is unaffected', async (t) => {
  const rig = await bootGateway()
  t.after(() => rig.cleanup())

  const control = await rawRequest({
    port: rig.proxy.port,
    target: '/_hypaware/ignore/session',
    host: `127.0.0.1:${rig.proxy.port}`,
  })
  assert.match(control, /^HTTP\/1\.1 204 /)
  assert.equal(rig.controlCalls.length, 1)

  const proxied = await rawRequest({
    port: rig.proxy.port,
    target: '/v1/messages',
    host: `localhost:${rig.proxy.port}`,
  })
  assert.match(proxied, /^HTTP\/1\.1 200 /)
  assert.deepEqual(rig.upstreamHits, ['/v1/messages'])
  assert.equal(rig.started.length, 1)
})

// `Host` is load-bearing for the other two front doors, which are addressed to
// a third party by design: an absolute-form request routes by the authority its
// request line names, and the `Host` beside it is the client's business.
test('an absolute-form request carrying a foreign Host is unaffected', async (t) => {
  const rig = await bootGateway()
  t.after(() => rig.cleanup())

  const authority = `${HOST}:${rig.upstreamPort}`
  const body = await rawRequest({
    port: rig.proxy.port,
    target: `https://${authority}/v1/messages`,
    host: 'attacker.example',
  })

  assert.match(body, /^HTTP\/1\.1 200 /)
  assert.deepEqual(rig.upstreamHits, ['/v1/messages'])
  assert.equal(rig.started.length, 1)
})

// The barrier's absolute-form exemption is scoped by shape, not by the door.
// A pure reverse-proxy listener never opens the forward-proxy door, so
// `absoluteForm` is false there, but it still answers the shape by path
// routing, and LLP 0233 promises it behaves exactly as it always has. Judging
// the `Host` beside a request line that already named its destination would
// break that promise with a 421.
// @ref LLP 0247#only-forward-proxy-listeners-serve-it [tests]
test('a reverse-proxy-only listener still path-routes absolute-form under a foreign Host', async (t) => {
  const rig = await bootGateway({ mode: 'reverse-proxy' })
  t.after(() => rig.cleanup())

  const authority = `${HOST}:${rig.upstreamPort}`
  const body = await rawRequest({
    port: rig.proxy.port,
    target: `https://${authority}/v1/messages`,
    host: 'api.anthropic.com',
  })

  assert.match(body, /^HTTP\/1\.1 200 /)
  assert.deepEqual(rig.upstreamHits, ['/v1/messages'])
  assert.equal(rig.started.length, 1)
  assert.equal(rig.warns.some((w) => w.message === 'listener.host_refused'), false)
})

/**
 * Write a POST at the rebinding barrier (a foreign `Host` on the direct
 * origin) and stream `body` at it, resolving when the listener closes the
 * connection. Reports the answer and how many bytes the client managed to
 * send, which is the only sender-visible trace of a paused read.
 *
 * @param {number} port
 * @param {Buffer} body
 * @returns {Promise<{ response: string, sent: number }>}
 */
function streamAtRefusal(port, body) {
  return new Promise((resolve, reject) => {
    let response = ''
    let sent = 0
    // Half-open, so the listener's own FIN does not tear the sender down
    // before it has handed over the body: what is measured is how many bytes
    // the listener reads, not how early the sender gave up.
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`the listener read ${sent} bytes and left the connection open`))
    }, 5000)
    function pump() {
      while (sent < body.length && !socket.destroyed) {
        const end = Math.min(sent + 64 * 1024, body.length)
        const chunk = body.subarray(sent, end)
        sent = end
        if (!socket.write(chunk)) {
          socket.once('drain', pump)
          return
        }
      }
      if (sent === body.length && !socket.destroyed) socket.end()
    }
    socket.on('connect', () => {
      socket.write(
        'POST /v1/messages HTTP/1.1\r\nHost: attacker.example\r\n' +
        `content-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n`
      )
      pump()
    })
    socket.on('data', (chunk) => { response += chunk.toString('utf8') })
    // The close is the point of the test, so a reset counts as one rather than
    // as a failure.
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(timer)
      resolve({ response, sent })
    })
  })
}

// The refused body is drained so a caller still uploading can read its 421, and
// draining it without a bound hands the length of that read to the sender: the
// rebound page the barrier exists to refuse can stream at it for as long as it
// likes (issue #1276). So the drain is capped, and a body past the cap has its
// connection closed once the refusal is on the wire.
test('a body refused with 421 is drained only up to a cap', async (t) => {
  // `startProxy` does not hand its server back, so capture the connections it
  // accepts. The port is read at accept time, because a destroyed socket no
  // longer reports one and being destroyed is what this measures.
  /** @type {{ socket: net.Socket, port: number | undefined }[]} */
  const serverSockets = []
  const createServer = http.createServer
  http.createServer = (/** @type {any[]} */ ...args) => {
    const server = createServer(...args)
    server.on('connection', (socket) => serverSockets.push({ socket, port: socket.localPort }))
    return server
  }
  const rig = await bootGateway().finally(() => { http.createServer = createServer })
  t.after(() => rig.cleanup())

  // Far larger than the cap, and larger than any socket buffer either side
  // could swallow whole, so a listener that stops reading stalls the write.
  const huge = Buffer.alloc(32 * 1024 * 1024, 'x')
  const streamed = await streamAtRefusal(rig.proxy.port, huge)
  assert.ok(streamed.sent < huge.length, `the listener read all ${huge.length} bytes of a refused body`)
  assert.match(streamed.response, /^HTTP\/1\.1 421 /)
  // The reset must not be answered as a reusable connection, or a pooling
  // client meets it on a request it already considers finished.
  assert.match(
    streamed.response,
    /\r\nconnection: close\r\n/i,
    `the oversized sender got ${JSON.stringify(streamed.response.slice(0, 200))}`
  )
  assert.deepEqual(rig.upstreamHits, [])
  assert.equal(rig.started.length, 0)

  // The same bound measured on the listener's own socket rather than the
  // sender's, which cannot tell a paused read from a socket buffer that
  // swallowed its write. Read to the end this is 256 KiB and change.
  serverSockets.length = 0
  const overCap = Buffer.alloc(256 * 1024, 'x')
  const measured = await streamAtRefusal(rig.proxy.port, overCap)
  assert.match(measured.response, /^HTTP\/1\.1 421 /)
  const served = serverSockets.find((entry) => entry.port === rig.proxy.port)?.socket
  assert.ok(served, 'the refused upload opened no listener connection to measure')
  if (!served.destroyed) await new Promise((resolve) => served.on('close', resolve))
  assert.ok(
    served.bytesRead < 3 * 64 * 1024,
    `the listener read ${served.bytesRead} of the ${overCap.length} bytes it refused`
  )
})

// The cap answers `connection: close` so a pooling client never meets the
// reset on a request it has already finished. A refusal that declares no body
// drains nothing, can never reach the cap, and is never reset, so it must keep
// the connection: on this listener that is the common refusal, and it arrives
// on the socket an attached client forwards everything else over.
test('a bodyless refusal keeps the connection a pooling client is reusing', async (t) => {
  const rig = await bootGateway()
  t.after(() => rig.cleanup())
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  t.after(() => agent.destroy())

  /** @param {string} path */
  function get(path) {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: rig.proxy.port, path, agent, method: 'GET' },
        (res) => {
          const port = res.socket.localPort
          res.resume()
          res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, port }))
        }
      )
      request.on('error', reject)
      request.end()
    })
  }

  const first = await get('/nope')
  const second = await get('/nope')
  assert.equal(first.status, 404)
  assert.equal(second.status, 404)
  assert.notEqual(first.connection, 'close')
  // The same local port both times is the pool surviving the refusal.
  assert.equal(second.port, first.port, 'the bodyless refusal cost the client its pooled socket')
  assert.deepEqual(rig.upstreamHits, [])
})
