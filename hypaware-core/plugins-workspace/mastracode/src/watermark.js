// @ts-check

/**
 * Poll watermark for the mastracode source (`src/source.js`), a sidecar JSON
 * in the plugin's kernel-managed state dir (`ctx.paths.stateDir`), the same
 * approach the goose and crush sources use.
 *
 * @ref LLP 0586#reconciliation [implements]: for the database `{path,
 *   stat_sig, max_rowid, floor}`, per thread `{updated_at, message_count,
 *   max_rowid, open, digest}`, written only after a commit, and capped at
 *   10,000 threads by evicting the oldest `updated_at`; an evicted or pruned
 *   entry raises the floor so it is not treated as new.
 *
 * @import { MastraDbWatermark, MastraThreadWatermark, MastraWatermarkState } from './types.js'
 */

import path from 'node:path'

import { atomicWriteJsonSync, readJsonIfExistsSync } from 'hypaware/core/util'
import { compareStrings } from '../../../../src/core/util/compare_strings.js'

const WATERMARK_FILE = 'watermark.json'
const SCHEMA_VERSION = 1

/** Most thread entries the sidecar keeps (LLP 0586#reconciliation). */
export const MAX_WATERMARK_THREADS = 10_000

/** @returns {MastraWatermarkState} */
export function emptyMastraWatermark() {
  return { db: null, threads: {} }
}

/**
 * Order two `updatedAt` values. Mastra Code writes ISO 8601 strings, compared
 * as instants; a value that does not parse falls back to string order.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareUpdatedAt(a, b) {
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
  return compareStrings(a, b)
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
 * `schema_version` all read as "no watermark yet", which the source treats
 * as a first start: the cursor and floor are baselined and history is not
 * walked.
 *
 * @param {string} stateDir
 * @returns {MastraWatermarkState}
 */
export function readMastraWatermark(stateDir) {
  try {
    const parsed = readJsonIfExistsSync(watermarkFilePath(stateDir))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = /** @type {Record<string, unknown>} */ (parsed)
      if (record.schema_version === SCHEMA_VERSION) {
        const db = readDbMark(record.db)
        return { db, threads: db ? readThreads(record.threads) : {} }
      }
    }
  } catch {
    // Malformed JSON on disk: start clean rather than throw out of a poll tick.
  }
  return emptyMastraWatermark()
}

/**
 * @param {unknown} value
 * @returns {Record<string, MastraThreadWatermark>}
 */
function readThreads(value) {
  /** @type {Record<string, MastraThreadWatermark>} */
  const out = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const mark = readThreadMark(raw)
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
 * @returns {MastraDbWatermark | null}
 */
function readDbMark(value) {
  if (!value || typeof value !== 'object') return null
  const c = /** @type {Record<string, unknown>} */ (value)
  if (typeof c.path !== 'string' || !isFiniteNumber(c.max_rowid)) return null
  if (c.stat_sig !== null && typeof c.stat_sig !== 'string') return null
  if (c.floor !== null && typeof c.floor !== 'string') return null
  return { path: c.path, stat_sig: c.stat_sig, max_rowid: c.max_rowid, floor: c.floor }
}

/**
 * @param {unknown} value
 * @returns {MastraThreadWatermark | null}
 */
function readThreadMark(value) {
  if (!value || typeof value !== 'object') return null
  const c = /** @type {Record<string, unknown>} */ (value)
  if (typeof c.updated_at !== 'string') return null
  if (!isFiniteNumber(c.message_count) || !isFiniteNumber(c.max_rowid)) return null
  return {
    updated_at: c.updated_at,
    message_count: c.message_count,
    max_rowid: c.max_rowid,
    open: c.open === true,
    ...(typeof c.digest === 'string' ? { digest: c.digest } : {}),
  }
}

/**
 * Drop one thread entry and raise the floor to at least the entry's
 * `updated_at`, so the next threads read does not take the thread for a new
 * one. Its next change still misses the entry and forces one idempotent
 * reconcile.
 *
 * @param {MastraWatermarkState} watermark
 * @param {string} threadId
 */
export function dropMastraWatermarkThread(watermark, threadId) {
  const entry = watermark.threads[threadId]
  if (!entry) return
  const db = watermark.db
  if (db && (db.floor === null || compareUpdatedAt(db.floor, entry.updated_at) < 0)) db.floor = entry.updated_at
  delete watermark.threads[threadId]
}

/**
 * Drop the entries with the oldest `updated_at` until at most `max` remain.
 * Sorts only when over the cap, so the common flush is a single key count.
 *
 * @param {MastraWatermarkState} watermark
 * @param {number} [max]
 * @returns {number} entries evicted
 */
export function capMastraWatermarkThreads(watermark, max = MAX_WATERMARK_THREADS) {
  const ids = Object.keys(watermark.threads)
  const excess = ids.length - max
  if (excess <= 0) return 0
  ids.sort((a, b) => compareUpdatedAt(watermark.threads[a].updated_at, watermark.threads[b].updated_at) || compareStrings(a, b))
  for (let i = 0; i < excess; i++) dropMastraWatermarkThread(watermark, ids[i])
  return excess
}

/**
 * Drop the entries whose thread is not in `present`: the sweep's prune of
 * threads the database no longer holds or that left its scope
 * (LLP 0586#prune).
 *
 * @param {MastraWatermarkState} watermark
 * @param {Set<string>} present
 * @returns {number} entries pruned
 */
export function pruneMastraWatermark(watermark, present) {
  let pruned = 0
  for (const threadId of Object.keys(watermark.threads)) {
    if (present.has(threadId)) continue
    dropMastraWatermarkThread(watermark, threadId)
    pruned++
  }
  return pruned
}

/**
 * Atomically persist the watermark (write-temp-then-rename) after applying
 * the entry cap.
 *
 * @param {string} stateDir
 * @param {MastraWatermarkState} watermark
 * @returns {number} entries evicted by the cap
 */
export function writeMastraWatermark(stateDir, watermark) {
  const evicted = capMastraWatermarkThreads(watermark)
  atomicWriteJsonSync(watermarkFilePath(stateDir), { schema_version: SCHEMA_VERSION, ...watermark })
  return evicted
}
