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
