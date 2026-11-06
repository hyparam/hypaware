// @ts-check

/**
 * Read-only reader over Mastra Code's `mastra.db` SQLite store. This is the
 * only module that touches the file; the projector, backfill and poll source
 * all go through it.
 *
 * @ref LLP 0586#sqlite [implements]: `node:sqlite` `DatabaseSync` opened
 *   `{ readOnly: true }`, never a write or checkpoint, a SQLite 3.45 floor
 *   for `json()` over JSONB, a bounded SQLITE_BUSY retry, and a table and
 *   column check that names what is missing.
 *
 * @import { MastraThreadRow, MastraMessageRow, MastraThreadSnapshot, MastraBusyRetryOptions, MastraDbOptions, MastraNewRows, MastraThreadCounts } from './types.js'
 * @import { DatabaseSync } from 'node:sqlite'
 */

import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

import { MastraDbError } from './errors.js'

/** Bounded SQLITE_BUSY retry attempts (including the first try), LLP 0586#sqlite. */
export const DEFAULT_BUSY_RETRY_ATTEMPTS = 5
/** Delay between SQLITE_BUSY retries in ms. */
export const DEFAULT_BUSY_RETRY_DELAY_MS = 20
/** The first SQLite release that reads JSONB through `json()`. */
export const MIN_SQLITE_VERSION = [3, 45]

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
 * Whether `err` is a `node:sqlite` SQLITE_BUSY / SQLITE_LOCKED error. Any
 * other error is not retryable and propagates immediately.
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
 * `MastraDbError` with `code: 'sqlite_busy'`.
 *
 * @template T
 * @param {() => T} fn
 * @param {MastraBusyRetryOptions} [opts]
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
  throw new MastraDbError(
    `mastra.db is locked (SQLITE_BUSY) after ${attempts} attempts`,
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
    throw new MastraDbError(
      'mastracode source requires Node >= 22.12 (node:sqlite builtin not available)',
      { code: 'sqlite_unavailable', cause: err }
    )
  }
}

/**
 * Whether a `sqlite_version()` string is at least {@link MIN_SQLITE_VERSION}.
 *
 * @param {string} version
 * @returns {boolean}
 */
export function sqliteVersionSupported(version) {
  const [major, minor] = String(version).split('.').map(Number)
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
  return major > MIN_SQLITE_VERSION[0] || (major === MIN_SQLITE_VERSION[0] && minor >= MIN_SQLITE_VERSION[1])
}

// @ref LLP 0586#owner-decisions [implements]: D7, the two tables and the
// columns read from them are named here and in every query; `resourceId` is
// never read.
const THREAD_COLUMNS = ['id', 'title', 'metadata', 'createdAt', 'updatedAt']
const MESSAGE_COLUMNS = ['id', 'thread_id', 'content', 'role', 'type', 'createdAt']
/** Every table the reader names and the columns it reads from each. */
export const READ_TABLES = /** @type {const} */ ({ mastra_threads: THREAD_COLUMNS, mastra_messages: MESSAGE_COLUMNS })

/** Messages above the rowid cursor: a rowid range search on the table. */
export const NEW_ROWS_SQL = 'SELECT rowid AS row_id, thread_id FROM mastra_messages WHERE rowid > ? ORDER BY rowid ASC'
/** Every thread's id and `updatedAt`: a scan of small rows, without `metadata` (LLP 0586#cost). */
export const THREADS_SQL = 'SELECT id, updatedAt FROM mastra_threads'
/** One thread's message count and largest rowid: a search of `idx_messages_thread_created_at`. */
export const THREAD_COUNTS_SQL = 'SELECT COUNT(*) AS message_count, MAX(rowid) AS max_rowid FROM mastra_messages WHERE thread_id = ?'
/** The SQLite library version, checked on open. */
export const SQLITE_VERSION_SQL = 'SELECT sqlite_version() AS version'
export const MAX_ROWID_SQL = 'SELECT MAX(rowid) AS max_rowid FROM mastra_messages'
export const MAX_UPDATED_SQL = 'SELECT MAX(updatedAt) AS max_updated_at FROM mastra_threads'
// `metadata` is SQLite JSONB, so it is read through `json()`.
export const THREAD_SQL = 'SELECT id, title, json(metadata) AS metadata, createdAt, updatedAt FROM mastra_threads WHERE id = ?'
export const MESSAGES_SQL = 'SELECT rowid AS row_id, id, thread_id, content, role, type, createdAt FROM mastra_messages WHERE thread_id = ? ORDER BY createdAt ASC, rowid ASC'

