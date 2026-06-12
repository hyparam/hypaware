// @ts-check

import path from 'node:path'

import { nodeId, edgeId } from './ids.js'

/**
 * The hand-authored T0 contract for `ai_gateway_messages`. Each rule is a
 * read-only SELECT (the contract's read half is genuinely SQL) plus a
 * `toRow` that maps a result row to a graph node/edge with deterministic
 * id and inline provenance. `toRow` returns `null` to skip a row.
 *
 * A generic declarative-contract -> SQL compiler is a later slice; for now
 * the rules are explicit and each SELECT documents the structural fact it
 * extracts.
 *
 * @import { GraphRow, ContractRule } from './types.d.ts'
 */

export const SOURCE_DATASET = 'ai_gateway_messages'
export const PROJECTOR = 'ai-gateway.t0'
export const PROJECTOR_VERSION = 1

/** Tools whose args name a concrete file. */
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * @param {{ type: string, key: string, label?: string | null, props?: Record<string, unknown>, firstSeen: unknown, sourceKeys: Record<string, unknown> }} spec
 * @returns {GraphRow}
 */
function buildNode(spec) {
  return {
    node_id: nodeId(spec.type, spec.key),
    node_type: spec.type,
    natural_key: spec.key,
    label: spec.label ?? null,
    props: spec.props && Object.keys(spec.props).length > 0 ? spec.props : null,
    first_seen: firstSeen(spec.firstSeen),
    source_dataset: SOURCE_DATASET,
    source_keys: spec.sourceKeys,
    projector: PROJECTOR,
    projector_version: PROJECTOR_VERSION,
  }
}

/**
 * @param {{ type: string, srcType: string, srcKey: string, dstType: string, dstKey: string, firstSeen: unknown, sourceKeys: Record<string, unknown> }} spec
 * @returns {GraphRow}
 */
function buildEdge(spec) {
  const src = nodeId(spec.srcType, spec.srcKey)
  const dst = nodeId(spec.dstType, spec.dstKey)
  return {
    edge_id: edgeId(src, spec.type, dst),
    edge_type: spec.type,
    src_id: src,
    dst_id: dst,
    src_type: spec.srcType,
    dst_type: spec.dstType,
    props: null,
    first_seen: firstSeen(spec.firstSeen),
    source_dataset: SOURCE_DATASET,
    source_keys: spec.sourceKeys,
    projector: PROJECTOR,
    projector_version: PROJECTOR_VERSION,
  }
}

/**
 * The T0 rules. Node rules first, then edge rules.
 *
 * @type {ReadonlyArray<ContractRule>}
 * @ref LLP 0023#t0-contract [implements] — hand-authored rule list; a declarative-contract compiler is a deliberate later slice
 */
export const CONTRACT_RULES = Object.freeze([
  // --- nodes ---

  // Session per conversation. SQL: SELECT conversation_id, ... (one row per part)
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
        props: pruned({ cwd: str(r.cwd), git_branch: str(r.git_branch), client_name: str(r.client_name), user_id: str(r.user_id) }),
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
])

/**
 * Resolve a file path from a file-touching tool's args. `tool_args` is a
 * JSON column that may arrive parsed or as a string.
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
 * Normalize a timestamp-ish value to an ISO string when possible.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function firstSeen(value) {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
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
