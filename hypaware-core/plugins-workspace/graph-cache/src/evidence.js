// @ts-check

import { McpRpcError } from '../../../../src/core/mcp/client.js'
import { abortableSleep } from '../../../../src/core/util/backoff.js'
import { compareStrings } from '../../../../src/core/util/compare_strings.js'

/**
 * @import { EvidenceEntry, EvidenceMcpClient, EvidencePart, EvidenceResult, EvidenceStatus, Lead, LeadEvidence, PlannedEntry } from '../../../../hypaware-core/plugins-workspace/graph-cache/src/types.js'
 */

/**
 * The evidence client of LLP 0480#evidence: for the top leads, one
 * `session_evidence` call on the selected remote, read per the pinned
 * `hypaware.session-evidence/1` fixtures, with the command's budget as its
 * deadline and abort. A server without the verb gets per-session `query_sql`
 * reads with the same window, labeled as such. Pure functions over an MCP
 * client: no registration, no connection management (the warm daemon
 * session and the cold handshake are the caller's).
 */

export const EVIDENCE_CONTRACT = 'hypaware.session-evidence/1'
export const EVIDENCE_TOOL = 'session_evidence'
/** Leads that get evidence by default, and at most. */
export const DEFAULT_EVIDENCE_LEADS = 6
export const MAX_EVIDENCE_LEADS = 16
/** The server's limit on entries per call. */
export const MAX_ENTRIES = 16
/** Parts per call, split evenly across entries. */
export const CALL_ALLOWANCE_PARTS = 240
/** The window around a lead's touch time, each side. */
export const WINDOW_MS = 15 * 60_000
export const MAX_TEXT_CHARS = 2000
export const DEADLINE_FLOOR_MS = 250
/** The one retry after a capacity refusal waits at most this long (server LLP 0562). */
export const CAPACITY_RETRY_MS = 250
export const EVIDENCE_ROLES = Object.freeze(['user', 'assistant'])
export const EVIDENCE_PART_TYPES = Object.freeze(['text'])
/** The UX guardian's wording for not_found: never "this session does not exist". */
export const NOT_FOUND_NOTE = 'no readable text (purged, deleted or outside your access)'
export const INVALID_CURSOR_NOTE = 'the continuation cursor is no longer valid; read again without it'
export const FALLBACK_LABEL = 'server without evidence index support'
/** Server LLP 0565#client: an entry not read because its freshness could not be bounded. Never "no evidence". */
export const FRESHNESS_UNAVAILABLE_NOTE = 'the server could not confirm how fresh its evidence is'
/** Server LLP 0566#consequences: the server could not resume from the cursor. */
export const CURSOR_UNRESOLVABLE_NOTE = "the server could not continue this session's evidence"
/** Pages a single entry is followed for, at most, within one call (each always makes progress, server LLP 0566). */
export const MAX_FOLLOWS_PER_ENTRY = 4

/** Server LLP 0566: "N parts too large to return were skipped". @param {number} n */
export function skippedNote(n) {
  return `${n} ${n === 1 ? 'part' : 'parts'} too large to return ${n === 1 ? 'was' : 'were'} skipped`
}
/**
 * How much of a `session_evidence` response is read. The server caps its body
 * (default 4 MiB, at least 256 KiB) and sends it about twice on the wire
 * (server LLP 0565#byte-cap): this allows twice a cap of up to 8 MiB.
 */
export const EVIDENCE_MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/** Worst first: the status a lead reports when its entries disagree. */
const STATUS_RANK = /** @type {const} */ (['error', 'deadline', 'invalid_cursor', 'partial', 'ok', 'not_found'])

/**
 * The entries one call asks for: a window entry per lead (touch time plus or
 * minus 15 minutes, or the server's locator bounds when the touch time is
 * unknown), and an exemplar entry by `message_ids` when the edge carried one
 * and the server's 16-entry limit leaves room, in rank order. `max_parts`
 * divides the call's allowance evenly.
 *
 * @ref LLP 0480#evidence [implements]: window of touch time plus or minus 15 minutes, exemplar by message_ids, allowance split evenly
 * @param {readonly Lead[]} leads ranked
 * @param {{ leads?: number, allowance?: number }} [opts]
 * @returns {PlannedEntry[]}
 */
