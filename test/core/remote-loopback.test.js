// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

import { startLoopbackReceiver } from '../../src/core/remote/loopback.js'

/**
 * Send a raw request line the way `fetch` never would, so we can exercise a
 * request target that makes `new URL` throw. Resolves with the response bytes.
 *
 * @param {string} redirectUri
 * @param {string} target the raw request-target after the method
 * @returns {Promise<string>}
 */
function rawRequest(redirectUri, target) {
  const port = Number(new URL(redirectUri).port)
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
    })
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk) => { buf += chunk })
    sock.on('end', () => resolve(buf))
    sock.on('error', reject)
  })
}

/**
 * Drive the real bound port with a real HTTP request, the way the browser
 * would hit the loopback redirect.
 *
 * @param {string} redirectUri
 * @param {Record<string, string>} query
 * @returns {Promise<number>}
 */
async function hitCallback(redirectUri, query) {
  const url = new URL(redirectUri)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const res = await fetch(url, { redirect: 'manual' })
  await res.text()
  return res.status
}

test('a matching state resolves { code } and closes the listener', async () => {
  const recv = await startLoopbackReceiver({ state: 's-good', timeoutMs: 2000 })
  const waiting = recv.waitForCode()
  const status = await hitCallback(recv.redirectUri, { code: 'abc123', state: 's-good' })
  assert.equal(status, 200)
  assert.deepEqual(await waiting, { code: 'abc123' })

  // The listener is single-shot: a second request must fail to connect.
  await assert.rejects(() => hitCallback(recv.redirectUri, { code: 'x', state: 's-good' }))
})

test('a mismatched state rejects without yielding a code', async () => {
  const recv = await startLoopbackReceiver({ state: 's-real', timeoutMs: 2000 })
  // Attach the rejection assertion synchronously so the (synchronous) reject
  // inside the request handler always lands on a handler.
  const assertion = assert.rejects(() => recv.waitForCode(), /mismatched state/)
  await hitCallback(recv.redirectUri, { code: 'leak', state: 's-forged' })
  await assertion
})

test('an error= callback rejects with the error code attached', async () => {
  const recv = await startLoopbackReceiver({ state: 's1', timeoutMs: 2000 })
  const assertion = assert.rejects(() => recv.waitForCode(), (err) => {
    assert.match(/** @type {Error} */ (err).message, /org_selection_required/)
    assert.equal(/** @type {any} */ (err).callbackError, 'org_selection_required')
    return true
  })
  await hitCallback(recv.redirectUri, { error: 'org_selection_required', state: 's1' })
  await assertion
})

test('an error= callback with no state reports the real error, not a state mismatch', async () => {
  const recv = await startLoopbackReceiver({ state: 's1', timeoutMs: 2000 })
  // A provider that drops `state` on an error redirect must still surface the
  // denial, not be misreported as a CSRF/state mismatch (which also appends a
  // misleading headless-token hint downstream).
  const assertion = assert.rejects(() => recv.waitForCode(), (err) => {
    assert.match(/** @type {Error} */ (err).message, /access_denied/)
    assert.doesNotMatch(/** @type {Error} */ (err).message, /mismatched state/)
    assert.equal(/** @type {any} */ (err).callbackError, 'access_denied')
    return true
  })
  await hitCallback(recv.redirectUri, { error: 'access_denied' })
  await assertion
})

test('a timeout rejects', async () => {
  const recv = await startLoopbackReceiver({ state: 's1', timeoutMs: 50 })
  await assert.rejects(() => recv.waitForCode(), /timed out/)
})

test('close() before a code arrives rejects a pending waitForCode (no hang)', async () => {
  const recv = await startLoopbackReceiver({ state: 's1', timeoutMs: 2000 })
  const assertion = assert.rejects(() => recv.waitForCode(), /closed before a code arrived/)
  recv.close()
  await assertion
})

test('a malformed request target returns 400 without crashing or settling the flow', async () => {
  const recv = await startLoopbackReceiver({ state: 's1', timeoutMs: 2000 })
  const waiting = recv.waitForCode()
  // `GET //` makes `new URL('//', base)` throw; the handler must answer 400
  // rather than letting the throw crash the process.
  const resp = await rawRequest(recv.redirectUri, '//')
  assert.match(resp, /^HTTP\/1\.1 400/)
  // The flow is untouched: the real callback afterward still resolves.
  await hitCallback(recv.redirectUri, { code: 'ok', state: 's1' })
  assert.deepEqual(await waiting, { code: 'ok' })
})

test('a request to a path other than /callback does not consume the single shot', async () => {
  const recv = await startLoopbackReceiver({ state: 's1', timeoutMs: 2000 })
  const waiting = recv.waitForCode()
  // A favicon-style probe to another path 404s without settling the flow.
  const probe = await fetch(new URL('/favicon.ico', recv.redirectUri))
  await probe.text()
  assert.equal(probe.status, 404)
  // The real callback still works afterward.
  await hitCallback(recv.redirectUri, { code: 'ok', state: 's1' })
  assert.deepEqual(await waiting, { code: 'ok' })
})
