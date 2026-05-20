import { readCursor } from './cursor.js'
import { sessionCursorPath } from './paths.js'
import { streamSse } from './sse_client.js'

/**
 * @import { SessionContext } from './types.d.ts'
 * @import { NormalizerDispatcher } from './normalizer_dispatcher.js'
 * @import { ParquetWriter } from './parquet_writer.js'
 * @import { GascityRuntimeStateWriter } from './runtime_state.js'
 */

/**
 * Per-session frame consumer. Owns one SSE connection to
 * `/v0/city/{city}/session/{id}/stream?format=raw`, parses each `data:`
 * payload as the supervisor's `format=raw` envelope, and hands it to the
 * normalizer dispatcher. Reconnect is delegated to `streamSse`; cursor
 * persistence is owned by the `ParquetWriter` (bead 3) so the cursor only
 * advances after a successful flush. The worker still reads the cursor at
 * startup to compose the SSE `?after=<uuid>` resume query.
 */
export class SessionWorker {
  /**
   * @param {{
   *   city: string,
   *   apiUrl: string,
   *   sessionId: string,
   *   template?: string,
   *   rig?: string,
   *   alias?: string,
   *   sinkRoot: string,
   *   dispatcher: NormalizerDispatcher,
   *   writer?: ParquetWriter,
   *   stateWriter?: GascityRuntimeStateWriter,
   *   stderr?: { write: (s: string) => void },
   *   debug?: boolean,
   *   fetchFn?: typeof fetch,
   *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
   * }} opts
   */
  constructor(opts) {
    /** @type {string} */
    this.city = opts.city
    /** @type {string} */
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '')
    /** @type {string} */
    this.sessionId = opts.sessionId
    /** @type {string | undefined} */
    this.template = opts.template
    /** @type {string | undefined} */
    this.rig = opts.rig
    /** @type {string | undefined} */
    this.alias = opts.alias
    /** @type {string} */
    this.sinkRoot = opts.sinkRoot
    /** @type {NormalizerDispatcher} */
    this.dispatcher = opts.dispatcher
    /** @type {ParquetWriter | undefined} */
    this.writer = opts.writer
    /** @type {GascityRuntimeStateWriter | undefined} */
    this.stateWriter = opts.stateWriter
    /** @type {{ write: (s: string) => void }} */
    this.stderr = opts.stderr ?? process.stderr
    /** @type {boolean} */
    this.debug = opts.debug ?? false
    /** @type {typeof fetch | undefined} */
    this.fetchFn = opts.fetchFn
    /** @type {((ms: number, signal: AbortSignal) => Promise<void>) | undefined} */
    this.sleep = opts.sleep
    /** @type {AbortController} */
    this.controller = new AbortController()
    /** @type {Promise<void> | undefined} */
    this.runPromise = undefined
    /** @type {string | undefined} Last frame uuid dispatched in-memory (not yet flushed; informational). */
    this.lastUuid = undefined
    /** @type {boolean} */
    this.draining = false
  }

  /**
   * Open the per-session SSE connection and start dispatching frames. Idempotent
   * — subsequent calls return the in-flight promise.
   *
   * @returns {Promise<void>}
   */
  start() {
    if (this.runPromise) return this.runPromise
    this.runPromise = this.run().catch((err) => {
      this.stderr.write(`[gascity] session worker crashed city=${this.city} session=${this.sessionId} err=${formatError(err)}\n`)
    })
    return this.runPromise
  }

  /**
   * Mark the worker as draining (no more frames expected) and wait for the
   * SSE loop to exit. Called by the supervisor on `session.draining` /
   * `session.stopped` lifecycle events.
   *
   * Bead 3 hooks the writer's `retireSession` into the drain path so the
   * session's pending buffer flushes and the cursor is marked
   * `retired=true` — a subsequent daemon start then skips this session
   * during backfill. When `writer` is undefined (legacy tests) the worker
   * still aborts cleanly; the next start just resumes from the last
   * flushed cursor.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this.draining = true
    this.controller.abort()
    if (this.runPromise) await this.runPromise
    if (this.writer) {
      try {
        await this.writer.retireSession(this.city, this.sessionId)
      } catch (err) {
        this.stderr.write(
          `[gascity] session_retire_failed city=${this.city} session=${this.sessionId} err=${formatError(err)}\n`
        )
      }
    }
  }

  /**
   * @returns {Promise<void>}
   * @private
   */
  async run() {
    const cursorPath = sessionCursorPath(this.sinkRoot, this.city, this.sessionId)
    const cursor = await readCursor(cursorPath, { onError: (m) => this.stderr.write(`${m}\n`) })
    const initialAfter = typeof cursor?.last_uuid === 'string' ? cursor.last_uuid : undefined
    if (initialAfter !== undefined) {
      this.lastUuid = initialAfter
    }
    const url = buildSessionStreamUrl(this.apiUrl, this.city, this.sessionId, initialAfter)
    if (this.debug) {
      this.stderr.write(`[gascity] session_worker_start city=${this.city} session=${this.sessionId} url=${url}\n`)
    }
    /** @type {SessionContext} */
    const ctx = {
      city: this.city,
      sessionId: this.sessionId,
      template: this.template,
      rig: this.rig,
      alias: this.alias,
    }
    /** @type {Parameters<typeof streamSse>[0]} */
    const streamOpts = {
      url,
      signal: this.controller.signal,
      onEvent: (ev) => this.handleEvent(ev, ctx),
      onError: (msg) => this.stderr.write(`${msg}\n`),
      onConnect: () => {
        if (this.debug) {
          this.stderr.write(`[gascity] session_worker_connected city=${this.city} session=${this.sessionId}\n`)
        }
      },
      initialLastEventId: initialAfter,
    }
    if (this.fetchFn) streamOpts.fetchFn = this.fetchFn
    if (this.sleep) streamOpts.sleep = this.sleep
    await streamSse(streamOpts)
    if (this.debug) {
      this.stderr.write(`[gascity] session_worker_stop city=${this.city} session=${this.sessionId}\n`)
    }
  }

  /**
   * Parse one SSE event as a supervisor frame envelope and route to the
   * dispatcher. Bead 3 moved cursor ownership to the writer, so this handler
   * no longer persists a cursor per frame — the writer writes the cursor
   * after each successful parquet flush. `lastUuid` is still tracked in
   * memory for observability (debug logs, tests) but is informational only.
   *
   * @param {import('../types.js').SseEvent} ev
   * @param {SessionContext} ctx
   * @returns {void}
   * @private
   */
  handleEvent(ev, ctx) {
    if (ev.event === 'ping' || ev.event === 'heartbeat') return
    if (ev.data.length === 0) return
    /** @type {unknown} */
    let envelope
    try {
      envelope = JSON.parse(ev.data)
    } catch (err) {
      this.stderr.write(
        `[gascity] frame_parse_error city=${this.city} session=${this.sessionId} err=${formatError(err)}\n`
      )
      return
    }
    if (this.debug) {
      this.stderr.write(`[gascity] frame_received city=${this.city} session=${this.sessionId} event=${ev.event}\n`)
    }
    const rows = this.dispatcher.dispatch(envelope, ctx)
    if (this.debug && rows.length > 0) {
      this.stderr.write(
        `[gascity] frame_normalized city=${this.city} session=${this.sessionId} rows=${rows.length}\n`
      )
    }
    if (this.stateWriter !== undefined) {
      this.stateWriter.recordFrame(this.city, this.sessionId, 1)
    }
    // Bead 3 hooks the parquet writer in here. Until then, rows are discarded
    // after the debug log — the cursor still advances so resume semantics hold.
    const uuid = extractUuid(envelope)
    if (uuid !== undefined) this.lastUuid = uuid
  }
}