export function planEntries(leads, { leads: count = DEFAULT_EVIDENCE_LEADS, allowance = CALL_ALLOWANCE_PARTS } = {}) {
  const chosen = leads.slice(0, Math.max(0, Math.min(count, MAX_EVIDENCE_LEADS, MAX_ENTRIES)))
  /** @type {PlannedEntry[]} */
  const planned = chosen.map((lead, i) => {
    /** @type {EvidenceEntry} */
    const entry = { session_id: lead.session_id, order: 'asc', max_parts: 0 }
    const touched = lead.touched_at === null ? NaN : Date.parse(lead.touched_at)
    if (Number.isFinite(touched)) {
      entry.from = new Date(touched - WINDOW_MS).toISOString()
      entry.to = new Date(touched + WINDOW_MS).toISOString()
    }
    return { lead: i, kind: 'window', entry }
  })
  for (let i = 0; i < chosen.length && planned.length < MAX_ENTRIES; i++) {
    const messageId = chosen[i].exemplar?.message_id
    if (!messageId) continue
    planned.push({ lead: i, kind: 'message', entry: { session_id: chosen[i].session_id, message_ids: [messageId], order: 'asc', max_parts: 0 } })
  }
  const maxParts = planned.length ? Math.max(1, Math.floor(allowance / planned.length)) : 0
  for (const p of planned) p.entry.max_parts = maxParts
  return planned
}

/**
 * The `tools/call` arguments: each entry as its own JSON string (server
 * LLP 0557), user and assistant text only, 2,000 characters per part.
 *
 * @param {readonly PlannedEntry[]} planned
 * @param {number} deadlineMs
 */
export function evidenceRequest(planned, deadlineMs) {
  return {
    contract: EVIDENCE_CONTRACT,
    sessions: planned.map((p) => JSON.stringify(p.entry)),
    roles: [...EVIDENCE_ROLES],
    part_types: [...EVIDENCE_PART_TYPES],
    max_text_chars: MAX_TEXT_CHARS,
    deadline_ms: deadlineMs,
  }
}

/**
 * The server-side deadline: what is left of the command's budget after
 * discovery, minus the measured round trip to the server, never under
 * 250 ms. The client still aborts at its own budget.
 *
 * @ref LLP 0480#evidence [implements]: deadline_ms from the remaining budget minus the measured round trip, 250 ms floor
 * @param {number} remainingMs
 * @param {number} [roundTripMs]
 */
export function evidenceDeadlineMs(remainingMs, roundTripMs = 0) {
  return Math.max(DEADLINE_FLOOR_MS, Math.floor(remainingMs - roundTripMs))
}

/**
 * Whether a `tools/list` result advertises the verb with this contract. A
 * missing tool means an older server; a contract `enum` without v1 means the
 * server speaks only other versions. Both fall back to `query_sql`.
 *
 * @param {any} toolsList
 * @returns {'supported' | 'missing_tool' | 'unsupported_contract'}
 */
export function evidenceSupport(toolsList) {
  const tool = (Array.isArray(toolsList?.tools) ? toolsList.tools : []).find((/** @type {any} */ t) => t?.name === EVIDENCE_TOOL)
  if (!tool) return 'missing_tool'
  const contracts = tool.inputSchema?.properties?.contract?.enum
  if (Array.isArray(contracts) && !contracts.includes(EVIDENCE_CONTRACT)) return 'unsupported_contract'
  return 'supported'
}

