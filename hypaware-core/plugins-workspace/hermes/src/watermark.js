// @ts-check

/**
 * Per-session poll watermark for the hermes source (`src/source.js`),
 * persisted as a sidecar JSON under the plugin's kernel-managed state dir
 * (`ctx.paths.stateDir`), the same sidecar-file approach
 * `context-graph-enrich/src/state.js` and `vector-search/src/shards.js`
 * use for their own per-host cursors ("the plugin's kernel storage", LLP
 * 0122#watermark).
 *
 * @ref LLP 0122#watermark [implements]: `{ session_id (stringified) ->
 *   { max_message_id, ended_at } }`, the exact shape `listChangedSessions`
 *   (T1, `state_db.js`) diffs against.
 *
 * @import { HermesSessionWatermark, HermesWatermarkState } from './types.js'
 */

import path from 'node:path'

import { atomicWriteJsonSync, readJsonIfExistsSync } from 'hypaware/core/util'

const WATERMARK_FILE = 'watermark.json'
const SCHEMA_VERSION = 1

/**
 * @param {string} stateDir
 * @returns {string}
 */
function watermarkFilePath(stateDir) {
  return path.join(stateDir, WATERMARK_FILE)
}

/**
 * Read the persisted watermark map. Missing, malformed, or a mismatched
 * `schema_version` all read as "no watermark yet" (empty map): a session
 * absent from the map compares against the implicit
 * `{ max_message_id: 0, ended_at: null }` mark in `listChangedSessions`,
 * so a fresh/blown-away sidecar just re-examines every session on the next
 * tick rather than crashing the source.
 *
 * @param {string} stateDir
 * @returns {HermesWatermarkState}
 */
export function readHermesWatermark(stateDir) {
  try {
    const parsed = readJsonIfExistsSync(watermarkFilePath(stateDir))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = /** @type {Record<string, unknown>} */ (parsed)
      if (record.schema_version === SCHEMA_VERSION) {
        return readSessions(record.sessions)
      }
    }
  } catch {
    // Malformed JSON on disk: start clean rather than throw out of a poll tick.
  }
  return {}
}

/**
 * @param {unknown} value
 * @returns {HermesWatermarkState}
 */
function readSessions(value) {
  /** @type {HermesWatermarkState} */
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
 * @returns {HermesSessionWatermark | null}
 */
function readMark(value) {
  if (!value || typeof value !== 'object') return null
  const candidate = /** @type {Record<string, unknown>} */ (value)
  const maxMessageId = candidate.max_message_id
  if (typeof maxMessageId !== 'number' || !Number.isFinite(maxMessageId)) return null
  const endedAt = candidate.ended_at
  if (endedAt !== null && typeof endedAt !== 'string') return null
  return { max_message_id: maxMessageId, ended_at: endedAt ?? null }
}

/**
 * Atomically persist the watermark map (write-temp-then-rename), so a
 * crash mid-write never leaves a half-written sidecar for the next poll
 * tick to trip over.
 *
 * @param {string} stateDir
 * @param {HermesWatermarkState} watermark
 */
export function writeHermesWatermark(stateDir, watermark) {
  atomicWriteJsonSync(watermarkFilePath(stateDir), { schema_version: SCHEMA_VERSION, sessions: watermark })
}
