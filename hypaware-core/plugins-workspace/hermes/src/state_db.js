// @ts-check

/**
 * Read-only reader over hermes's `state.db` SQLite store. This is the only
 * module that touches the file; the projector (T2), backfill (T3), and poll
 * source (T4) all go through it.
 *
 * @ref LLP 0119 [implements]: capture pulls read-only from hermes's own
 *   canonical store; hermes is never modified, configured, or proxied.
 * @ref LLP 0122#sqlite [implements]: `node:sqlite` `DatabaseSync` opened
 *   `{ readOnly: true }`, a one-line activation probe that turns a missing
 *   builtin into a clear refusal instead of a crash, and a short bounded
 *   SQLITE_BUSY retry so a persistently locked store degrades status
 *   rather than throwing raw into the daemon.
 * @ref LLP 0449#detection [implements]: per-session payload digests replace the append-only watermark.
 *
 * @import { HermesSessionRow, HermesMessageRow, HermesWatermarkState, HermesChangedSession, HermesBusyRetryOptions, HermesStateDbOptions } from './types.js'
 * @import { DatabaseSync } from 'node:sqlite'
 */

import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

import { HermesStateDbError } from './errors.js'

/** Bounded SQLITE_BUSY retry attempts (including the first try), LLP 0122#sqlite. */
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
 * Whether `err` is a `node:sqlite` SQLITE_BUSY / SQLITE_LOCKED error, the
 * two codes a short-lived writer (hermes itself, mid-append) can produce
 * against a WAL-mode store. Any other error (corruption, schema mismatch,
 * a plain bug) is not retryable and must propagate immediately.
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
 * Run `fn`, retrying on SQLITE_BUSY / SQLITE_LOCKED up to a bounded number
 * of attempts with a delay between them. Any non-busy error, or the final
 * busy error once attempts are exhausted, propagates as a
 * `HermesStateDbError` with `code: 'sqlite_busy'` (busy) or unchanged
 * (non-busy).
 *
 * @ref LLP 0122#sqlite [implements]: "short bounded retry" for SQLITE_BUSY;
 *   exhaustion is a degrade-status signal for the poll source (T4), not an
 *   uncaught throw into the daemon.
 *
 * @template T
 * @param {() => T} fn
 * @param {HermesBusyRetryOptions} [opts]
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
  throw new HermesStateDbError(
    `hermes state.db is locked (SQLITE_BUSY) after ${attempts} attempts`,
    { code: 'sqlite_busy', cause: lastErr }
  )
}

/**
 * @ref LLP 0125 [implements]: the activation probe. Absent builtin (Node
 * < 22.5, or an EOL runtime that ignored the `engines` floor) throws a
 * clear refusal instead of letting a raw `require` failure crash the
 * caller with an opaque module-not-found error.
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
    throw new HermesStateDbError(
      'hermes source requires Node >= 22.12 (node:sqlite builtin not available)',
      { code: 'sqlite_unavailable', cause: err }
    )
  }
}

const SESSION_COLUMNS = [
  'id', 'source', 'model', 'cwd', 'parent_session_id', 'started_at', 'ended_at',
  'end_reason', 'billing_provider', 'billing_base_url', 'system_prompt',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'reasoning_tokens', 'estimated_cost_usd', 'actual_cost_usd', 'api_call_count',
].join(', ')

const MESSAGE_COLUMNS = [
  'id', 'session_id', 'role', 'content', 'tool_calls', 'tool_name',
  'tool_call_id', 'reasoning', 'timestamp', 'token_count', 'finish_reason',
].join(', ')

/**
 * Read-only handle onto one hermes `state.db`. Construct via
 * {@link openHermesStateDb}; every read goes through the bounded busy
 * retry.
 */
export class HermesStateDb {
  /**
   * @param {DatabaseSync} db
   * @param {HermesBusyRetryOptions} [retryOpts]
   */
  constructor(db, retryOpts = {}) {
    /** @type {DatabaseSync} */
    this.db = db
    /** @type {HermesBusyRetryOptions} */
    this.retryOpts = retryOpts
    /** @type {number | undefined} */
    this.lastDataVersion = undefined
    /** @type {HermesChangedSession[] | undefined} */
    this.snapshot = undefined
  }