/**
 * Read evidence for the top leads within the command's budget.
 *
 * - `-32601` (no such tool) and a known lack of support fall back to
 *   per-session `query_sql` with the same window, labeled.
 * - `-32602` and a tool error are client defects and come back as an
 *   `invalid_request` failure, never hidden.
 * - A capacity refusal (HTTP 429 at the MCP route, server LLP 0562) is retried once
 *   after at most 250 ms when the budget still leaves the floor deadline for
 *   the retry; otherwise it is `server_busy`.
 * - An abort at the command's budget (the caller's `signal`, which must be
 *   the one the MCP client was created with) is a `deadline` failure.
 *
 * @ref LLP 0480#evidence [implements]: one session_evidence call per command; -32601 falls back, -32602 is reported, the caller's abort reaches the server
 * @param {{
 *   client: EvidenceMcpClient,
 *   leads: readonly Lead[],
 *   remainingMs: number,
 *   roundTripMs?: number,
 *   support?: 'supported' | 'missing_tool' | 'unsupported_contract',
 *   leadCount?: number,
 *   signal?: AbortSignal,
 *   now?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 * }} args
 * @returns {Promise<EvidenceResult>}
 */
export async function fetchEvidence({ client, leads, remainingMs, roundTripMs = 0, support = 'supported', leadCount, signal, now = () => performance.now(), sleep = abortableSleep }) {
  const deadlineAt = now() + remainingMs
  const planned = planEntries(leads, { leads: leadCount })
  const count = planned.reduce((n, p) => Math.max(n, p.lead + 1), 0)
  if (planned.length === 0) return emptyResult('session_evidence', 0)
  if (support !== 'supported') return fallbackEvidence({ client, planned, leadCount: count, deadlineAt, signal, now })
  const outcome = await callEvidence({ client, planned, leadCount: count, deadlineAt, roundTripMs, signal, now, sleep })
  if (outcome === 'fallback') return fallbackEvidence({ client, planned, leadCount: count, deadlineAt, signal, now })
  return outcome
}

/**
 * One `session_evidence` call for already planned entries, with its failure
 * channels. Exported so a fixture's own request can be replayed through it.
 *
 * @param {{
 *   client: EvidenceMcpClient,
 *   planned: readonly PlannedEntry[],
 *   leadCount: number,
 *   deadlineAt: number,
 *   roundTripMs?: number,
 *   request?: Record<string, unknown>,
 *   signal?: AbortSignal,
 *   now?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 * }} args
 * @returns {Promise<EvidenceResult | 'fallback'>}
 */
export async function callEvidence({ client, planned, leadCount, deadlineAt, roundTripMs = 0, request, signal, now = () => performance.now(), sleep = abortableSleep }) {
  let retries = 0
  let args = request ?? evidenceRequest(planned, evidenceDeadlineMs(deadlineAt - now(), roundTripMs))
  for (;;) {
    try {
      const result = await client.callTool(EVIDENCE_TOOL, args, { maxBytes: EVIDENCE_MAX_RESPONSE_BYTES })
      if (result?.isError) {
        const text = firstText(result) ?? 'session_evidence reported an error'
        const code = text.split(':', 1)[0].trim()
        // An older server answered capacity as a tool error; it is the same case.
        if (code === 'org_read_capacity') throw Object.assign(new Error(text), { status: 429 })
        if (code === 'query_deadline_exceeded') return failedResult('session_evidence', leadCount, 'deadline', text, retries)
        return failedResult('session_evidence', leadCount, 'invalid_request', text, retries)
      }
      const structured = result?.structuredContent ?? parseJson(firstText(result))
      const resends = await resendUnfitEntries({ client, planned, structured, args, deadlineAt, roundTripMs, signal, now })
      const read = readEvidenceResponse(planned, structured, leadCount)
      read.retries = retries
      read.resends = resends
      return read
    } catch (err) {
      if (signal?.aborted) return failedResult('session_evidence', leadCount, 'deadline', 'evidence read stopped at the command budget', retries)
      if (err instanceof McpRpcError && err.rpcCode === -32601) return 'fallback'
      if (err instanceof McpRpcError && err.rpcCode === -32602) return failedResult('session_evidence', leadCount, 'invalid_request', err.rpcMessage, retries)
      if (/** @type {any} */ (err)?.status === 429) {
        const left = deadlineAt - now()
        // org_read_capacity is the MCP route's 429 with no Retry-After (server
        // LLP 0562): one retry of at most 250 ms when the budget allows, else busy.
        if (retries === 0 && left - CAPACITY_RETRY_MS >= DEADLINE_FLOOR_MS) {
          retries += 1
          try {
            await sleep(CAPACITY_RETRY_MS, signal)
          } catch {
            return failedResult('session_evidence', leadCount, 'deadline', 'evidence read stopped at the command budget', retries)
          }
          if (!request) args = evidenceRequest(planned, evidenceDeadlineMs(deadlineAt - now(), roundTripMs))
          continue
        }
        return failedResult('session_evidence', leadCount, 'server_busy', 'server busy: the organization read capacity is in use, try again shortly', retries)
      }
      return failedResult('session_evidence', leadCount, 'transport', err instanceof Error ? err.message : String(err), retries)
    }
  }
}

