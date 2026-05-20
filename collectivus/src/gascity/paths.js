import os from 'node:os'
import path from 'node:path'

/**
 * Default sink root for gascity-source recordings. Matches the layout the
 * epic spec calls out: `~/.collectivus/sink/gascity_messages/`.
 *
 * @returns {string}
 */
export function defaultGascityRoot() {
  return path.join(os.homedir(), '.collectivus', 'sink', 'gascity_messages')
}

/**
 * Directory holding lifecycle and per-session cursors for one city.
 *
 * @param {string} root Sink root from `defaultGascityRoot` or an override.
 * @param {string} city Configured city name.
 * @returns {string}
 */
export function cursorsDir(root, city) {
  return path.join(root, '.cursors', city)
}

/**
 * Path to the lifecycle cursor JSON for a city. The file may not exist yet —
 * callers treat ENOENT as "no resume id".
 *
 * @param {string} root
 * @param {string} city
 * @returns {string}
 */
export function lifecycleCursorPath(root, city) {
  return path.join(cursorsDir(root, city), 'lifecycle.json')
}

/**
 * Path to a per-session cursor JSON.
 *
 * @param {string} root
 * @param {string} city
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionCursorPath(root, city, sessionId) {
  return path.join(cursorsDir(root, city), `${sessionId}.json`)
}

/**
 * Directory holding parquet part files for one (date, city) pair. Hive-style
 * `date=` and `city=` segments let downstream readers (and the bead-6
 * catalog registration) use directory-based partition pruning.
 *
 * @param {string} root
 * @param {string} date ISO `YYYY-MM-DD` (UTC).
 * @param {string} city
 * @returns {string}
 */
export function parquetPartitionDir(root, date, city) {
  return path.join(root, `date=${date}`, `city=${city}`)
}

/**
 * Path for one part-file within a (date, city, session) partition. The
 * `counter` is the writer's per-session flush counter (resets daily, starts
 * at 0). Filenames are stable across daemon restarts because the writer
 * sources the counter from `flushed_count` in the cursor.
 *
 * @param {string} root
 * @param {string} date ISO `YYYY-MM-DD` (UTC).
 * @param {string} city
 * @param {string} sessionId
 * @param {number} counter
 * @returns {string}
 */
export function parquetPartPath(root, date, city, sessionId, counter) {
  return path.join(
    parquetPartitionDir(root, date, city),
    `part-${encodeURIComponent(sessionId)}-${counter}.parquet`
  )
}
