// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Per-host watermark state for the enrichment sources, persisted as a single
 * sidecar JSON under the plugin's state dir (the same approach vector-search
 * uses for shard metadata). The propose cursor is a keyset tuple over the
 * part-level source — (timestamp, row-unique id), "rows processed up to
 * here". Curate has no cursor — its queue is "prospects with no resolution",
 * computed by query.
 *
 * @import { EnrichStateFile, ProposeCursor } from './types.d.ts'
 */

const STATE_FILE = 'enrich-state.json'
const SCHEMA_VERSION = 2

/**
 * @param {string} stateDir
 * @returns {EnrichStateFile}
 */
export function readState(stateDir) {
  const file = path.join(stateDir, STATE_FILE)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && parsed.schema_version === SCHEMA_VERSION) {
      return { schema_version: SCHEMA_VERSION, propose_cursor: readCursor(parsed.propose_cursor) }
    }
  } catch {
    // Missing, malformed, or an older schema — start from the beginning.
  }
  return { schema_version: SCHEMA_VERSION, propose_cursor: null }
}

/**
 * @param {unknown} value
 * @returns {ProposeCursor | null}
 */
function readCursor(value) {
  if (value && typeof value === 'object') {
    const c = /** @type {Record<string, unknown>} */ (value)
    if (typeof c.ts === 'number' && Number.isFinite(c.ts) && typeof c.id === 'string') return { ts: c.ts, id: c.id }
  }
  return null
}

/**
 * Atomically persist state (write-temp-then-rename, like vector-search's
 * shard sidecars) so a crash mid-write never leaves a half-written cursor.
 *
 * @param {string} stateDir
 * @param {EnrichStateFile} state
 */
export function writeState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, STATE_FILE)
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}