/**
 * Follow entries that came back `partial` with no parts (server LLP 0565#client,
 * LLP 0566): either the entry did not fit its share of the byte cap (its
 * cursor unchanged) or the server skipped a part too large to return (its
 * cursor advanced). Requested alone with its cursor, an entry always makes
 * progress, so each is followed, page by page, while it still has no parts,
 * the budget still leaves the floor deadline, and at most
 * `MAX_FOLLOWS_PER_ENTRY` times. Pages merge into the entry's place in
 * `structured`: parts appended (the reader deduplicates by `part_id`, since a
 * resumed page may repeat rows), `skipped_parts` summed, status, cursor and
 * coverage from the latest page. Error entries (`freshness_unavailable`,
 * `cursor_unresolvable`) are never followed. Returns the pages fetched.
 *
 * @param {{
 *   client: EvidenceMcpClient,
 *   planned: readonly PlannedEntry[],
 *   structured: any,
 *   args: Record<string, unknown>,
 *   deadlineAt: number,
 *   roundTripMs: number,
 *   signal?: AbortSignal,
 *   now: () => number,
 * }} opts
 * @returns {Promise<number>}
 */
async function resendUnfitEntries({ client, planned, structured, args, deadlineAt, roundTripMs, signal, now }) {
  const sessions = Array.isArray(structured?.sessions) ? structured.sessions : []
  let resends = 0
  for (let i = 0; i < sessions.length; i++) {
    const index = sessions[i]?.request_index
    if (!Number.isInteger(index) || !planned[index]) continue
    for (let follow = 0; follow < MAX_FOLLOWS_PER_ENTRY; follow++) {
      const answer = sessions[i]
      if (answer?.status !== 'partial' || (Array.isArray(answer.parts) && answer.parts.length > 0)) break
      const left = deadlineAt - now()
      if (signal?.aborted || left - roundTripMs < DEADLINE_FLOOR_MS) return resends
      const cursor = typeof answer.next_cursor === 'string' ? answer.next_cursor : planned[index].entry.cursor
      const entry = { ...planned[index].entry, ...(cursor ? { cursor } : {}) }
      let again
      try {
        const alone = await client.callTool(EVIDENCE_TOOL, { ...args, sessions: [JSON.stringify(entry)], deadline_ms: evidenceDeadlineMs(left, roundTripMs) }, { maxBytes: EVIDENCE_MAX_RESPONSE_BYTES })
        again = alone?.isError ? null : (alone?.structuredContent ?? parseJson(firstText(alone)))?.sessions?.[0]
      } catch {
        // Keep what was read: the entry stays partial, with its continuation.
        if (signal?.aborted) return resends
        break
      }
      resends++
      if (!again) break
      sessions[i] = {
        ...again,
        request_index: index,
        parts: [...(Array.isArray(answer.parts) ? answer.parts : []), ...(Array.isArray(again.parts) ? again.parts : [])],
        ...(skippedOf(answer) + skippedOf(again) > 0 ? { skipped_parts: skippedOf(answer) + skippedOf(again) } : {}),
        coverage: again.coverage ?? answer.coverage ?? null,
      }
    }
  }
  return resends
}

/** @param {any} answer */
function skippedOf(answer) {
  return Number.isSafeInteger(answer?.skipped_parts) && answer.skipped_parts > 0 ? answer.skipped_parts : 0
}

