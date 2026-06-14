// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'
import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from 'node:zlib'

import { createRecorder } from '../../hypaware-core/plugins-workspace/ai-gateway/src/recorder.js'

/**
 * @param {{ responseHeaders?: Record<string, string | string[]>, responseBody?: Buffer, requestHeaders?: Record<string, string>, requestBody?: Buffer, redactHeaders?: string[] }} opts
 */
function finishExchange(opts) {
  const recorder = createRecorder({ redactHeaders: opts.redactHeaders })
  const exchange = recorder.startExchange({
    upstream: 'test',
    provider: 'test',
    method: 'POST',
    path: '/v1/messages',
    requestHeaders: opts.requestHeaders ?? {},
  })
  if (opts.requestBody) exchange.appendRequestChunk(opts.requestBody)
  exchange.setResponseStart({ status: 200, headers: opts.responseHeaders ?? {} })
  if (opts.responseBody) exchange.appendResponseChunk(opts.responseBody)
  return exchange.finalize()
}

const payload = JSON.stringify({ id: 'msg_1', content: [{ type: 'text', text: 'hello' }] })

test('decodes a gzip-encoded response body', () => {
  const row = finishExchange({
    responseHeaders: { 'content-encoding': 'gzip' },
    responseBody: gzipSync(Buffer.from(payload)),
  })
  assert.equal(row.response_body, payload)
})

test('decodes a brotli-encoded response body', () => {
  const row = finishExchange({
    responseHeaders: { 'content-encoding': 'br' },
    responseBody: brotliCompressSync(Buffer.from(payload)),
  })
  assert.equal(row.response_body, payload)
})

test('decodes a deflate-encoded response body (zlib and raw)', () => {
  const zlib = finishExchange({
    responseHeaders: { 'content-encoding': 'deflate' },
    responseBody: deflateSync(Buffer.from(payload)),
  })
  assert.equal(zlib.response_body, payload)

  const raw = finishExchange({
    responseHeaders: { 'content-encoding': 'deflate' },
    responseBody: deflateRawSync(Buffer.from(payload)),
  })
  assert.equal(raw.response_body, payload)
})

test('passes through an identity / unencoded response body unchanged', () => {
  const identity = finishExchange({
    responseHeaders: { 'content-encoding': 'identity' },
    responseBody: Buffer.from(payload),
  })
  assert.equal(identity.response_body, payload)

  const none = finishExchange({ responseBody: Buffer.from(payload) })
  assert.equal(none.response_body, payload)
})

test('decodes a gzip-encoded request body', () => {
  const row = finishExchange({
    requestHeaders: { 'content-encoding': 'gzip' },
    requestBody: gzipSync(Buffer.from(payload)),
  })
  assert.equal(row.request_body, payload)
})

test('handles content-encoding header case-insensitively', () => {
  const row = finishExchange({
    responseHeaders: { 'Content-Encoding': 'GZIP' },
    responseBody: gzipSync(Buffer.from(payload)),
  })
  assert.equal(row.response_body, payload)
})

test('decodes the body even when content-encoding is a redacted header', () => {
  // The raw upstream encoding is captured before redaction, so decoding
  // still works when an operator adds content-encoding to redactHeaders.
  const row = finishExchange({
    redactHeaders: ['content-encoding'],
    responseHeaders: { 'content-encoding': 'gzip' },
    responseBody: gzipSync(Buffer.from(payload)),
  })
  assert.equal(row.response_body, payload)
  // The stored header is still redacted in the row.
  const headers = JSON.parse(/** @type {string} */ (row.response_headers))
  assert.match(headers['content-encoding'], /^REDACTED:/)
})

test('falls back to raw bytes when the encoding is unknown', () => {
  const row = finishExchange({
    responseHeaders: { 'content-encoding': 'snappy' },
    responseBody: Buffer.from(payload),
  })
  assert.equal(row.response_body, payload)
})

