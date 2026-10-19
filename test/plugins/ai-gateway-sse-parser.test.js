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

test('a lone CR ends a line, and two of them end a block', () => {
  assert.deepEqual(feedWhole('data: 1\r\r'), [{ event: 'message', data: '1' }])
  assert.deepEqual(feedWhole('data: 1\rdata: 2\n\n'), [{ event: 'message', data: '1\n2' }])
  assert.deepEqual(feedWhole('event: a\rdata: 1\r\rdata: 2\r\r').map((e) => [e.event, e.data]), [
    ['a', '1'],
    ['message', '2'],
  ])
})

test('a terminator split across a feed boundary after a long partial block dispatches once', () => {
  // The resume offset is the risk here: the next feed starts its search 3
  // chars before the old end, so every terminator must still be seen when
  // the boundary falls inside it, and none may be seen twice.
  for (const term of ['\n\n', '\r\r', '\r\n\r\n']) {
    const body = `data: ${'x'.repeat(40)}${term}data: 2${term}`
    const whole = feedWhole(body)
    assert.equal(whole.length, 2)
    for (let cut = 1; cut < body.length; cut++) {
      const parser = new SseParser()
      const got = []
      for (const piece of [body.slice(0, cut), body.slice(cut)]) {
        got.push(...parser.feed(piece))
        assert.ok(
          parser.scanFrom >= 0 && parser.scanFrom <= parser.buffer.length,
          `scanFrom ${parser.scanFrom} outside a ${parser.buffer.length} char buffer`,
        )
      }
      assert.deepEqual(got, whole, JSON.stringify({ term, cut }))
      // Everything was consumed, so the next search starts at the front.
      assert.equal(parser.buffer, '')
      assert.equal(parser.scanFrom, 0)
    }
  }
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
 * it: the LF and CR walks in `findSeparator` and the field split in
 * `parseBlock`.
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
  // One pass per walk: the LF walk covers the body, and the CR walk finds no
  // CR and covers it once more, so about 2x.
  assert.ok(
    scanned < body.length * 3,
    `scanned ${scanned} chars of a ${body.length} char body; one pass per walk is about 2x, the two-probe search about 10000x`,
  )
})

test('a newline-dense stream with no blank line is scanned once across chunks', () => {
  // No terminator ever arrives, so the whole stream stays buffered. Resuming
  // each feed's search from 0 walked that buffer again per chunk: 64 chunks
  // here cost about 33x the body. The persistent offset holds it to one pass
  // per walk, whichever line ending the stream uses.
  for (const eol of ['\n', '\r']) {
    const body = `data: x${eol}`.repeat(32768)
    const parser = new SseParser()
    const scanned = scannedChars(() => {
      for (let i = 0; i < body.length; i += 4096) assert.deepEqual(parser.feed(body.slice(i, i + 4096)), [])
    })
    assert.equal(parser.buffer, body)
    assert.ok(
      scanned < body.length * 3,
      `${JSON.stringify(eol)} stream: scanned ${scanned} chars of a ${body.length} char body`,
    )
  }
})

test('a feed reassigns the buffer a bounded number of times, not once per event', () => {
  // The scan guard above counts characters walked, so it cannot see a
  // return to slicing the buffer after every event: that keeps the scan
  // linear and copies the remainder per event. Count the assignments: one
  // append and one final slice.
  const parser = new SseParser()
  let value = parser.buffer
  let sets = 0
  Object.defineProperty(parser, 'buffer', {
    get: () => value,
    set: (v) => {
      value = v
      sets++
    },
  })
  assert.equal(parser.feed(sseBody(200)).length, 200)
  assert.ok(sets <= 2, `buffer reassigned ${sets} times for 200 events`)
})

/**
 * The terminator search the walk replaced, one probe per terminator over the
 * whole remaining buffer, with the earliest start winning. Kept here as the
 * oracle for the parity check.
 * @param {string} buf
 * @returns {{ idx: number, len: number } | -1}
 */
function findSeparatorOriginal(buf) {
  /** @type {{ idx: number, len: number } | -1} */
  let best = -1
  for (const term of ['\n\n', '\r\r', '\r\n\r\n']) {
    const idx = buf.indexOf(term)
    if (idx !== -1 && (best === -1 || idx < best.idx)) best = { idx, len: term.length }
  }
  return best
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

test('chunked feeds consume the same bytes the probe scan consumed', () => {
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

test('the single-pass scan splits blocks exactly where the probe scan did', () => {
  // The parity that matters is the split *point*, not the byte count: an
  // off-by-one in the CRLF branch (`{ idx: cr + 1, len: 3 }`) consumes exactly as
  // many bytes and leaves the same remainder, yet hands `parseBlock` a block
  // with a stray \r glued to its first field name. So compare the returned
  // offset and length directly, and do it exhaustively rather than randomly:
  // every string over {CR, LF, text} up to length 8, at every resume offset.
  // That covers the overlaps the three terminators can form - \r\n\n,
  // \n\r\n, \r\r\n, \r\n\r\r, \n\n\r\n - and a trailing \r with no room
  // to complete.
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
      // must still find every terminator rather than report none.
      if (from === 0) assert.deepEqual(findSeparator(buf), want, JSON.stringify({ buf }))
      checked++
    }
    if (buf.length === 8) return
    for (const c of alphabet) walk(buf + c)
  }
  walk('')
  assert.ok(checked > 80000, `only ${checked} split points compared`)
})
