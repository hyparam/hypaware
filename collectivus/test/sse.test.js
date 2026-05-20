import { describe, expect, it } from 'vitest'
import { SseParser, isSseHeaders } from '../src/sse.js'

describe('SseParser — single-chunk dispatch', () => {
  it('parses a basic event/data pair', () => {
    const p = new SseParser()
    const events = p.feed('event: ping\ndata: hello\n\n')
    expect(events).toEqual([{ event: 'ping', data: 'hello' }])
  })

  it('defaults the event type to "message" when no event field is present', () => {
    const p = new SseParser()
    const events = p.feed('data: just-data\n\n')
    expect(events).toEqual([{ event: 'message', data: 'just-data' }])
  })

  it('emits multiple events from a single chunk', () => {
    const p = new SseParser()
    const events = p.feed(
      'event: a\ndata: 1\n\n' +
      'event: b\ndata: 2\n\n' +
      'event: c\ndata: 3\n\n'
    )
    expect(events).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
      { event: 'c', data: '3' },
    ])
  })

  it('joins multiple data lines with \\n', () => {
    const p = new SseParser()
    const events = p.feed('event: multiline\ndata: one\ndata: two\ndata: three\n\n')
    expect(events).toEqual([{ event: 'multiline', data: 'one\ntwo\nthree' }])
  })

  it('strips at most one space after the field colon (per WHATWG eventsource)', () => {
    const p = new SseParser()
    const events = p.feed('event:nospace\ndata:  two-spaces\n\n')
    // First space stripped; second space preserved as part of the value.
    expect(events).toEqual([{ event: 'nospace', data: ' two-spaces' }])
  })

  it('treats a colon-less line as a field name with empty value', () => {
    const p = new SseParser()
    const events = p.feed('data\n\n')
    expect(events).toEqual([{ event: 'message', data: '' }])
  })
})

describe('SseParser — partial chunks across packet boundaries', () => {
  it('reassembles an event split across two chunks', () => {
    const p = new SseParser()
    expect(p.feed('event: split\ndata: par')).toEqual([])
    expect(p.feed('t-1\n\n')).toEqual([{ event: 'split', data: 'part-1' }])
  })

  it('reassembles an event split across three chunks', () => {
    const p = new SseParser()
    expect(p.feed('event: deltas\nda')).toEqual([])
    expect(p.feed('ta: chunk-1\nda')).toEqual([])
    expect(p.feed('ta: chunk-2\n\n')).toEqual([
      { event: 'deltas', data: 'chunk-1\nchunk-2' },
    ])
  })

  it('emits the first event when a chunk straddles a separator', () => {
    const p = new SseParser()
    expect(p.feed('event: a\ndata: 1\n\nevent: b\nda')).toEqual([
      { event: 'a', data: '1' },
    ])
    expect(p.feed('ta: 2\n\n')).toEqual([{ event: 'b', data: '2' }])
  })

  it('handles the separator itself arriving in pieces', () => {
    const p = new SseParser()
    expect(p.feed('event: x\ndata: y\n')).toEqual([])
    expect(p.feed('\n')).toEqual([{ event: 'x', data: 'y' }])
  })

  it('accepts Buffer input as well as string input', () => {
    const p = new SseParser()
    const events = p.feed(Buffer.from('event: bin\ndata: bytes\n\n', 'utf8'))
    expect(events).toEqual([{ event: 'bin', data: 'bytes' }])
  })

  it('preserves utf-8 multi-byte characters that span chunk boundaries', () => {
    const p = new SseParser()
    // Feed pre-decoded strings so the surrogate-pair / multi-byte concern is
    // about the parser concatenating across chunks, not about decoding bytes.
    expect(p.feed('event: emoji\ndata: hello ')).toEqual([])
    expect(p.feed('🚀 world\n\n')).toEqual([
      { event: 'emoji', data: 'hello 🚀 world' },
    ])
  })

  it('preserves utf-8 multi-byte characters split across Buffer chunks', () => {
    const p = new SseParser()
    const payload = 'event: emoji\ndata: hello 🚀 world\n\n'
    const bytes = Buffer.from(payload, 'utf8')
    const emojiStart = bytes.indexOf(Buffer.from('🚀', 'utf8'))
    expect(p.feed(bytes.subarray(0, emojiStart + 1))).toEqual([])
    expect(p.feed(bytes.subarray(emojiStart + 1))).toEqual([
      { event: 'emoji', data: 'hello 🚀 world' },
    ])
  })
})

