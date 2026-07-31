// @ts-check

import { isPlainObject, sha256Hex, stringValue } from 'hypaware/core/util'

import { getLogger } from '../../../../src/core/observability/index.js'
import { createUsagePolicyResolver, USAGE_POLICY_DROP } from '../../../../src/core/usage-policy/index.js'
import {
  buildOrdinalFallbackIndex,
  matchOrdinalFallback,
  sessionMatchKey,
  withRoleOrdinals,
} from './match_key.js'
import {
  defaultOpenclawAgentsDir,
  listOpenclawSessionFiles,
  readOpenclawSessionHeader,
  readOpenclawSessionMessages,
} from './session_file.js'

/**
 * @import { AiGatewaySettlementEnricher, DatasetSettleContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { OpenclawSessionHeader, OpenclawSessionIndex, OpenclawSessionMessage } from './types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

const CLIENT_NAME = 'openclaw'

/**
 * How many session files one flush may index. OpenClaw writes one file per
 * session and never prunes, so an install accumulates them without bound;
 * a flush must not pay for the whole history to settle one batch. Candidates
 * are ordered newest-first before this cut, so the bound drops the oldest
 * files, which are exactly the ones a live flush batch cannot belong to.
 */
export const OPENCLAW_SETTLEMENT_CANDIDATE_LIMIT = 32

/**
 * How far a candidate session file's `mtime` may sit *before* the earliest
 * row in the batch and still be considered. A session file is appended to
 * as the session runs, so the file that owns a batch has an `mtime` at or
 * after the batch's first row; the slack only absorbs clock skew between
 * the row timestamps (the daemon's clock) and the file's (the OpenClaw
 * process's), never a genuinely stale file.
 */
export const OPENCLAW_SETTLEMENT_MTIME_SLACK_MS = 60 * 60 * 1000

/**
 * `@hypaware/openclaw` flush-time settlement enricher (LLP 0159).
 *
 * OpenClaw's live rows cannot start native: the request-time contexts a
 * gateway plugin controls carry no session id and no message ids, so the
 * projector keys the session on a prompt-head hash and the gateway
 * synthesizes a content-hash `message_id` (LLP 0144). The session JSONL,
 * written by OpenClaw itself, carries native ids for the session and for
 * every message. At flush this reads that file through the one LLP 0158
 * reader and upgrades a matched row to the native identity the backfill
 * provider will emit for the same turn, so the existing `part_id` dedupe
 * collapses the two routes instead of double-importing every turn.
 *
 * It also carries the client's ONLY `.hypignore` seam. Live OpenClaw proxy
 * rows capture no cwd at all, so without the header `cwd` resolved here the
 * usage policy would fail open for this entire client, permanently. The
 * drop is therefore not an optimization on top of identity settlement, it
 * is the enforcement point (LLP 0049 R1 as extended by LLP 0085).
 *
 * Two shapes from the Claude precedent (`claude/src/settle.js`) are
 * deliberately NOT ported:
 *
 *  - `pickRecordForRow`'s time-slicing. It exists because a Claude session
 *    can carry several session-context records with different cwds. An
 *    OpenClaw session file states exactly one `cwd`, once, in its header
 *    (LLP 0158 Context), so there is nothing to pick between: resolve it
 *    once per file and apply it to every row that file settles.
 *  - last-wins content indexing. See {@link buildOpenclawSessionIndex}: an
 *    ambiguous content key declines to upgrade here rather than handing two
 *    distinct rows the same native `message_id`.
 *
 * @ref LLP 0161#settlement-enricher [implements]: per-session file read,
 * match-key index, identity upgrade, and the single-header-cwd policy drop
 * @ref LLP 0157#requirements [implements]: R14 (resolve the session's cwd
 * through the LLP 0158 reader and drop a policy-ignored row before it is
 * committed) and R9 (both reads go through the one reader, never a private
 * parse)
 *
 * @param {{
 *   homeDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   agentsDir?: string,
 *   clientName?: string,
 *   resolver?: UsagePolicyResolver,
 *   localOnlyListPath?: string,
 *   candidateLimit?: number,
 *   logger?: { info(message: string, fields?: Record<string, unknown>): void, warn(message: string, fields?: Record<string, unknown>): void },
 * }} opts
 * @returns {AiGatewaySettlementEnricher}
 */
