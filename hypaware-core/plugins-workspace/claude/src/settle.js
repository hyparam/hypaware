// @ts-check

import { createHash } from 'node:crypto'

import {
  agentScopedKey,
  assignTranscriptIdentity,
  defaultClaudeProjectsDir,
  indexTranscriptEntries,
  loadTranscript,
  withToolUseResult,
} from './transcripts.js'
import { pickLatestMatching, readSessionContext } from './session_context.js'
import { getLogger } from '../../../../src/core/observability/index.js'
import { createUsagePolicyResolver, USAGE_POLICY_DROP } from '../../../../src/core/usage-policy/index.js'
import { isPlainObject, stringValue } from 'hypaware/core/util'

/**
 * @import { AiGatewaySettlementEnricher, DatasetSettleContext } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { SessionContextRecord, TranscriptEntry } from './types.js'
 * @import { ResolveResult, UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

/**
 * `@hypaware/claude` flush-time settlement enricher (LLP 0027).
 *
 * The live projector writes a Claude message under a fallback hash id
 * when its transcript line hasn't landed on disk yet (the
 * finalize-vs-transcript race). At flush (minutes later, the line now
 * present), this upgrades those rows to native uuid identity so they
 * collapse onto the uuid copy a later replay already wrote.
 *
 * Each fallback row carries `attributes.claude.match_key` (stamped at
 * projection from the wire content), so settlement is a pure transcript
 * lookup (no need to reconstruct the content array that per-part
 * expansion discards). Rows that still don't match (no transcript line:
 * harness aux traffic, wire-only reminders) are returned unchanged.
 *
 * A second, transcript-independent pass handles the session-start race
 * (issue #258): a row that was projected before the session-context
 * hook record landed carries `cwd = null`, so the projector's
 * `.hypignore` check was skipped (fail-open). At flush the record is
 * present, so this re-reads it, fills `cwd`/`git_branch`/`repo_root`,
 * and applies the usage-policy resolver late. Because a session can hold
 * several context records with different cwds (a mid-session dir change),
 * the record is chosen PER ROW by the row's own time (`pickRecordForRow`),
 * not the session's latest: these are opening exchanges, so the newest cwd
 * is the wrong one. A now-known cwd that resolves to `ignore` marks the row
 * for removal (the `USAGE_POLICY_DROP` sentinel at its position); otherwise
 * the row is enriched.
 * @ref LLP 0085 [implements]: flush-time settlement may DROP a late-resolved
 * `ignore` row, not only upgrade identity - the capture-seam-or-settlement
 * enforcement of the `.hypignore` guarantee when cwd was unknown at capture.
 *
 * @param {{
 *   homeDir: string,
 *   stateFile: string,
 *   projectsDir?: string,
 *   clientName?: string,
 *   resolver?: UsagePolicyResolver,
 *   localOnlyListPath?: string,
 *   logger?: { info(message: string, fields?: Record<string, unknown>): void, warn(message: string, fields?: Record<string, unknown>): void },
 * }} opts
 * @returns {AiGatewaySettlementEnricher}
 */
