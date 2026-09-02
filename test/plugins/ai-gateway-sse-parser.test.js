// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { SseParser } from '../../hypaware-core/plugins-workspace/ai-gateway/src/sse.js'

/** @param {string} text */
function feedWhole(text) {
  return new SseParser().feed(text)
}

/**
 * Feed `text` in fixed-size pieces, the way a live response arrives, and
 * collect everything that dispatches.
 * @param {string} text
 * @param {number} size
 */
function feedChunked(text, size) {
  const parser = new SseParser()
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(...parser.feed(text.slice(i, i + size)))
  return out
}

test('LF-terminated blocks dispatch in order with event, data, and id', () => {
  const body = 'event: a\ndata: 1\n\nid: 7\ndata: 2\ndata: 3\n\n: comment only\n\ndata: 4\n\n'
  assert.deepEqual(feedWhole(body), [
    { event: 'a', data: '1' },
    { event: 'message', data: '2\n3', id: '7' },
    { event: 'message', data: '4' },
  ])
})

test('CRLF-terminated blocks parse identically to LF ones', () => {
  const lf = 'event: a\ndata: 1\n\ndata: 2\n\n'
  const crlf = lf.replace(/\n/g, '\r\n')
  assert.deepEqual(feedWhole(crlf), feedWhole(lf))
})

test('a stream that mixes terminators picks the earliest one each time', () => {
  const body = 'data: 1\r\n\r\ndata: 2\n\ndata: 3\r\n\r\ndata: 4\n\n'
  assert.deepEqual(feedWhole(body).map((e) => e.data), ['1', '2', '3', '4'])
})

test('a terminator split across chunks still dispatches once, and only once', () => {
  const body = 'data: 1\r\n\r\ndata: 2\n\ndata: 3\n\n'
  const whole = feedWhole(body)
  for (const size of [1, 2, 3, 5, 7, 11]) {
    assert.deepEqual(feedChunked(body, size), whole, `chunk size ${size}`)
  }
})

test('a partial trailing block stays buffered until its terminator arrives', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.feed('data: 1\n\ndata: 2\r'), [{ event: 'message', data: '1' }])
  assert.deepEqual(parser.feed('\n\r'), [])
  assert.deepEqual(parser.feed('\n'), [{ event: 'message', data: '2' }])
  assert.equal(parser.buffer, '')
})

test('a whole-body feed of many events costs linear time', () => {
  // The deferred path (compressed or header-blind SSE) feeds the entire
  // decoded body in one call. Before the single-pass scan this was
  // O(events x bytes): 20,000 events over 4 MB took about 700 ms.
  const delta = 'x'.repeat(100)
  let body = ''
  for (let i = 0; i < 20000; i++) body += `event: delta\ndata: {"i":${i},"d":"${delta}"}\n\n`
  const started = process.hrtime.bigint()
  const events = feedWhole(body)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(events.length, 20000)
  assert.ok(elapsedMs < 200, `whole-body feed took ${elapsedMs.toFixed(0)} ms`)
})

/**
 * The terminator search this replaced: two probes per event, each over the
 * whole remaining buffer. Kept here as the oracle for the parity check.
 * @param {string} buf
 * @returns {{ idx: number, len: number } | -1}
 */
function findSeparatorOriginal(buf) {
  const a = buf.indexOf('\n\n')
  const b = buf.indexOf('\r\n\r\n')
  if (a === -1 && b === -1) return -1
  if (a === -1) return { idx: b, len: 4 }
  if (b === -1) return { idx: a, len: 2 }
  if (a < b) return { idx: a, len: 2 }
  return { idx: b, len: 4 }
}

/** @param {string} text */
function blocksOriginal(text) {
  const out = []
  let buf = text
  while (true) {
    const sep = findSeparatorOriginal(buf)
    if (sep === -1) break
    out.push(buf.slice(0, sep.idx))
    buf = buf.slice(sep.idx + sep.len)
  }
  return { blocks: out, rest: buf }
}

test('the single-pass scan splits blocks exactly where the two-probe scan did', () => {
  // Random soups of the bytes that matter (CR, LF, text), whole and chunked.
  // Parity is on the split, so the oracle compares raw blocks, not parsed
  // events; a block that is only CRs or empty is still a block to both.
  let seed = 12345
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const alphabet = ['\r', '\n', '\n', 'd', 'a', 't', ':', ' ', '1']
  for (let round = 0; round < 3000; round++) {
    let text = ''
    const len = 1 + Math.floor(rand() * 24)
    for (let i = 0; i < len; i++) text += alphabet[Math.floor(rand() * alphabet.length)]
    const size = 1 + Math.floor(rand() * 6)
    // Drive the oracle with the same chunking and record how many bytes each
    // feed consumed; the split positions are identical iff these agree.
    const expected = []
    let oracleBuf = ''
    const got = []
    const parser = new SseParser()
    for (let i = 0; i < text.length; i += size) {
      const piece = text.slice(i, i + size)
      oracleBuf += piece
      const beforeLen = oracleBuf.length
      oracleBuf = blocksOriginal(oracleBuf).rest
      expected.push(beforeLen - oracleBuf.length)
      const before = parser.buffer.length + piece.length
      parser.feed(piece)
      got.push(before - parser.buffer.length)
    }
    assert.deepEqual(got, expected, JSON.stringify({ text, size }))
    assert.equal(parser.buffer, oracleBuf, JSON.stringify({ text, size }))
  }
})
