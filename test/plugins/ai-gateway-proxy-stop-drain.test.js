// @ts-check

import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'

import { STOP_GRACE_MS, startProxy } from '../../hypaware-core/plugins-workspace/ai-gateway/src/proxy.js'

// stop() used to wait on `server.close()` alone, which waits for every open
// connection to end. A proxied SSE stream never ends on its own, so a daemon
// stop wedged until the service manager SIGKILLed it (#610). These tests run a
// real loopback upstream and client against the proxy and stop it mid-flight.

// Every wait gets a bound, so a regression fails with what stalled rather than
// hanging the run (`scripts/run-tests.js` sets no `--test-timeout`).
const GIVE_UP_MS = 5000
const GRACE_MS = 300

/**
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
 * A recorded exchange that keeps what the proxy hands it, so a test can read
 * the partial body and the error a stop left on it.
 */
function fakeExchange() {
  return {
    isSse: true,
    /** @type {unknown} */
    response: undefined,
    /** @type {unknown} */
    error: undefined,
    responseBytes: 0,
    appendRequestChunk() {},
    /** @param {{ status?: number }} init */
    setResponseStart(init) { this.response = init },
    /** @param {Buffer} chunk */
    appendResponseChunk(chunk) { this.responseBytes += chunk.length },
    /** @param {Buffer} chunk */
    consumeStreamChunk(chunk) { this.responseBytes += chunk.length },
    /** @param {unknown} error */
    setError(error) { this.error = error },
  }
}

/**
 * Start an upstream whose handler the test drives, and a proxy in front of it
 * that records every exchange. `finished` lists the exchanges handed to
 * `onExchangeFinished`, in order; `settleMs` delays each one's settle, which
 * stands in for the recorder's write.
 *
 * @param {{
 *   upstream: (req: http.IncomingMessage, res: http.ServerResponse) => void,
 *   settleMs?: number,
 *   stopGraceMs?: number,
 * }} opts
 */
async function rig(opts) {
  const upstream = http.createServer(opts.upstream)
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', () => resolve(undefined)))
  const upstreamPort = /** @type {net.AddressInfo} */ (upstream.address()).port
  /** @type {ReturnType<typeof fakeExchange>[]} */
  const started = []
  /** @type {ReturnType<typeof fakeExchange>[]} */
  const finished = []
  /** @type {ReturnType<typeof fakeExchange>[]} */
  const settled = []
  const proxy = await startProxy({
    listen: '127.0.0.1:0',
    upstreams: [{ name: 'anthropic', base_url: `http://127.0.0.1:${upstreamPort}`, path_prefix: '/v1/messages' }],
    stopGraceMs: opts.stopGraceMs ?? GRACE_MS,
    startExchange: () => {
      const exchange = fakeExchange()
      started.push(exchange)
      return /** @type {any} */ (exchange)
    },
    onExchangeFinished: async (exchange) => {
      const fake = /** @type {any} */ (exchange)
      finished.push(fake)
      if (opts.settleMs) await new Promise((resolve) => setTimeout(resolve, opts.settleMs))
      settled.push(fake)
    },
  })
  return {
    proxy,
    started,
    finished,
    settled,
    async close() {
      await bounded(proxy.stop(), 'the proxy to stop')
      upstream.closeAllConnections()
      await new Promise((resolve) => upstream.close(() => resolve(undefined)))
    },
  }
}

/**
 * POST to the proxy and resolve with the response once its head arrives, so
 * the caller can stop the proxy while the body is still streaming.
 * `firstData` is armed before the body starts flowing, so it cannot miss a
 * chunk that arrived with the head.
 *
 * @param {number} port
 * @param {http.Agent | false} [agent]
 * @returns {Promise<{ req: http.ClientRequest, res: http.IncomingMessage, body: Promise<string>, firstData: Promise<void> }>}
 */
function post(port, agent = false) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      agent,
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      const firstData = bounded(new Promise((resolveFirst) => res.once('data', () => resolveFirst(undefined))), 'the first event')
      const body = new Promise((resolveBody) => {
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => resolveBody(text))
        res.on('close', () => resolveBody(text))
        res.on('error', () => resolveBody(text))
      })
      resolve({ req, res, body, firstData })
    })
    req.on('error', reject)
    req.end('{}')
  })
}

/** @param {http.ServerResponse} res */
function openSse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
}