export function createClaudeSettlementEnricher(opts) {
  const projectsDir = opts.projectsDir ?? defaultClaudeProjectsDir(opts.homeDir)
  const stateFile = opts.stateFile
  const clientName = opts.clientName ?? 'claude'
  // One resolver per enricher (per daemon run): the per-cwd cache rides the
  // flush path, mirroring the projector's live-capture resolver. Injectable
  // for tests. @ref LLP 0050 [constrained-by]: the same shared core matcher the
  // capture-seam drop uses; the drop just happens later here.
  // @ref LLP 0103 [implements]: consult the machine-local list too, so a late
  // cwd resolving to a `--private` (`ignore`) dir still drops at settle.
  const resolver = opts.resolver ?? createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })
  const logger = opts.logger ?? getLogger('plugin.claude')

  return {
    name: 'claude-settlement',
    clientName,
    /**
     * @param {Record<string, unknown>[]} rows
     * @param {DatasetSettleContext} _ctx
     * @returns {Promise<Array<Record<string, unknown> | typeof USAGE_POLICY_DROP>>}
     */
    async settle(rows, _ctx) {
      if (!Array.isArray(rows) || rows.length === 0) return rows

      // Group rows by session so each session's transcript is loaded and
      // indexed once. @ref LLP 0030#decision: the session id lives in
      // `session_id` now; Claude `conversation_id` is null, so grouping on it
      // would load nothing and never enrich.
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

      /** @type {SessionContextRecord[]} */
      const sessionRecords = await readSessionContextSafe(stateFile)

      /** @type {Array<Record<string, unknown> | typeof USAGE_POLICY_DROP>} */
      const out = rows.slice()
      for (const [sessionId, indices] of bySession) {
        // Transcript path is session-level (stable across a session's context
        // records), so the session-latest record is fine for the transcript
        // load. The cwd record, in contrast, is chosen PER ROW below: a session
        // can carry records with different cwds, and the null-cwd rows are its
        // opening exchanges (see pickRecordForRow).
        const sessionRecord = pickLatestMatching(sessionRecords, { sessionId })
        // Transcript load feeds the identity upgrade; it is best-effort and
        // INDEPENDENT of the cwd late-resolution below (they read different
        // files), so an empty/unreadable transcript must NOT skip cwd
        // settlement for the session (that would re-open the #258 hole).
        /** @type {Awaited<ReturnType<typeof loadTranscript>>} */
        let entries = []
        try {
          entries = await loadTranscript({
            projectsDir,
            sessionId,
            transcriptPath: sessionRecord?.transcript_path,
          })
        } catch {
          entries = []
        }
        const index = entries.length > 0 ? indexTranscriptEntries(entries) : undefined

        for (const i of indices) {
          let row = rows[i]
          // 1. Identity upgrade: only fallback rows carry a match_key, and only
          // once the transcript line has landed. The content-key index is
          // agent-scoped, so settle a row only against its own thread's entries
          // (row.agent_id; empty = main loop) - a subagent row must not match a
          // main-loop entry's uuid and vice versa.
          if (index) {
            const key = readMatchKey(row.attributes)
            if (key) {
              const match = index.byContentKey.get(agentScopedKey(stringValue(row.agent_id), key))
              if (match && match.provider_uuid) row = upgradeRow(row, match)
            }
          }

          // 2. cwd late-resolution (issue #258). Independent of the transcript.
          // Select the context record by the row's OWN time, not the session's
          // latest: a session can change dirs, and these null-cwd rows are the
          // opening exchanges, so the newest record can carry a different cwd
          // that would leak an ignored opening row or drop a clean one.
          const rowRecord = pickRecordForRow(sessionRecords, sessionId, row.message_created_at, row.message_index)
          const settled = lateResolveCwd(row, rowRecord, resolver)
          if (settled.drop) {
            // @ref LLP 0085#telemetry [implements]: observable as a drop with a
            // hashed cwd, never a raw local path (mirrors the capture-seam drop
            // event the projector emits).
            logger.info('plugin.claude.usage_policy_drop', {
              component: 'claude',
              operation: 'usage_policy_drop',
              policy_source: 'settlement_late_resolve',
              session_id: sessionId,
              cwd_hash: hashCwd(settled.cwd),
              declared: settled.policy.declared,
              governed_by: settled.policy.governedBy,
              ...(settled.policy.warn ? { warn: settled.policy.warn } : {}),
            })
            out[i] = USAGE_POLICY_DROP
            continue
          }
          out[i] = settled.row
        }
      }
      return out
    },
  }
}

/**
 * Give a row whose `cwd` was null at capture (the #258 race) a second look now
 * that its session-context record is present. Returns a `drop` verdict when the
 * now-known cwd resolves to `ignore`; otherwise the (possibly cwd-enriched) row.
 * A row that already has a cwd, or a session whose record never arrived
 * (SDK/headless traffic), is returned unchanged - no drop, no crash.
 *
 * @param {Record<string, unknown>} row
 * @param {SessionContextRecord | undefined} record
 * @param {UsagePolicyResolver} resolver
 * @returns {{ drop: true, cwd: string, policy: ResolveResult } | { drop?: false, row: Record<string, unknown> }}
 */