/**
 * Build the SSE URL for a session's frame stream. When `after` is provided
 * we append `?after=<uuid>` so the supervisor resumes from the next frame
 * — `Last-Event-ID` is also sent (by `streamSse`) but the supervisor's REST
 * docs document the `after` query param explicitly, so we use both for
 * resilience against a server that may have only implemented one.
 *
 * @param {string} apiUrl
 * @param {string} city
 * @param {string} sessionId
 * @param {string | undefined} after
 * @returns {string}
 */
export function buildSessionStreamUrl(apiUrl, city, sessionId, after) {
  const base = `${apiUrl}/v0/city/${encodeURIComponent(city)}/session/${encodeURIComponent(sessionId)}/stream`
  const params = new URLSearchParams({ format: 'raw' })
  if (after !== undefined) params.set('after', after)
  return `${base}?${params.toString()}`
}

/**
 * Pull the per-frame uuid off a supervisor frame envelope. Different providers
 * surface the uuid in different positions; we look at the obvious places and
 * return undefined when the envelope doesn't carry one (passthrough provider,
 * malformed frame, etc).
 *
 * @param {unknown} envelope
 * @returns {string | undefined}
 */
export function extractUuid(envelope) {
  if (envelope === null || typeof envelope !== 'object') return undefined
  const obj = /** @type {Record<string, unknown>} */ (envelope)
  if (typeof obj.uuid === 'string') return obj.uuid
  if (obj.frame && typeof obj.frame === 'object') {
    const frame = /** @type {Record<string, unknown>} */ (obj.frame)
    if (typeof frame.uuid === 'string') return frame.uuid
  }
  return undefined
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