/**
 * Turn a `session_evidence` response into per-lead evidence. A lead's
 * entries merge: parts deduplicated by `part_id` in time order, the worst
 * status wins (not_found only when every entry is), and the first entry with
 * a cursor becomes the continuation. Unknown response fields are ignored.
 *
 * @param {readonly PlannedEntry[]} planned
 * @param {any} structured
 * @param {number} leadCount
 * @returns {EvidenceResult}
 */
export function readEvidenceResponse(planned, structured, leadCount) {
  const result = emptyResult('session_evidence', leadCount)
  const sessions = Array.isArray(structured?.sessions) ? structured.sessions : []
  /** @type {Map<number, any>} */
  const byIndex = new Map()
  for (const s of sessions) if (Number.isInteger(s?.request_index)) byIndex.set(s.request_index, s)
  /** @type {Array<{ statuses: string[], parts: Map<string, EvidencePart>, continuation: EvidenceEntry | null, error: string | null, unbounded: boolean, skipped: number }>} */
  const acc = Array.from({ length: leadCount }, () => ({ statuses: [], parts: new Map(), continuation: null, error: null, unbounded: false, skipped: 0 }))
  // A lead read by one entry keeps the server's order (asc or desc); one
  // read by two (window and exemplar) is merged back into time order.
  /** @type {string | null} */
  let through = null
  /** @type {Set<string>} */
  const paths = new Set()
  planned.forEach((p, index) => {
    const answer = byIndex.get(index)
    const lead = acc[p.lead]
    if (!lead) return
    if (!answer) { lead.statuses.push('error'); lead.error ??= 'no answer for this entry'; return }
    lead.statuses.push(String(answer.status))
    for (const part of Array.isArray(answer.parts) ? answer.parts : []) {
      const kept = keepPart(part)
      if (!lead.parts.has(kept.part_id)) lead.parts.set(kept.part_id, kept)
    }
    if (typeof answer.next_cursor === 'string' && !lead.continuation) lead.continuation = { ...p.entry, cursor: answer.next_cursor }
    // @ref LLP 0480#evidence [implements]: parts too large to return are counted, never silent (server LLP 0566)
    lead.skipped += skippedOf(answer)
    if (answer.status === 'error') {
      const code = answer.error?.code
      if (code === 'freshness_unavailable') lead.unbounded = true
      lead.error ??= code === 'freshness_unavailable' ? FRESHNESS_UNAVAILABLE_NOTE
        : code === 'cursor_unresolvable' ? CURSOR_UNRESOLVABLE_NOTE
          : code ? `${code}: ${answer.error.message ?? ''}`.trim() : 'entry error'
    }
    const received = answer.coverage?.received_through
    // The evidence is complete only through the earliest point every entry reached.
    if (typeof received === 'string' && (through === null || received < through)) through = received
    if (typeof answer.coverage?.read_path === 'string') paths.add(answer.coverage.read_path)
  })
  result.leads = acc.map((lead) => {
    const status = mergeStatus(lead.statuses)
    const parts = [...lead.parts.values()]
    const note = status === 'not_found' ? NOT_FOUND_NOTE : status === 'invalid_cursor' ? INVALID_CURSOR_NOTE : status === 'error' ? lead.error : null
    return {
      status,
      parts: lead.statuses.length > 1 ? parts.sort(byTime) : parts,
      continuation: lead.continuation,
      note: lead.skipped > 0 ? [note, skippedNote(lead.skipped)].filter(Boolean).join('; ') : note,
      skipped_parts: lead.skipped,
    }
  })
  result.complete = structured?.complete === true && result.leads.every((l) => l.status === 'ok' || l.status === 'not_found')
  result.deadline_reached = structured?.deadline_reached === true
  result.received_through = through
  result.read_path = paths.size === 0 ? null : paths.size === 1 ? [...paths][0] : 'mixed'
  // @ref LLP 0480#evidence [implements]: an entry whose freshness the server could not bound was not read (server LLP 0565#client); when no entry was read, nothing was
  if (acc.length > 0 && acc.every((lead) => lead.unbounded)) result.failure = { code: 'freshness_unavailable', message: FRESHNESS_UNAVAILABLE_NOTE }
  markNothingRead(result)
  return result
}