export function createOpenclawSettlementEnricher(opts) {
  const clientName = opts.clientName ?? CLIENT_NAME
  const agentsDir = opts.agentsDir ?? defaultOpenclawAgentsDir(opts.env, opts.homeDir)
  // One resolver per enricher (per daemon run): the per-cwd cache rides the
  // flush path, mirroring the Claude enricher. Injectable for tests.
  // @ref LLP 0103 [implements]: consult the machine-local list too, so a
  // header cwd naming a `--private` (`ignore`) dir still drops at settle.
  const resolver = opts.resolver ?? createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })
  const logger = opts.logger ?? getLogger('plugin.openclaw')
  const candidateLimit = opts.candidateLimit ?? OPENCLAW_SETTLEMENT_CANDIDATE_LIMIT

  return {
    name: 'openclaw-settlement',
    clientName,
    /**
     * @param {Record<string, unknown>[]} rows
     * @param {DatasetSettleContext} _ctx
     * @returns {Promise<Array<Record<string, unknown> | typeof USAGE_POLICY_DROP>>}
     */
    async settle(rows, _ctx) {
      if (!Array.isArray(rows) || rows.length === 0) return rows

      // Group rows by the projector's session key so each session file is
      // read and indexed once, mirroring Claude's `bySession` Map. The key
      // is the prompt-head hash (LLP 0144), not a native id: which file it
      // belongs to is what `bindSessionFile` below has to establish.
      /** @type {Map<string, number[]>} */
      const bySession = new Map()
      for (let i = 0; i < rows.length; i++) {
        const sessionId = stringValue(rows[i].session_id)
        if (!sessionId) continue
        const list = bySession.get(sessionId)
        if (list) list.push(i)
        else bySession.set(sessionId, [i])
      }
      if (bySession.size === 0) return rows

      const candidates = await candidateSessionFiles(agentsDir, rows, candidateLimit)
      if (candidates.length === 0) return rows

      /** @type {Map<string, OpenclawSessionIndex>} */
      const indexCache = new Map()
      /** @type {Array<Record<string, unknown> | typeof USAGE_POLICY_DROP>} */
      const out = rows.slice()

      for (const [sessionId, indices] of bySession) {
        const keys = matchKeysOf(rows, indices)
        const index = await bindSessionFile(candidates, indexCache, keys)
        if (!index) {
          // No file claims this session's content. Settling on time alone
          // would risk applying an unrelated session's cwd verdict, and a
          // settlement drop is destructive: decline both the upgrade and
          // the drop, leaving the rows at fallback identity (the residue
          // LLP 0159 accepts, never a lost row).
          logger.info('plugin.openclaw.settlement', {
            component: CLIENT_NAME,
            operation: 'settlement',
            status: 'unbound',
            session_id: sessionId,
            rows: indices.length,
            match_keys: keys.size,
            candidates: candidates.length,
          })
          continue
        }

        // One resolve per session file: the header states exactly one cwd,
        // so there is nothing to re-pick per row (the Claude precedent's
        // pickRecordForRow has no counterpart here).
        const gate = index.cwd ? { cwd: index.cwd, policy: resolver.resolve(index.cwd) } : undefined
        let contentMatches = 0
        let ordinalMatches = 0

        for (const i of indices) {
          const row = rows[i]

          // 1. Identity upgrade. Content match first (strong evidence);
          // only on a miss does the ordinal/time fallback run, as a
          // separate second pass (LLP 0161 Section 5), never merged into
          // one score with the content match.
          const key = readMatchKey(row.attributes)
          let match = key ? index.byContentKey.get(key) : undefined
          if (match) contentMatches++
          else {
            match = ordinalFallbackMatch(index, row)
            if (match) ordinalMatches++
          }

          // 2. cwd policy, independent of match success: it is the session
          // header's, not the matched message's, so a row that never
          // matched is still governed by the directory its session ran in.
          if (gate && gate.policy.class === 'ignore') {
            // @ref LLP 0085#telemetry [implements]: observable as a drop
            // with a hashed cwd, never a raw local path - the same shape
            // the Claude enricher's drop log carries, so one query spans
            // both adapters.
            logger.info('plugin.openclaw.usage_policy_drop', {
              component: CLIENT_NAME,
              operation: 'usage_policy_drop',
              policy_source: 'settlement_late_resolve',
              session_id: sessionId,
              cwd_hash: hashCwd(gate.cwd),
              declared: gate.policy.declared,
              governed_by: gate.policy.governedBy,
              ...(gate.policy.warn ? { warn: gate.policy.warn } : {}),
            })
            out[i] = USAGE_POLICY_DROP
            continue
          }

          out[i] = settleRow(row, match, index)
        }

        logger.info('plugin.openclaw.settlement', {
          component: CLIENT_NAME,
          operation: 'settlement',
          status: gate?.policy.class === 'ignore' ? 'dropped' : 'ok',
          session_id: sessionId,
          native_session_id: index.sessionId,
          rows: indices.length,
          match_keys: keys.size,
          content_matches: contentMatches,
          ordinal_matches: ordinalMatches,
          unmatched: indices.length - contentMatches - ordinalMatches,
          transcript_messages: index.messageCount,
          ...(gate ? { cwd_hash: hashCwd(gate.cwd), usage_class: gate.policy.class } : {}),
        })
      }
      return out
    },
  }
}

