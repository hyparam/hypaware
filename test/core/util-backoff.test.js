// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RETRY_BACKOFF_SECONDS,
  abortReason,
  abortableSleep,
  discardBody,
  parseRetryAfter,
  readBodyCapped,
} from '../../src/core/util/backoff.js'
import * as central from '../../hypaware-core/plugins-workspace/central/src/backoff.js'

/**
 * A streaming body that yields `chunks`, then either ends or stalls forever,
 * recording whether the reader cancelled it.
 *
 * @param {string[]} chunks
 * @param {{ stall?: boolean, headers?: Record<string, string> }} [opts]
 */
function streamingResponse(chunks, opts = {}) {
  const state = { cancelled: false, pulls: 0 }
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    pull(controller) {
      const next = chunks[state.pulls++]
      if (next !== undefined) return controller.enqueue(encoder.encode(next))
      if (opts.stall) return new Promise(() => {})
      controller.close()
    },
    cancel() { state.cancelled = true },
  })
  return { response: new Response(body, { headers: opts.headers }), state }
}

test('the ladder is 30, 60, 120, 300 seconds', () => {
  assert.deepEqual(RETRY_BACKOFF_SECONDS, [30, 60, 120, 300])
})

test('central re-exports the shared helpers rather than copies', () => {
  assert.equal(central.RETRY_BACKOFF_SECONDS, RETRY_BACKOFF_SECONDS)
  assert.equal(central.parseRetryAfter, parseRetryAfter)
  assert.equal(central.abortableSleep, abortableSleep)
  assert.equal(central.discardBody, discardBody)
  assert.equal(central.readBodyCapped, readBodyCapped)
})

test('parseRetryAfter reads delta-seconds, including zero', () => {
  assert.equal(parseRetryAfter('7'), 7)
  assert.equal(parseRetryAfter('0'), 0)
  assert.equal(parseRetryAfter('120'), 120)
})

test('parseRetryAfter reads an HTTP-date, clamping the past to zero', () => {
  const future = new Date(Date.now() + 90_000).toUTCString()
  const seconds = parseRetryAfter(future)
  assert.ok(seconds !== undefined && seconds >= 88 && seconds <= 91, `got ${seconds}`)
  assert.equal(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0)
})

test('parseRetryAfter returns undefined for absent or unparseable values', () => {
  assert.equal(parseRetryAfter(null), undefined)
  assert.equal(parseRetryAfter(''), undefined)
  assert.equal(parseRetryAfter('soonish'), undefined)
})

test('parseRetryAfter reads a negative delta as a past date, so callers fall back to the ladder', () => {
  // Date.parse('-5') is year -5: a past HTTP-date, which parses to 0.
  assert.equal(parseRetryAfter('-5'), 0)
})

test('abortableSleep resolves after the delay and leaves no abort listener', async () => {
  const controller = new AbortController()
  let added = 0
  let removed = 0
  const { signal } = controller
  const add = signal.addEventListener.bind(signal)
  const remove = signal.removeEventListener.bind(signal)
  signal.addEventListener = (/** @type {any} */ ...args) => { added++; add(...args) }
  signal.removeEventListener = (/** @type {any} */ ...args) => { removed++; remove(...args) }
  const start = Date.now()
  await abortableSleep(20, signal)
  assert.ok(Date.now() - start >= 15, 'waited roughly the requested delay')
  assert.equal(added, 1)
  assert.equal(removed, 1)
})

test('abortableSleep rejects with the reason when already aborted', async () => {
  const controller = new AbortController()
  controller.abort(new Error('already gone'))
  await assert.rejects(abortableSleep(10_000, controller.signal), /already gone/)
})

test('abortableSleep rejects promptly when aborted mid-sleep', async () => {
  const controller = new AbortController()
  const p = abortableSleep(10_000, controller.signal)
  const start = Date.now()
  setTimeout(() => controller.abort('stopping'), 10)
  await assert.rejects(p, (err) => err instanceof Error && err.message === 'stopping')
  assert.ok(Date.now() - start < 1000, 'did not wait out the full delay')
})

test('abortReason keeps an Error reason and wraps anything else', () => {
  const err = new Error('boom')
  const a = new AbortController()
  a.abort(err)
  assert.equal(abortReason(a.signal), err)
  const b = new AbortController()
  b.abort('text reason')
  assert.equal(abortReason(b.signal).message, 'text reason')
  assert.equal(abortReason(undefined).message, 'aborted')
})

test('discardBody cancels a streaming body and tolerates no body or a failing cancel', async () => {
  const { response, state } = streamingResponse(['x'], { stall: true })
  await discardBody(response)
  assert.equal(state.cancelled, true)
  await discardBody(new Response(null))
  const failing = /** @type {Response} */ (/** @type {unknown} */ ({
    body: { cancel: async () => { throw new Error('already locked') } },
  }))
  await discardBody(failing)
})

test('readBodyCapped returns the whole streamed body under the cap', async () => {
  const { response } = streamingResponse(['hello ', 'world'])
  assert.deepEqual(await readBodyCapped(response, 1024), { ok: true, body: 'hello world' })
})

test('readBodyCapped refuses an oversized content-length without reading', async () => {
  const { response, state } = streamingResponse(['never read'], { headers: { 'content-length': '5000' } })
  assert.deepEqual(await readBodyCapped(response, 100), { ok: false, bytesRead: 5000 })
  assert.equal(state.cancelled, true)
  assert.equal(state.pulls <= 1, true, 'did not drain the body')
})

test('readBodyCapped stops and cancels once the stream passes the cap', async () => {
  const { response, state } = streamingResponse(['aaaa', 'bbbb', 'cccc'], { stall: true })
  assert.deepEqual(await readBodyCapped(response, 6), { ok: false, bytesRead: 8 })
  assert.equal(state.cancelled, true)
})

test('readBodyCapped handles a non-streaming test double on both sides of the cap', async () => {
  const double = (/** @type {string} */ text) => /** @type {Response} */ (/** @type {unknown} */ ({
    headers: new Headers(),
    body: null,
    text: async () => text,
  }))
  assert.deepEqual(await readBodyCapped(double('small'), 10), { ok: true, body: 'small' })
  assert.deepEqual(await readBodyCapped(double('é'.repeat(6)), 10), { ok: false, bytesRead: 12 })
})

test('readBodyCapped throws at once on an already aborted signal', async () => {
  const controller = new AbortController()
  controller.abort(new Error('gone before read'))
  const { response } = streamingResponse(['x'])
  await assert.rejects(readBodyCapped(response, 10, controller.signal), /gone before read/)
})

test('readBodyCapped cancels a stalled read when the signal aborts', async () => {
  const controller = new AbortController()
  const { response, state } = streamingResponse(['part'], { stall: true })
  const p = readBodyCapped(response, 1024, controller.signal)
  setTimeout(() => controller.abort(new Error('deadline')), 10)
  await assert.rejects(p, /deadline/)
  assert.equal(state.cancelled, true)
  assert.equal(response.body?.locked, false, 'reader lock released')
})
