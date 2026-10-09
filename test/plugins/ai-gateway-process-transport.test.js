// @ts-check

import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import assert from 'node:assert/strict'
import { createCaptureReceiver, createCaptureSender, PENDING_BYTES } from '../../hypaware-core/plugins-workspace/ai-gateway/src/process_transport.js'

/** @import { ChildProcess } from 'node:child_process' */

function fixture() {
  /** @type {object[]} */
  const frames = []
  /** @type {string[]} */
  const warnings = []
  const child = /** @type {ChildProcess} */ (/** @type {unknown} */ ({
    connected: true,
    send(message, callback) { frames.push(message); callback(null) },
  }))
  const sender = createCaptureSender({ getChild: () => child, log: { warn: event => warnings.push(event) } })
  const init = { upstream: 'test', provider: 'openai', method: 'POST', path: '/v1/chat/completions', requestHeaders: { authorization: 'private-key', 'x-extra-secret': 'private-extra' } }
  return { sender, child, frames, warnings, init }
}

test('a dead or stalled processor cannot accumulate unbounded gateway capture copies', () => {
  const { sender, init, frames, warnings } = fixture()
  const absent = sender.recorder.startExchange(init)
  absent.appendRequestChunk(Buffer.alloc(1024))
  sender.finish(absent, new Set())
  assert.equal(frames.length, 0)
  assert.equal(sender.snapshot().capture_dropped, 1)

  sender.message({ type: 'gateway.capture_ready' })
  const stalled = sender.recorder.startExchange(init)
  stalled.appendRequestChunk(Buffer.alloc(PENDING_BYTES * 2))
  sender.finish(stalled, new Set())
  assert.ok(sender.snapshot().capture_pending_bytes <= PENDING_BYTES)
  assert.equal(sender.snapshot().capture_active, 0)
  assert.equal(stalled.requestChunks.length, 0, 'gateway retained request bodies')
  assert.equal(stalled.responseChunks.length, 0)
  assert.equal(sender.snapshot().capture_dropped, 2)
  assert.ok(warnings.includes('gateway.capture_dropped'))
  sender.reset()
  assert.equal(sender.snapshot().capture_pending_bytes, 0)
})

test('processing reconstructs redacted captures and keeps the gateway ignore snapshot', async () => {
  const { sender, init, frames } = fixture()
  sender.configure(['x-extra-secret'])
  /** @type {any[]} */
  const results = []
  const receiver = createCaptureReceiver({
    send: message => sender.message(message),
    async onExchange(exchange, ignored) { results.push({ row: exchange.finalize(), ignored }) },
  })
  sender.message({ type: 'gateway.capture_ready' })
  const exchange = sender.recorder.startExchange(init)
  exchange.appendRequestChunk(Buffer.from('{"model":"test","messages":[]}'))
  exchange.setResponseStart({ status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'private-cookie' } })
  exchange.appendResponseChunk(Buffer.from('{"ok":true}'))
  sender.finish(exchange, new Set(['ignored-session']))
  assert.ok(!JSON.stringify(frames).includes('private-'))
  for (const frame of frames) receiver.message(frame)
  await receiver.close()
  assert.equal(results.length, 1)
  assert.equal(results[0].row.response_body, '{"ok":true}')
  assert.equal(results[0].row.exchange_id, exchange.id)
  assert.equal(results[0].row.ts_start, exchange.tsStart)
  assert.ok(results[0].ignored.has('ignored-session'))
  assert.equal(sender.snapshot().capture_pending_bytes, 0)
})

test('processor restart abandons old captures and resumes only new exchanges', () => {
  const { sender, init, frames } = fixture()
  sender.message({ type: 'gateway.capture_ready' })
  const old = sender.recorder.startExchange(init)
  sender.reset()
  sender.message({ type: 'gateway.capture_ready' })
  const before = frames.length
  old.appendResponseChunk(Buffer.from('must not resume'))
  sender.finish(old, new Set())
  assert.equal(frames.length, before)
  const next = sender.recorder.startExchange(init)
  sender.finish(next, new Set())
  assert.equal(frames.length, before + 2)
})