/**
 * The session files a flush batch could plausibly belong to: everything
 * under the `agents/` root whose `mtime` is not older than the batch's
 * earliest row (less a skew slack), newest first, capped at `limit`.
 *
 * Both bounds exist for cost, not correctness: a file the window excludes
 * simply never becomes a candidate, which degrades to "row stays at
 * fallback identity", the same outcome as a session OpenClaw has not
 * flushed to disk yet.
 *
 * @param {string} agentsDir
 * @param {Record<string, unknown>[]} rows
 * @param {number} limit
 * @returns {Promise<Array<{ path: string, mtimeMs: number }>>}
 */
async function candidateSessionFiles(agentsDir, rows, limit) {
  const files = await listOpenclawSessionFiles(agentsDir)
  if (files.length === 0) return files
  let earliest = Infinity
  for (const row of rows) {
    const ms = toEpochMs(row.message_created_at)
    if (ms !== undefined && ms < earliest) earliest = ms
  }
  const floor = earliest === Infinity ? -Infinity : earliest - OPENCLAW_SETTLEMENT_MTIME_SLACK_MS
  return files
    .filter((file) => file.mtimeMs >= floor)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
}

/**
 * Bind one hash-keyed row group to at most one session file.
 *
 * The design says the match index is "scoped to this one session file
 * only". Which file that is, though, is not something a live row states:
 * its `session_id` is a prompt-head hash the session file never sees
 * (LLP 0144), so the binding has to be established rather than read. It is
 * established by CONTENT, the same evidence the identity upgrade itself
 * rests on: the candidate whose transcript contains the most of this
 * group's match keys wins, ties break toward the newer file, and a
 * candidate that contains none of them is not a candidate at all.
 *
 * Content is the right key here precisely because the weaker signals are
 * not safe for this decision: binding by time or by recency alone would
 * hand a group whatever session happened to be running, and the cwd verdict
 * that follows the binding DROPS rows. A wrong binding is therefore a
 * silent data loss, while an absent binding is only an unsettled row.
 *
 * Scans stop early on a candidate that contains every key in the group
 * (nothing can beat it), so the common case reads one file.
 *
 * @param {Array<{ path: string, mtimeMs: number }>} candidates newest-first
 * @param {Map<string, OpenclawSessionIndex>} cache per-flush, keyed by file path
 * @param {Set<string>} keys the group's distinct match keys
 * @returns {Promise<OpenclawSessionIndex | undefined>}
 */
