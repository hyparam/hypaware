// @ts-check
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import zlib from 'node:zlib'

/**
 * @import { DatabaseSync } from 'node:sqlite'
 * @import { OpenclawSessionSource } from '../../../../hypaware-core/plugins-workspace/openclaw/src/types.js'
 */

export const OPENCLAW_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024
const EVENT_MAX_BYTES = 4 * 1024 * 1024
const PAGE_SIZE = 128

/**
 * A storage failure is never evidence of an empty or policy-safe session.
 *
 * `bytes` is what the read had already pulled out of SQLite before it failed,
 * so a caller metering its reads charges a failure the transfer it cost.
 */
export class OpenclawStorageError extends Error {
  /** @param {string} code @param {number} [bytes] */
  constructor(code, bytes = 0) {
    super(code === 'zstd_unavailable_upgrade_node'
      ? 'OpenClaw compressed transcripts require a Node runtime with built-in zstd support; upgrade the HypAware daemon runtime'
      : `OpenClaw transcript storage unavailable (${code}); recovery will retry`)
    this.name = 'OpenclawStorageError'
    this.code = code
    this.bytes = bytes
  }
}

/**
 * @ref LLP 0444#reads [implements]: read-only snapshots, bounded busy retries,
 * no migrations, checkpoints, extensions, or payloads in errors.
 * @template T
 * @param {string} dbPath
 * @param {(db: DatabaseSync) => T} read
 * @returns {Promise<T>}
 */
async function withDatabase(dbPath, read) {
  for (let attempt = 0; ; attempt++) {
    /** @type {DatabaseSync | undefined} */
    let db
    try {
      const { DatabaseSync } = await import('node:sqlite')
      db = new DatabaseSync(dbPath, { readOnly: true })
      db.exec('PRAGMA query_only = ON; BEGIN')
      const result = read(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      if (error instanceof OpenclawStorageError) throw error
      const errcode = /** @type {{errcode?: number}} */ (error)?.errcode
      const code = typeof errcode === 'number' ? errcode & 0xff : undefined
      if ((code === 5 || code === 6) && attempt < 2) {
        // Release the snapshot before waiting; never sleep holding a reader.
      } else {
        throw new OpenclawStorageError(code === 5 || code === 6 ? 'sqlite_busy' : 'sqlite_read_failed')
      }
    } finally {
      try { db?.close() } catch { /* preserve the sanitized read failure */ }
    }
    await delay(25 * (attempt + 1))
  }
}

/** @param {DatabaseSync} db @param {string} table */
function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)))
}

/** @param {DatabaseSync} db */
function shape(db) {
  const windows = columns(db, 'session_windows')
  const events = columns(db, 'transcript_events')
  if (!['session_id', 'updated_at'].every(key => windows.has(key)) ||
      !['session_id', 'seq', 'event_json'].every(key => events.has(key))) {
    throw new OpenclawStorageError('unsupported_schema')
  }
  return {
    activity: windows.has('transcript_updated_at') ? 'COALESCE(transcript_updated_at, updated_at)' : 'updated_at',
    compressed: events.has('event_zstd') && events.has('event_utf8_bytes'),
    cold: columns(db, 'session_transcript_cold_archives').size > 0,
  }
}

/**
 * Cursor pagination avoids retaining every session on a long-lived install.
 * @param {string} dbPath
 * @param {string} agentId
 * @param {{ floorMs?: number }} [opts]
 * @returns {AsyncGenerator<OpenclawSessionSource>}
 */
export async function* listSqliteSessions(dbPath, agentId, opts = {}) {
  let after = ''
  for (;;) {
    const page = await withDatabase(dbPath, db => {
      const { activity } = shape(db)
      return db.prepare(`SELECT session_id, ${activity} AS activity FROM session_windows
        WHERE session_id > ? AND ${activity} >= ? ORDER BY session_id LIMIT ?`)
        .all(after, opts.floorMs ?? -Number.MAX_SAFE_INTEGER, PAGE_SIZE)
    })
    for (const row of page) {
      if (typeof row.session_id !== 'string' || !row.session_id || !Number.isFinite(Number(row.activity))) throw new OpenclawStorageError('invalid_session_metadata')
      const sessionId = row.session_id
      yield { path: `${dbPath}#${encodeURIComponent(sessionId)}`, sqlitePath: dbPath, sessionId, agentId, mtimeMs: Number(row.activity) }
    }
    if (page.length < PAGE_SIZE) return
    after = String(page[page.length - 1].session_id)
  }
}

