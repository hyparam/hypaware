// @ts-check

import { EVIDENCE_PART_TYPES, EVIDENCE_ROLES, MAX_TEXT_CHARS, WINDOW_MS } from './evidence.js'
import { MAX_TERMS } from './discovery.js'

/**
 * @import { SearchHit, SearchResult, SearchSession } from '../../../../hypaware-core/plugins-workspace/graph-cache/src/types.js'
 */

/** Candidate sessions one search takes (LLP 0487#decision). */
export const MAX_SEARCH_SESSIONS = 16
/** Sessions queried at once. */
export const SEARCH_CONCURRENCY = 2
export const DEFAULT_HITS_PER_SESSION = 10
export const MAX_HITS_PER_SESSION = 50
export const DEFAULT_HIT_CHARS = 400

/**
 * Text search inside given candidate sessions: one bounded `query_sql` per
 * session (any of up to 12 terms, case-insensitive substring, user and
 * assistant text parts, oldest first), at most two sessions at a time, each
 * reported separately with its own truncation or error. Hits carry the ids
 * `query evidence` takes and an excerpt around the first match, capped.
 *
 * Work per call: at most 16 queries of at most `hitsPerSession + 1` rows each;
 * memory is those rows, cut to excerpts as each session answers.
 *
 * @ref LLP 0487#decision [implements]: search is a client fan-out of query_sql per candidate session, 16 sessions, concurrency 2, 12 terms OR'd, a per-session hit budget
 * @param {{
 *   runSql: (sql: string) => Promise<Record<string, unknown>[]>,
 *   sessions: string[],
 *   terms: string[],
 *   hitsPerSession?: number,
 *   hitChars?: number,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<SearchResult>}
 */
export async function searchSessions({ runSql, sessions, terms, hitsPerSession = DEFAULT_HITS_PER_SESSION, hitChars = DEFAULT_HIT_CHARS, signal }) {
  const uniqueSessions = [...new Set(sessions.filter(Boolean))]
  const asked = uniqueSessions.slice(0, MAX_SEARCH_SESSIONS)
  const uniqueTerms = [...new Map(terms.map((t) => t.trim()).filter((t) => t.length > 0).map((t) => [t.toLowerCase(), t])).values()]
  const kept = uniqueTerms.slice(0, MAX_TERMS)
  const patterns = kept.map((t) => t.toLowerCase())
  const hitCap = Math.min(Math.max(1, Math.floor(hitsPerSession)), MAX_HITS_PER_SESSION)
  const charCap = Math.min(Math.max(1, Math.floor(hitChars)), MAX_TEXT_CHARS)

  /** @type {SearchSession[]} */
  const results = asked.map((session_id) => ({ session_id, hits: [], truncated: false, error: null }))
  let next = 0
  async function worker() {
    while (next < asked.length) {
      const i = next++
      const result = results[i]
      if (signal?.aborted) {
        result.error = 'not searched: the call was aborted'
        continue
      }
      if (patterns.length === 0) continue
      try {
        const rows = await runSql(sessionSql(result.session_id, patterns, hitCap + 1))
        result.truncated = rows.length > hitCap
        for (const row of rows) {
          const hit = toHit(result.session_id, row, kept, charCap)
          // A row the terms do not actually match never spends the budget.
          if (hit.matched_terms.length === 0) continue
          if (result.hits.length === hitCap) break
          result.hits.push(hit)
        }
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, asked.length) }, worker))
  return {
    terms: kept,
    sessions: results,
    coverage: {
      sessions_asked: asked.length,
      sessions_dropped: uniqueSessions.length - asked.length,
      terms_dropped: uniqueTerms.length - kept.length,
      hits: results.reduce((n, r) => n + r.hits.length, 0),
    },
  }
}

/**
 * One session's query: any term as a literal, case-insensitive substring
 * (`strpos`, so `_`, `%` and `\` match themselves; LIKE would treat the
 * first two as wildcards and this engine has no ESCAPE clause).
 *
 * @param {string} sessionId
 * @param {string[]} patterns lowercased terms
 * @param {number} limit
 */
export function sessionSql(sessionId, patterns, limit) {
  const any = patterns.map((p) => `strpos(lower(content_text), ${sqlString(p)}) > 0`).join(' OR ')
  return 'SELECT message_id, part_id, role, message_created_at, content_text FROM ai_gateway_messages '
    + `WHERE session_id = ${sqlString(sessionId)} AND role IN (${EVIDENCE_ROLES.map(sqlString).join(', ')}) `
    + `AND part_type IN (${EVIDENCE_PART_TYPES.map(sqlString).join(', ')}) AND (${any}) `
    + `ORDER BY message_created_at ASC, message_index ASC, part_index ASC LIMIT ${limit}`
}

/**
 * @param {string} sessionId
 * @param {Record<string, unknown>} row
 * @param {string[]} terms
 * @param {number} charCap
 * @returns {SearchHit}
 */
function toHit(sessionId, row, terms, charCap) {
  const text = row.content_text == null ? '' : String(row.content_text)
  const lower = text.toLowerCase()
  const matched = terms.filter((t) => lower.includes(t.toLowerCase()))
  let first = -1
  for (const t of matched) {
    const at = lower.indexOf(t.toLowerCase())
    if (at !== -1 && (first === -1 || at < first)) first = at
  }
  const start = Math.max(0, Math.min(Math.max(0, first) - Math.floor(charCap / 4), text.length - charCap))
  const excerpt = text.slice(start, start + charCap)
  const created = row.message_created_at == null ? null : toIso(row.message_created_at)
  const messageId = row.message_id == null ? null : String(row.message_id)
  const at = created ? Date.parse(created) : NaN
  return {
    message_id: messageId,
    part_id: row.part_id == null ? null : String(row.part_id),
    role: row.role == null ? null : String(row.role),
    message_created_at: created,
    matched_terms: matched,
    excerpt,
    text_truncated: excerpt.length < text.length,
    read: Number.isFinite(at)
      ? { session_id: sessionId, from: new Date(at - WINDOW_MS).toISOString(), to: new Date(at + WINDOW_MS).toISOString(), order: 'asc' }
      : { session_id: sessionId, message_ids: messageId ? [messageId] : [] },
  }
}

/** @param {unknown} value */
function toIso(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value)
}

/** @param {string} value */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}
