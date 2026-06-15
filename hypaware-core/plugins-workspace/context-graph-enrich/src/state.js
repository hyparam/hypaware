// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Per-host watermark state for the enrichment sources, persisted as a single
 * sidecar JSON under the plugin's state dir (the same approach vector-search
 * uses for shard metadata). The propose cursor is a monotonic source
 * timestamp ("rows processed up to here"); curate has no cursor — its queue
 * is "prospects with no resolution", computed by query.
 */

const STATE_FILE = 'enrich-state.json'

/** @typedef {{ schema_version: 1, propose_cursor: string | null }} EnrichStateFile */

/**
 * @param {string} stateDir
 * @returns {EnrichStateFile}
 */
export function readState(stateDir) {
  const file = path.join(stateDir, STATE_FILE)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && parsed.schema_version === 1) {
      return { schema_version: 1, propose_cursor: typeof parsed.propose_cursor === 'string' ? parsed.propose_cursor : null }
    }
  } catch {
    // Missing or malformed sidecar — start from the beginning.
  }
  return { schema_version: 1, propose_cursor: null }
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
