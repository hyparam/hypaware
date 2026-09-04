// @ts-check

import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'

import { createControlHandler, isControlPath } from '../../src/core/control/session_ignore.js'

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 * @import { Socket } from 'node:net'
 */

// @ref LLP 0066#control-path [tests] / LLP 0066#requirements: the reserved
// `/_hypaware/` control surface: POST/DELETE /_hypaware/ignore/session over
// the in-memory ignored-session set, idempotent, returning `.total`; the
// error grid (400/404/405/413).

test('POST adds a session id and reports ignored:true with the running total', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const out = await postSession(base, 'sess-a')
    assert.equal(out.status, 200)
    assert.deepEqual(out.body, { session_id: 'sess-a', ignored: true, total: 1 })
    assert.ok(set.has('sess-a'), 'the session id landed in the shared set')
  })
})

test('DELETE removes a session id and reports ignored:false', async () => {
  const set = new Set(['sess-a'])
  await withControlServer(set, async (base) => {
    const out = await deleteSession(base, 'sess-a')
    assert.equal(out.status, 200)
    assert.deepEqual(out.body, { session_id: 'sess-a', ignored: false, total: 0 })
    assert.equal(set.has('sess-a'), false, 'the session id was removed from the set')
  })
})

test('both verbs are idempotent and .total tracks the set across a sequence', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    assert.equal((await postSession(base, 's1')).body.total, 1)
    assert.equal((await postSession(base, 's2')).body.total, 2)
    // Re-POSTing an already-ignored id is a 200 no-op: still ignored, no growth.
    const reAdd = await postSession(base, 's1')
    assert.deepEqual(reAdd.body, { session_id: 's1', ignored: true, total: 2 })
    assert.equal((await deleteSession(base, 's1')).body.total, 1)
    // DELETEing an unknown id is a 200 no-op.
    const reDel = await deleteSession(base, 's1')
    assert.deepEqual(reDel.body, { session_id: 's1', ignored: false, total: 1 })
    assert.equal((await deleteSession(base, 's2')).body.total, 0)
    assert.equal(set.size, 0)
  })
})

test('session_id whitespace only gates non-emptiness; the STORED token is the raw value verbatim (R5)', async () => {
  // @ref LLP 0066#requirements: R5: the match key MUST be the session_id the
  // adapter resolves and stamps. The adapters (Claude's resolveClaudeSessionId,
  // Codex's metadata/header readers) never trim, so this route must not either:
  // trimming is used ONLY to validate non-emptiness, never to transform the
  // stored/returned token. Trimming the stored value would desync it from a
  // raw, whitespace-padded id an adapter actually resolves and stamps, which
  // is the privacy-relevant failure direction (the exchange would be
  // recorded despite the opt-out).
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const out = await postSession(base, '  sess-pad  ')
    assert.equal(out.status, 200)
    assert.equal(out.body.session_id, '  sess-pad  ', 'the response echoes the raw, untrimmed token')
    assert.ok(set.has('  sess-pad  '), 'the set stores the raw, untrimmed token')
    assert.equal(set.has('sess-pad'), false, 'a trimmed lookup key must NOT hit - the token is opaque, not normalized')
  })
})

test('a whitespace-padded session_id round-trips byte-identical to what an adapter would resolve and look up (R5)', async () => {
  // Simulates the real failure mode: the skill posts a session_id exactly as
  // an adapter would resolve it from a header/metadata field (which may carry
  // incidental surrounding whitespace, e.g. a header value). The control
  // route must store that EXACT raw string, so a later `ignoredSessions.has()`
  // lookup keyed on the same raw adapter-resolved value hits.
  const set = /** @type {Set<string>} */ (new Set())
  const rawResolvedByAdapter = ' sess-with-leading-and-trailing-space '
  await withControlServer(set, async (base) => {
    const out = await postSession(base, rawResolvedByAdapter)
    assert.equal(out.status, 200)
    assert.equal(out.body.session_id, rawResolvedByAdapter)
    // The lookup an adapter performs uses the raw resolved id directly.
    assert.ok(
      set.has(rawResolvedByAdapter),
      'a lookup with the exact raw adapter-resolved value must hit'
    )
  })
})

test('400 when session_id is missing, empty, or not a string', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    for (const body of [JSON.stringify({}), JSON.stringify({ session_id: '' }), JSON.stringify({ session_id: '   ' }), JSON.stringify({ session_id: 123 })]) {
      const out = await rawRequest(base, 'POST', '/_hypaware/ignore/session', body)
      assert.equal(out.status, 400, `expected 400 for body ${body}`)
    }
    assert.equal(set.size, 0, 'no id is recorded on a 400')
  })
})

test('400 on malformed JSON', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const out = await rawRequest(base, 'POST', '/_hypaware/ignore/session', '{ not json')
    assert.equal(out.status, 400)
    assert.equal(set.size, 0)
  })
})