/**
 * Every lead an error means nothing was read at all: an aggregate failure,
 * so the command exits 1 with the first reason a lead carries.
 *
 * @ref LLP 0480#evidence [implements]: an aggregate failure (nothing read at all) exits 1 with the reason
 * @param {EvidenceResult} result
 */
function markNothingRead(result) {
  if (result.failure || result.leads.length === 0 || !result.leads.every((l) => l.status === 'error')) return
  const reason = result.leads.find((l) => l.note && l.note !== FALLBACK_LABEL)?.note
  result.failure = { code: 'entries_failed', message: reason ? `no lead's evidence could be read: ${reason}` : "no lead's evidence could be read" }
}

/**
 * Per-session `query_sql` reads on a server without the verb: the same
 * window, roles, part types and order the verb would use, `LIMIT
 * max_parts + 1` to tell a full page from a partial one, one entry at a time
 * until the budget runs out. No cursors: a partial lead's follow-up widens
 * with the conversation command instead.
 *
 * @param {{ client: EvidenceMcpClient, planned: readonly PlannedEntry[], leadCount: number, deadlineAt: number, signal?: AbortSignal, now?: () => number }} args
 * @returns {Promise<EvidenceResult>}
 */
export async function fallbackEvidence({ client, planned, leadCount, deadlineAt, signal, now = () => performance.now() }) {
  const result = emptyResult('query_sql', leadCount)
  result.label = FALLBACK_LABEL
  /** @type {Array<{ statuses: string[], parts: Map<string, EvidencePart> }>} */
  const acc = Array.from({ length: leadCount }, () => ({ statuses: [], parts: new Map() }))
  for (const p of planned) {
    const lead = acc[p.lead]
    if (!lead) continue
    if (signal?.aborted || deadlineAt - now() <= 0) { lead.statuses.push('deadline'); continue }
    try {
      const answer = await client.callTool('query_sql', { sql: fallbackSql(p.entry) })
      if (answer?.isError) { lead.statuses.push('error'); continue }
      const structured = answer?.structuredContent ?? parseJson(firstText(answer))
      const rows = Array.isArray(structured?.rows) ? structured.rows : []
      for (const row of rows.slice(0, p.entry.max_parts)) {
        const kept = keepPart(rowToPart(row))
        if (!lead.parts.has(kept.part_id)) lead.parts.set(kept.part_id, kept)
      }
      lead.statuses.push(rows.length > p.entry.max_parts ? 'partial' : 'ok')
    } catch {
      lead.statuses.push(signal?.aborted ? 'deadline' : 'error')
    }
  }
  result.leads = acc.map((lead) => {
    const status = mergeStatus(lead.statuses)
    return { status, parts: [...lead.parts.values()].sort(byTime), continuation: null, note: status === 'ok' ? null : FALLBACK_LABEL, skipped_parts: 0 }
  })
  result.complete = result.leads.every((l) => l.status === 'ok')
  result.deadline_reached = result.leads.some((l) => l.status === 'deadline')
  markNothingRead(result)
  return result
}

/**
 * The verb's own read as SQL (server `entrySql`, LLP 0553): the window on
 * `message_created_at` (from inclusive, to exclusive) with the day bounds
 * widened by a day for partition pruning, the requested roles and part
 * types, and the verb's ordering.
 *
 * @param {EvidenceEntry} entry
 */
export function fallbackSql(entry) {
  const where = [`session_id = ${sqlString(entry.session_id)}`]
  if (entry.from) where.push(`date >= ${sqlString(dayOf(Date.parse(entry.from) - DAY_MS))}`)
  if (entry.to) where.push(`date <= ${sqlString(dayOf(Date.parse(entry.to) - 1 + DAY_MS))}`)
  if (entry.from) where.push(`message_created_at >= ${sqlString(entry.from)}`)
  if (entry.to) where.push(`message_created_at < ${sqlString(entry.to)}`)
  if (entry.message_ids?.length) where.push(`message_id IN (${entry.message_ids.map(sqlString).join(', ')})`)
  where.push(`role IN (${EVIDENCE_ROLES.map(sqlString).join(', ')})`)
  where.push(`part_type IN (${EVIDENCE_PART_TYPES.map(sqlString).join(', ')})`)
  const dir = entry.order === 'desc' ? 'DESC' : 'ASC'
  return `SELECT message_id, part_id, role, message_created_at, message_index, part_index, content_text FROM ai_gateway_messages WHERE ${where.join(' AND ')} `
    + `ORDER BY message_created_at ${dir}, message_index ${dir}, part_index ${dir}, part_id ${dir} LIMIT ${entry.max_parts + 1}`
}