async function bindSessionFile(candidates, cache, keys) {
  if (keys.size === 0) return undefined
  /** @type {OpenclawSessionIndex | undefined} */
  let best
  let bestScore = 0
  for (const candidate of candidates) {
    let index = cache.get(candidate.path)
    if (!index) {
      index = await readOpenclawSessionIndex(candidate)
      cache.set(candidate.path, index)
    }
    let score = 0
    for (const key of keys) {
      if (index.byContentKey.has(key)) score++
    }
    if (score > bestScore) {
      best = index
      bestScore = score
      if (score === keys.size) break
    }
  }
  return best
}

/**
 * Read and index one session file. Best-effort end to end (the reader
 * itself never throws): an unreadable file yields an empty index and an
 * absent cwd, which settles nothing and drops nothing.
 *
 * @param {{ path: string, mtimeMs: number }} candidate
 * @returns {Promise<OpenclawSessionIndex>}
 */
async function readOpenclawSessionIndex(candidate) {
  /** @type {OpenclawSessionHeader | undefined} */
  let header
  /** @type {OpenclawSessionMessage[]} */
  let messages = []
  try {
    header = readOpenclawSessionHeader(candidate.path)
    messages = await readOpenclawSessionMessages(candidate.path)
  } catch {
    header = undefined
    messages = []
  }
  return buildOpenclawSessionIndex(candidate, header, messages)
}

/**
 * Build the two match structures from one session file's transcript.
 *
 * `byContentKey` maps a {@link sessionMatchKey} to the message that owns
 * it, but only while that ownership is unambiguous: a key two messages
 * share is REMOVED, not last-wins (the Claude precedent's choice). Two
 * rows upgrading to one native `message_id` would give them one `part_id`
 * as well, and `part_id` dedupe would then collapse two genuinely distinct
 * messages into one committed row - a settlement that loses data. Declining
 * is free by comparison: the rows keep fallback identity.
 *
 * `ordinalIndex` and `positions` are the second pass's halves: the index
 * keyed by `(role, same-role ordinal)` as T4 defines it, and the parallel
 * per-position role/ordinal table {@link ordinalFallbackMatch} uses to turn
 * a row's `message_index` into the ordinal to look up. EVERY message feeds
 * the ordinal index, including the ones with no native id and no usable
 * timestamp, because `buildOrdinalFallbackIndex` counts ordinals over the
 * entries it is handed: skipping one would silently renumber every later
 * message and desynchronize the two halves. A message with no timestamp
 * gets `Infinity` instead, which is outside every window, so it is indexed
 * but never matched.
 *
 * @param {{ path: string, mtimeMs: number }} candidate
 * @param {OpenclawSessionHeader | undefined} header
 * @param {OpenclawSessionMessage[]} messages
 * @returns {OpenclawSessionIndex}
 */