test('405 on an unsupported method for the ignore route', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const out = await rawRequest(base, 'PUT', '/_hypaware/ignore/session', JSON.stringify({ session_id: 's' }))
    assert.equal(out.status, 405)
    // `GET` joined the allow list when the set gained a reader (issue #432 /
    // LLP 0066#readable): a privacy control that can only be written cannot be
    // verified, so the opt-out failed open silently.
    assert.equal(out.headers.get('allow'), 'GET, POST, DELETE')
    assert.equal(set.size, 0)
  })
})

test('404 on an unknown /_hypaware/* control path', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const out = await rawRequest(base, 'POST', '/_hypaware/unknown/thing', JSON.stringify({ session_id: 's' }))
    assert.equal(out.status, 404)
    assert.equal(set.size, 0)
  })
})

test('413 when the request body exceeds the size bound', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  await withControlServer(set, async (base) => {
    const huge = 'x'.repeat(70 * 1024)
    const out = await rawRequest(base, 'POST', '/_hypaware/ignore/session', JSON.stringify({ session_id: huge }))
    assert.equal(out.status, 413)
    assert.equal(set.size, 0, 'an oversized body records nothing')
  })
})

test('a control request emits a structured ignore log carrying the running total', async () => {
  const set = /** @type {Set<string>} */ (new Set())
  /** @type {Array<{ message: string, fields: Record<string, unknown> }>} */
  const logs = []
  const log = {
    debug() {}, warn() {}, error() {},
    /** @param {string} message @param {Record<string, unknown>=} fields */
    info(message, fields) { logs.push({ message, fields: fields ?? {} }) },
  }
  const handler = createControlHandler({ ignoredSessions: set, log })
  await withHandler(handler, async (base) => {
    await postSession(base, 'sess-logged')
    const entry = logs.find((l) => l.message === 'aigw.control.ignore_session')
    assert.ok(entry, 'a structured ignore log is emitted')
    assert.equal(entry.fields.operation, 'ignore_session')
    assert.equal(entry.fields.session_id, 'sess-logged')
    assert.equal(entry.fields.ignored, true)
    assert.equal(entry.fields.total, 1)
  })
})

// A discarded body still has to be read for the answer to reach a caller
// mid-upload, and reading it without a bound hands the length of that read to
// the sender.
// @ref LLP 0066#control-path [tests]: the reserved control surface is
// reachable by anything that can reach the listener, so what it reads off a
// request it is refusing is bounded by the handler, not by the sender.
for (const refusal of [
  { name: 'the unknown-control-path 404', method: 'POST', path: '/_hypaware/unknown/thing', status: 404 },
  { name: 'the GET read path', method: 'GET', path: '/_hypaware/ignore/session?session_id=s', status: 200 },
  { name: 'the method-not-allowed 405', method: 'PUT', path: '/_hypaware/ignore/session', status: 405 },
  { name: 'the body-too-large 413', method: 'POST', path: '/_hypaware/ignore/session', status: 413 },
]) {
  test(`${refusal.name} discards an oversized body only up to a cap`, async () => {
    const set = /** @type {Set<string>} */ (new Set())
    await withControlSockets(set, async (port, sockets) => {
      const out = await streamOversizedBody(port, refusal.method, refusal.path)
      assert.ok(
        out.sent < out.total,
        `${refusal.name} read all ${out.total} bytes of the body it discarded`
      )
      const [served] = sockets
      assert.ok(served, 'the upload opened no server connection to measure')
      if (!served.destroyed) await new Promise((resolve) => served.on('close', resolve))
      // The handler buffers at most MAX_BODY_BYTES (64 KiB) and then discards
      // at most MAX_REJECTED_DRAIN_BYTES (64 KiB) more, plus whatever read was
      // already in the parser when the pause landed.
      assert.ok(
        served.bytesRead < 512 * 1024,
        `${refusal.name} read ${served.bytesRead} of the ${out.total} bytes it refused`
      )
      // The answer is written before a byte is discarded, so a caller reading
      // its socket while it uploads still gets the status, and the reset it
      // meets past the cap is announced rather than handed to a connection
      // pool.
      if (out.received) {
        assert.match(out.received, new RegExp(`^HTTP/1\\.1 ${refusal.status} `), out.received.slice(0, 80))
        assert.match(out.received, /\r\nconnection: close\r\n/i, out.received.slice(0, 200))
      }
    })
  })
}

