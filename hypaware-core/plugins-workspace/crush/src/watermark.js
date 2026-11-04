// @ts-check

/**
 * Poll watermark for the crush source (`src/source.js`), a sidecar JSON in
 * the plugin's kernel-managed state dir (`ctx.paths.stateDir`), the same
 * approach the goose source uses.
 *
 * @ref LLP 0573#reconciliation [implements]: per database `{stat_sig,
 *   max_rowid, floor}`, per session `{db, updated_at, message_count,
 *   max_rowid, open, digest}`, written only after a commit, and capped at
 *   10,000 sessions by evicting the oldest `updated_at`; an evicted or pruned
 *   entry raises its database's floor so it is not treated as new.
 *
 * @import { CrushDbWatermark, CrushSessionWatermark, CrushWatermarkState } from './types.js'
 */

import path from 'node:path'

import { atomicWriteJsonSync, readJsonIfExistsSync } from 'hypaware/core/util'

const WATERMARK_FILE = 'watermark.json'
const SCHEMA_VERSION = 1

/** Most session entries the sidecar keeps (LLP 0573#reconciliation). */
export const MAX_WATERMARK_SESSIONS = 10_000

/** @returns {CrushWatermarkState} */
export function emptyCrushWatermark() {
  return { dbs: {}, sessions: {} }
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
 * a first start: every database baselines its cursor and floor and history
 * is not walked.
 *
 * @param {string} stateDir
 * @returns {CrushWatermarkState}
 */
export function readCrushWatermark(stateDir) {
  try {
    const parsed = readJsonIfExistsSync(watermarkFilePath(stateDir))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = /** @type {Record<string, unknown>} */ (parsed)
      if (record.schema_version === SCHEMA_VERSION) {
        return { dbs: readEntries(record.dbs, readDbMark), sessions: readEntries(record.sessions, readSessionMark) }
      }
    }
  } catch {
    // Malformed JSON on disk: start clean rather than throw out of a poll tick.
  }
  return emptyCrushWatermark()
}

/**
 * @template T
 * @param {unknown} value
 * @param {(raw: unknown) => T | null} readOne
 * @returns {Record<string, T>}
 */
function readEntries(value, readOne) {
  /** @type {Record<string, T>} */
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const mark = readOne(raw)
    if (mark) out[key] = mark
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * @param {unknown} value
 * @returns {CrushDbWatermark | null}
 */
function readDbMark(value) {
  if (!value || typeof value !== 'object') return null
  const c = /** @type {Record<string, unknown>} */ (value)
  if (!isFiniteNumber(c.max_rowid) || !isFiniteNumber(c.floor)) return null
  if (c.stat_sig !== null && typeof c.stat_sig !== 'string') return null
  return { stat_sig: c.stat_sig, max_rowid: c.max_rowid, floor: c.floor }
}

/**
 * @param {unknown} value
 * @returns {CrushSessionWatermark | null}
 */
function readSessionMark(value) {
  if (!value || typeof value !== 'object') return null
  const c = /** @type {Record<string, unknown>} */ (value)
  if (typeof c.db !== 'string' || !isFiniteNumber(c.updated_at)) return null
  if (!isFiniteNumber(c.message_count) || !isFiniteNumber(c.max_rowid)) return null
  return {
    db: c.db,
    updated_at: c.updated_at,
    message_count: c.message_count,
    max_rowid: c.max_rowid,
    open: c.open === true,
    ...(typeof c.digest === 'string' ? { digest: c.digest } : {}),
  }
}

/**
 * Drop one session entry and raise its database's floor to at least the
 * entry's `updated_at`, so the next metadata scan does not take the session
 * for a new one. Its next change still misses the entry and forces one
 * idempotent reconcile.
 *
 * @param {CrushWatermarkState} watermark
 * @param {string} sessionId
 */
export function dropCrushWatermarkSession(watermark, sessionId) {
  const entry = watermark.sessions[sessionId]
  if (!entry) return
  const db = watermark.dbs[entry.db]
  if (db && db.floor < entry.updated_at) db.floor = entry.updated_at
  delete watermark.sessions[sessionId]
}

/**
 * Drop the entries with the oldest `updated_at` until at most `max` remain.
 * Sorts only when over the cap, so the common flush is a single key count.
 *
 * @param {CrushWatermarkState} watermark
 * @param {number} [max]
 * @returns {number} entries evicted
 */
export function capCrushWatermarkSessions(watermark, max = MAX_WATERMARK_SESSIONS) {
  const ids = Object.keys(watermark.sessions)
  const excess = ids.length - max
  if (excess <= 0) return 0
  ids.sort((a, b) => watermark.sessions[a].updated_at - watermark.sessions[b].updated_at)
  for (let i = 0; i < excess; i++) dropCrushWatermarkSession(watermark, ids[i])
  return excess
}

/**
 * Drop the entries of `db` whose session is not in `present`: the sweep's
 * prune of sessions the database no longer holds (LLP 0573#backfill).
 *
 * @param {CrushWatermarkState} watermark
 * @param {string} db
 * @param {Set<string>} present
 * @returns {number} entries pruned
 */
export function pruneCrushWatermark(watermark, db, present) {
  let pruned = 0
  for (const [sessionId, entry] of Object.entries(watermark.sessions)) {
    if (entry.db !== db || present.has(sessionId)) continue
    dropCrushWatermarkSession(watermark, sessionId)
    pruned++
  }
  return pruned
}

/**
 * Atomically persist the watermark (write-temp-then-rename) after applying
 * the entry cap.
 *
 * @param {string} stateDir
 * @param {CrushWatermarkState} watermark
 * @returns {number} entries evicted by the cap
 */
export function writeCrushWatermark(stateDir, watermark) {
  const evicted = capCrushWatermarkSessions(watermark)
  atomicWriteJsonSync(watermarkFilePath(stateDir), { schema_version: SCHEMA_VERSION, ...watermark })
  return evicted
}