function buildOpenclawSessionIndex(candidate, header, messages) {
  /** @type {Map<string, OpenclawSessionMessage>} */
  const byContentKey = new Map()
  /** @type {Set<string>} */
  const ambiguous = new Set()
  /** @type {Array<{ role: string, timestampMs: number, value: OpenclawSessionMessage }>} */
  const ordinalEntries = []
  /** @type {Array<{ role: string, ordinal: number }>} */
  const positions = []

  const roles = messages.map((message) => rawRole(message))
  const counted = withRoleOrdinals(
    messages.map((message, i) => ({ message, role: normalizeRole(roles[i]) })),
    (entry) => entry.role
  )
  for (let i = 0; i < counted.length; i++) {
    const { entry, role, ordinal } = counted[i]
    const message = entry.message
    positions.push({ role, ordinal })
    ordinalEntries.push({
      role,
      timestampMs: message.timestampMs ?? Number.POSITIVE_INFINITY,
      value: message,
    })
    // A message the file gives no native id is indexed for position only:
    // there is no identity to upgrade a row to, so it never enters the
    // content index.
    if (!message.id) continue
    const key = sessionMatchKey(roles[i], message.record.content)
    if (ambiguous.has(key)) continue
    if (byContentKey.has(key)) {
      byContentKey.delete(key)
      ambiguous.add(key)
    } else {
      byContentKey.set(key, message)
    }
  }

  return {
    path: candidate.path,
    mtimeMs: candidate.mtimeMs,
    sessionId: header?.sessionId,
    cwd: header?.cwd,
    messageCount: messages.length,
    byContentKey,
    ordinalIndex: buildOrdinalFallbackIndex(ordinalEntries),
    positions,
  }
}

/**
 * The second match pass: a row whose content key missed retries once
 * against `(role, same-role ordinal)`, bounded to T4's five-minute window
 * around the row's own `message_created_at`.
 *
 * The ordinal comes from the FILE, not from the batch. A row's
 * `message_index` is its position in the exchange's own message array, and
 * OpenClaw re-sends the whole conversation on every request, so that
 * position is the message's position in the session, the same ordering the
 * session file appends in. The file can therefore say which
 * `(role, ordinal)` sits at that position; the batch cannot, since a
 * mid-session flush holds only the turns the gateway had not already seen.
 *
 * Two guards keep this from mis-assigning identity. The row's position must
 * exist in the file, and the role recorded at that position must be the
 * row's own role: a session whose wire shape and file shape disagree about
 * message boundaries (a `toolResult` record that the Anthropic wire nests
 * inside a `user` turn) shifts every later position, and the role check is
 * what notices. The window does the rest.
 *
 * @param {OpenclawSessionIndex} index
 * @param {Record<string, unknown>} row
 * @returns {OpenclawSessionMessage | undefined}
 */
function ordinalFallbackMatch(index, row) {
  const messageIndex = integerValue(row.message_index)
  if (messageIndex === undefined) return undefined
  const position = index.positions[messageIndex]
  if (!position) return undefined
  const role = stringValue(row.role)
  if (!role || normalizeRole(role) !== position.role) return undefined
  const rowMs = toEpochMs(row.message_created_at)
  if (rowMs === undefined) return undefined
  return matchOrdinalFallback(index.ordinalIndex, position.role, position.ordinal, rowMs)
}

/**
 * Produce the settled copy of one row: native identity when a session
 * message matched, and the session's header `cwd` when the header stated a
 * usable one (the caller has already established it is not `ignore`).
 *
 * `session_id` is upgraded only alongside a matched message, per LLP 0159:
 * it is a partition key (LLP 0030), and moving an unmatched row into the
 * native partition would separate it from the fallback twin the compaction
 * re-settle sweep can still collapse. `cwd` is stamped regardless, because
 * it is the session header's fact about the whole file, not the matched
 * message's.
 *
 * @ref LLP 0159#decision [implements]: settlement upgrades a matched row to
 * the native message id and the header's session container id, and stamps
 * the header cwd, so live and backfill rows converge on one identity
 * @param {Record<string, unknown>} row
 * @param {OpenclawSessionMessage | undefined} match
 * @param {OpenclawSessionIndex} index
 * @returns {Record<string, unknown>}
 */
function settleRow(row, match, index) {
  /** @type {Record<string, unknown>} */
  let settled = row
  if (match?.id) {
    settled = { ...row }
    settled.message_id = match.id
    if (index.sessionId) settled.session_id = index.sessionId
    const partIndex = settled.part_index
    if (typeof partIndex === 'number' || typeof partIndex === 'bigint') {
      settled.part_id = `${match.id}#${partIndex}`
    }
    settled.attributes = cleanAttributes(settled.attributes)
  }
  if (index.cwd && !stringValue(settled.cwd)) {
    if (settled === row) settled = { ...row }
    settled.cwd = index.cwd
  }
  return settled
}

