// @ts-check

// The transport contract of the shared OTLP http/json listener. Two
// plugins host listeners on this machinery (LLP 0257 #registration), so
// the routing, content-type, content-encoding and envelope behaviour is
// pinned here rather than inside either plugin's tests.

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'

import { createOtlpJsonServer, isMisdirectedHost, listenAndResolve } from '../../src/core/otlp/server.js'

/**
 * @import { PluginLogger } from '../../hypaware-plugin-kernel-types.js'
 * @import { OtlpJsonServerOptions, OtlpRequest, OtlpSignal } from '../../src/core/otlp/types.js'
 */

/**
 * Start a listener on a dynamic loopback port and return an origin plus
 * the requests the handler saw. `onRequest` lets a test make the handler
 * fail.
 *
 * @param {{
 *   name?: string,
 *   signals?: readonly OtlpSignal[],
 *   onRequest?: (req: OtlpRequest) => void,
 *   onControlRequest?: OtlpJsonServerOptions['onControlRequest'],
 * }} [options]
 */
async function startServer(options = {}) {
  /** @type {OtlpRequest[]} */
  const seen = []
  const server = createOtlpJsonServer({
    name: options.name ?? 'hypaware/test',
    signals: options.signals,
    onControlRequest: options.onControlRequest,
    handler: {
      async handle(req) {
        seen.push(req)
        options.onRequest?.(req)
      },
    },
  })
  const bound = await listenAndResolve(server, '127.0.0.1', 0, 'hypaware/test')
  return {
    seen,
    bound,
    origin: `http://127.0.0.1:${bound.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve(undefined)))
        server.closeIdleConnections?.()
        server.closeAllConnections?.()
      })
    },
  }
}

/**
 * POST with no `Content-Type` header at all, which `fetch` cannot express.
 *
 * @param {number} port
 * @param {string} path
 * @returns {Promise<{ status: number, body: string }>}
 */
function postWithoutContentType(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => {
      /** @type {Buffer[]} */
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      )
    })
    req.on('error', reject)
    req.end('{}')
  })
}

/**
 * Send a request with an explicit `Host` header, which `fetch` forbids.
 *
 * @param {number} port
 * @param {{ path: string, host: string, method?: string }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
function requestWithHost(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path,
        method: options.method ?? 'POST',
        headers: { host: options.host, 'content-type': 'application/json' },
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.end('{}')
  })
}

/**
 * Write a raw request and resolve with its status line. Used for request
 * lines and header values no HTTP client will build.
 *
 * @param {number} port
 * @param {string} request
 * @returns {Promise<string>}
 */
function rawRequestLine(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let received = ''
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8')
      if (received.includes('\r\n')) {
        socket.destroy()
        resolve(received.split('\r\n')[0])
      }
    })
    socket.on('error', reject)
    // A Node that rejected the request at the parser would close with no status
    // line at all, and waiting on `data` alone would hang the run.
    socket.on('close', () =>
      reject(new Error(`socket closed with no status line, got ${JSON.stringify(received)}`))
    )
  })
}

test('listenAndResolve reports the port a dynamic bind actually got', async () => {
  const s = await startServer()
  try {
    assert.equal(s.bound.host, '127.0.0.1')
    assert.ok(s.bound.port > 0)
  } finally {
    await s.close()
  }
})

test('GET / answers with the listener name banner', async () => {
  const s = await startServer({ name: 'hypaware/otel' })
  try {
    const res = await fetch(`${s.origin}/`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'hypaware/otel OTLP listener\n')
  } finally {
    await s.close()
  }
})

test('each signal route answers with its own empty partialSuccess envelope', async () => {
  const s = await startServer()
  try {
    /** @type {[string, string][]} */
    const cases = [
      ['/v1/logs', 'rejectedLogRecords'],
      ['/v1/traces', 'rejectedSpans'],
      ['/v1/metrics', 'rejectedDataPoints'],
    ]
    for (const [route, field] of cases) {
      const res = await fetch(`${s.origin}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/json')
      assert.deepEqual(await res.json(), { partialSuccess: { [field]: 0 } })
    }
    assert.deepEqual(
      s.seen.map((req) => req.signal),
      ['logs', 'traces', 'metrics']
    )
  } finally {
    await s.close()
  }
})

