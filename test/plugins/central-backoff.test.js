// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { abortableSleep, parseRetryAfter, RETRY_BACKOFF_SECONDS } from '../../hypaware-core/plugins-workspace/central/src/backoff.js'

test('abortableSleep resolves after the delay when not aborted', async () => {
  const start = Date.now()
  await abortableSleep(20)
  assert.ok(Date.now() - start >= 15, 'waited roughly the requested delay')
})

test('abortableSleep rejects immediately when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort(new Error('already gone'))
  await assert.rejects(abortableSleep(10_000, controller.signal), /already gone/)
})

test('abortableSleep rejects promptly when aborted mid-sleep', async () => {
  const controller = new AbortController()
  const p = abortableSleep(10_000, controller.signal)
  const start = Date.now()
  setTimeout(() => controller.abort(new Error('interrupted')), 10)
  await assert.rejects(p, /interrupted/)
  assert.ok(Date.now() - start < 1000, 'did not wait out the full delay')
})

test('parseRetryAfter and the ladder are the shared canonical source', () => {
  assert.equal(parseRetryAfter('7'), 7)
  assert.equal(parseRetryAfter('soonish'), undefined)
  assert.deepEqual(RETRY_BACKOFF_SECONDS, [30, 60, 120, 300])
})