  /**
   * All sessions, oldest first.
   *
   * @returns {Promise<HermesSessionRow[]>}
   */
  async listSessions() {
    return withBusyRetry(
      () => /** @type {HermesSessionRow[]} */ (/** @type {unknown} */ (
        this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY id ASC`).all()
      )),
      this.retryOpts
    )
  }

  visibleClause() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(messages)').all().map(row => String(row.name)))
    return columns.has('active')
      ? (columns.has('compacted') ? '(active = 1 OR compacted = 1)' : 'active = 1')
      : '1 = 1'
  }

  /**
   * All messages for one session, oldest first.
   *
   * @param {string | number} sessionId
   * @returns {Promise<HermesMessageRow[]>}
   */
  async listMessagesForSession(sessionId) {
    return withBusyRetry(
      () => /** @type {HermesMessageRow[]} */ (/** @type {unknown} */ (
        this.db
          .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ? AND ${this.visibleClause()} ORDER BY id ASC`)
          .all(sessionId)
      )),
      this.retryOpts
    )
  }

  /**
   * Sessions whose visible content or metadata differs from the last
   * successfully reconciled snapshot. Stream payloads only after a database
   * commit; preserve just digests between polls.
   * @ref LLP 0449#detection [implements]: edits and rewinds need not advance IDs
   * @param {HermesWatermarkState} [watermarks]
   * @returns {Promise<HermesChangedSession[]>}
   */
  async listChangedSessions(watermarks = {}) {
    // @ref LLP 0449#detection [implements]: unchanged databases cost a pragma,
    // not a payload scan. A new connection always seeds from the actual store.
    const version = Number(this.db.prepare('PRAGMA data_version').get()?.data_version)
    if (this.lastDataVersion !== version || !this.snapshot) {
      this.snapshot = await withBusyRetry(() => {
        this.db.exec('BEGIN')
        try {
          const statement = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ? AND ${this.visibleClause()} ORDER BY id ASC`)
          // Stream the sessions too: a mark is small, but a session row carries
          // its whole `system_prompt`, and `.all()` would hold every one of
          // them resident for the length of the full-history hash.
          const marks = []
          for (const session of this.db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY id ASC`).iterate()) {
            const hash = createHash('sha256').update(JSON.stringify(session))
            let maxMessageId = 0
            for (const message of statement.iterate(session.id)) {
              hash.update(JSON.stringify(message))
              maxMessageId = Math.max(maxMessageId, Number(message.id))
            }
            marks.push({ session_id: session.id, reason: 'changed', max_message_id: maxMessageId,
              ended_at: session.ended_at ?? null, fingerprint: hash.digest('hex') })
          }
          this.db.exec('COMMIT')
          return /** @type {HermesChangedSession[]} */ (/** @type {unknown} */ (marks))
        } catch (error) {
          this.db.exec('ROLLBACK')
          throw error
        }
      }, this.retryOpts)
      this.lastDataVersion = version
    }
    const changed = this.snapshot.filter(row => {
      const prior = watermarks[String(row.session_id)]
      return !prior || prior.fingerprint !== row.fingerprint
    }).map(row => ({ ...row,
      reason: /** @type {HermesChangedSession['reason']} */ (row.max_message_id > (watermarks[String(row.session_id)]?.max_message_id ?? 0)
        ? 'new_messages' : row.ended_at != null && watermarks[String(row.session_id)]?.ended_at == null ? 'ended' : 'changed'),
    }))
    return changed
  }

  /** Close the underlying connection. Safe to call once; a second call throws per `node:sqlite`. */
  close() {
    this.db.close()
  }
}

/**
 * Open `dbPath` read-only and return a {@link HermesStateDb}.
 *
 * @ref LLP 0119 [implements]: read-only open, never a write path.
 * @ref LLP 0122#sqlite [implements]: activation probe before touching the
 *   file; `{ readOnly: true }` so the connection cannot disturb hermes's
 *   WAL (spec R5).
 *
 * @param {string} dbPath
 * @param {HermesStateDbOptions} [opts]
 * @returns {Promise<HermesStateDb>}
 * @throws {HermesStateDbError} `sqlite_unavailable` (no `node:sqlite`),
 *   `missing` (no file at `dbPath`), or `open_failed` (file present but
 *   SQLite could not open it).
 */
export async function openHermesStateDb(dbPath, opts = {}) {
  const { DatabaseSync } = loadSqliteModule(opts.requireFn)

  if (!existsSync(dbPath)) {
    throw new HermesStateDbError(`no hermes state.db at ${dbPath}`, { code: 'missing' })
  }

  /** @type {DatabaseSync} */
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (err) {
    throw new HermesStateDbError(`failed to open hermes state.db at ${dbPath}`, {
      code: 'open_failed',
      cause: err,
    })
  }

  return new HermesStateDb(db, { attempts: opts.attempts, delayMs: opts.delayMs, sleep: opts.sleep })
}