test('a request with no body keeps its connection reusable', async () => {
  // The cap must not cost the ordinary caller its keep-alive: with no framing
  // there is no body to read, nothing to bound, and nothing to reset.
  const set = new Set(['sess-live'])
  await withControlSockets(set, async (port) => {
    const received = await rawExchange(port, 'GET /_hypaware/ignore/session?session_id=sess-live HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    assert.match(received, /^HTTP\/1\.1 200 /)
    assert.equal(/\r\nconnection: close\r\n/i.test(received), false, received.slice(0, 200))
    assert.match(received, /"ignored":true/)
  })
})

test('isControlPath recognizes the reserved prefix at segment boundaries only', () => {
  assert.equal(isControlPath('/_hypaware'), true)
  assert.equal(isControlPath('/_hypaware/ignore/session'), true)
  assert.equal(isControlPath('/_hypaware/anything'), true)
  assert.equal(isControlPath('/_hypawarefoo'), false, 'a look-alike path is not a control path')
  assert.equal(isControlPath('/v1/messages'), false)
})

/**
 * Start an HTTP server that dispatches `/_hypaware/*` to a fresh control
 * handler over `set` (mirroring the proxy's control short-circuit), run the
 * body, and always tear the server down.
 *
 * @param {Set<string>} set
 * @param {(base: string) => Promise<void>} body
 */
async function withControlServer(set, body) {
  const handler = createControlHandler({ ignoredSessions: set })
  await withHandler(handler, body)
}

/**
 * @param {(req: IncomingMessage, res: ServerResponse, url: URL) => void} handler
 * @param {(base: string) => Promise<void>} body
 */
async function withHandler(handler, body) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    if (isControlPath(url.pathname)) {
      handler(req, res, url)
      return
    }
    req.resume()
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  try {
    await body(base)
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)))
    })
  }
}

/**
 * Start the same control server as `withControlServer`, but hand the body the
 * bound port and the sockets the server accepted. The cap is only visible as
 * bytes the server read off the socket: a sender cannot tell a paused read
 * from a socket buffer that swallowed its write.
 *
 * @param {Set<string>} set
 * @param {(port: number, sockets: Socket[]) => Promise<void>} body
 */
async function withControlSockets(set, body) {
  const handler = createControlHandler({ ignoredSessions: set })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://placeholder')
    handler(req, res, url)
  })
  /** @type {Socket[]} */
  const sockets = []
  server.on('connection', (socket) => sockets.push(socket))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    await body(address.port, sockets)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)))
    })
  }
}

/**
 * Announce a body far larger than any cap and push it until the server stops
 * reading. Resolves when the connection closes (the bounded outcome) or when
 * the whole body went out (the unbounded one, which the caller asserts
 * against).
 *
 * @param {number} port
 * @param {string} method
 * @param {string} path
 */
function streamOversizedBody(port, method, path) {
  // Larger than any socket buffer either side could swallow whole, so a
  // server that stops reading stalls the write rather than absorbing it.
  const body = Buffer.alloc(8 * 1024 * 1024, 'x')
  let received = ''
  let sent = 0
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`the handler read ${sent} bytes and left the connection open`))
    }, 10000)
    function settle() {
      clearTimeout(timer)
      socket.destroy()
      resolve({ sent, total: body.length, received })
    }
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
      // Everything went out, so nothing bounded the read. Settle rather than
      // wait for a close that a keep-alive answer will never send.
      if (sent >= body.length) setTimeout(settle, 50)
    }
    socket.on('connect', () => {
      socket.write(
        `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
          `content-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n`
      )
      pump()
    })
    socket.on('data', (chunk) => { received += chunk.toString('utf8') })
    // The close is the point of the test, so a reset counts as one rather
    // than as a failure.
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(timer)
      resolve({ sent, total: body.length, received })
    })
  })
}

/**
 * Send one raw request and read what comes back, without a client that might
 * normalize hop-by-hop headers away.
 *
 * @param {number} port
 * @param {string} request
 * @returns {Promise<string>}
 */
function rawExchange(port, request) {
  return new Promise((resolve, reject) => {
    let received = ''
    const socket = net.connect(port, '127.0.0.1')
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`no response after ${JSON.stringify(request)}`))
    }, 10000)
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8')
      if (!received.includes('\r\n\r\n')) return
      const [head, rest] = received.split('\r\n\r\n')
      const match = /\r\ncontent-length: (\d+)/i.exec(head)
      if (match && rest.length < Number(match[1])) return
      clearTimeout(timer)
      socket.destroy()
      resolve(received)
    })
    socket.on('error', reject)
  })
}

/** @param {string} base @param {string} sessionId */
function postSession(base, sessionId) {
  return rawRequest(base, 'POST', '/_hypaware/ignore/session', JSON.stringify({ session_id: sessionId }))
}

/** @param {string} base @param {string} sessionId */
function deleteSession(base, sessionId) {
  return rawRequest(base, 'DELETE', '/_hypaware/ignore/session', JSON.stringify({ session_id: sessionId }))
}

/**
 * @param {string} base
 * @param {string} method
 * @param {string} path
 * @param {string} [reqBody]
 */
async function rawRequest(base, method, path, reqBody) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: reqBody,
  })
  const text = await res.text()
  let parsed
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  return { status: res.status, headers: res.headers, body: parsed }
}
