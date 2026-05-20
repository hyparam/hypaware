import fs from 'node:fs/promises'
import path from 'node:path'
import { readCursor, writeCursor } from './cursor.js'
import { SessionDedup } from './dedup.js'
import { parquetPartPath, sessionCursorPath } from './paths.js'
import { GASCITY_MESSAGES_SCHEMA_VERSION, rowsToColumnData } from './schema.js'

/**
 * @import { SessionContext, SessionCursor } from './types.d.ts'
 * @import { NormalizedRow } from './normalizers/types.d.ts'
 */

/**
 * Default in-memory buffer threshold per session. The supervisor's frame
 * cadence on a hot Claude Code session is roughly 5–20 frames/sec; 256
 * rows is ~10–60 s of capture at peak, low enough that a crash loses a
 * bounded amount of data but high enough that disk seeks aren't dominated
 * by the per-flush parquet footer/header overhead.
 */
const DEFAULT_FLUSH_ROWS = 256

/**
 * Default time-based flush cadence. Independent of `flushRows` so a
 * low-throughput session (one frame every few seconds) still lands a
 * part-file roughly once a minute and the on-disk view of the session
 * stays close to real time.
 */
const DEFAULT_FLUSH_INTERVAL_MS = 30_000

/**
 * Bounded dedup window per session. See `dedup.js` for the reasoning.
 */
const DEFAULT_DEDUP_LIMIT = 10000

/**
 * Per-session buffer + flush coordinator. Owns:
 *
 *   - The pending rows for one (city, sessionId).
 *   - The per-session cursor (read on first append, written on every flush).
 *   - The flush counter used to compose unique part-file names per day.
 *   - The dedup set that drops re-seen `(provider_session_id, provider_uuid)`
 *     pairs before they reach the buffer.
 *
 * Flushes are serialised per session so a slow disk under high churn can't
 * interleave two writes of the same buffer state. The writer pulls
 * hyparquet-writer in lazily so the optional dep doesn't have to be present
 * when the gascity source is disabled.
 *
 * @internal
 */
class SessionBuffer {
  /**
   * @param {{
   *   city: string,
   *   sessionId: string,
   *   sinkRoot: string,
   *   stderr: { write: (s: string) => void },
   *   now: () => Date,
   * }} opts
   */
  constructor(opts) {
    /** @type {string} */
    this.city = opts.city
    /** @type {string} */
    this.sessionId = opts.sessionId
    /** @type {string} */
    this.sinkRoot = opts.sinkRoot
    /** @type {{ write: (s: string) => void }} */
    this.stderr = opts.stderr
    /** @type {() => Date} */
    this.now = opts.now
    /** @type {NormalizedRow[]} */
    this.pending = []
    /** @type {string | undefined} */
    this.lastUuid = undefined
    /** @type {number} */
    this.lastSeq = 0
    /** @type {string | undefined} */
    this.lastTimestamp = undefined
    /** @type {number} */
    this.flushedCount = 0
    /** @type {boolean} */
    this.retired = false
    /** @type {string | undefined} */
    this.startedAt = undefined
    /** @type {number | undefined} */
    this.schemaVersionOnDisk = undefined
    /** @type {boolean} */
    this.cursorLoaded = false
    /** @type {Map<string, number>} per-day flush counters; resets across days. */
    this.counterByDate = new Map()
    /** @type {Promise<void>} */
    this.flushQueue = Promise.resolve()
  }

  /**
   * Lazily read the on-disk cursor the first time we append, so a writer
   * created eagerly (e.g. at startGascitySource) does no I/O until it has
   * actual work to do.
   *
   * @returns {Promise<void>}
   */
  async ensureCursorLoaded() {
    if (this.cursorLoaded) return
    this.cursorLoaded = true
    const cursorPath = sessionCursorPath(this.sinkRoot, this.city, this.sessionId)
    const cursor = await readCursor(cursorPath, {
      onError: (m) => this.stderr.write(`${m}\n`),
    })
    if (cursor) {
      if (typeof cursor.last_uuid === 'string') this.lastUuid = cursor.last_uuid
      if (typeof cursor.last_seq === 'number') this.lastSeq = cursor.last_seq
      if (typeof cursor.last_timestamp === 'string') this.lastTimestamp = cursor.last_timestamp
      if (typeof cursor.flushed_count === 'number') this.flushedCount = cursor.flushed_count
      if (typeof cursor.retired === 'boolean') this.retired = cursor.retired
      if (typeof cursor.started_at === 'string') this.startedAt = cursor.started_at
      if (typeof cursor.schema_version === 'number') this.schemaVersionOnDisk = cursor.schema_version
    }
  }
}