function lateResolveCwd(row, record, resolver) {
  if (stringValue(row.cwd)) return { row } // cwd already known; nothing to do
  const cwd = record ? stringValue(record.cwd) : undefined
  if (!cwd) return { row } // context never arrived: settle unchanged
  const policy = resolver.resolve(cwd)
  // @ref LLP 0085 [implements]: only `ignore` drops; `local-only`/`full` enrich
  // (a filled cwd also re-arms the LLP 0070 export-seam withholding).
  if (policy.class === 'ignore') return { drop: true, cwd, policy }
  /** @type {Record<string, unknown>} */
  const enriched = { ...row, cwd }
  fillIfEmpty(enriched, 'git_branch', record?.git_branch)
  fillIfEmpty(enriched, 'repo_root', record?.repo_root)
  fillIfEmpty(enriched, 'git_remote', record?.git_remote)
  fillIfEmpty(enriched, 'head_sha', record?.head_sha)
  return { row: enriched }
}

/**
 * Choose the session-context record to late-resolve ONE row's cwd against.
 *
 * A session can carry several context records with different cwds: the hook
 * fires on SessionStart / UserPromptSubmit / PostToolUse, and part (a) of
 * LLP 0085 appends TWO records per fire (a minimal `{session_id, cwd, ts}` then
 * an enriched one with git identity). The rows this settles are a session's
 * OPENING exchanges (they raced past the capture seam with `cwd = null`), so
 * resolving every one against the session's NEWEST record (`pickLatestMatching`)
 * is wrong once the session changed dirs: an opening row projected in an ignored
 * dir would survive (leak), or a clean opening row would be dropped against a
 * later ignored cwd (data loss). Because settlement now DROPS, that
 * mis-selection is destructive, so pick the record live at the row's OWN time.
 *
 * Rule: the latest record for the session whose `ts` is at or before the row's
 * `message_created_at`. Tie-break on equal `ts`: the ENRICHED record wins over
 * the minimal one from the same fire, so git identity still lands on a tie.
 *
 * Fallbacks (never crash, never silently mis-resolve): a row with no usable
 * timestamp resolves against the session-start (earliest) record when it is the
 * opening row (`message_index === 0`), else the session's latest (the prior
 * behavior); a row that predates every record (clock skew) resolves against the
 * earliest record, the one closest to the opening exchange.
 *
 * @ref LLP 0085 [implements]: the settlement backstop's "second look" selects
 * the context record by the row's own time, so a mid-session dir change cannot
 * leak an ignored opening row or drop a clean one.
 *
 * @param {SessionContextRecord[]} records all records (any session)
 * @param {string} sessionId
 * @param {unknown} rowTs the row's `message_created_at`
 * @param {unknown} messageIndex the row's `message_index`
 * @returns {SessionContextRecord | undefined}
 */
function pickRecordForRow(records, sessionId, rowTs, messageIndex) {
  const forSession = records.filter((r) => r.session_id === sessionId)
  if (forSession.length === 0) return undefined
  const rowMs = toEpochMs(rowTs)
  if (rowMs === undefined) {
    // No comparable row time: an opening row's safest signal is the earliest
    // (session-start) record; otherwise keep the newest-wins prior behavior.
    return isOpeningIndex(messageIndex)
      ? earliestRecord(forSession)
      : pickLatestMatching(records, { sessionId }) ?? earliestRecord(forSession)
  }
  /** @type {SessionContextRecord | undefined} */
  let best
  let bestMs = -Infinity
  for (const r of forSession) {
    const ms = toEpochMs(r.ts)
    if (ms === undefined || ms > rowMs) continue
    if (ms > bestMs || (best !== undefined && ms === bestMs && isEnrichedRecord(r) && !isEnrichedRecord(best))) {
      best = r
      bestMs = ms
    }
  }
  // Every record is newer than the row (the row predates all recorded context):
  // fall back to the earliest, the record closest to the opening exchange.
  return best ?? earliestRecord(forSession)
}

/**
 * A record is "enriched" when part (a)'s second write added git identity beyond
 * the minimal `{session_id, cwd, ts}` (any of git_branch / git_remote /
 * head_sha / repo_root). Used to break a same-fire `ts` tie toward the richer
 * record.
 *
 * @param {SessionContextRecord} record
 */
function isEnrichedRecord(record) {
  return Boolean(record.git_branch || record.git_remote || record.head_sha || record.repo_root)
}

/**
 * The earliest record in a session's (append-ordered) list by `ts`, i.e. its
 * session-start fire. Prefers a record with a parseable `ts`; falls back to
 * append order when none parse.
 *
 * @param {SessionContextRecord[]} records non-empty, single-session
 * @returns {SessionContextRecord}
 */
