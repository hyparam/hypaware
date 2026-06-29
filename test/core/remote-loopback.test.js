// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { startLoopbackReceiver } from '../../src/core/remote/loopback.js'

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

test('a timeout rejects', async () => {
  const recv = await startLoopbackReceiver({ state: 's1', timeoutMs: 50 })
  await assert.rejects(() => recv.waitForCode(), /timed out/)
})