/**
 * Parquet writer for the `gascity_messages` dataset. One instance is shared
 * by all session workers; it keeps a `SessionBuffer` per active session and
 * fans out flushes per session so a slow disk on one session doesn't block
 * another's frames from being accepted.
 *
 * Flush triggers (all idempotent, all converge on the same disk state):
 *
 *   - `flushRows` rows have accumulated in a single session's buffer.
 *   - `flushIntervalMs` have passed since the last flush (timer-driven).
 *   - Session retires (`retireSession`) — drains then marks the cursor.
 *   - Daemon shuts down (`stop`) — drains every session.
 *
 * Cursor advance is the writer's invariant: a cursor is written ONLY after
 * a successful parquet rename. A torn flush (process killed between fsync
 * and rename) leaves the previous cursor on disk, so the next start
 * re-requests the same frames via `?after=<last_uuid>` and the dedup set
 * collapses any overlap.
 */
export class ParquetWriter {
  /**
   * @param {{
   *   sinkRoot: string,
   *   stderr?: { write: (s: string) => void },
   *   flushRows?: number,
   *   flushIntervalMs?: number,
   *   dedupLimit?: number,
   *   now?: () => Date,
   *   parquetWriteBuffer?: (args: { columnData: ReturnType<typeof rowsToColumnData>, compressed?: boolean, compression?: string }) => ArrayBuffer,
   * }} opts
   */
  constructor(opts) {
    /** @type {string} */
    this.sinkRoot = opts.sinkRoot
    /** @type {{ write: (s: string) => void }} */
    this.stderr = opts.stderr ?? process.stderr
    /** @type {number} */
    this.flushRows = opts.flushRows ?? DEFAULT_FLUSH_ROWS
    /** @type {number} */
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    /** @type {() => Date} */
    this.now = opts.now ?? (() => new Date())
    /** @type {SessionDedup} */
    this.dedup = new SessionDedup({ limit: opts.dedupLimit ?? DEFAULT_DEDUP_LIMIT })
    /** @type {Map<string, SessionBuffer>} */
    this.buffers = new Map()
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined
    /** @type {boolean} */
    this.stopped = false
    /** Lazy hyparquet-writer dynamic import; resolved on first flush. */
    /** @type {((args: { columnData: ReturnType<typeof rowsToColumnData>, compressed?: boolean, compression?: string }) => ArrayBuffer) | undefined} */
    this.parquetWriteBuffer = opts.parquetWriteBuffer
  }

  /**
   * Append rows for one session, deduplicating against the session's prior
   * uuids. Rows that pass the dedup check are buffered; when the buffer
   * reaches `flushRows` a flush is triggered (async — the caller does not
   * wait).
   *
   * Required row fields (the non-nullable columns in `GASCITY_MESSAGES_COLUMNS`)
   * are validated at flush time via the schema's `coerceCell`; appending
   * only checks for `provider_uuid` since it's the dedup key.
   *
   * @param {SessionContext} ctx
   * @param {ReadonlyArray<NormalizedRow>} rows
   * @returns {Promise<void>} resolves once buffered (and any triggered
   *   threshold flush completes — failures are logged but never thrown back).
   */
  async append(ctx, rows) {
    if (this.stopped) return
    if (rows.length === 0) return
    const buf = this.bufferFor(ctx)
    await buf.ensureCursorLoaded()
    if (buf.startedAt === undefined) {
      buf.startedAt = this.now().toISOString()
    }
    for (const row of rows) {
      const uuid = typeof row.provider_uuid === 'string' ? row.provider_uuid : undefined
      if (!uuid) {
        this.stderr.write(
          `[gascity] writer_drop_no_uuid city=${ctx.city} session=${ctx.sessionId} part_type=${String(row.part_type ?? '<none>')}\n`
        )
        continue
      }
      if (!this.dedup.observe(ctx.city, ctx.sessionId, uuid)) {
        continue
      }
      buf.pending.push(row)
      buf.lastUuid = uuid
      buf.lastSeq += 1
      const ts = /** @type {unknown} */ (row.message_created_at)
      if (typeof ts === 'string') buf.lastTimestamp = ts
      else if (ts instanceof Date) buf.lastTimestamp = ts.toISOString()
      else if (typeof ts === 'number') buf.lastTimestamp = new Date(ts).toISOString()
    }
    this.armTimer()
    if (buf.pending.length >= this.flushRows) {
      this.scheduleFlush(buf, 'threshold')
    }
  }