const DAY_MS = 86_400_000

/** @param {number} ms */
function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/** @param {string} value */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** @param {any} row */
function rowToPart(row) {
  const text = row?.content_text == null ? null : String(row.content_text)
  const cut = text === null ? null : capText(text, MAX_TEXT_CHARS)
  return {
    message_id: row?.message_id,
    part_id: row?.part_id,
    role: row?.role,
    message_created_at: row?.message_created_at,
    content_text: cut,
    text_truncated: text !== null && cut !== null && cut.length < text.length,
  }
}

/**
 * Cut `text` to `max` UTF-16 units, one earlier when the cut would leave a
 * lone high surrogate (the server's rule, so both paths cut alike).
 * @param {string} text @param {number} max
 */
export function capText(text, max) {
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}

/**
 * The part fields fastask keeps. Bounded: the server caps text at
 * `max_text_chars` and the count at `max_parts`.
 * @param {any} part
 * @returns {EvidencePart}
 */
function keepPart(part) {
  return {
    message_id: String(part?.message_id ?? ''),
    part_id: String(part?.part_id ?? ''),
    role: String(part?.role ?? ''),
    message_created_at: isoOrNull(part?.message_created_at),
    content_text: part?.content_text == null ? null : String(part.content_text),
    text_truncated: part?.text_truncated === true,
  }
}

/** @param {unknown} value */
function isoOrNull(value) {
  if (value == null) return null
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** @param {EvidencePart} a @param {EvidencePart} b */
function byTime(a, b) {
  return compareStrings(a.message_created_at ?? '', b.message_created_at ?? '')
}

/**
 * @param {string[]} statuses
 * @returns {EvidenceStatus}
 */
function mergeStatus(statuses) {
  if (statuses.length === 0) return 'not_requested'
  if (statuses.every((s) => s === 'not_found')) return 'not_found'
  for (const s of STATUS_RANK) {
    if (s !== 'not_found' && statuses.includes(s)) return s
  }
  return 'error'
}

/**
 * @param {'session_evidence' | 'query_sql'} path
 * @param {number} leadCount
 * @returns {EvidenceResult}
 */
function emptyResult(path, leadCount) {
  return {
    path,
    label: null,
    leads: Array.from({ length: leadCount }, () => /** @type {LeadEvidence} */ ({ status: 'not_requested', parts: [], continuation: null, note: null, skipped_parts: 0 })),
    complete: leadCount === 0,
    deadline_reached: false,
    received_through: null,
    read_path: null,
    failure: null,
    retries: 0,
    resends: 0,
  }
}

/**
 * @param {'session_evidence' | 'query_sql'} path
 * @param {number} leadCount
 * @param {NonNullable<EvidenceResult['failure']>['code']} code
 * @param {string} message
 * @param {number} retries
 */
function failedResult(path, leadCount, code, message, retries) {
  const result = emptyResult(path, leadCount)
  result.complete = false
  result.deadline_reached = code === 'deadline'
  result.failure = { code, message }
  result.retries = retries
  const status = code === 'deadline' ? 'deadline' : 'error'
  for (const lead of result.leads) { lead.status = status; lead.note = message }
  return result
}

/** @param {any} result */
function firstText(result) {
  const item = Array.isArray(result?.content) ? result.content.find((/** @type {any} */ c) => c?.type === 'text') : undefined
  return typeof item?.text === 'string' ? item.text : undefined
}

/** @param {string | undefined} text */
function parseJson(text) {
  if (typeof text !== 'string') return undefined
  try { return JSON.parse(text) } catch { return undefined }
}