describe('SseParser — separators and line endings', () => {
  it('parses CRLF separators alongside LF', () => {
    const p = new SseParser()
    const events = p.feed(
      'event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n'
    )
    expect(events).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ])
  })

  it('mixes LF and CRLF terminators within one stream', () => {
    const p = new SseParser()
    const events = p.feed(
      'event: lf\ndata: 1\n\nevent: crlf\r\ndata: 2\r\n\r\n'
    )
    expect(events).toEqual([
      { event: 'lf', data: '1' },
      { event: 'crlf', data: '2' },
    ])
  })
})

describe('SseParser — comment lines and empty blocks', () => {
  it('ignores comment lines (those starting with ":")', () => {
    const p = new SseParser()
    const events = p.feed(
      ': heartbeat\n: another comment\nevent: real\ndata: payload\n\n'
    )
    expect(events).toEqual([{ event: 'real', data: 'payload' }])
  })

  it('does not emit a row for a comment-only block', () => {
    const p = new SseParser()
    const events = p.feed(': heartbeat\n\n: keepalive\n\n')
    expect(events).toEqual([])
  })

  it('does not emit a row for a fully empty block (just blank lines)', () => {
    const p = new SseParser()
    const events = p.feed('\n\n')
    expect(events).toEqual([])
  })
})

describe('SseParser — id and retry fields', () => {
  it('recognises id-only events as dispatchable with default event/data', () => {
    const p = new SseParser()
    const events = p.feed('id: 42\n\n')
    expect(events).toEqual([{ event: 'message', data: '', id: '42' }])
  })

  it('round-trips the id field on the dispatched event', () => {
    const p = new SseParser()
    const events = p.feed('id: abc-1\nevent: lifecycle\ndata: {"k":"v"}\n\n')
    expect(events).toEqual([{ event: 'lifecycle', data: '{"k":"v"}', id: 'abc-1' }])
  })

  it('omits the id field when the block has no id line', () => {
    const p = new SseParser()
    const events = p.feed('event: ping\ndata: x\n\n')
    expect(events).toEqual([{ event: 'ping', data: 'x' }])
  })

  it('treats an empty id value as a present-but-empty id (per WHATWG)', () => {
    const p = new SseParser()
    const events = p.feed('id: \nevent: x\ndata: y\n\n')
    expect(events).toEqual([{ event: 'x', data: 'y', id: '' }])
  })

  it('does not let unknown fields confuse the parser', () => {
    const p = new SseParser()
    const events = p.feed('event: keep\ndata: yes\nunknown: ignored\n\n')
    expect(events).toEqual([{ event: 'keep', data: 'yes' }])
  })
})

describe('SseParser — buffer state', () => {
  it('keeps trailing partial bytes in the buffer until terminated', () => {
    const p = new SseParser()
    expect(p.feed('event: pending\ndata: half')).toEqual([])
    expect(p.buffer).toBe('event: pending\ndata: half')
    expect(p.feed('-done\n\n')).toEqual([
      { event: 'pending', data: 'half-done' },
    ])
    expect(p.buffer).toBe('')
  })
})

describe('isSseHeaders', () => {
  it('recognises plain text/event-stream', () => {
    expect(isSseHeaders({ 'content-type': 'text/event-stream' })).toBe(true)
  })

  it('recognises text/event-stream with parameters and casing variants', () => {
    expect(isSseHeaders({ 'content-type': 'text/event-stream; charset=utf-8' })).toBe(true)
    expect(isSseHeaders({ 'Content-Type': 'TEXT/EVENT-STREAM' })).toBe(true)
    expect(isSseHeaders({ 'content-type': '  text/event-stream  ; charset=utf-8' })).toBe(true)
  })

  it('returns false for non-SSE content types and missing headers', () => {
    expect(isSseHeaders({ 'content-type': 'application/json' })).toBe(false)
    expect(isSseHeaders({})).toBe(false)
    expect(isSseHeaders({ 'content-type': undefined })).toBe(false)
  })

  it('uses the first array entry when content-type is array-valued', () => {
    expect(isSseHeaders({ 'content-type': ['text/event-stream', 'ignored'] })).toBe(true)
    expect(isSseHeaders({ 'content-type': ['application/json'] })).toBe(false)
  })
})
