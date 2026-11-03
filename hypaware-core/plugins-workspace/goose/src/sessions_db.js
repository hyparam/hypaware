// @ts-check

/**
 * Read-only reader over Goose's `sessions.db` SQLite store. This is the only
 * module that touches the file; the projector, backfill and poll source all
 * go through it.
 *
 * @ref LLP 0570#sqlite [implements]: `node:sqlite` `DatabaseSync` opened
 *   `{ readOnly: true }`, never a write or checkpoint, a bounded SQLITE_BUSY
 *   retry, and a required-column check that names what is missing.
 *
 * @import { GooseSessionRow, GooseMessageRow, GooseSessionSnapshot, GooseBusyRetryOptions, GooseSessionsDbOptions, GooseChanges } from './types.js'
 * @import { DatabaseSync } from 'node:sqlite'
 */

import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

import { GooseSessionsDbError } from './errors.js'

/** Bounded SQLITE_BUSY retry attempts (including the first try), LLP 0570#sqlite. */
export const DEFAULT_BUSY_RETRY_ATTEMPTS = 5
/** Delay between SQLITE_BUSY retries in ms. */
export const DEFAULT_BUSY_RETRY_DELAY_MS = 20

// SQLite primary result codes node:sqlite surfaces as `err.errcode`.
const SQLITE_BUSY = 5
const SQLITE_LOCKED = 6

/**
 * @param {(ms: number) => Promise<void>} [sleep]
 * @returns {(ms: number) => Promise<void>}
 */
function resolveSleep(sleep) {
  return sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
}

/**
 * Whether `err` is a `node:sqlite` SQLITE_BUSY / SQLITE_LOCKED error, the two
 * codes Goose's own writer can produce against its WAL-mode store. Any other
 * error is not retryable and propagates immediately.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryableBusyError(err) {
  if (!err || typeof err !== 'object') return false
  const candidate = /** @type {{ code?: unknown, errcode?: unknown }} */ (err)
  if (candidate.code !== 'ERR_SQLITE_ERROR') return false
  return candidate.errcode === SQLITE_BUSY || candidate.errcode === SQLITE_LOCKED
}

/**
 * Run `fn`, retrying on SQLITE_BUSY / SQLITE_LOCKED up to a bounded number of
 * attempts. A non-busy error propagates unchanged; exhaustion throws a
 * `GooseSessionsDbError` with `code: 'sqlite_busy'`.
 *
 * @template T
 * @param {() => T} fn
 * @param {GooseBusyRetryOptions} [opts]
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
  throw new GooseSessionsDbError(
    `goose sessions.db is locked (SQLITE_BUSY) after ${attempts} attempts`,
    { code: 'sqlite_busy', cause: lastErr }
  )
}

/**
 * Load the `node:sqlite` builtin, turning its absence into a clear refusal
 * instead of an opaque module-not-found crash.
 *
 * @param {(id: string) => unknown} [requireFn] injectable for tests
 * @returns {{ DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSync }}
 */
export function loadSqliteModule(requireFn) {
  const doRequire = requireFn ?? createRequire(import.meta.url)
  try {
    return /** @type {{ DatabaseSync: new (path: string, options?: Record<string, unknown>) => DatabaseSync }} */ (
      doRequire('node:sqlite')
    )
  } catch (err) {
    throw new GooseSessionsDbError(
      'goose source requires Node >= 22.12 (node:sqlite builtin not available)',
      { code: 'sqlite_unavailable', cause: err }
    )
  }
}

const SESSION_COLUMNS = [
  'id', 'name', 'session_type', 'working_dir', 'created_at', 'updated_at',
  'provider_name', 'model_config_json', 'parent_session_id',
]

const MESSAGE_COLUMNS = [
  'id', 'message_id', 'session_id', 'role', 'content_json', 'created_timestamp',
  'metadata_json',
]

const SESSION_SELECT = `SELECT ${SESSION_COLUMNS.join(', ')} FROM sessions`
const MESSAGE_SELECT = `SELECT ${MESSAGE_COLUMNS.join(', ')} FROM messages WHERE session_id = ? ORDER BY id ASC`

/**
 * Sessions with a message above the id cursor, with their first new id.
 * The derived table walks only `messages.id > ?` by its rowid: without
 * `NOT INDEXED` SQLite prefers a full scan of a `session_id` index, which
 * grows with history instead of with what changed.
 * @ref LLP 0570#cost [implements]: both range reads are SEARCHes bounded by the cursors.
 */
export const NEW_MESSAGES_SQL = 'SELECT n.session_id AS session_id, n.first_id AS first_id, s.updated_at AS updated_at'
  + ' FROM (SELECT m.session_id AS session_id, MIN(m.id) AS first_id FROM messages m NOT INDEXED WHERE m.id > ? GROUP BY m.session_id) n'
  + " JOIN sessions s ON s.id = n.session_id WHERE s.session_type != 'hidden'"
