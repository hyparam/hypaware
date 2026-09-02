// @ts-check

/**
 * Streaming Server-Sent Events parser. Hand-rolled per the WHATWG
 * eventsource grammar so the gateway can capture every event a
 * provider streams without depending on a runtime SSE library.
 *
 * Stateful and chunk-friendly: feed bytes as they arrive, get back
 * the events that became dispatchable on each call. Bytes from a
 * partial trailing event remain in the internal buffer until the
 * next chunk completes them.
 */

/**
 * @import { SseEvent } from './types.js'
 */

export class SseParser {
  constructor() {
    /** @type {string} */
    this.buffer = ''
    /** @type {TextDecoder} */
    this.decoder = new TextDecoder()
  }

  /**
   * Feed a chunk of the SSE byte stream. Returns the events that
   * completed within this chunk; partial trailing event bytes stay
   * buffered for the next call.
   *
   * @param {string | Buffer | Uint8Array} chunk
   * @returns {SseEvent[]}
   */
  feed(chunk) {
    if (typeof chunk === 'string') {
      this.buffer += this.decoder.decode() + chunk
    } else {
      this.buffer += this.decoder.decode(chunk, { stream: true })
    }
    /** @type {SseEvent[]} */
    const events = []
    // One forward pass per feed. Each terminator search resumes where the
    // last event ended, and the consumed prefix is dropped once at the end,
    // so a whole-body feed (the compressed and header-blind paths hand the
    // recorder the entire decoded stream in one call) costs O(bytes), not
    // O(events x bytes) as it did when every event re-scanned the remainder.
    let pos = 0
    while (true) {
      const sep = findSeparator(this.buffer, pos)
      if (sep === -1) break
      const block = this.buffer.slice(pos, sep.idx)
      pos = sep.idx + sep.len
      const ev = parseBlock(block)
      if (ev) events.push(ev)
    }
    if (pos > 0) this.buffer = this.buffer.slice(pos)
    return events
  }
}

/**
 * True when the response headers indicate `text/event-stream`. Matches
 * case-insensitively and tolerates trailing parameters (`; charset=...`).
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {boolean}
 */
export function isSseHeaders(headers) {
  const ct = headers['content-type'] ?? headers['Content-Type']
  const value = Array.isArray(ct) ? ct[0] : ct
  if (typeof value !== 'string') return false
  return value.toLowerCase().split(';')[0].trim() === 'text/event-stream'
}

/**
 * Find the next event-block terminator (`\n\n` or `\r\n\r\n`) at or after
 * `from` and return its offset plus the terminator length so callers can
 * advance past it.
 *
 * Walks newlines rather than probing for each terminator separately: the
 * `\r\n\r\n` probe almost never matches (providers send `\n\n`) and so
 * scanned to the end of the buffer on every call. Every terminator holds a
 * newline, so visiting newlines in order and testing the bytes around each
 * finds the earliest terminator start in one pass. The two cannot tie: a
 * `\r\n\r\n` starting at `b` has its first newline at `b + 1`, and `\n\n`
 * cannot start there because the byte after it is `\r`.
 *
 * @param {string} buf
 * @param {number} from
 * @returns {{ idx: number, len: number } | -1}
 */
function findSeparator(buf, from) {
  let i = buf.indexOf('\n', from)
  while (i !== -1) {
    if (buf.charCodeAt(i + 1) === 10) return { idx: i, len: 2 }
    if (
      i > from &&
      buf.charCodeAt(i - 1) === 13 &&
      buf.charCodeAt(i + 1) === 13 &&
      buf.charCodeAt(i + 2) === 10
    ) {
      return { idx: i - 1, len: 4 }
    }
    i = buf.indexOf('\n', i + 1)
  }
  return -1
}

/**
 * Parse a single event block. Multiple `data:` lines concatenate with
 * `\n`. Comment lines (`: ...`) are ignored. A block containing only
 * comments dispatches nothing.
 *
 * @param {string} block
 * @returns {SseEvent | undefined}
 */
function parseBlock(block) {
  let event = 'message'
  let data = ''
  /** @type {string | undefined} */
  let id
  let hasField = false
  const lines = block.split(/\r?\n/)
  for (const line of lines) {
    if (line.length === 0) continue
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') {
      event = value
      hasField = true
    } else if (field === 'data') {
      data = data.length === 0 ? value : `${data}\n${value}`
      hasField = true
    } else if (field === 'id') {
      id = value
      hasField = true
    } else if (field === 'retry') {
      hasField = true
    }
  }
  if (!hasField) return undefined
  /** @type {SseEvent} */
  const ev = { event, data }
  if (id !== undefined) ev.id = id
  return ev
}
