// @ts-check

/**
 * Typed error for the goose `sessions.db` reader. `code` is what callers
 * branch on rather than parsing `message`, and it is the `error_kind` the
 * source reports (LLP 0570#status):
 *
 * - `sqlite_unavailable`: the `node:sqlite` builtin is missing (Node
 *   < 22.5, or an EOL runtime that ignored the `engines` floor).
 * - `missing`: no file exists at the resolved `sessions_db` path.
 * - `permission_denied`: the file exists but cannot be read.
 * - `open_failed`: SQLite could not open the file read-only (corruption,
 *   not a SQLite file).
 * - `sqlite_busy`: every bounded retry attempt still hit SQLITE_BUSY /
 *   SQLITE_LOCKED.
 * - `schema_unsupported`: a column the reader needs is absent; the message
 *   names it.
 *
 * @ref LLP 0570#sqlite [implements]: a locked store or an unsupported schema
 *   surfaces as this error so the source degrades status rather than
 *   throwing raw into the daemon.
 *
 * @import { GooseSessionsDbErrorCode } from './types.js'
 */
export class GooseSessionsDbError extends Error {
  /**
   * @param {string} message
   * @param {{ code: GooseSessionsDbErrorCode, cause?: unknown }} opts
   */
  constructor(message, opts) {
    super(message)
    this.name = 'GooseSessionsDbError'
    /** @type {GooseSessionsDbErrorCode} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}
