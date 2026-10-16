// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { createRecorder } from '../../hypaware-core/plugins-workspace/ai-gateway/src/recorder.js'

// The daemon incident this guards against: the recorder retained every
// finished exchange in its `active` set for the life of the listener, so
// a busy gateway grew by the full size of every proxied body until it
// wedged in GC thrash (~4.8 GB RSS observed). Finished exchanges must
// leave the set; only truly in-flight exchanges may be retained.

function startExchange(recorder) {
  return recorder.startExchange({
    upstream: 'test',
    provider: 'test',
    method: 'POST',
    path: '/v1/messages',
    requestHeaders: {},
  })
}

test('a finalized exchange leaves the recorder active set', async () => {
  const recorder = createRecorder()
  const exchange = startExchange(recorder)
  assert.equal(recorder.inflightCount(), 1, 'in-flight exchange is tracked')

  exchange.appendRequestChunk(Buffer.from('{"model":"m"}'))
  exchange.setResponseStart({ status: 200, headers: {} })
  exchange.appendResponseChunk(Buffer.from('{"id":"msg_1"}'))
  exchange.finalize()

  // Removal rides the finished signal (a microtask after finalize).
  await exchange.finishedSignal
  await Promise.resolve()
  assert.equal(recorder.inflightCount(), 0, 'finished exchange is no longer retained')
})

test('drain force-finish also empties the active set', async () => {
  const recorder = createRecorder()
  const exchange = startExchange(recorder)
  exchange.appendRequestChunk(Buffer.from('{"model":"m"}'))
  // Never finalized by the proxy: drain must force-finish it.
  await recorder.drain(10)
  await exchange.finishedSignal
  await Promise.resolve()
  assert.equal(recorder.inflightCount(), 0, 'force-finished exchange is no longer retained')
})

test('finalize releases the raw chunk buffers while the row keeps the decoded bodies', () => {
  const recorder = createRecorder()
  const exchange = startExchange(recorder)
  const requestBody = '{"model":"m","messages":[]}'
  const responseBody = '{"id":"msg_1"}'
  exchange.appendRequestChunk(Buffer.from(requestBody))
  exchange.setResponseStart({ status: 200, headers: {} })
  exchange.appendResponseChunk(Buffer.from(responseBody))

  const row = exchange.finalize()
  assert.equal(row.request_body, requestBody)
  assert.equal(row.response_body, responseBody)
  assert.equal(exchange.requestChunks.length, 0, 'request chunk buffers are released at finalize')
  assert.equal(exchange.responseChunks.length, 0, 'response chunk buffers are released at finalize')

  // finalize stays idempotent after the buffers are dropped.
  const again = exchange.finalize()
  assert.equal(again, row, 'repeat finalize returns the cached row')
})
