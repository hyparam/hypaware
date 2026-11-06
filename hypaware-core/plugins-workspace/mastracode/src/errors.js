// @ts-check

/**
 * Typed error for the Mastra Code `mastra.db` reader. `code` is what callers
 * branch on rather than parsing `message`, and it is the `error_kind` the
 * source reports (LLP 0586#status):
 *
 * - `sqlite_unavailable`: the `node:sqlite` builtin is missing (Node
 *   before 22.13, where it is absent or behind a flag).
 * - `sqlite_unsupported`: the bundled SQLite is older than 3.45 and cannot
 *   read JSONB through `json()`.
 * - `missing`: no file exists at the resolved database path.
 * - `permission_denied`: the file exists but cannot be read.
 * - `open_failed`: SQLite could not open the file read-only (corruption,
 *   not a SQLite file).
 * - `sqlite_busy`: every bounded retry attempt still hit SQLITE_BUSY /
 *   SQLITE_LOCKED.
 * - `schema_unsupported`: a table or column the reader needs is absent; the
 *   message names it.
 * - `remote_store_unsupported`: `MASTRA_DB_URL` is set, so Mastra Code
 *   writes to a remote store and no local file is read.
 *
 * @ref LLP 0586#sqlite [implements]: a locked store, an old SQLite or an
 *   unsupported schema surfaces as this error so the source degrades status
 *   rather than throwing raw into the daemon.
 *
 * @import { MastraDbErrorCode } from './types.js'
 */
export class MastraDbError extends Error {
  /**
   * @param {string} message
   * @param {{ code: MastraDbErrorCode, cause?: unknown }} opts
   */
  constructor(message, opts) {
    super(message)
    this.name = 'MastraDbError'
    /** @type {MastraDbErrorCode} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}
