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
 * @import { SseEvent } from './types.d.ts'
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
    while (true) {
      const sep = findSeparator(this.buffer)
      if (sep === -1) break
      const block = this.buffer.slice(0, sep.idx)
      this.buffer = this.buffer.slice(sep.idx + sep.len)
      const ev = parseBlock(block)
      if (ev) events.push(ev)
    }
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
 * Find the next event-block terminator (`\n\n` or `\r\n\r\n`) and
 * return its offset plus the terminator length so callers can advance
 * past it.
 *
 * @param {string} buf
 * @returns {{ idx: number, len: number } | -1}
 */
function findSeparator(buf) {
  const a = buf.indexOf('\n\n')
  const b = buf.indexOf('\r\n\r\n')
  if (a === -1 && b === -1) return -1
  if (a === -1) return { idx: b, len: 4 }
  if (b === -1) return { idx: a, len: 2 }
  if (a < b) return { idx: a, len: 2 }
  return { idx: b, len: 4 }
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
