// @ts-check

import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'

import { startProxy } from '../../hypaware-core/plugins-workspace/ai-gateway/src/proxy.js'

// The gateway's upstream-failure 502 is the one refusal that answers a request
// already handed to a pipe: `req.pipe(upstreamReq)` runs before the upstream
// connect fails, and pipe's dest-`error` handler unpipes, which pauses the
// source. The explicit `req.resume()` in `drainRequestBody` is the only thing
// that reads that body, so these tests measure the bytes read and not whether
// the connection is still usable: the parser keeps pushing a declared body
// into the paused stream, so a follow-up request on the same socket is
// answered with or without the resume and proves nothing either way.

// The dead upstream. `127.0.0.1:1` refuses instantly and stays refusing: it
// is below the ephemeral range no `listen(0)` in this process draws from and
// no unprivileged process can bind, so the forward can never reach a listener
// - not the proxy itself, handed its own upstream's port back by the next
// bind, and not another test process that took a port this one released. The
// same address, for the same reason, as the budget tests in
// `test/core/observability-shutdown-budget.test.js`.
const DEAD_UPSTREAM = 'http://127.0.0.1:1'

const UNDER_CAP_BYTES = 60000
const OVER_CAP_BYTES = 200000

// How long any one wait on a socket event gets before it is reported as a
// failure. `scripts/run-tests.js` runs `node --test` without
// `--test-timeout`, so a test that waits forever waits forever and the only
// thing that ends the run is the CI job's own clock: a bare timeout, with no
// failing assertion to say what stalled.
const GIVE_UP_MS = 5000

/**
 * Reject with `what` rather than hang, so every wait in this file reports
 * itself.
 *
 * @template T
 * @param {Promise<T>} settling
 * @param {string} what
 * @returns {Promise<T>}
 */
function bounded(settling, what) {
  return new Promise((resolve, reject) => {
    const giveUp = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), GIVE_UP_MS)
    settling.then(
      (value) => {
        clearTimeout(giveUp)
        resolve(value)
      },
      (error) => {
        clearTimeout(giveUp)
        reject(error)
      }
    )
  })
}

/**
 * Run `body` against a gateway whose only upstream is a port nobody listens
 * on, so every forward fails to connect and lands on the 502. `requestBytes`
 * counts what the proxy hands the exchange, which is the body the drain read
 * off the socket, and `drained` waits for that count to reach a length.
 *
 * @param {(rig: {
 *   port: number,
 *   requestBytes: () => number,
 *   drained: (bytes: number) => Promise<void>,
 * }) => Promise<void>} body
 */
async function withDeadUpstream(body) {
  let requestBytes = 0
  /** @type {(() => void) | undefined} */
  let onChunk
  const proxy = await startProxy({
    listen: '127.0.0.1:0',
    upstreams: [{
      name: 'dead-anthropic',
      base_url: DEAD_UPSTREAM,
      path_prefix: '/v1/messages',
    }],
    startExchange: () => /** @type {any} */ ({
      isSse: false,
      response: undefined,
      appendRequestChunk(/** @type {Buffer} */ chunk) {
        requestBytes += chunk.length
        onChunk?.()
      },
      setResponseStart() {},
      appendResponseChunk() {},
      consumeStreamChunk() {},
      setError() {},
    }),
    onExchangeFinished: () => {},
  })
  try {
    await body({
      port: proxy.port,
      requestBytes: () => requestBytes,
      drained: (bytes) => new Promise((resolve, reject) => {
        const giveUp = setTimeout(() => {
          onChunk = undefined
          reject(new Error(`the 502 drained ${requestBytes} of ${bytes} declared body bytes`))
        }, GIVE_UP_MS)
        onChunk = () => {
          if (requestBytes < bytes) return
          onChunk = undefined
          clearTimeout(giveUp)
          resolve(undefined)
        }
        onChunk()
      }),
    })
  } finally {
    await bounded(proxy.stop(), 'the proxy to stop')
  }
}

/**
 * Open a socket and write a request head that declares `length` body bytes,
 * holding the body back. `head` resolves once the answer's own head is on the
 * wire, which is the point at which the caller is still mid-upload and the
 * drain is the only reader left: a body delivered before the pipe collapsed
 * would have been read without one.
 *
 * @param {{ port: number, length: number }} args
 */
function sendHead({ port, length }) {
  /** @type {Buffer[]} */
  const chunks = []
  const socket = net.connect(port, '127.0.0.1', () => {
    socket.write(
      'POST /v1/messages HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${port}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${length}\r\n` +
      '\r\n'
    )
  })
  const head = new Promise((resolve, reject) => {
    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk))
      const received = Buffer.concat(chunks).toString('utf8')
      if (received.includes('\r\n\r\n')) resolve(received)
    })
    // A close before the head is complete resolves with what did arrive, so
    // the assertion reports the answer rather than a timeout.
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('error', reject)
  })
  return { socket, head }
}

// The regression this file exists for: remove `req.resume()` from
// `drainRequestBody` and the body below is never read and never counted
// against the cap, and this test fails.
test('the upstream-failure 502 drains a declared body that arrives after the pipe collapsed', async () => {
  await withDeadUpstream(async (rig) => {
    const { socket, head } = sendHead({ port: rig.port, length: UNDER_CAP_BYTES })
    try {
      const received = /** @type {string} */ (await bounded(head, 'the 502 head'))
      assert.match(received, /^HTTP\/1\.1 502 /, received.slice(0, 120))
      assert.match(received, /"upstream connection failed"/, received.slice(0, 400))
      // A declared body that fits under the cap is drained to its end and can
      // never reach the cap, so no reset is coming and the connection is kept.
      assert.equal(
        /\r\nconnection: close\r\n/i.test(received),
        false,
        `the 502 closed a connection it drains to the end: ${received.slice(0, 200)}`
      )
      assert.equal(rig.requestBytes(), 0, 'nothing was sent before the answer, so nothing was read')
      socket.write(Buffer.alloc(UNDER_CAP_BYTES, 0x61))
      await rig.drained(UNDER_CAP_BYTES)
    } finally {
      socket.destroy()
    }
  })
})

test('the upstream-failure 502 never answers an over-cap declared body as a reusable connection', async () => {
  await withDeadUpstream(async (rig) => {
    const { socket, head } = sendHead({ port: rig.port, length: OVER_CAP_BYTES })
    try {
      const received = /** @type {string} */ (await bounded(head, 'the 502 head'))
      assert.match(received, /^HTTP\/1\.1 502 /, received.slice(0, 120))
      // A body this long is not known to fit, so the drain could reach its cap
      // and reset. Announcing the close keeps that reset off a socket a
      // pooling client would otherwise have handed back as reusable.
      assert.match(received, /\r\nconnection: close\r\n/i, received.slice(0, 200))
      // Announced and then done: the sender sees its socket close rather than
      // an invitation to finish an upload nobody is going to read.
      await bounded(new Promise((resolve) => socket.on('close', resolve)), 'the announced close')
    } finally {
      socket.destroy()
    }
  })
})