/** Sessions whose `updated_at` is at or above the time cursor (inclusive), oldest first. */
export const UPDATED_SQL = "SELECT id, updated_at FROM sessions WHERE updated_at >= ? AND session_type != 'hidden' ORDER BY updated_at ASC"
/** One session's largest message id, an index seek. */
export const MAX_ID_SQL = 'SELECT MAX(id) AS max_id FROM messages WHERE session_id = ?'
const MAX_ALL_ID_SQL = 'SELECT MAX(id) AS max_id FROM messages'
const MAX_UPDATED_SQL = 'SELECT MAX(updated_at) AS max_updated_at FROM sessions'

/**
 * Read-only handle onto one Goose `sessions.db`. Construct via
 * {@link openGooseSessionsDb}; every read goes through the bounded busy
 * retry and the required-column check.
 */
export class GooseSessionsDb {
  /**
   * @param {DatabaseSync} db
   * @param {GooseBusyRetryOptions} [retryOpts]
   */
  constructor(db, retryOpts = {}) {
    /** @type {DatabaseSync} */
    this.db = db
    /** @type {GooseBusyRetryOptions} */
    this.retryOpts = retryOpts
    /** @type {number | undefined} */
    this.checkedSchemaVersion = undefined
  }

  /**
   * Fail with `schema_unsupported` naming the first required column the
   * store lacks. The check runs once per SQLite schema cookie, so a Goose
   * migration between polls is seen on the next read; additive columns are
   * ignored.
   */
  checkSchema() {
    const schemaVersion = Number(this.db.prepare('PRAGMA schema_version').get()?.schema_version)
    if (this.checkedSchemaVersion === schemaVersion) return
    for (const [table, required] of /** @type {const} */ ([['sessions', SESSION_COLUMNS], ['messages', MESSAGE_COLUMNS]])) {
      const present = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)))
      const absent = required.find(column => !present.has(column))
      if (absent) {
        throw new GooseSessionsDbError(`goose sessions.db has no ${table}.${absent} column`, { code: 'schema_unsupported' })
      }
    }
    this.checkedSchemaVersion = schemaVersion
  }

  /**
   * Every session that is not `hidden`, oldest first, for discovery.
   * @ref LLP 0570#sqlite [implements]: D1, hidden sessions are skipped in the query.
   *
   * @returns {Promise<GooseSessionRow[]>}
   */
  async listSessions() {
    return withBusyRetry(() => {
      this.checkSchema()
      return /** @type {GooseSessionRow[]} */ (/** @type {unknown} */ (
        this.db.prepare(`${SESSION_SELECT} WHERE session_type != 'hidden' ORDER BY created_at ASC, id ASC`).all()
      ))
    }, this.retryOpts)
  }

  /**
   * `PRAGMA data_version`. The value is local to this connection: it changes
   * when another connection commits, and means nothing across a reopen.
   *
   * @returns {Promise<number>}
   */
  async dataVersion() {
    return withBusyRetry(() => Number(this.db.prepare('PRAGMA data_version').get()?.data_version), this.retryOpts)
  }

  /**
   * The candidate sessions above both cursors and the current maxima, read
   * in one transaction so the maxima cover exactly what the candidates saw.
   * A null `cursorId` reads every message and a null `cursorUpdatedAt` every
   * session; the source never passes them on a first start.
   *
   * @param {number | null} cursorId
   * @param {string | null} cursorUpdatedAt
   * @returns {Promise<GooseChanges>}
   */
  async detectChanges(cursorId, cursorUpdatedAt) {
    return withBusyRetry(() => {
      this.checkSchema()
      this.db.exec('BEGIN')
      try {
        const newMessages = this.db.prepare(NEW_MESSAGES_SQL).all(cursorId ?? 0).map(row => ({
          session_id: String(row.session_id),
          first_id: Number(row.first_id),
          updated_at: textOrNull(row.updated_at),
        }))
        const updated = this.db.prepare(UPDATED_SQL).all(cursorUpdatedAt ?? '').map(row => ({
          id: String(row.id),
          updated_at: textOrNull(row.updated_at),
        }))
        const maxima = this.readMaxima()
        this.db.exec('COMMIT')
        return { newMessages, updated, ...maxima }
      } catch (error) {
        rollbackQuietly(this.db)
        throw error
      }
    }, this.retryOpts)
  }

  /**
   * The largest message id and `updated_at` in the store, the first-start
   * baseline (LLP 0570#reconciliation).
   *
   * @returns {Promise<{ maxId: number | null, maxUpdatedAt: string | null }>}
   */
  async maxima() {
    return withBusyRetry(() => {
      this.checkSchema()
      return this.readMaxima()
    }, this.retryOpts)
  }

  /** @returns {{ maxId: number | null, maxUpdatedAt: string | null }} */
  readMaxima() {
    const maxId = this.db.prepare(MAX_ALL_ID_SQL).get()?.max_id
    const maxUpdatedAt = this.db.prepare(MAX_UPDATED_SQL).get()?.max_updated_at
    return { maxId: maxId == null ? null : Number(maxId), maxUpdatedAt: textOrNull(maxUpdatedAt) }
  }

  /**
   * One session's largest message id, 0 when it has none.
   *
   * @param {string} sessionId
   * @returns {Promise<number>}
   */
  async maxMessageId(sessionId) {
    return withBusyRetry(() => Number(this.db.prepare(MAX_ID_SQL).get(sessionId)?.max_id ?? 0), this.retryOpts)
  }

  /**
   * Sessions with `updated_at` exactly `updatedAt`, with their largest
   * message id: the first-start baseline seeds these, since the inclusive
   * time cursor reads them again on the next tick.
   *
   * @param {string} updatedAt
   * @returns {Promise<{ id: string, updated_at: string, max_id: number }[]>}
   */
  async sessionsAt(updatedAt) {
    return withBusyRetry(() => this.db.prepare(
      "SELECT s.id AS id, (SELECT MAX(m.id) FROM messages m WHERE m.session_id = s.id) AS max_id FROM sessions s WHERE s.updated_at = ? AND s.session_type != 'hidden'"
    ).all(updatedAt).map(row => ({ id: String(row.id), updated_at: updatedAt, max_id: Number(row.max_id ?? 0) })), this.retryOpts)
  }

  /**
   * One session's row and messages, read in a single read transaction so
   * both describe the same committed state, with the watermark entry they
   * settle. The digest covers every selected column of the session and its
   * messages, so an in-place edit or a truncation changes it. Null when the
   * session is gone or `hidden`.
   * @ref LLP 0449#read-commit-guard [implements]: metadata and messages come from one snapshot.
   *
   * @param {string} sessionId
   * @returns {Promise<GooseSessionSnapshot | null>}
   */
  async readSessionSnapshot(sessionId) {
    return withBusyRetry(() => {
      this.checkSchema()
      this.db.exec('BEGIN')
      try {
        const session = /** @type {GooseSessionRow | undefined} */ (/** @type {unknown} */ (
          this.db.prepare(`${SESSION_SELECT} WHERE id = ? AND session_type != 'hidden'`).get(sessionId)))
        const messages = session ? /** @type {GooseMessageRow[]} */ (/** @type {unknown} */ (
          this.db.prepare(MESSAGE_SELECT).all(sessionId))) : []
        this.db.exec('COMMIT')
        if (!session) return null
        const hash = createHash('sha256').update(JSON.stringify(session))
        for (const message of messages) hash.update(JSON.stringify(message))
        const mark = {
          updated_at: session.updated_at,
          max_id: messages.length ? Number(messages[messages.length - 1].id) : 0,
          digest: hash.digest('hex'),
        }
        return { session, messages, mark }
      } catch (error) {
        rollbackQuietly(this.db)
        throw error
      }
    }, this.retryOpts)
  }

  /** Close the underlying connection. Safe to call once; a second call throws per `node:sqlite`. */
  close() {
    this.db.close()
  }
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function textOrNull(value) {
  return value == null ? null : String(value)
}

