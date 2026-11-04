// @ts-check

/**
 * Read-only reader for one Crush project database (`<project>/.crush/crush.db`).
 *
 * Opens the file with `node:sqlite` `DatabaseSync` in read-only mode and
 * never writes, takes a write lock or checkpoints. Every read goes through a
 * bounded SQLITE_BUSY / SQLITE_LOCKED retry and a check that the migration
 * table and every column the reader names exist. Each read that needs one
 * snapshot runs inside one read transaction.
 *
 * Error messages never carry the database path: the path names the user's
 * project, and diagnostics carry counts, ids and error kinds only.
 *
 * @ref LLP 0573#sqlite [implements]: read-only, bounded busy retry, schema
 *   check, open per tick and close before it ends.
 * @ref LLP 0573#owner-decisions [implements]: D3 title sessions are skipped
 *   in every query and D6 no query names `files` or `read_files` or uses `*`.
 *
 * @import { CrushBusyRetryOptions, CrushChanges, CrushDbOptions, CrushMessageRow, CrushSessionRow, CrushSessionSnapshot } from './types.js'
 * @import { DatabaseSync } from 'node:sqlite'
 */

import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { CrushDbError } from './errors.js'

export const DEFAULT_BUSY_RETRY_ATTEMPTS = 5
export const DEFAULT_BUSY_RETRY_DELAY_MS = 20

const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6

/**
 * @param {CrushBusyRetryOptions['sleep']} sleep
 * @returns {(ms: number) => Promise<void>}
 */
function resolveSleep(sleep) {
  return sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isRetryableBusyError(err) {
  if (!err || typeof err !== 'object') return false
  const e = /** @type {{ code?: unknown, errcode?: unknown }} */ (err)
  return e.code === 'ERR_SQLITE_ERROR' && (e.errcode === SQLITE_BUSY || e.errcode === SQLITE_LOCKED)
}

/**
 * Run `fn` and retry it while SQLite reports BUSY or LOCKED, up to
 * `attempts` times `delayMs` apart, then fail with `sqlite_busy`.
 *
 * @template T
 * @param {() => T} fn
 * @param {CrushBusyRetryOptions} [opts]
 * @returns {Promise<T>}
 */
export async function withBusyRetry(fn, opts = {}) {
  const attempts = opts.attempts ?? DEFAULT_BUSY_RETRY_ATTEMPTS
  const delayMs = opts.delayMs ?? DEFAULT_BUSY_RETRY_DELAY_MS
  const sleep = resolveSleep(opts.sleep)
  /** @type {unknown} */
  let lastErr
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return fn()
    } catch (err) {
      if (!isRetryableBusyError(err)) throw err
      lastErr = err
      if (attempt < attempts - 1) await sleep(delayMs)
    }
  }
  throw new CrushDbError(`crush.db is locked (SQLITE_BUSY) after ${attempts} attempts`, {
    code: 'sqlite_busy',
    cause: lastErr,
  })
}

/**
 * @param {((id: string) => unknown) | undefined} requireFn
 * @returns {{ DatabaseSync: typeof DatabaseSync }}
 */
function loadSqliteModule(requireFn) {
  try {
    const req = requireFn ?? createRequire(import.meta.url)
    return /** @type {{ DatabaseSync: typeof DatabaseSync }} */ (req('node:sqlite'))
  } catch (cause) {
    throw new CrushDbError('crush capture requires Node >= 22.12 (node:sqlite builtin not available)', {
      code: 'sqlite_unavailable',
      cause,
    })
  }
}

const SESSION_COLUMNS = ['id', 'parent_session_id', 'title', 'message_count', 'cost', 'updated_at', 'created_at']
const MESSAGE_COLUMNS = [
  'id', 'session_id', 'role', 'parts', 'model', 'provider',
  'created_at', 'updated_at', 'finished_at', 'is_summary_message',
]

/** Tables and the columns the reader names in them. `goose_db_version` is checked for existence only. */
const REQUIRED_COLUMNS = /** @type {const} */ ([
  ['sessions', SESSION_COLUMNS],
  ['messages', MESSAGE_COLUMNS],
])

const NOT_TITLE_SESSION = "substr(id, 1, 6) <> 'title-'"
const NOT_TITLE_MESSAGE = "substr(session_id, 1, 6) <> 'title-'"

/** Every non-title session, with the columns the projector reads. */
export const SESSIONS_SQL = `SELECT ${SESSION_COLUMNS.join(', ')} FROM sessions WHERE ${NOT_TITLE_SESSION}`
/** One session by id, unless it is a title session. */
export const SESSION_SQL = `${SESSIONS_SQL} AND id = ?`
/** One session's messages in projection order. */
export const SESSION_MESSAGES_SQL = `SELECT rowid AS rowid, ${MESSAGE_COLUMNS.join(', ')} FROM messages`
  + ' WHERE session_id = ? ORDER BY created_at ASC, rowid ASC'