test('the handler sees the parsed payload and its decoded byte count', async () => {
  const s = await startServer()
  try {
    const body = JSON.stringify({ resourceLogs: [{ resource: {} }] })
    const res = await fetch(`${s.origin}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    assert.equal(res.status, 200)
    assert.equal(s.seen.length, 1)
    assert.equal(s.seen[0].signal, 'logs')
    assert.deepEqual(s.seen[0].data, { resourceLogs: [{ resource: {} }] })
    assert.equal(s.seen[0].payloadBytes, Buffer.byteLength(body))
  } finally {
    await s.close()
  }
})

test('an empty body reads as an empty object rather than a parse error', async () => {
  const s = await startServer()
  try {
    const res = await fetch(`${s.origin}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    })
    assert.equal(res.status, 200)
    assert.deepEqual(s.seen[0].data, {})
    assert.equal(s.seen[0].payloadBytes, 0)
  } finally {
    await s.close()
  }
})

test('a charset parameter on the content type is still application/json', async () => {
  const s = await startServer()
  try {
    const res = await fetch(`${s.origin}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: '{}',
    })
    assert.equal(res.status, 200)
  } finally {
    await s.close()
  }
})

test('protobuf and a missing content type are both refused with 415', async () => {
  const s = await startServer()
  try {
    const proto = await fetch(`${s.origin}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: 'not json',
    })
    assert.equal(proto.status, 415)
    const protoBody = /** @type {{ code: number, message: string }} */ (await proto.json())
    assert.equal(protoBody.code, 3)
    assert.match(protoBody.message, /application\/x-protobuf/)

    // `fetch` always stamps a content type, so the header-less case needs a raw request.
    const none = await postWithoutContentType(s.bound.port, '/v1/traces')
    assert.equal(none.status, 415)
    assert.match(none.body, /'none'/)

    assert.equal(s.seen.length, 0)
  } finally {
    await s.close()
  }
})

test('gzip and deflate bodies are decoded before the handler sees them', async () => {
  const s = await startServer()
  try {
    const payload = JSON.stringify({ resourceMetrics: [] })
    /** @type {[string, Buffer][]} */
    const cases = [
      ['gzip', zlib.gzipSync(payload)],
      ['deflate', zlib.deflateSync(payload)],
    ]
    for (const [encoding, compressed] of cases) {
      const res = await fetch(`${s.origin}/v1/metrics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': encoding },
        body: compressed,
      })
      assert.equal(res.status, 200)
    }
    assert.equal(s.seen.length, 2)
    for (const req of s.seen) {
      assert.deepEqual(req.data, { resourceMetrics: [] })
      // The count is of decoded bytes, not of what came off the wire.
      assert.equal(req.payloadBytes, Buffer.byteLength(payload))
    }
  } finally {
    await s.close()
  }
})

test('an unknown content encoding is refused with 415', async () => {
  const s = await startServer()
  try {
    const res = await fetch(`${s.origin}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br' },
      body: '{}',
    })
    assert.equal(res.status, 415)
    const body = /** @type {{ code: number, message: string }} */ (await res.json())
    assert.equal(body.code, 3)
    assert.match(body.message, /Content-Encoding: br/)
    assert.equal(s.seen.length, 0)
  } finally {
    await s.close()
  }
})

test('a malformed JSON body is refused with 400 rather than crashing', async () => {
  const s = await startServer()
  try {
    const res = await fetch(`${s.origin}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    })
    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), { code: 3, message: 'Invalid JSON' })
    assert.equal(s.seen.length, 0)
  } finally {
    await s.close()
  }
})

test('an unknown path is 404 and a non-POST method is 405', async () => {
  const s = await startServer()
  try {
    const missing = await fetch(`${s.origin}/v1/nope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), { code: 5, message: 'Not found' })

    const wrongMethod = await fetch(`${s.origin}/v1/logs`, { method: 'PUT', body: '{}' })
    assert.equal(wrongMethod.status, 405)
    assert.deepEqual(await wrongMethod.json(), { code: 12, message: 'Method not allowed' })
  } finally {
    await s.close()
  }
})