/**
 * Best-effort recovery ROLLBACK for a read transaction that threw. SQLite may
 * already have ended the transaction itself, and that ROLLBACK failure must
 * not replace the error the caller rethrows.
 * @param {DatabaseSync} db
 */
function rollbackQuietly(db) {
  try {
    db.exec('ROLLBACK')
  } catch {
    // The transaction is already gone; the caller rethrows the original error.
  }
}

/**
 * Open `dbPath` read-only and return a {@link GooseSessionsDb}. Errors may
 * name `dbPath`, never a session's `working_dir` (LLP 0570#privacy).
 *
 * @param {string} dbPath
 * @param {GooseSessionsDbOptions} [opts]
 * @returns {Promise<GooseSessionsDb>}
 * @throws {GooseSessionsDbError} `sqlite_unavailable`, `missing`,
 *   `permission_denied` or `open_failed`.
 */
export async function openGooseSessionsDb(dbPath, opts = {}) {
  const { DatabaseSync } = loadSqliteModule(opts.requireFn)
  if (!existsSync(dbPath)) {
    throw new GooseSessionsDbError(`no goose sessions.db at ${dbPath}`, { code: 'missing' })
  }
  try {
    accessSync(dbPath, constants.R_OK)
  } catch (err) {
    const code = /** @type {{ code?: unknown }} */ (err).code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new GooseSessionsDbError(`cannot read the goose sessions.db at ${dbPath}`, { code: 'permission_denied', cause: err })
    }
    throw err
  }
  /** @type {DatabaseSync} */
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (err) {
    throw new GooseSessionsDbError(`failed to open goose sessions.db at ${dbPath}`, {
      code: 'open_failed',
      cause: err,
    })
  }
  return new GooseSessionsDb(db, { attempts: opts.attempts, delayMs: opts.delayMs, sleep: opts.sleep })
}