/** @param {string} dbPath @param {string[]} sessionIds */
export async function sqliteOwnedSessions(dbPath, sessionIds) {
  return withDatabase(dbPath, db => {
    shape(db)
    return new Set(db.prepare(`SELECT session_id FROM session_windows WHERE session_id IN (${sessionIds.map(() => '?').join(',')})`).all(...sessionIds).map(row => String(row.session_id)))
  })
}

/** @param {Uint8Array} bytes @param {number} maxBytes */
function decompress(bytes, maxBytes) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw new OpenclawStorageError('zstd_unavailable_upgrade_node')
  try {
    return zlib.zstdDecompressSync(bytes, { maxOutputLength: maxBytes })
  } catch {
    throw new OpenclawStorageError('invalid_or_oversized_zstd')
  }
}

/**
 * @param {Record<string, any>} row
 * @param {number} budget
 */
function eventText(row, budget) {
  if (typeof row.event_json === 'string') {
    if (Buffer.byteLength(row.event_json) > budget) throw new OpenclawStorageError('transcript_limit')
    return row.event_json
  }
  const size = row.event_utf8_bytes
  if (!(row.event_zstd instanceof Uint8Array) || !Number.isSafeInteger(size) || size < 1 || size > EVENT_MAX_BYTES || size > budget || row.event_zstd.length > EVENT_MAX_BYTES) {
    throw new OpenclawStorageError('invalid_or_oversized_event')
  }
  const bytes = decompress(row.event_zstd, size)
  if (bytes.length !== size) throw new OpenclawStorageError('event_size_mismatch')
  return bytes.toString('utf8')
}

/**
 * @ref LLP 0444#archives [implements]: verify immutable archive identity,
 * digest, counts, and bounded decompression without restoring into OpenClaw.
 * @param {Record<string, any>} archive
 * @param {OpenclawSessionSource} source
 * @param {number} maxBytes
 * @returns {string[]}
 */
function coldEvents(archive, source, maxBytes) {
  if (!/^[a-f0-9]{64}\.jsonl\.zst$/.test(archive.archive_name) ||
      !Number.isSafeInteger(archive.archive_bytes) || archive.archive_bytes < 1 || archive.archive_bytes > maxBytes ||
      !Number.isSafeInteger(archive.raw_bytes) || archive.raw_bytes > maxBytes) throw new OpenclawStorageError('invalid_or_oversized_archive')
  let bytes
  if (archive.storage === 'sqlite') {
    bytes = archive.archive_blob
  } else if (archive.storage === 'file') {
    const file = path.join(path.dirname(path.dirname(source.sqlitePath ?? '')), 'sessions', 'cold', archive.archive_name)
    // Open and bound the same descriptor, rather than stat then an unbounded read.
    const fd = fs.openSync(file, 'r')
    try {
      if (fs.fstatSync(fd).size !== archive.archive_bytes) throw new OpenclawStorageError('archive_size_mismatch')
      bytes = Buffer.alloc(archive.archive_bytes)
      let offset = 0
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (count === 0) throw new OpenclawStorageError('archive_size_mismatch')
        offset += count
      }
    } finally { fs.closeSync(fd) }
  } else throw new OpenclawStorageError('unsupported_archive_storage')
  if (!(bytes instanceof Uint8Array) || bytes.length !== archive.archive_bytes || createHash('sha256').update(bytes).digest('hex') !== archive.archive_sha256) throw new OpenclawStorageError('archive_digest_mismatch')
  const text = decompress(bytes, maxBytes).toString('utf8')
  const events = []
  let previous = -1
  let rawBytes = 0
  let first = true
  for (const line of text.trimEnd().split('\n')) {
    let record
    try { record = JSON.parse(line) }
    catch { throw new OpenclawStorageError('invalid_archive_event') }
    if (first) {
      first = false
      if (record.kind !== 'header' || record.version !== 1 || record.sessionId !== source.sessionId || record.generation !== archive.generation) throw new OpenclawStorageError('archive_identity_mismatch')
    } else if (record.kind === 'header') throw new OpenclawStorageError('archive_identity_mismatch')
    else if (record.kind === 'event') {
      if (!Number.isSafeInteger(record.row?.seq) || record.row.seq <= previous || typeof record.row.event_json !== 'string') throw new OpenclawStorageError('invalid_archive_event')
      previous = record.row.seq
      rawBytes += Buffer.byteLength(record.row.event_json)
      events.push(record.row.event_json)
    }
  }
  if (events.length !== archive.event_count || previous !== archive.last_seq || rawBytes + events.length - 1 !== archive.raw_bytes) throw new OpenclawStorageError('archive_metadata_mismatch')
  return events
}