test('a handler failure becomes a 500 carrying its message', async () => {
  const s = await startServer({
    onRequest() {
      throw new Error('persist failed')
    },
  })
  try {
    const res = await fetch(`${s.origin}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { code: 13, message: 'persist failed' })
  } finally {
    await s.close()
  }
})

// @ref LLP 0256#control-route-on-listener [tests]: the reserved `/_hypaware/`
// prefix is a local control surface on the shared server too, short-circuited
// before OTLP routing, so the claude listener can host the session-ignore
// route with the identical shape the gateway proxy serves.
test('a registered control handler owns the reserved /_hypaware/ prefix, before OTLP routing', async () => {
  /** @type {string[]} */
  const controlPaths = []
  const s = await startServer({
    onControlRequest(req, res, url) {
      controlPaths.push(`${req.method} ${url.pathname}`)
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    },
  })
  try {
    // All three verbs the session-ignore route serves reach the handler,
    // including GET, which the OTLP side would have refused with 405.
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await fetch(`${s.origin}/_hypaware/ignore/session`, {
        method,
        ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' }, body: '{}' }),
      })
      assert.equal(res.status, 200, `${method} reaches the control handler`)
      assert.deepEqual(await res.json(), { ok: true })
    }
    assert.deepEqual(controlPaths, [
      'GET /_hypaware/ignore/session',
      'POST /_hypaware/ignore/session',
      'DELETE /_hypaware/ignore/session',
    ])
    assert.equal(s.seen.length, 0, 'a control request never reads as an OTLP export')

    // A look-alike path is NOT a control path, so it still routes as OTLP.
    const lookAlike = await fetch(`${s.origin}/_hypawarefoo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(lookAlike.status, 404)
    assert.equal(controlPaths.length, 3, 'the look-alike never reached the control handler')
  } finally {
    await s.close()
  }
})

test('without a control handler, control paths fall through as unknown OTLP routes', async () => {
  const s = await startServer()
  try {
    const post = await fetch(`${s.origin}/_hypaware/ignore/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(post.status, 404)
    assert.equal(s.seen.length, 0)
  } finally {
    await s.close()
  }
})

// A page whose domain re-resolves to 127.0.0.1 is same-origin with this
// listener, so it needs no preflight and the content-type gate above lets it
// through; the attacker's name in `Host` is the one signal that separates it
// from a local exporter.
test('a Host naming anything but loopback is refused on every route, control surface included', async () => {
  /** @type {string[]} */
  const controlPaths = []
  const s = await startServer({
    onControlRequest(req, res, url) {
      controlPaths.push(url.pathname)
      req.resume()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    },
  })
  try {
    for (const path of ['/v1/logs', '/v1/traces', '/v1/metrics', '/_hypaware/ignore/session']) {
      const res = await requestWithHost(s.bound.port, { path, host: 'attacker.example' })
      assert.equal(res.status, 421, `${path} refuses a rebound Host`)
      assert.match(JSON.parse(res.body).message, /Host/)
    }
    assert.equal(s.seen.length, 0, 'no export reached the handler')
    assert.deepEqual(controlPaths, [], 'no control request reached the handler')

    // A GET of the banner is refused too: rebinding reads as easily as it writes.
    const banner = await requestWithHost(s.bound.port, { path: '/', host: 'attacker.example', method: 'GET' })
    assert.equal(banner.status, 421)
  } finally {
    await s.close()
  }
})

test('loopback Hosts keep passing, with any port and in every spelling', async () => {
  const s = await startServer()
  try {
    const hosts = [
      `127.0.0.1:${s.bound.port}`,
      '127.0.0.1',
      '127.0.0.2:9999',
      `localhost:${s.bound.port}`,
      'LocalHost',
      `[::1]:${s.bound.port}`,
      '[::1]',
      // What a wildcard bind advertises as its `listen_host`, and therefore
      // what `hyp session ignore` addresses that recorder by. Refusing it
      // would leave the opt-out unable to reach a listener whose exports
      // keep flowing.
      `0.0.0.0:${s.bound.port}`,
      '[::]',
    ]
    for (const host of hosts) {
      const res = await requestWithHost(s.bound.port, { path: '/v1/logs', host })
      assert.equal(res.status, 200, `Host: ${host} still exports`)
    }
    assert.equal(s.seen.length, hosts.length)
  } finally {
    await s.close()
  }
})

// A `Host` no hostname can be read out of is refused with the foreign ones.
// Sent over a raw socket because an HTTP client will not put a space in a
// header value.
test('a malformed Host is refused rather than parsed', async () => {
  const s = await startServer()
  try {
    const socket = net.connect(s.bound.port, '127.0.0.1')
    const statusLine = await new Promise((resolve, reject) => {
      let received = ''
      socket.on('connect', () => {
        socket.write(
          'POST /v1/logs HTTP/1.1\r\nHost: attacker example\r\n' +
            'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}'
        )
      })
      socket.on('data', (chunk) => {
        received += chunk.toString('utf8')
        if (received.includes('\r\n')) resolve(received.split('\r\n')[0])
      })
      socket.on('error', reject)
      // A Node that rejected the header at the parser would close with no
      // status line at all, and waiting on `data` alone would hang the run
      // instead of failing it.
      socket.on('close', () => reject(new Error(`socket closed with no status line, got ${JSON.stringify(received)}`)))
    })
    socket.destroy()
    assert.equal(statusLine, 'HTTP/1.1 421 Misdirected Request')
    assert.equal(s.seen.length, 0)
  } finally {
    await s.close()
  }
})

// Node's HTTP parser hands the handler request targets `new URL` refuses
// (`//[`, `http://[::1`), and the throw would leave an `async` handler with no
// `unhandledRejection` handler anywhere in the repo behind it: one request line
// would end the daemon. The `Host` is loopback here, so the check above passes
// it through to the parser.
test('a request target new URL rejects is answered 400, not thrown out of the handler', async () => {
  const s = await startServer()
  try {
    for (const target of ['//[', 'http://[::1', '//[::1']) {
      const line = await rawRequestLine(s.bound.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`)
      assert.equal(line, 'HTTP/1.1 400 Bad Request', `GET ${target} is answered`)
    }
    // Still serving, which is the half a status code alone would not prove.
    const banner = await fetch(`http://127.0.0.1:${s.bound.port}/`)
    assert.equal(banner.status, 200)
    assert.equal(s.seen.length, 0)
  } finally {
    await s.close()
  }
})

test('the Host check judges loopback connections only, and needs a Host to judge', () => {
  /** @type {PluginLogger} */
  const log = { debug() {}, info() {}, warn() {}, error() {} }
  /** @param {string} localAddress @param {string} [host] */
  const misdirected = (localAddress, host) =>
    isMisdirectedHost(
      /** @type {any} */ ({ socket: { localAddress }, headers: host === undefined ? {} : { host } }),
      { name: 'hypaware/test', log }
    )

  assert.equal(misdirected('127.0.0.1', 'attacker.example'), true)
  // How a dual-stack bind reports an IPv4 loopback peer. Still loopback.
  assert.equal(misdirected('::ffff:127.0.0.1', 'attacker.example'), true)
  assert.equal(misdirected('::1', 'attacker.example'), true)
  // Bound to a routable address, the listener is meant to answer to whatever
  // name resolves there, and a rebound request never lands on that address.
  assert.equal(misdirected('203.0.113.5', 'collector.example'), false)
  // A local address that cannot be read is not an exemption. Only a routable
  // one is, so the unknown case is judged like a loopback one.
  assert.equal(misdirected('', 'attacker.example'), true)
  // No Host at all: HTTP/1.0 clients omit it and a browser never does.
  assert.equal(misdirected('127.0.0.1'), false)

  // A `Host` no hostname can be read out of is refused with the foreign ones,
  // rather than half-read into a loopback name.
  assert.equal(misdirected('127.0.0.1', '[::1'), true)
  assert.equal(misdirected('127.0.0.1', '[::1]x'), true)
  assert.equal(misdirected('127.0.0.1', '127.0.0.1:'), true)
  assert.equal(misdirected('127.0.0.1', '127.0.0.1:80x'), true)
  assert.equal(misdirected('127.0.0.1', 'localhost:1:2'), true)
  assert.equal(misdirected('127.0.0.1', 'user@localhost'), true)
})

// The bound on the refusal line, which is the half of a refusal a rebound page
// still controls: it chooses the `Host` and the rate, and the line lands in
// `logs`.
test('a refusal is always counted but logged at most once an interval, with the Host bounded', () => {
  /** @type {Array<{ event: string, fields: Record<string, unknown> }>} */
  const lines = []
  /** @type {PluginLogger} */
  const log = {
    debug() {},
    info() {},
    error() {},
    warn(event, fields) {
      lines.push({ event, fields: fields ?? {} })
    },
  }
  // Bounded only by Node's header budget, which is not a bound worth writing
  // a row against.
  const host = `${'a'.repeat(400)}.example`
  const refuse = () =>
    isMisdirectedHost(
      /** @type {any} */ ({ socket: { localAddress: '127.0.0.1' }, headers: { host } }),
      // A listener name of its own: the tally is per listener and lives as long
      // as the process, so sharing one with another test would couple the two.
      { name: 'hypaware/refusal-bound', log }
    )

  assert.equal(refuse(), true)
  assert.equal(refuse(), true)
  assert.equal(refuse(), true)

  // A page can send these as fast as it likes, so only the first is written:
  // a line apiece would answer blocked row injection with unbounded row growth
  // in `logs`.
  assert.equal(lines.length, 1)
  assert.equal(lines[0]?.event, 'listener.host_refused')
  assert.equal(lines[0]?.fields?.refused_total, 1)
  // The one line that is written cannot carry an unbounded value either.
  const logged = String(lines[0]?.fields?.host)
  assert.equal(logged.length, 128)
  assert.ok(host.startsWith(logged))
})

test('a listener can serve a subset of the signals', async () => {
  const s = await startServer({ signals: ['logs', 'metrics'] })
  try {
    const logs = await fetch(`${s.origin}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(logs.status, 200)

    const traces = await fetch(`${s.origin}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(traces.status, 404)
    assert.equal(s.seen.length, 1)
  } finally {
    await s.close()
  }
})