/**
 * Read-only handle onto one Mastra Code `mastra.db`. Construct via
 * {@link openMastraDb}; every read goes through the bounded busy retry and
 * the table and column check.
 */
export class MastraDb {
  /**
   * @param {DatabaseSync} db
   * @param {MastraBusyRetryOptions} [retryOpts]
   */
  constructor(db, retryOpts = {}) {
    /** @type {DatabaseSync} */
    this.db = db
    /** @type {MastraBusyRetryOptions} */
    this.retryOpts = retryOpts
    /** @type {number | undefined} */
    this.checkedSchemaVersion = undefined
  }

  /**
   * Fail with `schema_unsupported` naming the first table or column the
   * store lacks. The check runs once per SQLite schema cookie, so a Mastra
   * Code migration between reads is seen on the next one; additive columns
   * and tables are ignored.
   */
  checkSchema() {
    const schemaVersion = Number(this.db.prepare('PRAGMA schema_version').get()?.schema_version)
    if (this.checkedSchemaVersion === schemaVersion) return
    for (const [table, required] of Object.entries(READ_TABLES)) {
      const present = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)))
      if (present.size === 0) {
        throw new MastraDbError(`mastra.db has no ${table} table`, { code: 'schema_unsupported' })
      }
      const absent = required.find(column => !present.has(column))
      if (absent) {
        throw new MastraDbError(`mastra.db has no ${table}.${absent} column`, { code: 'schema_unsupported' })
      }
    }
    this.checkedSchemaVersion = schemaVersion
  }

  /**
   * The threads with a message above `afterRowid`, and the largest rowid
   * seen, which is `afterRowid` when there are none.
   *
   * @param {number} afterRowid
   * @returns {Promise<MastraNewRows>}
   */
  async newRows(afterRowid) {
    return withBusyRetry(() => {
      this.checkSchema()
      /** @type {Set<string>} */
      const threadIds = new Set()
      let maxRowid = afterRowid
      for (const row of this.db.prepare(NEW_ROWS_SQL).iterate(afterRowid)) {
        threadIds.add(String(row.thread_id))
        maxRowid = Number(row.row_id)
      }
      return { threadIds: [...threadIds], maxRowid }
    }, this.retryOpts)
  }

  /**
   * Every thread's id and `updatedAt`.
   *
   * @returns {Promise<{ id: string, updatedAt: string }[]>}
   */
  async listThreads() {
    return withBusyRetry(() => {
      this.checkSchema()
      return this.db.prepare(THREADS_SQL).all().map(row => ({ id: String(row.id), updatedAt: String(row.updatedAt) }))
    }, this.retryOpts)
  }

  /**
   * One thread's message count and largest rowid, 0 and 0 when it has none.
   *
   * @param {string} threadId
   * @returns {Promise<MastraThreadCounts>}
   */
  async threadCounts(threadId) {
    return withBusyRetry(() => {
      this.checkSchema()
      const row = this.db.prepare(THREAD_COUNTS_SQL).get(threadId)
      return { message_count: Number(row?.message_count ?? 0), max_rowid: Number(row?.max_rowid ?? 0) }
    }, this.retryOpts)
  }

  /**
   * The largest message rowid and thread `updatedAt` in the store, the
   * first-start baseline (LLP 0586#reconciliation).
   *
   * @returns {Promise<{ maxRowid: number, maxUpdatedAt: string | null }>}
   */
  async maxima() {
    return withBusyRetry(() => {
      this.checkSchema()
      this.db.exec('BEGIN')
      try {
        const maxRowid = Number(this.db.prepare(MAX_ROWID_SQL).get()?.max_rowid ?? 0)
        const maxUpdatedAt = this.db.prepare(MAX_UPDATED_SQL).get()?.max_updated_at
        this.db.exec('COMMIT')
        return { maxRowid, maxUpdatedAt: maxUpdatedAt == null ? null : String(maxUpdatedAt) }
      } catch (error) {
        rollbackQuietly(this.db)
        throw error
      }
    }, this.retryOpts)
  }

  /**
   * One thread's row and messages, read in a single read transaction so
   * both describe the same committed state, with the watermark entry they
   * settle. The digest covers every selected column of the thread and its
   * messages, so an in-place rewrite or a pruned message changes it. Null
   * when the thread is gone.
   * @ref LLP 0449#read-commit-guard [implements]: metadata and messages come from one snapshot.
   *
   * @param {string} threadId
   * @returns {Promise<MastraThreadSnapshot | null>}
   */
  async readThreadSnapshot(threadId) {
    return withBusyRetry(() => {
      this.checkSchema()
      this.db.exec('BEGIN')
      try {
        const thread = /** @type {MastraThreadRow | undefined} */ (/** @type {unknown} */ (
          this.db.prepare(THREAD_SQL).get(threadId)))
        const messages = thread ? /** @type {MastraMessageRow[]} */ (/** @type {unknown} */ (
          this.db.prepare(MESSAGES_SQL).all(threadId))) : []
        this.db.exec('COMMIT')
        if (!thread) return null
        const hash = createHash('sha256').update(JSON.stringify(thread))
        let maxRowid = 0
        for (const message of messages) {
          hash.update(JSON.stringify(message))
          if (Number(message.row_id) > maxRowid) maxRowid = Number(message.row_id)
        }
        const mark = {
          updated_at: thread.updatedAt,
          message_count: messages.length,
          max_rowid: maxRowid,
          digest: hash.digest('hex'),
        }
        return { thread, messages, mark }
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
 * Open one `mastra.db` read-only and check its SQLite can read JSONB.
 *
 * @param {string} dbPath
 * @param {MastraDbOptions} [opts]
 * @returns {MastraDb}
 * @throws {MastraDbError} `sqlite_unavailable`, `missing`,
 *   `permission_denied`, `open_failed` or `sqlite_unsupported`.
 */
export function openMastraDb(dbPath, opts = {}) {
  const { DatabaseSync } = loadSqliteModule(opts.requireFn)
  if (!existsSync(dbPath)) {
    throw new MastraDbError('no mastra.db at the resolved path', { code: 'missing' })
  }
  // @ref LLP 0586#privacy [implements]: every access failure becomes a typed,
  // path-free error, so a raw fs message never carries the database path
  // into logs or status.
  try {
    accessSync(dbPath, constants.R_OK)
  } catch (cause) {
    const code = /** @type {{ code?: unknown }} */ (cause)?.code
    if (code === 'EACCES' || code === 'EPERM') {
      throw new MastraDbError('mastra.db is not readable', { code: 'permission_denied', cause })
    }
    if (code === 'ENOENT') {
      throw new MastraDbError('no mastra.db at the resolved path', { code: 'missing', cause })
    }
    throw new MastraDbError('mastra.db could not be opened read-only', { code: 'open_failed', cause })
  }
  /** @type {DatabaseSync} */
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (cause) {
    throw new MastraDbError('mastra.db could not be opened read-only', { code: 'open_failed', cause })
  }
  /** @type {string} */
  let version
  try {
    version = String(db.prepare(SQLITE_VERSION_SQL).get()?.version)
  } catch (cause) {
    db.close()
    throw new MastraDbError('mastra.db could not be opened read-only', { code: 'open_failed', cause })
  }
  if (!sqliteVersionSupported(version)) {
    db.close()
    throw new MastraDbError(`SQLite ${version} cannot read Mastra Code's JSONB metadata (needs 3.45 or newer)`, { code: 'sqlite_unsupported' })
  }
  return new MastraDb(db, { attempts: opts.attempts, delayMs: opts.delayMs, sleep: opts.sleep })
}
