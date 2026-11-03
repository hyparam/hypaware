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
 * @import { GooseSessionRow, GooseMessageRow, GooseSessionSnapshot, GooseBusyRetryOptions, GooseSessionsDbOptions } from './types.js'
 * @import { DatabaseSync } from 'node:sqlite'
 */

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
   * One session's row and messages, read in a single read transaction so
   * both describe the same committed state. Null when the session is gone or
   * `hidden`.
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
        return session ? { session, messages } : null
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