test('invalid exclusions cancel an in-flight remote capture and release its slot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-ignore-'))
  const { sender, init, frames } = fixture()
  try {
    const ignored = new SessionIgnoreSet(root)
    ignored.add('private')
    sender.message({ type: 'gateway.capture_ready' })
    const exchange = sender.recorder.startExchange(init)
    fs.writeFileSync(path.join(ignored.directory, fs.readdirSync(ignored.directory)[0]), 'broken json')
    assert.throws(() => ignored.refresh())
    sender.finish(exchange, ignored)
    assert.equal(sender.snapshot().capture_active, 0)
    assert.equal(exchange.finished, true)
    assert.ok(frames.some(frame => /** @type {any} */ (frame).op === 'cancel'))
    assert.ok(!frames.some(frame => /** @type {any} */ (frame).op === 'end'))
  } finally {
    sender.reset()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// @ref LLP 0474#recording [tests]: a raw IPC receipt must identify the processor generation, with one cancellable waiter and no restart revival
test('recording IPC rejects unavailable, mismatched and lost acknowledgments with bounded cleanup', async t => {
  const { sender, child, frames } = fixture()
  await assert.rejects(sender.refreshRecording(false, 'gateway:1', new AbortController().signal), /processor_unavailable/)
  sender.message({ type: 'gateway.capture_ready' })
  const controller = new AbortController()
  const first = sender.refreshRecording(false, 'gateway:1', controller.signal)
  const control = /** @type {any} */ (frames.at(-1))
  assert.equal(sender.snapshot().recording_waiters, 1)
  await assert.rejects(sender.refreshRecording(false, 'gateway:2', controller.signal), /processor_unavailable/)
  sender.message({ type: 'gateway.recording_ack', id: control.id, ok: true, result: { recording: false, generation: 'old:0' } })
  await assert.rejects(first, /recording_barrier_unconfirmed/)
  assert.equal(sender.snapshot().recording_waiters, 0)
  assert.equal(/** @type {any} */ (frames.at(-1)).type, 'gateway.recording_cancel')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const lost = sender.refreshRecording(false, 'gateway:2', controller.signal)
  const rejected = assert.rejects(lost, /recording_barrier_unconfirmed/)
  t.mock.timers.tick(10_000)
  await rejected
  assert.equal(sender.snapshot().recording_waiters, 0)
  const disconnected = sender.refreshRecording(false, 'gateway:3', controller.signal)
  sender.reset()
  await assert.rejects(disconnected, /processor_unavailable/)
  assert.equal(sender.snapshot().recording_waiters, 0)
  sender.message({ type: 'gateway.capture_ready' })
  const aborted = sender.refreshRecording(false, 'gateway:4', controller.signal)
  controller.abort()
  await assert.rejects(aborted, /recording_barrier_unconfirmed/)
  assert.equal(sender.snapshot().recording_waiters, 0)
  // A late success cannot acknowledge a subsequent operation.
  const next = sender.refreshRecording(true, 'gateway:5', new AbortController().signal)
  sender.message({ type: 'gateway.recording_ack', id: control.id, ok: true, result: { recording: false, generation: 'gateway:1' } })
  assert.equal(sender.snapshot().recording_waiters, 1)
  const current = /** @type {any} */ (frames.at(-1))
  sender.message({ type: 'gateway.recording_ack', id: current.id, ok: true, result: { recording: true, generation: 'gateway:5' } })
  assert.deepEqual(await next, { recording: true, generation: 'gateway:5' })
  assert.equal(sender.snapshot().recording_waiters, 0)
  assert.ok(child.connected)
})

test('processor control cancels on shutdown and refuses malformed or concurrent generations', async () => {
  /** @type {any[]} */
  const replies = []
  let aborted = false
  const receiver = createCaptureReceiver({
    send: frame => replies.push(frame), async onExchange() {},
    refreshRecording: (_recording, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })
    }),
  })
  receiver.message({ type: 'gateway.recording_refresh', id: 1, recording: false, generation: '' })
  assert.equal(replies.at(-1).ok, false)
  receiver.message({ type: 'gateway.recording_refresh', id: 2, recording: false, generation: 'gateway:1' })
  receiver.message({ type: 'gateway.recording_refresh', id: 3, recording: false, generation: 'gateway:2' })
  assert.equal(replies.at(-1).id, 3)
  assert.equal(replies.at(-1).ok, false)
  await receiver.close()
  await Promise.resolve()
  assert.equal(aborted, true)
  assert.ok(!replies.some(reply => reply.id === 2 && reply.ok))
})

test('IPC disconnect race during cancellation cannot throw into forwarding or leave a waiter', async t => {
  const { sender, child, init } = fixture()
  /** @type {string[]} */
  const outcomes = []
  sender.observeCapture((_route, reason) => outcomes.push(reason))
  sender.message({ type: 'gateway.capture_ready' })
  const controller = new AbortController()
  const pending = sender.refreshRecording(false, 'gateway:1', controller.signal)
  t.mock.method(child, 'send', () => { throw new Error('SECRET closed channel') })
  controller.abort()
  await assert.rejects(pending, /recording_barrier_unconfirmed/)
  assert.equal(sender.snapshot().recording_waiters, 0)
  Object.defineProperty(child, 'connected', { value: false })
  sender.recorder.startExchange(init)
  assert.deepEqual(outcomes, ['processor_unavailable'])
})