test('stop() cuts an SSE stream that never ends after the grace, and records the partial turn', async () => {
  /** @type {Promise<void>} */
  let upstreamReleased = Promise.resolve()
  const r = await rig({
    upstream: (req, res) => {
      upstreamReleased = new Promise((resolve) => res.on('close', () => resolve(undefined)))
      openSse(res)
    },
  })
  try {
    const { body, firstData } = await post(r.proxy.port)
    await firstData
    const t0 = Date.now()
    await bounded(r.proxy.stop(), 'stop with an open stream')
    const took = Date.now() - t0
    assert.ok(took >= GRACE_MS - 20, `stop waited out the grace (${took} ms)`)
    assert.ok(took < GRACE_MS + 1500, `stop finished within its bound (${took} ms)`)
    assert.match(await bounded(body, 'the client to see the cut'), /message_start/)
    await bounded(upstreamReleased, 'the upstream request to be released')
    assert.equal(r.finished.length, 1, 'the cut exchange finalized once')
    assert.equal(r.finished[0].error, 'gateway_stopped')
    assert.ok(r.finished[0].responseBytes > 0, 'the partial stream was recorded')
  } finally {
    await r.close()
  }
})

test('stop() lets a response that ends within the grace finish, without waiting out the grace', async () => {
  const r = await rig({
    upstream: (req, res) => {
      openSse(res)
      setTimeout(() => res.end('event: message_stop\ndata: {}\n\n'), 100)
    },
    stopGraceMs: 2000,
  })
  try {
    const agent = new http.Agent({ keepAlive: true })
    const { body } = await post(r.proxy.port, agent)
    const t0 = Date.now()
    await bounded(r.proxy.stop(), 'stop with a finishing stream')
    const took = Date.now() - t0
    assert.ok(took < 1500, `stop did not wait out the grace on a kept-alive socket (${took} ms)`)
    assert.match(await body, /message_stop/)
    assert.equal(r.finished.length, 1)
    assert.equal(r.finished[0].error, undefined, 'a completed turn carries no error')
    agent.destroy()
  } finally {
    await r.close()
  }
})

test('stop() closes an idle keep-alive connection at once', async () => {
  const r = await rig({
    upstream: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    },
    stopGraceMs: 2000,
  })
  try {
    const agent = new http.Agent({ keepAlive: true })
    const { body } = await post(r.proxy.port, agent)
    await body
    const t0 = Date.now()
    await bounded(r.proxy.stop(), 'stop with an idle keep-alive socket')
    assert.ok(Date.now() - t0 < 1000, 'the idle socket did not hold the stop')
    agent.destroy()
  } finally {
    await r.close()
  }
})

test('a client that aborts during the grace is recorded as client_aborted', async () => {
  const r = await rig({ upstream: (req, res) => openSse(res) })
  try {
    const { req, firstData } = await post(r.proxy.port)
    await firstData
    const stopping = r.proxy.stop()
    req.destroy()
    await bounded(stopping, 'stop after the client left')
    assert.equal(r.finished.length, 1)
    assert.equal(r.finished[0].error, 'client_aborted')
  } finally {
    await r.close()
  }
})

test('stop() waits for every cut exchange to settle, and repeated stops share one drain', async () => {
  const r = await rig({ upstream: (req, res) => openSse(res), settleMs: 200 })
  try {
    const streams = await Promise.all([post(r.proxy.port), post(r.proxy.port)])
    await Promise.all(streams.map(({ firstData }) => firstData))
    const first = r.proxy.stop()
    const second = r.proxy.stop()
    assert.equal(first, second, 'a concurrent stop joins the first')
    await bounded(Promise.all([first, second]), 'both stops')
    assert.equal(r.finished.length, 2, 'each exchange finalized once')
    assert.equal(r.settled.length, 2, 'stop resolved only after both settled')
    await bounded(r.proxy.stop(), 'a repeat stop')
    assert.equal(r.finished.length, 2, 'a repeat stop finalizes nothing again')
  } finally {
    await r.close()
  }
})

test('the port is rebindable once stop() resolves with a stream open', async () => {
  const r = await rig({ upstream: (req, res) => openSse(res) })
  const port = r.proxy.port
  try {
    const { firstData } = await post(port)
    await firstData
    await bounded(r.proxy.stop(), 'stop')
    const again = net.createServer()
    await bounded(new Promise((resolve, reject) => {
      again.once('error', reject)
      again.listen(port, '127.0.0.1', () => resolve(undefined))
    }), 'the port to rebind')
    await new Promise((resolve) => again.close(() => resolve(undefined)))
  } finally {
    await r.close()
  }
})

test('the stop grace stays inside the gateway daemon\'s forced-exit deadline', () => {
  // src/core/daemon/gateway.js STOP_DEADLINE_MS (4 s) SIGKILLs the child and
  // exits; a grace at or past it would have the exit cut the streams first,
  // and the cut turns would never finalize. Half of it leaves the finalizers
  // and the child's writes the rest.
  assert.ok(STOP_GRACE_MS <= 2000, `grace ${STOP_GRACE_MS} ms leaves the finalizers time inside 4 s`)
})