/**
 * The distinct `attributes.openclaw.match_key` values a row group carries.
 *
 * @param {Record<string, unknown>[]} rows
 * @param {number[]} indices
 * @returns {Set<string>}
 */
function matchKeysOf(rows, indices) {
  /** @type {Set<string>} */
  const keys = new Set()
  for (const i of indices) {
    const key = readMatchKey(rows[i].attributes)
    if (key) keys.add(key)
  }
  return keys
}

/**
 * Strip the fallback provenance now that identity is native: drop
 * `gateway.identity_source` and the spent `openclaw.match_key`, mirroring
 * the Claude enricher's `cleanAttributes`. Accepts the attributes column
 * whether stored as an object or a JSON string, and returns the input
 * untouched when it is neither.
 *
 * @param {unknown} attributes
 */
function cleanAttributes(attributes) {
  const parsed = typeof attributes === 'string' ? safeParseJson(attributes) : attributes
  if (!isPlainObject(parsed)) return attributes
  /** @type {Record<string, unknown>} */
  const next = { ...parsed }
  if (isPlainObject(next.gateway)) {
    const gateway = { ...next.gateway }
    delete gateway.identity_source
    next.gateway = gateway
  }
  if (isPlainObject(next.openclaw)) {
    const openclaw = { ...next.openclaw }
    delete openclaw.match_key
    if (Object.keys(openclaw).length === 0) delete next.openclaw
    else next.openclaw = openclaw
  }
  return next
}

/** @param {unknown} attributes */
function readMatchKey(attributes) {
  const parsed = typeof attributes === 'string' ? safeParseJson(attributes) : attributes
  if (!isPlainObject(parsed)) return undefined
  const openclaw = parsed.openclaw
  if (!isPlainObject(openclaw)) return undefined
  return stringValue(openclaw.match_key)
}

/**
 * A session message record's own role, as written in the file (the raw
 * value `sessionMatchKey` needs, since it owns the `toolResult`
 * reconciliation itself).
 *
 * @param {OpenclawSessionMessage} message
 * @returns {string}
 */
function rawRole(message) {
  return stringValue(message.record.role) ?? 'unknown'
}

/**
 * The role a session record and a row are compared under. `toolResult` is
 * an OpenClaw session-file record shape whose Anthropic-wire equivalent is
 * a `tool_result` block nested in a `user` turn, so it counts as `user`
 * here for the same reason `sessionMatchKey` hashes it under `user`.
 *
 * @param {string} role
 * @returns {string}
 */
function normalizeRole(role) {
  return role === 'toolResult' ? 'user' : role
}

/**
 * Short, one-way digest of a `cwd` for the settlement drop event: dev
 * telemetry must never carry a raw local path, only a stable token
 * (mirrors the Claude enricher's `hashCwd`, same length, so the two
 * adapters' drop events are comparable).
 *
 * @param {string} cwd
 * @returns {string}
 */
function hashCwd(cwd) {
  return sha256Hex(cwd).slice(0, 16)
}

/**
 * Normalize a row timestamp to epoch millis: the ISO-8601 string the live
 * path writes, or the epoch-ms number/bigint/all-digit string a TIMESTAMP
 * takes once it has round-tripped through the spool.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function toEpochMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (/^\d+$/.test(trimmed)) return Number(trimmed)
    const ms = Date.parse(trimmed)
    return Number.isNaN(ms) ? undefined : ms
  }
  return undefined
}

/** @param {unknown} value */
function integerValue(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

/** @param {string} value */
function safeParseJson(value) {
  try { return JSON.parse(value) } catch { return undefined }
}
