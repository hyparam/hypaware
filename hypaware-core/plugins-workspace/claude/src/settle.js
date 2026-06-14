// @ts-check

import {
  agentScopedKey,
  assignTranscriptIdentity,
  defaultClaudeProjectsDir,
  indexTranscriptEntries,
  loadTranscript,
} from './transcripts.js'
import { pickLatestMatching, readSessionContext } from './session_context.js'

/**
 * @import { AiGatewaySettlementEnricher, DatasetSettleContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { SessionContextRecord } from './types.d.ts'
 */

/**
 * `@hypaware/claude` flush-time settlement enricher (LLP 0024).
 *
 * The live projector writes a Claude message under a fallback hash id
 * when its transcript line hasn't landed on disk yet (the
 * finalize-vs-transcript race). At flush — minutes later, the line now
 * present — this upgrades those rows to native uuid identity so they
 * collapse onto the uuid copy a later replay already wrote.
 *
 * Each fallback row carries `attributes.claude.match_key` (stamped at
 * projection from the wire content), so settlement is a pure transcript
 * lookup — no need to reconstruct the content array that per-part
 * expansion discards. Rows that still don't match (no transcript line —
 * harness aux traffic, wire-only reminders) are returned unchanged.
 *
 * @param {{ homeDir: string, stateFile: string, projectsDir?: string, clientName?: string }} opts
 * @returns {AiGatewaySettlementEnricher}
 */
export function createClaudeSettlementEnricher(opts) {
  const projectsDir = opts.projectsDir ?? defaultClaudeProjectsDir(opts.homeDir)
  const stateFile = opts.stateFile
  const clientName = opts.clientName ?? 'claude'

  return {
    name: 'claude-settlement',
    clientName,
    /**
     * @param {Record<string, unknown>[]} rows
     * @param {DatasetSettleContext} _ctx
     * @returns {Promise<Record<string, unknown>[]>}
     */
    async settle(rows, _ctx) {
      if (!Array.isArray(rows) || rows.length === 0) return rows

      // Group fallback rows by conversation so each session's transcript
      // is loaded and indexed once.
      /** @type {Map<string, number[]>} */
      const byConversation = new Map()
      for (let i = 0; i < rows.length; i++) {
        const conversationId = stringValue(rows[i].conversation_id)
        if (!conversationId) continue
        const list = byConversation.get(conversationId)
        if (list) list.push(i)
        else byConversation.set(conversationId, [i])
      }
      if (byConversation.size === 0) return rows

      /** @type {SessionContextRecord[]} */
      const sessionRecords = await readSessionContextSafe(stateFile)

      const out = rows.slice()
      for (const [sessionId, indices] of byConversation) {
        const record = pickLatestMatching(sessionRecords, { sessionId })
        /** @type {Awaited<ReturnType<typeof loadTranscript>>} */
        let entries
        try {
          entries = await loadTranscript({
            projectsDir,
            sessionId,
            transcriptPath: record?.transcript_path,
          })
        } catch {
          continue
        }
        if (entries.length === 0) continue
        const index = indexTranscriptEntries(entries)

        for (const i of indices) {
          const row = rows[i]
          const key = readMatchKey(row.attributes)
          if (!key) continue
          // The content-key index is agent-scoped, so settle a row only
          // against its own thread's entries (row.agent_id; empty = main
          // loop). Prevents a subagent row from matching a main-loop
          // entry's uuid and vice versa.
          const match = index.byContentKey.get(agentScopedKey(stringValue(row.agent_id), key))
          if (!match || !match.provider_uuid) continue
          out[i] = upgradeRow(row, match)
        }
      }
      return out
    },
  }
}

/**
 * Produce an upgraded copy of a fallback row: native identity from the
 * transcript line, a recomputed `part_id`, and a cleaned `attributes`
 * (fallback marker and the now-spent match_key removed).
 *
 * @param {Record<string, unknown>} row
 * @param {import('./types.d.ts').TranscriptEntry} match
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
  upgraded.attributes = cleanAttributes(upgraded.attributes)
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

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
