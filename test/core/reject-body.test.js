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
    // Four times the cap. Large enough that an unbounded read of it is
    // reliably the whole body, which leaves the cap as the only thing that can
    // stop the server reading all of it, and small enough that it still
    // crosses the cap inside two socket reads. Bounded, the server reads
    // 131072. Unbounded, it reads all 262372.
    //
    // Neither a much smaller nor a much larger body pins as well. At twice the
    // cap an unbounded read is 131300, under the bound below, so the test
    // would pass with the cap deleted. Much larger, an unbounded read stops
    // being the whole body: the `connection: close` answer destroys the socket
    // as soon as the refusal is flushed, so the read reaches only what arrived
    // first, which is a timing figure rather than a size one, and a
    // client-dependent one. At 8 MiB it measured 163705 in 43 of 64 samples
    // and 2097152 in the other 21 through `fetch`; a raw socket, which loses
    // the race at a different moment, read 112798 on one host and 98317 on
    // another.
    //
    // It is that teardown and not the sender running out of buffer that cuts
    // the read. With the cap deleted the read is still only what arrived
    // first; delete the `connection: close` answer as well and the same 8 MiB
    // sender empties its whole buffer in milliseconds, the server reading all
    // 8388702. Deleting the header on its own moves nothing, because the cap's
    // own `req.destroy()` still cuts there. And the sender stalls in every one
    // of those cells, including the one that reads the whole body, so the
    // stall is not what ends the read. Both sizes declare a `content-length`
    // past the cap and are answered `connection: close`, so nothing about
    // `fitsUnderCap` is what separates them.
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
    // Read back rather than discarded: the answer is written before a byte is
    // drained precisely so it survives the reset that follows the cap, and a
    // truncated one is the failure that would otherwise look like success.
    assert.equal(await refused.text(), 'refused', 'the refusal did not survive the reset intact')

    const [socket] = served.sockets
    assert.ok(socket, 'the refused upload opened no server connection to measure')
    if (!socket.destroyed) {
      await withDeadline(
        new Promise((resolve) => socket.on('close', () => resolve(undefined))),
        'over-cap connection close'
      )
    }
    // A bounded read is the cap plus the one socket read already in the parser
    // when the pause landed. Node reads a socket 64 KiB at a time and the
    // pause lands during the read that crosses the cap, so nothing past two
    // caps plus the request head can arrive, and 131072 is what every sample
    // measures. The allowance over that is Node's default
    // `--max-http-header-size`, the largest head the parser would have taken.
    //
    // Bounded there rather than a cap higher because the slack is exactly
    // where this probe degenerates. An unbounded read the refusal's teardown
    // cut early is 163705, and one that keeps the pause but drops the reset
    // behind it is 196608: both are under three caps, so a looser bound would
    // go quietly vacuous rather than fail. The early cut is not hypothetical
    // at this body size either - under load 163705 turned up in 2 of 64
    // samples of this very upload, so the bound has to sit under it rather
    // than merely under the whole body.
    const maxBoundedRead = 2 * CAP_BYTES + 16 * 1024
    assert.ok(
      socket.bytesRead < maxBoundedRead,
      `drainRequestBody read ${socket.bytesRead} bytes of the ${body.length} it refused, past the ` +
        `${maxBoundedRead} a bounded read can reach, so the MAX_REJECTED_DRAIN_BYTES (${CAP_BYTES}) ` +
        `cap did not bound the read`
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

    // Declared past the cap, where the declaration alone is what decides it.
    // The header has to be chosen before the answer is written, so this probe
    // sends no byte of the body it announces and needs none: `fitsUnderCap`
    // reads the framing headers and nothing else. What is pinned here is that
    // a connection the drain could later reset is not offered back as a
    // reusable one. The reset itself needs a body that actually crosses the
    // cap, never reaches `req.destroy()` from here (no `data` event fires at
    // all), and is what the first test pins.
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

    // Neither framing header is no body at all: no `data` event is ever
    // emitted, nothing can cross the cap, and the connection stays reusable.
    // Pinned separately from the declared-small body above because it is a
    // separate branch of `fitsUnderCap` and the one the gateway meets most,
    // a bodyless GET at a path nobody registered, arriving on the connection
    // an attached client forwards everything else over.
    const bodyless = await withDeadline(
      rawRefusal(served.port, 'GET /refused HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'),
      'bodyless refusal'
    )
    assert.match(bodyless, /^HTTP\/1\.1 415 /)
    assert.doesNotMatch(
      bodyless,
      /\r\nconnection: close/i,
      `drainRequestBody closed a connection carrying no body at all: ${JSON.stringify(bodyless)}`
    )
  } finally {
    await served.close()
  }
})