function earliestRecord(records) {
  let best = records[0]
  let bestMs = toEpochMs(best.ts)
  for (let i = 1; i < records.length; i++) {
    const ms = toEpochMs(records[i].ts)
    if (ms !== undefined && (bestMs === undefined || ms < bestMs)) {
      best = records[i]
      bestMs = ms
    }
  }
  return best
}

/** @param {unknown} messageIndex */
function isOpeningIndex(messageIndex) {
  return messageIndex === 0 || messageIndex === 0n
}

/**
 * Normalize a timestamp (a row's `message_created_at` or a record's `ts`) to
 * epoch milliseconds for ordering. Handles the ISO-8601 string both sides use
 * on the live path (`new Date().toISOString()`), plus the epoch-ms number,
 * bigint, or all-digit string a row's TIMESTAMP can take once it has
 * round-tripped through the spool or a committed partition. Returns `undefined`
 * when absent or unparseable, so the caller falls back rather than compare
 * against NaN.
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
    // A pure-integer string is an epoch-ms TIMESTAMP (a bigint serialized to
    // string on the spool path); anything else is an ISO-8601 instant.
    if (/^\d+$/.test(trimmed)) return Number(trimmed)
    const ms = Date.parse(trimmed)
    return Number.isNaN(ms) ? undefined : ms
  }
  return undefined
}

/**
 * Set `obj[key]` to `value` only when `value` is a non-empty string and the
 * key is not already populated (never overwrite a real value with a record's
 * stale/absent one).
 *
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {unknown} value
 */
function fillIfEmpty(obj, key, value) {
  const v = stringValue(value)
  if (v && !stringValue(obj[key])) obj[key] = v
}

/**
 * Short, one-way digest of a `cwd` for the settlement drop event: dev telemetry
 * must never carry a raw local path, only a stable token (mirrors
 * `storage.js`'s `hashCwd` for the export-drop aggregate).
 *
 * @param {string} cwd
 * @returns {string}
 */
function hashCwd(cwd) {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16)
}

/**
 * Produce an upgraded copy of a fallback row: native identity from the
 * transcript line, a recomputed `part_id`, and a cleaned `attributes`
 * (fallback marker and the now-spent match_key removed).
 *
 * @param {Record<string, unknown>} row
 * @param {TranscriptEntry} match
 * @returns {Record<string, unknown>}
 */
function upgradeRow(row, match) {
  const upgraded = { ...row }
  assignTranscriptIdentity(upgraded, match)
  const partIndex = upgraded.part_index
  if (typeof upgraded.message_id === 'string' &&
      (typeof partIndex === 'number' || typeof partIndex === 'bigint')) {
    upgraded.part_id = `${upgraded.message_id}#${partIndex}`
  }
  const cleaned = cleanAttributes(upgraded.attributes)
  // Stamp the transcript's structured tool result like the live match
  // path does, but never at the cost of an attributes column we could
  // not parse into an object.
  upgraded.attributes = isPlainObject(cleaned) || cleaned === undefined
    ? withToolUseResult(cleaned, match)
    : cleaned
  return upgraded
}

/**
 * Strip the fallback provenance now that identity is native: drop
 * `gateway.identity_source` and `claude.match_key`. Accepts the
 * attributes column whether stored as an object or a JSON string;
 * always returns an object (or undefined).
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
  if (isPlainObject(next.claude)) {
    const claude = { ...next.claude }
    delete claude.match_key
    if (Object.keys(claude).length === 0) delete next.claude
    else next.claude = claude
  }
  return next
}

/** @param {unknown} attributes */
function readMatchKey(attributes) {
  const parsed = typeof attributes === 'string' ? safeParseJson(attributes) : attributes
  if (!isPlainObject(parsed)) return undefined
  const claude = parsed.claude
  if (!isPlainObject(claude)) return undefined
  return stringValue(claude.match_key)
}

/**
 * @param {string} stateFile
 * @returns {Promise<SessionContextRecord[]>}
 */
async function readSessionContextSafe(stateFile) {
  try {
    return await readSessionContext(stateFile)
  } catch {
    return []
  }
}

/** @param {string} value */
function safeParseJson(value) {
  try { return JSON.parse(value) } catch { return undefined }
}

