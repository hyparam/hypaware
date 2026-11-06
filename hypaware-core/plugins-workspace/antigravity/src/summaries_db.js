// @ts-check

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { compareStrings } from 'hypaware/core/util'

/**
 * @import {
 *   AntigravityBusyRetryOptions,
 *   AntigravitySummariesOptions,
 *   AntigravitySummaryRow,
 * } from './types.js'
 */

export const DEFAULT_BUSY_RETRY_ATTEMPTS = 4
export const DEFAULT_BUSY_RETRY_DELAY_MS = 50
export const CLI_TRAJECTORY_SOURCE = 'CORTEX_TRAJECTORY_SOURCE_CLI'

const defaultRequire = createRequire(import.meta.url)

const SELECT_SUMMARIES_SQL = `
  SELECT
    conversation_id,
    title,
    step_count,
    last_modified_time,
    workspace_uris,
    status,
    source,
    agent_name,
    parent_conversation_id,
    nesting_depth,
    last_user_input_time,
    app_data_dir
  FROM conversation_summaries
  ORDER BY conversation_id ASC
`

/**
 * Read conversation summaries for an Antigravity `appDataDir`, combining
 * `<appDataDir>/conversation_summaries.db` (opened strictly read-only via
 * `node:sqlite`) with a fallback directory scan of `<appDataDir>/brain/` for
 * any conversation directories not yet indexed in the summary table.
 *
 * When `opts.excludeCliSyncedSummaries` is true (used by
 * `@hypaware/antigravity-desktop`), rows in `conversation_summaries.db` with
 * `source === 'CORTEX_TRAJECTORY_SOURCE_CLI'` are excluded so CLI sessions
 * synced into Desktop's summary index are not attributed to Desktop.
 *
 * @param {string} appDataDir
 * @param {AntigravitySummariesOptions} [opts]
 * @returns {Promise<{
 *   available: boolean,
 *   reason?: 'missing' | 'no_node_sqlite',
 *   summaries: AntigravitySummaryRow[],
 * }>}
 */
export async function listAntigravityConversations(appDataDir, opts = {}) {
  const summariesDbPath = path.join(appDataDir, 'conversation_summaries.db')
  const brainDir = path.join(appDataDir, 'brain')

  const hasSummariesDb = fs.existsSync(summariesDbPath)
  const hasBrainDir = fs.existsSync(brainDir)
  if (!hasSummariesDb && !hasBrainDir) {
    return { available: false, reason: 'missing', summaries: [] }
  }

  /** @type {Map<string, AntigravitySummaryRow>} */
  const byId = new Map()
  /** @type {Set<string>} */
  const excludedIds = new Set()

  if (hasSummariesDb) {
    const requireFn = opts.requireFn ?? defaultRequire
    /** @type {{ DatabaseSync?: new (path: string, options?: { readOnly?: boolean }) => any } | undefined} */
    let sqliteMod
    try {
      sqliteMod = /** @type {any} */ (requireFn('node:sqlite'))
    } catch {
      return { available: false, reason: 'no_node_sqlite', summaries: [] }
    }
    if (!sqliteMod || typeof sqliteMod.DatabaseSync !== 'function') {
      return { available: false, reason: 'no_node_sqlite', summaries: [] }
    }
    const DatabaseSyncCtor = sqliteMod.DatabaseSync

    const rows = await withBusyRetry(() => {
      const db = new DatabaseSyncCtor(summariesDbPath, { readOnly: true })
      try {
        const hasTable = db
          .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries'")
          .get()
        if (!hasTable) return []
        return /** @type {Record<string, unknown>[]} */ (db.prepare(SELECT_SUMMARIES_SQL).all())
      } finally {
        try {
          db.close()
        } catch {
          // ignore close errors
        }
      }
    }, opts)

    for (const raw of rows) {
      const row = coerceSummaryRow(raw)
      if (!row.conversation_id) continue
      if (opts.excludeCliSyncedSummaries && row.source === CLI_TRAJECTORY_SOURCE) {
        excludedIds.add(row.conversation_id)
        continue
      }
      byId.set(row.conversation_id, row)
    }
  }

  if (hasBrainDir) {
    try {
      const entries = await fsPromises.readdir(brainDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const convId = entry.name
        if (byId.has(convId) || excludedIds.has(convId)) continue
        byId.set(convId, {
          conversation_id: convId,
          title: null,
          step_count: 0,
          last_modified_time: null,
          workspace_uris: null,
          status: null,
          source: null,
          agent_name: null,
          parent_conversation_id: null,
          nesting_depth: 0,
          last_user_input_time: null,
          app_data_dir: appDataDir,
        })
      }
    } catch {
      // brain directory disappeared or became unreadable during scan
    }
  }

  const summaries = Array.from(byId.values()).sort((a, b) => compareStrings(a.conversation_id, b.conversation_id))
  return { available: true, summaries }
}

