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

/**
 * @import { IncomingMessage, ServerResponse } from 'node:http'
 */

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
 *
 * `answer` replaces the writing half only, never the drain: the slow-response
 * probe needs a handler that has called `drainRequestBody` and has not yet put
 * its refusal on the wire, and that window is not reachable from a second
 * server that drains some other way.
 *
 * @param {{ answer?: (req: IncomingMessage, res: ServerResponse) => void }} [options]
 */
async function startRefusingServer(options = {}) {
  /** @type {net.Socket[]} */
  const sockets = []
  const server = http.createServer((req, res) => {
    drainRequestBody(req, res)
    if (options.answer) {
      options.answer(req, res)
      return
    }
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
    // Four times the cap. Large enough that an unbounded read of it is all
    // but always the whole body, so a bounded read is the cap's doing and not
    // the teardown's; in the few samples where the teardown cuts first
    // instead, the bound further down still catches it. Small enough that it
    // still crosses the cap inside two socket reads. Bounded, the server reads
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
    // the race at a different moment, has read 112798 and 98317 in separate
    // probes on hosts of the same shape, so which of them it lands on tracks
    // the probe rather than the host.
    //
    // It is that teardown and not the sender running out of buffer that cuts
    // the read. With the cap deleted the read is still only what arrived
    // first; delete the `connection: close` answer as well and it moves under
    // either client. A raw socket empties its whole 8 MiB buffer in
    // milliseconds and the server reads all 8388702; `fetch`, which ends the
    // connection from its own side instead, reads 2613675. Both figures count
    // the request head, 94 bytes for the raw shape this file sends against 228
    // for `fetch`, so the two clients' numbers do not line up digit for digit.
    // Deleting the header on its own moves nothing, because the cap's own
    // `req.destroy()` still cuts there. And the sender hits backpressure in
    // every one of the raw-socket cells, the whole-body one included, so it is
    // a transient the read outlives rather than what ends it. Both sizes
    // declare a `content-length` past the cap and are answered
    // `connection: close`, so nothing about `fitsUnderCap` is what separates
    // them.
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
    // behind it is 196608: a bound a cap higher would be 212992, over both, so
    // it would go quietly vacuous rather than fail. The early cut is not
    // hypothetical at this body size either - under load 163705 turned up in
    // 2 of 64 samples of this very upload, so the bound has to sit under it
    // rather than merely under the whole body.
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

/**
 * Watch a server-side socket until its read stops growing, and report where it
 * stopped. Settling rather than a fixed wait, because a read is only shown to
 * be unbounded once it has had the chance to finish: a sleep long enough on an
 * idle machine is a coin flip on a loaded one, and a half-read body sampled
 * early reads as a bounded one. Returns the moment the read passes `bound`
 * too, so a failing probe says so promptly instead of waiting out a body it
 * has already disproved.
 *
 * @param {net.Socket} socket
 * @param {number} bound the largest read the caller will accept as bounded
 * @returns {Promise<number>} bytes read when the read settled
 */
async function settledBytesRead(socket, bound) {
  const SAMPLE_MS = 25
  const STABLE_MS = 400
  const LIMIT_MS = 5_000
  let previous = -1
  let stableFor = 0
  const started = Date.now()
  let sampledAt = started
  while (Date.now() - started < LIMIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS))
    const now = Date.now()
    // Measured, not the nominal `SAMPLE_MS`: a loaded host hands back a 25ms
    // timer late, and counting the sleeps rather than the clock would call a
    // read still, which the window is measured in, before it has been still
    // for that long.
    const waited = now - sampledAt
    sampledAt = now
    const sample = socket.bytesRead
    if (sample >= bound) return sample
    stableFor = sample === previous ? stableFor + waited : 0
    previous = sample
    // Settled under the cap is not settled, it is a sender that has not caught
    // up yet, and taking it for an answer would pass the probe without ever
    // entering the window it exists to measure.
    if (sample > CAP_BYTES && stableFor >= STABLE_MS) return sample
  }
  // Out of window with the read still moving. Handing the last sample back is
  // how an unbounded read on a sender too slow to finish inside the window
  // passes for a bounded one: it sits under the bound only because the rest of
  // the body has not arrived yet. Measured with the pause deleted and a sender
  // trickling 4 KiB every 100ms, that path reported 204894 bytes, over the cap
  // and under the bound, and every assertion below it passed. A read that
  // stalled instead is still returned, so the caller's own cap check gets to
  // say the drain was never asked to bound anything.
  if (stableFor < STABLE_MS) {
    throw new Error(
      `the refused body's read was still growing at ${socket.bytesRead} bytes when the ${LIMIT_MS}ms ` +
        'sampling window ran out, so no settled read was measured to hold against the bound'
    )
  }
  return socket.bytesRead
}

test('drainRequestBody stops reading a refused body while its answer is still pending', async () => {
  // Why a second cap probe: the first one cannot tell whether `req.pause()` is
  // doing anything. Two independent things bound the read there. One is the
  // cap block. The other is the `connection: close` answer, whose teardown
  // destroys the socket as soon as the refusal flushes, and in that probe the
  // refusal has always flushed before the read that crosses the cap lands. So
  // the teardown alone reaches the same bounded number, and deleting the pause
  // changes nothing that probe can see.
  //
  // Here the answer is withheld until after the measurement. That leaves
  // `res.writableFinished` false, which makes the `req.destroy()` inside
  // `closeIfAnswered` unreachable, and leaves the pause as the only thing that
  // can stop the read. It is also the case the pause exists for: a caller's
  // handler that has not finished answering by the time the upload crosses the
  // cap.
  /** @type {(entered: { req: IncomingMessage, res: ServerResponse }) => void} */
  let reached = () => {}
  /** @type {Promise<{ req: IncomingMessage, res: ServerResponse }>} */
  const handlerEntered = new Promise((resolve) => {
    reached = resolve
  })
  const served = await startRefusingServer({
    // Answers nothing on purpose. The refusal is written further down, once
    // the read has been measured inside the window.
    answer: (req, res) => reached({ req, res }),
  })
  /** @type {net.Socket | undefined} */
  let client
  try {
    // A bounded read here is bigger than the sibling probe's, and reached by a
    // different route, so it gets its own bound rather than sharing one. There
    // the answer is already out, so the read that crosses the cap is the last
    // one: the socket is destroyed inside it, and every sample is 131072. Here
    // nothing is destroyed, and `req.pause()` reaches the socket only through
    // the request stream, which goes on buffering until its own backpressure
    // stops the reads behind it. So the ceiling is the cap, plus the socket
    // read in flight when the pause landed, plus what the stream buffers on
    // the way to stopping, plus the read that stopping was too late for: four
    // 64 KiB reads, and Node's default `--max-http-header-size` on top for the
    // request head. Samples land at 229281, three and a half reads, and do not
    // move with the body size. They do move with the length of the request
    // head, which is what decides where inside a socket read the cap is
    // crossed, so the allowance is deliberately not trimmed to what this one
    // request measures.
    const maxBoundedRead = 4 * CAP_BYTES + 16 * 1024
    // Thirty-two times the cap, eight times what the sibling probe sends,
    // because neither half of what sizes that one holds here. It is ceilinged:
    // there the refusal is already out, so at a large enough body an unbounded
    // read stops being the whole body, the teardown cutting it at whatever
    // arrived first - at 32 caps it cut 5 of 8 samples to 163705 - and a body
    // chosen past that ceiling makes the probe vacuous rather than sharper. No
    // teardown happens inside this window at all, the answer being withheld for
    // the length of it, so an unbounded read here is the whole body at any size
    // and there is no ceiling to respect. And it needs a floor that probe does
    // not: a bounded read here already reaches three and a half caps, so the
    // small bodies are the vacuous ones. At 4 caps an unbounded read measures
    // 262237, which is under the bound, so the probe would pass with the pause
    // deleted; 5 caps is the first size to clear the bound at all, and only by
    // a sixth. At 32 caps an unbounded read is 2097246, seven and a half times
    // the bound, with nothing in between: every sample is either that or the
    // bounded 229281.
    const body = Buffer.alloc(32 * CAP_BYTES, 'x')
    client = net.connect(served.port, '127.0.0.1')
    // Ends as a reset arriving under a write this sender has not finished,
    // which is how a stalled upload is meant to end here, not a failure. A
    // connect that never lands is left to the deadline below instead.
    client.on('error', () => {})
    client.write(
      'POST /refused HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
        `content-type: text/plain\r\ncontent-length: ${body.length}\r\n\r\n`
    )
    client.write(body)
    const pending = await withDeadline(handlerEntered, 'slow-response handler entry')

    const serverSocket = pending.req.socket
    const bytesRead = await withDeadline(
      settledBytesRead(serverSocket, maxBoundedRead),
      'slow-response read settling'
    )

    // Both checked before the bound, because either one failing quietly would
    // leave a probe that passes without having entered the window at all. The
    // first is not a formality: stop withholding the answer and this same
    // upload reads 98317, under the bound, so the probe would go green having
    // measured the sibling's teardown rather than the pause.
    assert.ok(
      !pending.res.writableFinished,
      'the withheld refusal had already flushed, so the connection teardown could have bounded this read ' +
        'and the probe no longer isolates req.pause()'
    )
    assert.ok(
      bytesRead > CAP_BYTES,
      `only ${bytesRead} bytes of the ${body.length} being uploaded reached the server, never crossing the ` +
        `${CAP_BYTES} cap, so the drain was never asked to bound anything`
    )
    assert.ok(
      bytesRead < maxBoundedRead,
      `drainRequestBody read ${bytesRead} bytes of the ${body.length} it refused while its answer was still ` +
        `pending, past the ${maxBoundedRead} a bounded read can reach, so req.pause() did not bound the read ` +
        'and the length of a refused body is the sender\'s to choose'
    )

    // Released only now, so the assertions above ran inside the window. The
    // answer flushing is what makes `closeIfAnswered` destroy the request,
    // which is what ends the stalled upload.
    pending.res.writeHead(415, { 'content-type': 'text/plain' })
    pending.res.end('refused')
  } finally {
    client?.destroy()
    await served.close()
  }
})