  /**
   * Flush every session's buffer and write a `retired=true` cursor for one
   * session. Called when the supervisor sees `session.draining` or
   * `session.stopped` — backfill on a future start will then skip this
   * session.
   *
   * Safe to call repeatedly; the second call is a fast cursor rewrite with
   * no pending rows to flush.
   *
   * @param {string} city
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async retireSession(city, sessionId) {
    if (this.stopped) return
    const key = bufferKey(city, sessionId)
    const buf = this.buffers.get(key)
    if (buf) {
      await buf.ensureCursorLoaded()
      buf.retired = true
      this.scheduleFlush(buf, 'retire')
      await buf.flushQueue
    } else {
      const cursorPath = sessionCursorPath(this.sinkRoot, city, sessionId)
      const existing = await readCursor(cursorPath, {
        onError: (m) => this.stderr.write(`${m}\n`),
      })
      const next = /** @type {SessionCursor} */ { ...existing ?? {} }
      next.retired = true
      try {
        await writeCursor(cursorPath, /** @type {Record<string, unknown>} */ (next))
      } catch (err) {
        this.stderr.write(
          `[gascity] cursor_write_failed city=${city} session=${sessionId} err=${formatError(err)}\n`
        )
      }
    }
    this.dedup.forget(city, sessionId)
  }

  /**
   * Flush every pending session. Returns once every flush has completed.
   *
   * @returns {Promise<void>}
   */
  async flushAll() {
    if (this.stopped) return
    /** @type {Promise<void>[]} */
    const flushes = []
    for (const buf of this.buffers.values()) {
      this.scheduleFlush(buf, 'flushAll')
      flushes.push(buf.flushQueue)
    }
    await Promise.all(flushes)
  }

  /**
   * Drain every session and release the periodic timer. Subsequent appends
   * are silently dropped — the daemon is shutting down and the supervisor
   * will resume from the last flushed cursor on restart.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    /** @type {Promise<void>[]} */
    const flushes = []
    for (const buf of this.buffers.values()) {
      this.scheduleFlush(buf, 'stop')
      flushes.push(buf.flushQueue)
    }
    await Promise.all(flushes)
  }

  /**
   * Re-emit the most recently flushed uuid for `(city, sessionId)`. Used by
   * the backfill runner to compose the supervisor `?after=` query and by
   * the session worker on (re)connect for the SSE `Last-Event-ID` header.
   * Reads the on-disk cursor when the writer has no in-memory state for
   * this session — covers the cold-start case.
   *
   * @param {string} city
   * @param {string} sessionId
   * @returns {Promise<string | undefined>}
   */
  async getLastFlushedUuid(city, sessionId) {
    const key = bufferKey(city, sessionId)
    const buf = this.buffers.get(key)
    if (buf) {
      await buf.ensureCursorLoaded()
      return buf.lastUuid
    }
    const cursorPath = sessionCursorPath(this.sinkRoot, city, sessionId)
    const cursor = await readCursor(cursorPath, {
      onError: (m) => this.stderr.write(`${m}\n`),
    })
    return typeof cursor?.last_uuid === 'string' ? cursor.last_uuid : undefined
  }

  /**
   * @param {SessionContext} ctx
   * @returns {SessionBuffer}
   * @private
   */
  bufferFor(ctx) {
    const key = bufferKey(ctx.city, ctx.sessionId)
    let buf = this.buffers.get(key)
    if (!buf) {
      buf = new SessionBuffer({
        city: ctx.city,
        sessionId: ctx.sessionId,
        sinkRoot: this.sinkRoot,
        stderr: this.stderr,
        now: this.now,
      })
      this.buffers.set(key, buf)
    }
    return buf
  }

  /**
   * Lazily start the periodic flush timer the first time we have any
   * pending rows. Using a single timer for every session keeps the
   * implementation simple — each tick walks the buffer map and flushes
   * anything older than `flushIntervalMs`.
   *
   * @returns {void}
   * @private
   */
  armTimer() {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => {
      for (const buf of this.buffers.values()) {
        if (buf.pending.length === 0) continue
        this.scheduleFlush(buf, 'interval')
      }
    }, this.flushIntervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /**
   * Chain a flush onto the session's serial queue. The returned promise is
   * stored on the buffer so the writer can `await buf.flushQueue` to wait
   * for in-flight work without scheduling a new flush.
   *
   * @param {SessionBuffer} buf
   * @param {string} reason debug label appearing in the flush log line
   * @returns {void}
   * @private
   */
  scheduleFlush(buf, reason) {
    buf.flushQueue = buf.flushQueue.then(
      () => this.runFlush(buf, reason),
      () => this.runFlush(buf, reason)
    )
    // Detach from caller-visible failures so a flush rejection on session A
    // doesn't cascade as an unhandled-rejection through session B.
    buf.flushQueue = buf.flushQueue.catch(() => {})
  }

  /**
   * Perform one flush: pull pending rows off the buffer, encode them as
   * parquet, write `<path>.tmp`, fsync, rename, then update the cursor.
   * Failures retain the pending rows so the next flush retries.
   *
   * @param {SessionBuffer} buf
   * @param {string} reason
   * @returns {Promise<void>}
   * @private
   */
  async runFlush(buf, reason) {
    if (buf.pending.length === 0 && !buf.retired) return
    if (buf.pending.length === 0 && buf.retired) {
      await this.writeCursor(buf)
      return
    }
    const rows = buf.pending
    buf.pending = []
    const date = isoDate(this.now())
    const counter = buf.counterByDate.get(date) ?? 0
    const filePath = parquetPartPath(this.sinkRoot, date, buf.city, buf.sessionId, counter)
    const tmpPath = `${filePath}.tmp`
    try {
      const buffer = await this.encodeRows(rows)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      const handle = await fs.open(tmpPath, 'w')
      try {
        await handle.writeFile(buffer)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(tmpPath, filePath)
      buf.counterByDate.set(date, counter + 1)
      buf.flushedCount += rows.length
      buf.schemaVersionOnDisk = GASCITY_MESSAGES_SCHEMA_VERSION
      await this.writeCursor(buf)
      this.stderr.write(
        `[gascity] writer_flush_ok reason=${reason} city=${buf.city} session=${buf.sessionId} rows=${rows.length} file=${filePath}\n`
      )
    } catch (err) {
      buf.pending = rows.concat(buf.pending)
      buf.counterByDate.delete(date)
      this.stderr.write(
        `[gascity] writer_flush_failed reason=${reason} city=${buf.city} session=${buf.sessionId} rows=${rows.length} err=${formatError(err)}\n`
      )
      try { await fs.unlink(tmpPath) } catch { /* best-effort */ }
      throw err
    }
  }

  /**
   * @param {SessionBuffer} buf
   * @returns {Promise<void>}
   * @private
   */
  async writeCursor(buf) {
    const cursorPath = sessionCursorPath(this.sinkRoot, buf.city, buf.sessionId)
    /** @type {SessionCursor} */
    const cursor = {
      schema_version: buf.schemaVersionOnDisk ?? GASCITY_MESSAGES_SCHEMA_VERSION,
      retired: buf.retired,
      flushed_count: buf.flushedCount,
    }
    if (buf.lastUuid !== undefined) cursor.last_uuid = buf.lastUuid
    if (buf.lastSeq > 0) cursor.last_seq = buf.lastSeq
    if (buf.lastTimestamp !== undefined) cursor.last_timestamp = buf.lastTimestamp
    if (buf.startedAt !== undefined) cursor.started_at = buf.startedAt
    try {
      await writeCursor(cursorPath, /** @type {Record<string, unknown>} */ (cursor))
    } catch (err) {
      this.stderr.write(
        `[gascity] cursor_write_failed city=${buf.city} session=${buf.sessionId} err=${formatError(err)}\n`
      )
      throw err
    }
  }

  /**
   * Encode a list of `NormalizedRow`s as a snappy-compressed parquet
   * buffer. The encoder is loaded lazily so the optional dep is only
   * required when the gascity source is actually capturing.
   *
   * @param {ReadonlyArray<NormalizedRow>} rows
   * @returns {Promise<Uint8Array>}
   * @private
   */
  async encodeRows(rows) {
    const write = await this.resolveWriter()
    const columnData = rowsToColumnData(rows)
    const arrayBuffer = write({ columnData, compressed: true, compression: 'SNAPPY' })
    return new Uint8Array(arrayBuffer)
  }

  /**
   * @returns {Promise<(args: { columnData: ReturnType<typeof rowsToColumnData>, compressed?: boolean, compression?: string }) => ArrayBuffer>}
   * @private
   */
  async resolveWriter() {
    if (this.parquetWriteBuffer) return this.parquetWriteBuffer
    const mod = /** @type {{ parquetWriteBuffer: (args: { columnData: ReturnType<typeof rowsToColumnData>, compressed?: boolean, compression?: string }) => ArrayBuffer }} */
      await import('hyparquet-writer')

    this.parquetWriteBuffer = mod.parquetWriteBuffer
    return mod.parquetWriteBuffer
  }
}

/**
 * @param {string} city
 * @param {string} sessionId
 * @returns {string}
 */
function bufferKey(city, sessionId) {
  return `${city} ${sessionId}`
}

/**
 * @param {Date} d
 * @returns {string}
 */
function isoDate(d) {
  return d.toISOString().slice(0, 10)
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