/**
 * Locate the transcript JSONL file for `conversationId` under `appDataDir` and
 * return its path and `fs.Stats` in a single stat pass. Prefers
 * `transcript_full.jsonl` and falls back to `transcript.jsonl`.
 *
 * @param {string} appDataDir
 * @param {string} conversationId
 * @returns {Promise<{ transcriptPath: string, stat: fs.Stats } | null>}
 */
export async function statConversationTranscript(appDataDir, conversationId) {
  const logsDir = path.join(appDataDir, 'brain', conversationId, '.system_generated', 'logs')
  const fullPath = path.join(logsDir, 'transcript_full.jsonl')
  try {
    const stat = await fsPromises.stat(fullPath)
    if (stat.isFile()) return { transcriptPath: fullPath, stat }
  } catch {
    // fall through to compact transcript
  }
  const compactPath = path.join(logsDir, 'transcript.jsonl')
  try {
    const stat = await fsPromises.stat(compactPath)
    if (stat.isFile()) return { transcriptPath: compactPath, stat }
  } catch {
    // neither transcript file exists yet
  }
  return null
}

/**
 * Execute `fn` with bounded retry on `SQLITE_BUSY` / `SQLITE_LOCKED`.
 *
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {AntigravityBusyRetryOptions} [opts]
 * @returns {Promise<T>}
 */
export async function withBusyRetry(fn, opts = {}) {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_BUSY_RETRY_ATTEMPTS)
  const delayMs = opts.delayMs ?? DEFAULT_BUSY_RETRY_DELAY_MS
  const sleep = opts.sleep ?? defaultSleep

  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isSqliteBusyError(err) || i === attempts - 1) {
        throw err
      }
      await sleep(delayMs)
    }
  }
  throw lastErr
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isSqliteBusyError(err) {
  if (!err || typeof err !== 'object') return false
  const e = /** @type {{ code?: unknown, errcode?: unknown, errstr?: unknown, message?: unknown }} */ (err)
  if (typeof e.code === 'string' && (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED' || e.code.startsWith('SQLITE_BUSY_'))) {
    return true
  }
  if (typeof e.errcode === 'number' && (e.errcode === 5 || e.errcode === 6 || (e.errcode & 0xff) === 5)) {
    return true
  }
  if (typeof e.errstr === 'string' && /database is locked|database table is locked/i.test(e.errstr)) {
    return true
  }
  if (typeof e.message === 'string' && /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(e.message)) {
    return true
  }
  return false
}

/**
 * @param {Record<string, unknown>} r
 * @returns {AntigravitySummaryRow}
 */
function coerceSummaryRow(r) {
  return {
    conversation_id: String(r.conversation_id ?? ''),
    title: r.title == null ? null : String(r.title),
    step_count: typeof r.step_count === 'number' && Number.isFinite(r.step_count) ? r.step_count : 0,
    last_modified_time: r.last_modified_time == null ? null : String(r.last_modified_time),
    workspace_uris: r.workspace_uris == null ? null : String(r.workspace_uris),
    status: r.status == null ? null : String(r.status),
    source: r.source == null ? null : String(r.source),
    agent_name: r.agent_name == null ? null : String(r.agent_name),
    parent_conversation_id: r.parent_conversation_id == null ? null : String(r.parent_conversation_id),
    nesting_depth: typeof r.nesting_depth === 'number' && Number.isFinite(r.nesting_depth) ? r.nesting_depth : 0,
    last_user_input_time: r.last_user_input_time == null ? null : String(r.last_user_input_time),
    app_data_dir: r.app_data_dir == null ? null : String(r.app_data_dir),
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