test('falls back to raw bytes when a gzip body is corrupt', () => {
  const corrupt = Buffer.from('not actually gzip')
  const row = finishExchange({
    responseHeaders: { 'content-encoding': 'gzip' },
    responseBody: corrupt,
  })
  assert.equal(row.response_body, corrupt.toString('utf8'))
})

test('parses SSE events from a gzip-encoded stream at finalize', () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s1","role":"assistant"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('')
  const compressed = gzipSync(Buffer.from(sse))

  const recorder = createRecorder({})
  const exchange = recorder.startExchange({
    upstream: 'test',
    provider: 'test',
    method: 'POST',
    path: '/v1/messages',
    requestHeaders: {},
  })
  exchange.setResponseStart({
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
  })
  // Split mid-gzip-frame: compressed chunks are NOT independently
  // decodable, which is exactly why parsing must defer to finalize.
  exchange.consumeStreamChunk(compressed.subarray(0, 20))
  exchange.consumeStreamChunk(compressed.subarray(20))
  const row = exchange.finalize()

  assert.equal(row.is_sse, true)
  assert.equal(row.stream_event_count, 4)
  assert.equal(row.stream_events.length, 4)
  assert.equal(row.stream_events[0].event, 'message_start')
  assert.equal(row.stream_events[3].event, 'message_stop')
  assert.equal(row.response_bytes, compressed.byteLength, 'response_bytes counts wire (compressed) bytes')
})

test('uncompressed SSE streams still parse incrementally per chunk', () => {
  const recorder = createRecorder({})
  const exchange = recorder.startExchange({
    upstream: 'test',
    provider: 'test',
    method: 'POST',
    path: '/v1/messages',
    requestHeaders: {},
  })
  exchange.setResponseStart({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
  exchange.consumeStreamChunk(Buffer.from('event: message_start\ndata: {"type":"message_start"}\n\n'))
  exchange.consumeStreamChunk(Buffer.from('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
  const row = exchange.finalize()
  assert.equal(row.stream_event_count, 2)
  assert.equal(row.stream_events[1].event, 'message_stop')
})

test('header-blind SSE: a stream with no content-type is sniffed and parsed', () => {
  // ChatGPT's codex endpoint streams SSE but sends no content-type
  // header, so isSseHeaders() can't flag it. The body sniff must.
  const sse = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"the answer"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","id":"resp_1","status":"completed"}\n\n',
  ].join('')
  const recorder = createRecorder({})
  const exchange = recorder.startExchange({
    upstream: 'chatgpt', provider: 'chatgpt', method: 'POST',
    path: '/backend-api/codex/responses', requestHeaders: {},
  })
  // No content-type at all (only the codex-style headers).
  exchange.setResponseStart({ status: 200, headers: { 'transfer-encoding': 'chunked' } })
  exchange.appendResponseChunk(Buffer.from(sse.slice(0, 30)))
  exchange.appendResponseChunk(Buffer.from(sse.slice(30)))
  const row = exchange.finalize()

  assert.equal(row.is_sse, true, 'body-sniff promotes a header-less SSE stream to SSE')
  assert.equal(row.stream_event_count, 2)
  assert.equal(row.stream_events[0].event, 'response.output_text.delta')
  assert.equal(row.response_body, null, 'SSE rows store events, not a raw body')
})

test('a JSON response with no content-type stays non-SSE (no false sniff)', () => {
  const json = JSON.stringify({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }] })
  const recorder = createRecorder({})
  const exchange = recorder.startExchange({
    upstream: 'chatgpt', provider: 'chatgpt', method: 'POST',
    path: '/backend-api/codex/responses', requestHeaders: {},
  })
  exchange.setResponseStart({ status: 200, headers: {} })
  exchange.appendResponseChunk(Buffer.from(json))
  const row = exchange.finalize()

  assert.equal(row.is_sse, false, 'a JSON body must not be mistaken for SSE')
  assert.equal(row.response_body, json)
})
