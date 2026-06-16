// @ts-check

import path from 'node:path'

/**
 * @import { ContractRule, GraphKit } from './types.d.ts'
 */

/** This connector's plugin name, stamped on the contract for provenance/dedup keys. */
export const PLUGIN_NAME = '@hypaware/ai-gateway-graph'

/** The public dataset the gateway fills; named by string (no import of ai-gateway private files, per LLP 0006). */
export const SOURCE_DATASET = 'ai_gateway_messages'
/** Projector id stamped into every row's provenance. */
export const PROJECTOR = 'ai-gateway.t0'
/** Projector version, stamped into provenance to mark which projector generation minted a row (not a re-projection trigger — ids are content-addressed; see LLP 0023 §inline-provenance). */
export const PROJECTOR_VERSION = 1

/** Tools whose args name a concrete file. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * Build the `ai_gateway_messages → graph` T0 contract. The rules are the same
 * hand-authored node/edge mappings that used to live in `@hypaware/context-graph`;
 * they now live here, beside the source they read. Rows are built with the
 * graph plugin's `kit` so the id recipe and provenance columns stay owned by
 * the graph plugin — this connector owns only the SQL + `toRow` semantics.
 *
 * @param {GraphKit} kit
 * @returns {{ name: string, plugin: string, sourceDataset: string, projector: string, projectorVersion: number, rules: ContractRule[] }}
 * @ref LLP 0023#contract-contribution [implements] — a source's contract, contributed via the capability; engine + kit stay central
 */
export function createAiGatewayGraphContract(kit) {
  const { buildNode, buildEdge } = kit.makeRowBuilders({
    sourceDataset: SOURCE_DATASET,
    projector: PROJECTOR,
    projectorVersion: PROJECTOR_VERSION,
  })

  /** @type {ContractRule[]} */
  const rules = [
    // --- nodes ---

    // Session per conversation.
    {
      kind: 'node',
      type: 'Session',
      sql: `SELECT conversation_id, cwd, git_branch, client_name, user_id, message_created_at FROM ${SOURCE_DATASET}`,
      toRow(r) {
        const key = str(r.conversation_id)
        if (!key) return null
        return buildNode({
          type: 'Session',
          key,
          props: pruned({
            cwd: str(r.cwd),
            git_branch: str(r.git_branch),
            client_name: str(r.client_name),
            user_id: str(r.user_id),
          }),
          firstSeen: r.message_created_at,
          sourceKeys: { conversation_id: key },
        })
      },
    },

    // App per client_name.
    {
      kind: 'node',
      type: 'App',
      sql: `SELECT client_name, message_created_at FROM ${SOURCE_DATASET}`,
      toRow(r) {
        const key = str(r.client_name)
        if (!key) return null
        return buildNode({ type: 'App', key, label: key, firstSeen: r.message_created_at, sourceKeys: { client_name: key } })
      },
    },

    // Model per model id.
    {
      kind: 'node',
      type: 'Model',
      sql: `SELECT model, message_created_at FROM ${SOURCE_DATASET}`,
      toRow(r) {
        const key = str(r.model)
        if (!key) return null
        return buildNode({ type: 'Model', key, label: key, firstSeen: r.message_created_at, sourceKeys: { model: key } })
      },
    },

    // Tool per tool_name, from tool_call parts.
    {
      kind: 'node',
      type: 'Tool',
      sql: `SELECT tool_name, message_created_at FROM ${SOURCE_DATASET} WHERE part_type = 'tool_call'`,
      toRow(r) {
        const key = str(r.tool_name)
        if (!key) return null
        return buildNode({ type: 'Tool', key, label: key, firstSeen: r.message_created_at, sourceKeys: { tool_name: key } })
      },
    },

    // File per resolved path, from file-touching tool calls.
    {
      kind: 'node',
      type: 'File',
      sql: `SELECT tool_name, tool_args, message_created_at FROM ${SOURCE_DATASET} WHERE part_type = 'tool_call'`,
      toRow(r) {
        const file = filePathFrom(r.tool_name, r.tool_args)
        if (!file) return null
        return buildNode({ type: 'File', key: file, label: path.basename(file), firstSeen: r.message_created_at, sourceKeys: { file_path: file } })
      },
    },

    // --- edges ---

    // Session -via-> App
    {
      kind: 'edge',
      type: 'via',
      sql: `SELECT conversation_id, client_name, message_created_at FROM ${SOURCE_DATASET}`,
      toRow(r) {
        const session = str(r.conversation_id)
        const app = str(r.client_name)
        if (!session || !app) return null
        return buildEdge({ type: 'via', srcType: 'Session', srcKey: session, dstType: 'App', dstKey: app, firstSeen: r.message_created_at, sourceKeys: { conversation_id: session, client_name: app } })
      },
    },

    // Session -used_model-> Model
    {
      kind: 'edge',
      type: 'used_model',
      sql: `SELECT conversation_id, model, message_created_at FROM ${SOURCE_DATASET}`,
      toRow(r) {
        const session = str(r.conversation_id)
        const model = str(r.model)
        if (!session || !model) return null
        return buildEdge({ type: 'used_model', srcType: 'Session', srcKey: session, dstType: 'Model', dstKey: model, firstSeen: r.message_created_at, sourceKeys: { conversation_id: session, model } })
      },
    },

    // Session -used-> Tool
    {
      kind: 'edge',
      type: 'used',
      sql: `SELECT conversation_id, tool_name, message_created_at FROM ${SOURCE_DATASET} WHERE part_type = 'tool_call'`,
      toRow(r) {
        const session = str(r.conversation_id)
        const tool = str(r.tool_name)
        if (!session || !tool) return null
        return buildEdge({ type: 'used', srcType: 'Session', srcKey: session, dstType: 'Tool', dstKey: tool, firstSeen: r.message_created_at, sourceKeys: { conversation_id: session, tool_name: tool } })
      },
    },

    // Session -touched-> File
    {
      kind: 'edge',
      type: 'touched',
      sql: `SELECT conversation_id, tool_name, tool_args, message_created_at FROM ${SOURCE_DATASET} WHERE part_type = 'tool_call'`,
      toRow(r) {
        const session = str(r.conversation_id)
        const file = filePathFrom(r.tool_name, r.tool_args)
        if (!session || !file) return null
        return buildEdge({ type: 'touched', srcType: 'Session', srcKey: session, dstType: 'File', dstKey: file, firstSeen: r.message_created_at, sourceKeys: { conversation_id: session, file_path: file } })
      },
    },
  ]

  // @ref LLP 0026#decision [implements] — tag-don't-drop: the gateway now
  // RETAINS Claude harness aux exchanges (security monitor, etc.) tagged
  // `attributes.claude.aux_kind` instead of dropping them. That traffic is
  // real but not user conversation, so it must not mint graph
  // Session/App/Model/Tool/File nodes or edges. One shared source filter:
  // select `attributes` for every rule and drop aux rows before toRow runs,
  // so each rule's SQL stays focused on its own columns.
  const auxFilteredRules = rules.map((rule) => ({
    ...rule,
    sql: withAttributes(rule.sql),
    /** @param {Record<string, unknown>} r */
    toRow(r) {
      if (auxKindOf(r.attributes)) return null
      return rule.toRow(r)
    },
  }))

  return {
    name: 'ai-gateway-t0',
    plugin: PLUGIN_NAME,
    sourceDataset: SOURCE_DATASET,
    projector: PROJECTOR,
    projectorVersion: PROJECTOR_VERSION,
    rules: auxFilteredRules,
  }
}

