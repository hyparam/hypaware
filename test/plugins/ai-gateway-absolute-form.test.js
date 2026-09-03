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
