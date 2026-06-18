// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Per-host watermark state for the enrichment proposer, persisted as a single
 * sidecar JSON under the plugin's state dir (the same approach vector-search
 * uses for shard metadata). The watermark is a **per-session high-water mark** —
 * one (timestamp, row-unique id) tuple per session, "this session has been
 * enriched through here" — which replaces the original single global keyset
 * cursor. Backfill seeds the marks, the ongoing batch advances them, and a
 * resumed session re-qualifies when its latest part moves past its mark. Curate
 * has no mark — its queue is "prospects with no resolution", computed by query.
 *
 * @ref LLP 0028#per-session-watermark [implements]
 *
 * @import { CurateJob, EnrichStateFile, SessionMark } from './types.d.ts'
 */

const STATE_FILE = 'enrich-state.json'
const SCHEMA_VERSION = 4

/**
 * @param {string} stateDir
 * @returns {EnrichStateFile}
 */
export function readState(stateDir) {
  const file = path.join(stateDir, STATE_FILE)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && parsed.schema_version === SCHEMA_VERSION) {
      return { schema_version: SCHEMA_VERSION, session_marks: readMarks(parsed.session_marks), curate_job: readCurateJob(parsed.curate_job) }
    }
  } catch {
    // Missing, malformed, or an older schema — start from the beginning. An
    // older sidecar carries no per-session marks or job, so it is discarded
    // rather than migrated (a fresh ongoing run re-settles every session).
  }
  return { schema_version: SCHEMA_VERSION, session_marks: {}, curate_job: null }
}

/**
 * Parse the persisted in-flight curate batch job, dropping it if malformed.
 *
 * @param {unknown} value
 * @returns {CurateJob | null}
 */
function readCurateJob(value) {
  if (!value || typeof value !== 'object') return null
  const j = /** @type {Record<string, unknown>} */ (value)
  if (typeof j.id !== 'string' || !Array.isArray(j.clusters)) return null
  /** @type {Array<{ customId: string, prospectIds: string[] }>} */
  const clusters = []
  for (const raw of j.clusters) {
    const c = /** @type {Record<string, unknown>} */ (raw ?? {})
    if (typeof c.customId === 'string' && Array.isArray(c.prospectIds)) {
      clusters.push({ customId: c.customId, prospectIds: c.prospectIds.filter((x) => typeof x === 'string') })
    }
  }
  return { id: j.id, submitted_at: typeof j.submitted_at === 'string' ? j.submitted_at : '', clusters }
}

/**
 * Parse the persisted `session_marks` map, dropping any malformed entry.
 *
 * @param {unknown} value
 * @returns {Record<string, SessionMark>}
 */
function readMarks(value) {
  /** @type {Record<string, SessionMark>} */
  const out = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [sessionId, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      const mark = readMark(raw)
      if (mark) out[sessionId] = mark
    }
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {SessionMark | null}
 */
function readMark(value) {
  if (value && typeof value === 'object') {
    const c = /** @type {Record<string, unknown>} */ (value)
    if (typeof c.ts === 'number' && Number.isFinite(c.ts) && typeof c.id === 'string') return { ts: c.ts, id: c.id }
  }
  return null
}

/**
 * Atomically persist state (write-temp-then-rename, like vector-search's
 * shard sidecars) so a crash mid-write never leaves a half-written mark map.
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
