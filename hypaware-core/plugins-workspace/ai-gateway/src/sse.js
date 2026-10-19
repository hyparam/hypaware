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
    // Where the next feed's terminator search starts. The buffer holds no
    // terminator that starts before it, so a stream that never sends a blank
    // line is scanned once rather than from 0 again on every chunk. It stays
    // within the buffer and drops to 0 whenever the buffer is consumed.
    /** @type {number} */
    this.scanFrom = 0
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
    let from = this.scanFrom
    const next = { lf: -2, cr: -2 }
    while (true) {
      const sep = findSeparator(this.buffer, from, next)
      if (sep === -1) break
      const block = this.buffer.slice(pos, sep.idx)
      pos = sep.idx + sep.len
      from = pos
      const ev = parseBlock(block)
      if (ev) events.push(ev)
    }
    if (pos > 0) this.buffer = this.buffer.slice(pos)
    // The search reached the end without a terminator, so the only one the
    // next chunk can complete starts in the last 3 chars (the longest
    // terminator is 4) and runs into the new bytes.
    this.scanFrom = Math.max(0, this.buffer.length - 3)
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
 * Find the next event-block terminator (`\n\n`, `\r\r` or `\r\n\r\n`) at
 * or after `from` and return its offset plus the terminator length so
 * callers can advance past it.
 *
 * Walks line-ending characters rather than probing for each terminator
 * separately: a probe that almost never matches (providers send `\n\n`)
 * scans to the end of the buffer on every call. Every terminator starts
 * with a CR or an LF, so visiting those in order and testing the bytes
 * after each finds the earliest terminator start in one pass. Two cannot
 * tie: only `\n\n` starts with an LF, and the two that start with a CR
 * differ in their second byte.
 *
 * `next` caches the next LF and CR position across calls on the same
 * buffer, so a buffer with no CR (or no LF) is searched for it once per
 * feed rather than once per event. -1 means none to the end of `buf`; any
 * other value before `from` means unknown. A cache holds only for the
 * buffer string it was filled from, so `feed` makes a new one per call.
 *
 * Exported only so the parser tests can check every split point against a
 * probe-per-terminator search; `feed` is the sole runtime caller.
 *
 * @param {string} buf
 * @param {number} [from]
 * @param {{ lf: number, cr: number }} [next]
 * @returns {{ idx: number, len: number } | -1}
 */
export function findSeparator(buf, from = 0, next = { lf: -2, cr: -2 }) {
  let lf = next.lf !== -1 && next.lf < from ? buf.indexOf('\n', from) : next.lf
  let cr = next.cr !== -1 && next.cr < from ? buf.indexOf('\r', from) : next.cr
  /** @type {{ idx: number, len: number } | -1} */
  let found = -1
  while (lf !== -1 || cr !== -1) {
    if (cr === -1 || (lf !== -1 && lf < cr)) {
      if (buf.charCodeAt(lf + 1) === 10) {
        found = { idx: lf, len: 2 }
        break
      }
      lf = buf.indexOf('\n', lf + 1)
    } else {
      const after = buf.charCodeAt(cr + 1)
      if (after === 13) {
        found = { idx: cr, len: 2 }
        break
      }
      if (after === 10 && buf.charCodeAt(cr + 2) === 13 && buf.charCodeAt(cr + 3) === 10) {
        found = { idx: cr, len: 4 }
        break
      }
      cr = buf.indexOf('\r', cr + 1)
    }
  }
  next.lf = lf
  next.cr = cr
  return found
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
  const lines = block.split(/\r\n|\r|\n/)
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
