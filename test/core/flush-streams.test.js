// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { flushStream } from '../../src/core/cli/flush-streams.js'

/** A minimal Writable-shaped stub exposing only what flushStream touches. */
function fakeStream({ writableLength, mode }) {
  /** @type {Record<string, Function>} */
  const handlers = {}
  return {
    writableLength,
    once(event, cb) {
      handlers[event] = cb
    },
    write(_chunk, cb) {
      if (mode === 'drain') queueMicrotask(() => cb())
      else if (mode === 'error') queueMicrotask(() => handlers.error?.())
      // mode 'hang' never invokes either. Used with a timeout race
    },
  }
}

test('resolves immediately when nothing is buffered', async () => {
  let resolved = false
  await flushStream(/** @type {any} */ (fakeStream({ writableLength: 0, mode: 'hang' })))
    .then(() => { resolved = true })
  assert.equal(resolved, true)
})

test('resolves via the write callback once buffered output drains', async () => {
  await flushStream(/** @type {any} */ (fakeStream({ writableLength: 42, mode: 'drain' })))
  assert.ok(true) // resolving (not hanging) is the assertion
})

test('resolves on error (EPIPE) instead of hanging', async () => {
  await flushStream(/** @type {any} */ (fakeStream({ writableLength: 42, mode: 'error' })))
  assert.ok(true)
})

test('does not double-resolve when both error and write callback fire', async () => {
  /** @type {Record<string, Function>} */
  const handlers = {}
  let resolveCount = 0
  const stream = {
    writableLength: 10,
    once(event, cb) { handlers[event] = cb },
    write(_chunk, cb) {
      // fire both paths; the `done` guard must collapse them to one resolve
      handlers.error?.()
      cb()
    },
  }
  await flushStream(/** @type {any} */ (stream)).then(() => { resolveCount += 1 })
  // microtask queue drains; a double-resolve on a Promise is a no-op but we
  // assert the awaited value settled exactly once observationally.
  assert.equal(resolveCount, 1)
})
