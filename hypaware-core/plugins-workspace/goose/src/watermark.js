// @ts-check

/**
 * Poll watermark for the goose source (`src/source.js`), a sidecar JSON in
 * the plugin's kernel-managed state dir (`ctx.paths.stateDir`), the same
 * approach the hermes source uses.
 *
 * @ref LLP 0570#reconciliation [implements]: two global cursors plus a
 *   per-session `{updated_at, max_id, digest}` entry, written only after a
 *   commit, and capped at 10,000 entries by evicting the oldest `updated_at`.
 *
 * @import { GooseSessionWatermark, GooseWatermarkState } from './types.js'
 */

import path from 'node:path'

import { atomicWriteJsonSync, readJsonIfExistsSync } from 'hypaware/core/util'

const WATERMARK_FILE = 'watermark.json'
const SCHEMA_VERSION = 1

/** Most session entries the sidecar keeps (LLP 0570#reconciliation). */
export const MAX_WATERMARK_SESSIONS = 10_000

/** @returns {GooseWatermarkState} */
export function emptyGooseWatermark() {
  return { data_version: null, cursor_id: null, cursor_updated_at: null, sessions: {} }
}

/**
 * @param {string} stateDir
 * @returns {string}
 */
function watermarkFilePath(stateDir) {
  return path.join(stateDir, WATERMARK_FILE)
}

/**
 * Read the persisted watermark. Missing, malformed, or a mismatched
 * `schema_version` all read as "no watermark yet", which the source treats as
 * a first start: it baselines the cursors and does not walk history.
 *
 * @param {string} stateDir
 * @returns {GooseWatermarkState}
 */
export function readGooseWatermark(stateDir) {
  try {
    const parsed = readJsonIfExistsSync(watermarkFilePath(stateDir))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = /** @type {Record<string, unknown>} */ (parsed)
      if (record.schema_version === SCHEMA_VERSION) {
        return {
          data_version: finiteOrNull(record.data_version),
          cursor_id: finiteOrNull(record.cursor_id),
          cursor_updated_at: typeof record.cursor_updated_at === 'string' ? record.cursor_updated_at : null,
          sessions: readSessions(record.sessions),
        }
      }
    }
  } catch {
    // Malformed JSON on disk: start clean rather than throw out of a poll tick.
  }
  return emptyGooseWatermark()
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * @param {unknown} value
 * @returns {Record<string, GooseSessionWatermark>}
 */
function readSessions(value) {
  /** @type {Record<string, GooseSessionWatermark>} */
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [sessionId, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const mark = readMark(raw)
    if (mark) out[sessionId] = mark
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {GooseSessionWatermark | null}
 */
function readMark(value) {
  if (!value || typeof value !== 'object') return null
  const candidate = /** @type {Record<string, unknown>} */ (value)
  const maxId = candidate.max_id
  if (typeof maxId !== 'number' || !Number.isFinite(maxId)) return null
  const updatedAt = candidate.updated_at
  if (updatedAt !== null && typeof updatedAt !== 'string') return null
  return { updated_at: updatedAt, max_id: maxId, ...(typeof candidate.digest === 'string' ? { digest: candidate.digest } : {}) }
}

/**
 * Drop the entries with the oldest `updated_at` (null sorts first) until at
 * most `max` remain. Sorts only when over the cap, so the common flush is a
 * single key count. An evicted session's next change finds no entry and
 * forces one idempotent reconcile.
 *
 * @param {Record<string, GooseSessionWatermark>} sessions
 * @param {number} [max]
 * @returns {number} entries evicted
 */
export function capGooseWatermarkSessions(sessions, max = MAX_WATERMARK_SESSIONS) {
  const ids = Object.keys(sessions)
  const excess = ids.length - max
  if (excess <= 0) return 0
  ids.sort((a, b) => compareUpdatedAt(sessions[a].updated_at, sessions[b].updated_at))
  for (let i = 0; i < excess; i++) delete sessions[ids[i]]
  return excess
}

/**
 * @param {string | null} a
 * @param {string | null} b
 */
function compareUpdatedAt(a, b) {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a < b ? -1 : 1
}

/**
 * Atomically persist the watermark (write-temp-then-rename) after applying
 * the entry cap.
 *
 * @param {string} stateDir
 * @param {GooseWatermarkState} watermark
 * @returns {number} entries evicted by the cap
 */
export function writeGooseWatermark(stateDir, watermark) {
  const evicted = capGooseWatermarkSessions(watermark.sessions)
  atomicWriteJsonSync(watermarkFilePath(stateDir), { schema_version: SCHEMA_VERSION, ...watermark })
  return evicted
}
