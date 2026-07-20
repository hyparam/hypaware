// @ts-check

/**
 * Typed error for the hermes `state.db` reader (`src/state_db.js`). `code`
 * is what callers branch on rather than parsing `message`:
 *
 * - `sqlite_unavailable`: the `node:sqlite` builtin is missing (Node
 *   < 22.5, or an EOL runtime that ignored the `engines` floor).
 * - `missing`: no file exists at the configured `state_db` path.
 * - `open_failed`: the file exists but SQLite could not open it read-only
 *   (permissions, corruption, not a SQLite file).
 * - `sqlite_busy`: every bounded retry attempt still hit SQLITE_BUSY /
 *   SQLITE_LOCKED.
 *
 * @ref LLP 0125 [implements]: the activation probe turns a missing builtin
 *   into this typed refusal instead of a crash.
 * @ref LLP 0122#sqlite [implements]: a persistently locked store surfaces
 *   as this error so the source degrades status rather than throwing raw
 *   into the daemon.
 */
export class HermesStateDbError extends Error {
  /**
   * @param {string} message
   * @param {{ code: 'sqlite_unavailable' | 'missing' | 'open_failed' | 'sqlite_busy', cause?: unknown }} opts
   */
  constructor(message, opts) {
    super(message)
    this.name = 'HermesStateDbError'
    /** @type {'sqlite_unavailable' | 'missing' | 'open_failed' | 'sqlite_busy'} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}
