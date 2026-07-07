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
 * and applies the usage-policy resolver late. A now-known cwd that
 * resolves to `ignore` marks the row for removal (the `USAGE_POLICY_DROP`
 * sentinel at its position); otherwise the row is enriched.
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
  const resolver = opts.resolver ?? createUsagePolicyResolver()
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
        const record = pickLatestMatching(sessionRecords, { sessionId })
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
            transcriptPath: record?.transcript_path,
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
          const settled = lateResolveCwd(row, record, resolver)
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

