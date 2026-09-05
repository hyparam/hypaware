// @ts-check

// Direct coverage of the one capped body drain, `drainRequestBody`, rather
// than of any single one of the four servers that call it. The cap is shared,
// so it is pinned here once: a caller's own test can be refactored away, and
// the cap would then be enforced with nothing left to notice if it stopped
// being.

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

import { drainRequestBody } from '../../src/core/util/reject_body.js'

// The cap the helper documents, restated here because it is not exported.
const CAP_BYTES = 64 * 1024

// Every probe below either settles in milliseconds or is broken. The suite
// runs with no `--test-timeout`, so an unbounded wait would hang until the CI
// job clock kills it, with no assertion naming the stall.
const DEADLINE_MS = 10_000

/**
 * @template T
 * @param {Promise<T>} work
 * @param {string} label what is being waited on, so a stall names itself
 * @returns {Promise<T>}
 */
function withDeadline(work, label) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  /** @type {Promise<never>} */
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`drainRequestBody probe '${label}' did not settle within ${DEADLINE_MS}ms`)),
      DEADLINE_MS
    )
  })
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer))
}

/**
 * A server that refuses every request the way the helper's callers do: drain
 * first, because the drain decides whether the connection can be answered as
 * a reusable one, then write the refusal.
 */
async function startRefusingServer() {
  /** @type {net.Socket[]} */
  const sockets = []
  const server = http.createServer((req, res) => {
    drainRequestBody(req, res)
    res.writeHead(415, { 'content-type': 'text/plain' })
    res.end('refused')
  })
  server.on('connection', (socket) => sockets.push(socket))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    sockets,
    port,
    origin: `http://127.0.0.1:${port}`,
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
 * Send one raw request and read the response head back, which is where the
 * connection disposition is visible. `fetch` normalizes that header away.
 *
 * @param {number} port
 * @param {string} request the whole request text, framing and all
 * @returns {Promise<string>} the response head, up to its blank line
 */
function rawRefusal(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let received = ''
    socket.on('connect', () => socket.write(request))
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8')
      const end = received.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.destroy()
      resolve(received.slice(0, end))
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(received))
  })
}

test('drainRequestBody stops reading a refused body at MAX_REJECTED_DRAIN_BYTES', async () => {
  const served = await startRefusingServer()
  try {
    // Four times the cap, and deliberately no larger: a body this size fits
    // in the two socket buffers whole, so the sender hands it over in one go
    // and never stalls, which leaves the cap as the only thing that can stop
    // the server reading all of it. A body big enough to outrun those buffers
    // (8 MiB, say) cannot pin the cap at all - its `content-length` fails
    // `fitsUnderCap`, so the drain answers `connection: close` and the socket
    // is torn down as the ~60-byte refusal flushes, long before 64 KiB could
    // be counted.
    const body = Buffer.alloc(4 * CAP_BYTES, 'x')
    const refused = await withDeadline(
      fetch(`${served.origin}/refused`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body,
      }),
      'over-cap upload'
    )
    assert.equal(refused.status, 415)
    await refused.text()

    const [socket] = served.sockets
    assert.ok(socket, 'the refused upload opened no server connection to measure')
    if (!socket.destroyed) {
      await withDeadline(
        new Promise((resolve) => socket.on('close', () => resolve(undefined))),
        'over-cap connection close'
      )
    }
    // The read settles at the cap plus whatever the socket had already
    // delivered to the parser when the pause landed, so about twice the cap.
    assert.ok(
      socket.bytesRead < 3 * CAP_BYTES,
      `drainRequestBody read ${socket.bytesRead} of the ${body.length} bytes it refused, so the ` +
        `MAX_REJECTED_DRAIN_BYTES (${CAP_BYTES}) cap did not bound the read`
    )
  } finally {
    await served.close()
  }
})

test('drainRequestBody closes only the connection whose body is not known to fit under the cap', async () => {
  const served = await startRefusingServer()
  try {
    // Declared under the cap: the drain is promised to end before the cap, no
    // reset is coming, and closing would cost a pooling client its socket for
    // nothing.
    const underCap = await withDeadline(
      rawRefusal(
        served.port,
        'POST /refused HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
          'content-type: text/plain\r\ncontent-length: 4\r\n\r\nabcd'
      ),
      'under-cap refusal'
    )
    assert.match(underCap, /^HTTP\/1\.1 415 /)
    assert.doesNotMatch(
      underCap,
      /\r\nconnection: close/i,
      `drainRequestBody closed a connection whose body fits under MAX_REJECTED_DRAIN_BYTES: ${JSON.stringify(underCap)}`
    )

    // Declared past the cap: the connection is reset once the answer is out,
    // so it must not be offered back as a reusable one.
    const overCap = await withDeadline(
      rawRefusal(
        served.port,
        'POST /refused HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
          `content-type: text/plain\r\ncontent-length: ${128 * CAP_BYTES}\r\n\r\n`
      ),
      'declared-over-cap refusal'
    )
    assert.match(
      overCap,
      /\r\nconnection: close/i,
      `drainRequestBody answered a body declared past MAX_REJECTED_DRAIN_BYTES as reusable: ${JSON.stringify(overCap)}`
    )

    // Chunked declares no length, so it is never known to fit, even when it
    // turns out to be empty.
    const chunked = await withDeadline(
      rawRefusal(
        served.port,
        'POST /refused HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
          'content-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n'
      ),
      'chunked refusal'
    )
    assert.match(
      chunked,
      /\r\nconnection: close/i,
      `drainRequestBody answered a chunked body as reusable: ${JSON.stringify(chunked)}`
    )
  } finally {
    await served.close()
  }
})
