// @ts-check

import { sessionIgnoreLoadError } from '../../../../src/core/control/session_ignore_store.js'
import { Exchange, createRecorder } from './recorder.js'

/**
 * @import { ChildProcess } from 'node:child_process'
 * @import { ExchangeInit, GatewayProcessTransport, ResponseStart } from '../../../../hypaware-core/plugins-workspace/ai-gateway/src/types.js'
 */

// Limits apply to raw capture copies, not the forwarded request/response.
export const CAPTURE_BYTES = 16 * 1024 * 1024
export const PENDING_BYTES = 4 * 1024 * 1024
export const MAX_CAPTURES = 32
const MAX_FRAMES = 256
const FRAME_BYTES = 64 * 1024
const MAX_IGNORED_SESSIONS = 1024
const CAPTURE_TIMEOUT_MS = 30 * 60 * 1000

/** @type {GatewayProcessTransport | undefined} */
let transport

/** @param {GatewayProcessTransport | undefined} value */
export function setGatewayProcessTransport(value) { transport = value }
export function getGatewayProcessTransport() { return transport }

/**
 * The gateway retains at most a fixed number of IPC frames. Credits return
 * when the processor consumes a frame, not when Node queues it to the pipe.
 * A stalled/dead consumer therefore costs recordings, never provider traffic.
 * @ref LLP 0038#implemented-boundary [implements]: bounded memory-only capture copies across separate heaps
 * @param {{ getChild(): ChildProcess | undefined, log: { warn(event: string, fields?: Record<string, unknown>): void }, redactHeaders?: readonly string[] }} opts
 */
export function createCaptureSender(opts) {
  let redactSet = createRecorder({ redactHeaders: opts.redactHeaders }).redactSet
  /** @type {Map<number, number>} */
  const pending = new Map()
  /** @type {Set<string>} */
  const cancellations = new Set()
  /** @type {Set<RemoteExchange>} */
  const active = new Set()
  let pendingBytes = 0
  let serial = 0
  let ready = false
  let dropped = 0
  let reported = false

  function reportDrop() {
    dropped++
    if (reported) return
    reported = true
    opts.log.warn('gateway.capture_dropped', { reason: 'processor_unavailable_or_capture_limit', dropped })
  }

  /** @param {Record<string, unknown>} frame @param {number} bytes */
  function send(frame, bytes) {
    const child = opts.getChild()
    if (!ready || !child?.connected || pending.size >= MAX_FRAMES || pendingBytes + bytes > PENDING_BYTES) return false
    const seq = ++serial
    pending.set(seq, bytes)
    pendingBytes += bytes
    try {
      child.send({ type: 'gateway.capture', seq, ...frame }, (error) => {
        if (error && opts.getChild() === child) reset()
      })
      return true
    } catch {
      reset()
      return false
    }
  }

  class RemoteExchange extends Exchange {
    /** @param {ExchangeInit} init */
    constructor(init) {
      super({ redactSet, init })
      this.accepted = false
      this.bytes = 0
      this.deadline = Date.now() + CAPTURE_TIMEOUT_MS
      // Credentials are needed for upstream routing, not for recording.
      this._rawRequestHeaders = this.requestHeaders
      const safeInit = { ...init, requestHeaders: this.requestHeaders }
      const size = Buffer.byteLength(JSON.stringify(safeInit))
      if (size <= FRAME_BYTES && active.size < MAX_CAPTURES && send({ op: 'start', id: this.id, init: safeInit, ts: this.tsStartMs }, size)) {
        this.accepted = true
        active.add(this)
      } else reportDrop()
    }

    abandon() {
      if (!this.accepted) return
      this.accepted = false
      active.delete(this)
      if (!send({ op: 'cancel', id: this.id }, 128)) cancellations.add(this.id)
      reportDrop()
    }

    /** @param {'request'|'response'} op @param {Buffer | Uint8Array} chunk */
    chunk(op, chunk) {
      if (!this.accepted) return
      this.bytes += chunk.byteLength
      if (this.bytes > CAPTURE_BYTES || Date.now() > this.deadline) { this.abandon(); return }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      for (let offset = 0; offset < buf.length; offset += FRAME_BYTES) {
        const data = buf.subarray(offset, offset + FRAME_BYTES)
        if (!send({ op, id: this.id, data }, data.byteLength + 128)) { this.abandon(); return }
      }
    }
    /** @param {Buffer | Uint8Array} chunk */
    appendRequestChunk(chunk) { this.chunk('request', chunk) }
    /** @param {Buffer | Uint8Array} chunk */
    appendResponseChunk(chunk) { this.chunk('response', chunk) }
    /** @param {Buffer | Uint8Array} chunk */
    consumeStreamChunk(chunk) { this.chunk('response', chunk) }
    /** @param {ResponseStart} init */
    setResponseStart(init) {
      super.setResponseStart(init)
      const size = Buffer.byteLength(JSON.stringify(this.response))
      if (this.accepted && (size > FRAME_BYTES || !send({ op: 'head', id: this.id, head: this.response }, size))) this.abandon()
    }
    /** @param {unknown} error */
    setError(error) {
      super.setError(error)
      if (this.error) this.error = this.error.slice(0, 1024)
    }
  }

  function reset() {
    ready = false
    pending.clear()
    cancellations.clear()
    pendingBytes = 0
    for (const exchange of active) {
      exchange.accepted = false
      reportDrop()
    }
    active.clear()
  }

  return {
    /** @param {readonly string[]} redactHeaders */
    configure(redactHeaders) { redactSet = createRecorder({ redactHeaders }).redactSet },
    recorder: {
      /** @param {ExchangeInit} init */
      startExchange(init) { return new RemoteExchange(init) },
      async drain() {
        for (const exchange of [...active]) exchange.abandon()
      },
    },
    /** @param {Exchange} exchange @param {Set<string>} ignored */
    finish(exchange, ignored) {
      const remote = /** @type {RemoteExchange} */ (exchange)
      if (remote.accepted) {
        // Opaque session IDs only. Refuse a too-large snapshot before copying it.
        if (sessionIgnoreLoadError(ignored) || ignored.size > MAX_IGNORED_SESSIONS) remote.abandon()
        else {
          const ids = []
          let size = 2048
          for (const id of ignored) {
            // Six bytes per UTF-16 code unit bounds JSON escaping before any
            // serialization/allocation of a potentially oversized snapshot.
            size += id.length * 6 + 3
            if (size > FRAME_BYTES) break
            ids.push(id)
          }
          if (size > FRAME_BYTES || !send({ op: 'end', id: remote.id, ignored: ids, error: remote.error }, size)) remote.abandon()
        }
      }
      active.delete(remote)
      remote.accepted = false
      remote.finished = true
      remote._resolveFinished()
    },
    /** @param {unknown} input */
    message(input) {
      const msg = /** @type {{ type?: string, seq?: number }} */ (input)
      if (msg.type === 'gateway.capture_ready') { ready = true; reported = false }
      if (msg.type === 'gateway.capture_paused') reset()
      if (msg.type === 'gateway.capture_dropped') reportDrop()
      if (msg.type === 'gateway.capture_ack' && typeof msg.seq === 'number') {
        pendingBytes -= pending.get(msg.seq) ?? 0
        pending.delete(msg.seq)
        // A full data pipe must not lose cancellation and pin the receiver's
        // active slot until timeout. This queue holds only bounded opaque IDs.
        for (const id of cancellations) {
          if (!send({ op: 'cancel', id }, 128)) break
          cancellations.delete(id)
        }
      }
    },
    reset,
    snapshot: () => ({ capture_ready: ready, capture_dropped: dropped, capture_pending_bytes: pendingBytes, capture_active: active.size }),
  }
}