/**
 * Sessions with message rows above the rowid cursor and their largest rowid.
 * `NOT INDEXED` keeps the planner on the rowid range instead of walking
 * `idx_messages_session_id` to avoid the GROUP BY sort.
 *
 * @ref LLP 0573#cost [implements]: the new-row read is a rowid range SEARCH bounded by the cursor.
 */
export const NEW_ROWS_SQL = 'SELECT session_id, MAX(rowid) AS max_rowid FROM messages NOT INDEXED'
  + ` WHERE rowid > ? AND ${NOT_TITLE_MESSAGE} GROUP BY session_id`
/** Session metadata for candidate selection; a scan of the small sessions table, accepted in LLP 0573#cost. */
export const SESSION_META_SQL = `SELECT id, updated_at, message_count, parent_session_id FROM sessions WHERE ${NOT_TITLE_SESSION}`
/** One session's largest message rowid, a seek on `idx_messages_session_id`. */
export const SESSION_MAX_ROWID_SQL = 'SELECT MAX(rowid) AS max_rowid FROM messages WHERE session_id = ?'
/** The database's largest message rowid, the first-start cursor. */
export const MAX_ROWID_SQL = 'SELECT MAX(rowid) AS max_rowid FROM messages'

/**
 * Read-only handle onto one `crush.db`. Construct via {@link openCrushDb};
 * every read goes through the bounded busy retry and the schema check.
 */
export class CrushDb {
  /**
   * @param {DatabaseSync} db
   * @param {CrushBusyRetryOptions} [retryOpts]
   */
  constructor(db, retryOpts = {}) {
    this.db = db
    this.retryOpts = retryOpts
    /** @type {number | null} */
    this.checkedSchemaVersion = null
  }

  /**
   * Verify the migration table and every column the reader names, once per
   * `PRAGMA schema_version`. Additive columns and newer migrations pass.
   */
  checkSchema() {
    const version = Number(this.db.prepare('PRAGMA schema_version').get()?.schema_version)
    if (this.checkedSchemaVersion === version) return
    if (this.db.prepare('PRAGMA table_info(goose_db_version)').all().length === 0) {
      throw new CrushDbError('crush.db has no goose_db_version table', { code: 'schema_unsupported' })
    }
    for (const [table, required] of REQUIRED_COLUMNS) {
      const present = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(r => String(r.name)))
      if (present.size === 0) {
        throw new CrushDbError(`crush.db has no ${table} table`, { code: 'schema_unsupported' })
      }
      const absent = required.find(column => !present.has(column))
      if (absent) {
        throw new CrushDbError(`crush.db has no ${table}.${absent} column`, { code: 'schema_unsupported' })
      }
    }
    this.checkedSchemaVersion = version
  }

  /**
   * The database's largest message rowid, 0 when it has none: the cursor a
   * first start records so the poll never walks history.
   *
   * @returns {Promise<number>}
   */
  maxRowid() {
    return withBusyRetry(() => {
      this.checkSchema()
      return Number(this.db.prepare(MAX_ROWID_SQL).get()?.max_rowid ?? 0)
    }, this.retryOpts)
  }

  /**
   * The two reads a changed database gets, in one read transaction: the
   * sessions with rows above `cursor`, and every session's metadata.
   *
   * @param {number} cursor
   * @returns {Promise<CrushChanges>}
   */
  changes(cursor) {
    return withBusyRetry(() => {
      this.checkSchema()
      this.db.exec('BEGIN')
      try {
        const newRows = this.db.prepare(NEW_ROWS_SQL).all(cursor).map(row => ({
          session_id: String(row.session_id),
          max_rowid: Number(row.max_rowid),
        }))
        const sessions = this.db.prepare(SESSION_META_SQL).all().map(row => ({
          id: String(row.id),
          updated_at: Number(row.updated_at),
          message_count: Number(row.message_count),
          parent_session_id: textOrNull(row.parent_session_id),
        }))
        const maxRowid = Number(this.db.prepare(MAX_ROWID_SQL).get()?.max_rowid ?? 0)
        this.db.exec('COMMIT')
        return { newRows, sessions, maxRowid }
      } catch (error) {
        rollbackQuietly(this.db)
        throw error
      }
    }, this.retryOpts)
  }

  /**
   * One session's largest message rowid, 0 when it has none.
   *
   * @param {string} sessionId
   * @returns {Promise<number>}
   */
  sessionMaxRowid(sessionId) {
    return withBusyRetry(() => {
      this.checkSchema()
      return Number(this.db.prepare(SESSION_MAX_ROWID_SQL).get(sessionId)?.max_rowid ?? 0)
    }, this.retryOpts)
  }

  /**
   * Every non-title session, for the backfill and the sweep.
   *
   * @returns {Promise<CrushSessionRow[]>}
   */
  listSessions() {
    return withBusyRetry(() => {
      this.checkSchema()
      return this.db.prepare(SESSIONS_SQL).all().map(toSessionRow)
    }, this.retryOpts)
  }

  /**
   * One session's metadata and messages from one snapshot, with the
   * watermark mark the reconcile compares. Null for an absent or title
   * session.
   *
   * @ref LLP 0449#read-commit-guard [implements]: metadata and messages come from one read transaction.
   * @param {string} sessionId
   * @returns {Promise<CrushSessionSnapshot | null>}
   */
  readSessionSnapshot(sessionId) {
    return withBusyRetry(() => {
      this.checkSchema()
      this.db.exec('BEGIN')
      try {
        const sessionRow = this.db.prepare(SESSION_SQL).get(sessionId)
        const messages = sessionRow ? this.db.prepare(SESSION_MESSAGES_SQL).all(sessionId).map(toMessageRow) : []
        this.db.exec('COMMIT')
        if (!sessionRow) return null
        const session = toSessionRow(sessionRow)
        const hash = createHash('sha256').update(JSON.stringify(session))
        let maxRowid = 0
        for (const message of messages) {
          hash.update(JSON.stringify(message))
          if (message.rowid > maxRowid) maxRowid = message.rowid
        }
        const last = messages[messages.length - 1]
        return {
          session,
          messages,
          mark: {
            updated_at: session.updated_at,
            message_count: session.message_count,
            max_rowid: maxRowid,
            // @ref LLP 0573#reconciliation [implements]: open = the latest message is an unfinished assistant message.
            open: !!last && last.role === 'assistant' && last.finished_at == null,
            digest: hash.digest('hex'),
          },
        }
      } catch (error) {
        rollbackQuietly(this.db)
        throw error
      }
    }, this.retryOpts)
  }

  close() {
    this.db.close()
  }
}