/**
 * Prepend the `attributes` column to a rule's projection so the shared aux
 * filter can read `attributes.claude.aux_kind` without each rule's SQL
 * repeating it. Every rule begins `SELECT <cols> FROM …`.
 *
 * @param {string} sql
 * @returns {string}
 */
function withAttributes(sql) {
  return sql.replace(/^SELECT\s+/i, 'SELECT attributes, ')
}

/**
 * Read `attributes.claude.aux_kind` from a source row. `attributes` is a
 * JSON column that may arrive parsed or as a string (like `tool_args`).
 *
 * @param {unknown} attributes
 * @returns {string | null}
 */
function auxKindOf(attributes) {
  const attrs = parseMaybeJson(attributes)
  if (!attrs || typeof attrs !== 'object') return null
  const claude = parseMaybeJson(/** @type {Record<string, unknown>} */ (attrs).claude)
  if (!claude || typeof claude !== 'object') return null
  return str(/** @type {Record<string, unknown>} */ (claude).aux_kind)
}

/**
 * Resolve a file path from a file-touching tool's args. `tool_args` is a JSON
 * column that may arrive parsed or as a string.
 *
 * @param {unknown} toolName
 * @param {unknown} toolArgs
 * @returns {string | null}
 */
function filePathFrom(toolName, toolArgs) {
  const name = str(toolName)
  if (!name || !FILE_TOOLS.has(name)) return null
  const args = parseMaybeJson(toolArgs)
  if (!args || typeof args !== 'object') return null
  const obj = /** @type {Record<string, unknown>} */ (args)
  return str(obj.file_path) ?? str(obj.notebook_path) ?? null
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function str(value) {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

/**
 * Drop null/undefined entries so identical inputs build identical props.
 *
 * @param {Record<string, unknown>} obj
 * @returns {Record<string, unknown>}
 */
function pruned(obj) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] != null) out[key] = obj[key]
  }
  return out
}