/**
 * @param {OpenclawSessionSource} source
 * @param {{ maxBytes?: number, quietBeforeMs?: number, acceptHeaderLine?: (line: string) => boolean }} [opts]
 * @returns {Promise<string[] | undefined>}
 */
export async function readSqliteSession(source, opts = {}) {
  const maxBytes = opts.maxBytes ?? OPENCLAW_TRANSCRIPT_MAX_BYTES
  return withDatabase(source.sqlitePath ?? '', db => {
    const schema = shape(db)
    const session = db.prepare(`SELECT ${schema.activity} AS activity FROM session_windows WHERE session_id = ?`).get(source.sessionId ?? '')
    if (!session) throw new OpenclawStorageError('session_disappeared')
    // Check again inside the payload snapshot: enumeration can race a new turn.
    if (opts.quietBeforeMs !== undefined && Number(session.activity) > opts.quietBeforeMs) return undefined
    if (schema.cold) {
      const size = db.prepare('SELECT archive_bytes, raw_bytes, length(archive_blob) AS blob_bytes FROM session_transcript_cold_archives WHERE session_id = ?').get(source.sessionId ?? '')
      if (size && (Number(size.archive_bytes) > maxBytes || Number(size.raw_bytes) > maxBytes || Number(size.blob_bytes) > maxBytes)) throw new OpenclawStorageError('transcript_limit')
      const archive = size ? db.prepare('SELECT * FROM session_transcript_cold_archives WHERE session_id = ?').get(source.sessionId ?? '') : undefined
      if (archive) return coldEvents(archive, source, maxBytes)
    }
    const selected = schema.compressed ? 'event_json, event_zstd, event_utf8_bytes' : 'event_json'
    // `octet_length` answers from the value header, so a size pre-pass never
    // pulls a payload off its overflow pages; `length(CAST(x AS BLOB))` does.
    const firstSize = db.prepare(`SELECT octet_length(event_json) AS bytes${schema.compressed ? ', octet_length(event_zstd) AS compressed, event_utf8_bytes AS decoded' : ''} FROM transcript_events WHERE session_id = ? ORDER BY seq LIMIT 1`).get(source.sessionId ?? '')
    if (Number(firstSize?.bytes) > maxBytes || Number(firstSize?.compressed) > EVENT_MAX_BYTES || Number(firstSize?.decoded) > maxBytes) throw new OpenclawStorageError('transcript_limit')
    const first = db.prepare(`SELECT ${selected} FROM transcript_events WHERE session_id = ? ORDER BY seq LIMIT 1`).get(source.sessionId ?? '')
    const firstText = first ? eventText(first, maxBytes) : undefined
    if (firstText && opts.acceptHeaderLine?.(firstText) === false) return [firstText]
    // SQLite measures sizes before transferring any potentially large text or
    // blob to JS. This also bounds metadata-only records and malformed stores.
    const sizeSql = schema.compressed ? 'CASE WHEN event_json IS NOT NULL THEN octet_length(event_json) ELSE event_utf8_bytes END' : 'octet_length(event_json)'
    // The inner query projects sizes only: `SELECT *` hands every payload to
    // the aggregate, reading the whole transcript once more before `iterate`.
    const totals = db.prepare(`SELECT count(*) AS n, sum(sz) AS bytes${schema.compressed ? ', max(zsz) AS compressed' : ''} FROM (SELECT ${sizeSql} AS sz${schema.compressed ? ', octet_length(event_zstd) AS zsz' : ''} FROM transcript_events WHERE session_id = ? ORDER BY seq LIMIT 100001)`).get(source.sessionId ?? '')
    if (Number(totals?.n) > 100000 || Number(totals?.bytes) > maxBytes || Number(totals?.compressed ?? 0) > EVENT_MAX_BYTES) throw new OpenclawStorageError('transcript_limit')
    const rows = db.prepare(`SELECT ${selected} FROM transcript_events WHERE session_id = ? ORDER BY seq`).iterate(source.sessionId ?? '')
    const out = []
    let bytes = 0
    try {
      for (const row of rows) {
        const text = eventText(row, maxBytes - bytes)
        bytes += Buffer.byteLength(text)
        if (out.length >= 100000) throw new OpenclawStorageError('transcript_limit')
        out.push(text)
      }
    } catch (error) {
      // The events before the failing one were transferred all the same.
      if (error instanceof OpenclawStorageError) error.bytes = bytes
      throw error
    }
    return out
  })
}
