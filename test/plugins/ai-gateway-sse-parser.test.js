// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { SseParser, findSeparator } from '../../hypaware-core/plugins-workspace/ai-gateway/src/sse.js'

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

/**
 * An SSE body of `count` small delta events, the shape a provider streams.
 * @param {number} count
 */
function sseBody(count) {
  const delta = 'x'.repeat(100)
  let body = ''
  for (let i = 0; i < count; i++) body += `event: delta\ndata: {"i":${i},"d":"${delta}"}\n\n`
  return body
}

/**
 * Characters `run` walks past, counted by wrapping `String.prototype.indexOf`
 * for the duration of the call. Every scan the parser performs goes through
 * it: the newline walk in `findSeparator` and the field split in `parseBlock`.
 * The wrapper is restored even if `run` throws.
 *
 * @param {() => void} run
 * @returns {number}
 */
function scannedChars(run) {
  const real = String.prototype.indexOf
  let scanned = 0
  String.prototype.indexOf = function (needle, from) {
    const at = real.call(this, needle, from)
    scanned += (at === -1 ? this.length : at) - (from ?? 0)
    return at
  }
  try {
    run()
  } finally {
    String.prototype.indexOf = real
  }
  return scanned
}

test('a whole-body feed scans the body once, not once per event', () => {
  // The deferred path (compressed or header-blind SSE) feeds the entire
  // decoded body in one call. The two-probe search this replaced re-scanned
  // the whole remainder for `\r\n\r\n` on every event, so this body cost
  // about 27 billion character steps against its own 2.7 million.
  //
  // Count the steps rather than the milliseconds. The count is identical on
  // every machine and every run, where a wall-clock bound measures the runner
  // as much as the parser: `npm test` hands all 461 files to `node --test`,
  // which runs them in parallel, so on a 2-core CI box this body's parse is
  // competing with the rest of the suite. A timing ratio measured under that
  // contention overlaps the quadratic signature it is supposed to catch, and
  // cannot tell a regression from a busy runner.
  const body = sseBody(20000)
  let events = []
  const scanned = scannedChars(() => {
    events = new SseParser().feed(body)
  })
  assert.equal(events.length, 20000)
  assert.ok(
    scanned < body.length * 2,
    `scanned ${scanned} chars of a ${body.length} char body; one pass is about 1x, the two-probe search about 10000x`,
  )
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

test('chunked feeds consume the same bytes the two-probe scan consumed', () => {
  // Random soups of the bytes that matter (CR, LF, text), whole and chunked.
  // Parity is on the split, so the oracle compares raw blocks, not parsed
  // events; a block that is only CRs or empty is still a block to both.
  let seed = 12345
  // Math.imul keeps the multiply exact. A plain `*` overflows the 53-bit
  // mantissa, which drops the generator into a short cycle (it repeats after
  // about 6,000 draws) and quietly re-tests inputs it has already seen.
  const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff
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

test('the single-pass scan splits blocks exactly where the two-probe scan did', () => {
  // The parity that matters is the split *point*, not the byte count: an
  // off-by-one in the CRLF branch (`{ idx: i, len: 3 }`) consumes exactly as
  // many bytes and leaves the same remainder, yet hands `parseBlock` a block
  // with a stray \r glued to its first field name. So compare the returned
  // offset and length directly, and do it exhaustively rather than randomly:
  // every string over {CR, LF, text} up to length 8, at every resume offset.
  // That covers the overlaps the two terminators can form - \r\n\n, \n\r\n,
  // \r\r\n\n, \n\n\r\n - and a trailing \r with no room to complete.
  const alphabet = ['\r', '\n', 'x']
  let checked = 0
  /** @param {string} buf */
  function walk(buf) {
    for (let from = 0; from <= buf.length; from++) {
      // The old search always ran from the front of a freshly sliced buffer,
      // so the oracle for a resume at `from` is that search over the tail.
      const tail = findSeparatorOriginal(buf.slice(from))
      const want = tail === -1 ? -1 : { idx: tail.idx + from, len: tail.len }
      assert.deepEqual(findSeparator(buf, from), want, JSON.stringify({ buf, from }))
      // `from` defaults to 0, so the one-argument call the old signature took
      // must still find CRLF terminators rather than report none.
      if (from === 0) assert.deepEqual(findSeparator(buf), want, JSON.stringify({ buf }))
      checked++
    }
    if (buf.length === 8) return
    for (const c of alphabet) walk(buf + c)
  }
  walk('')
  assert.ok(checked > 80000, `only ${checked} split points compared`)
})