/**
 * Reconstruct exchanges only in the processing heap. The adapter's existing
 * ignore checks still run before append; there is no raw durable capture.
 * @param {{ onExchange(exchange: Exchange, ignored: Set<string>): Promise<void>, send(message: object): void }} opts
 */
export function createCaptureReceiver(opts) {
  /** @type {Map<string, { exchange: Exchange, bytes: number, at: number }>} */
  const active = new Map()
  const recorder = createRecorder()
  let retainedBytes = 0
  let finishing = 0
  /** @type {Set<Promise<void>>} */
  const tasks = new Set()

  /** @param {string} id */
  function discard(id, report = false) {
    const record = active.get(id)
    if (!record) return
    retainedBytes -= record.bytes
    record.exchange.finished = true
    record.exchange._resolveFinished()
    active.delete(id)
    if (report) opts.send({ type: 'gateway.capture_dropped' })
  }
  const timer = setInterval(() => {
    for (const [id, record] of active) if (Date.now() - record.at > CAPTURE_TIMEOUT_MS) discard(id, true)
  }, 30_000)
  timer.unref()

  return {
    /** @param {unknown} input */
    message(input) {
      const msg = /** @type {{ type?: string, seq: number, id: string, op: string, init: ExchangeInit, ts: number, data: Buffer, head: ResponseStart, ignored: string[], error?: string }} */ (input)
      if (msg.type !== 'gateway.capture') return
      try {
        if (msg.op === 'start') {
          if (active.size + finishing >= MAX_CAPTURES) { opts.send({ type: 'gateway.capture_dropped' }); return }
          const exchange = recorder.startExchange(msg.init)
          exchange.id = msg.id
          exchange.tsStartMs = msg.ts
          exchange.tsStart = new Date(msg.ts).toISOString()
          active.set(msg.id, { exchange, bytes: 0, at: Date.now() })
          return
        }
        const record = active.get(msg.id)
        if (!record) return
        const exchange = record.exchange
        if (msg.op === 'cancel') { discard(msg.id); return }
        if (msg.op === 'request' || msg.op === 'response') {
          if (!Buffer.isBuffer(msg.data)) { discard(msg.id); return }
          record.bytes += msg.data.byteLength
          retainedBytes += msg.data.byteLength
          if (record.bytes > CAPTURE_BYTES || retainedBytes > CAPTURE_BYTES * 2) { discard(msg.id, true); return }
          if (msg.op === 'request') exchange.appendRequestChunk(msg.data)
          else if (exchange.isSse) exchange.consumeStreamChunk(msg.data)
          else exchange.appendResponseChunk(msg.data)
        } else if (msg.op === 'head') exchange.setResponseStart(msg.head)
        else if (msg.op === 'end') {
          if (msg.error) exchange.setError(msg.error)
          active.delete(msg.id)
          finishing++
          const task = opts.onExchange(exchange, new Set(msg.ignored)).catch(() => {}).finally(() => {
            retainedBytes -= record.bytes
            finishing--
            tasks.delete(task)
          })
          tasks.add(task)
        }
      } finally { opts.send({ type: 'gateway.capture_ack', seq: msg.seq }) }
    },
    async close() {
      clearInterval(timer)
      for (const id of active.keys()) discard(id)
      await Promise.allSettled(tasks)
    },
  }
}
