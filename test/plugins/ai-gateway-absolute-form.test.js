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
 * A gateway in front of a fake upstream, no interception: absolute-form
 * arrives on a plain socket, so the CONNECT machinery is not involved.
 */
async function bootGateway() {
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

  const proxy = await startProxy({
    listen: '127.0.0.1:0',
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