/**
 * @param {Record<string, unknown>} row
 * @returns {CrushSessionRow}
 */
function toSessionRow(row) {
  return {
    id: String(row.id),
    parent_session_id: textOrNull(row.parent_session_id),
    title: textOrNull(row.title),
    message_count: Number(row.message_count),
    cost: Number(row.cost ?? 0),
    updated_at: Number(row.updated_at),
    created_at: Number(row.created_at),
  }
}

/**
 * @param {Record<string, unknown>} row
 * @returns {CrushMessageRow}
 */
function toMessageRow(row) {
  return {
    rowid: Number(row.rowid),
    id: String(row.id),
    session_id: String(row.session_id),
    role: String(row.role),
    parts: String(row.parts ?? '[]'),
    model: textOrNull(row.model),
    provider: textOrNull(row.provider),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    is_summary_message: Number(row.is_summary_message ?? 0) === 1,
  }
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function textOrNull(value) {
  return value == null ? null : String(value)
}

/** @param {DatabaseSync} db */
function rollbackQuietly(db) {
  try {
    db.exec('ROLLBACK')
  } catch {
    // no transaction open
  }
}

/**
 * Open one `crush.db` read-only.
 *
 * @param {string} dbPath
 * @param {CrushDbOptions} [opts]
 * @returns {CrushDb}
 */
export function openCrushDb(dbPath, opts = {}) {
  const { DatabaseSync } = loadSqliteModule(opts.requireFn)
  if (!existsSync(dbPath)) {
    throw new CrushDbError('no crush.db in the data dir', { code: 'missing' })
  }
  // @ref LLP 0573#status [implements]: every access failure becomes a typed,
  // path-free error, so a raw fs message never carries a project path into
  // status, and one bad database is counted rather than failing the tick.
  try {
    accessSync(dbPath, constants.R_OK)
  } catch (cause) {
    const code = /** @type {{ code?: unknown }} */ (cause)?.code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new CrushDbError('crush.db is not readable', { code: 'permission_denied', cause })
    }
    if (code === 'ENOENT') {
      throw new CrushDbError('no crush.db in the data dir', { code: 'missing', cause })
    }
    throw new CrushDbError('crush.db could not be opened read-only', { code: 'open_failed', cause })
  }
  /** @type {DatabaseSync} */
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (cause) {
    throw new CrushDbError('crush.db could not be opened read-only', { code: 'open_failed', cause })
  }
  return new CrushDb(db, { attempts: opts.attempts, delayMs: opts.delayMs, sleep: opts.sleep })
}
