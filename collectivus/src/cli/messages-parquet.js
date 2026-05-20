/**
 * Parquet schema + pure per-exchange transform for the canonical
 * `proxy_messages` dataset: one row per content part, globally deduped by
 * content-derived `message_id`.
 *
 * This module is the foundational pure-function layer. It declares the
 * schema and decomposes one (exchange, message) pair into a list
 * of part rows. No I/O happens on import or during decomposition; callers
 * (the walker in a sibling bead, the refresh pipeline in another) feed in
 * exchanges plus reconstructed assistant messages and pass the
 * conversation-scoped state around explicitly.
 *
 * See umbrella co-7ni0 for the full design and column-by-column derivation.
 */

import { createHash } from 'node:crypto'

/**
 * @import { ColumnSpec } from '../upload/upload.d.ts'
 */

const SCHEMA_VERSION = 3

/**
 * Parquet schema for `proxy_messages`. Grain is one row per content part.
 * Order matters: this is also the column order written into the Parquet file.
 *
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const MESSAGES_COLUMNS = [
  { name: 'schema_version', type: 'INT32', nullable: false },
  { name: 'conversation_id', type: 'STRING', nullable: false },
  { name: 'user_id', type: 'STRING', nullable: true },
  { name: 'provider', type: 'STRING', nullable: false },
  { name: 'model', type: 'STRING', nullable: true },
  { name: 'system_text', type: 'STRING', nullable: true },
  { name: 'tools', type: 'JSON', nullable: true },
  { name: 'conversation_started_at', type: 'TIMESTAMP', nullable: false },
  { name: 'conversation_source', type: 'STRING', nullable: true },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'git_branch', type: 'STRING', nullable: true },
  { name: 'client_version', type: 'STRING', nullable: true },
  { name: 'entrypoint', type: 'STRING', nullable: true },
  { name: 'user_type', type: 'STRING', nullable: true },
  { name: 'permission_mode', type: 'STRING', nullable: true },
  { name: 'is_sidechain', type: 'BOOLEAN', nullable: true },
  { name: 'message_id', type: 'STRING', nullable: false },
  { name: 'previous_message_id', type: 'STRING', nullable: true },
  { name: 'provider_uuid', type: 'STRING', nullable: true },
  { name: 'parent_uuid', type: 'STRING', nullable: true },
  { name: 'logical_parent_uuid', type: 'STRING', nullable: true },
  { name: 'source_tool_assistant_uuid', type: 'STRING', nullable: true },
  { name: 'request_id', type: 'STRING', nullable: true },
  { name: 'prompt_id', type: 'STRING', nullable: true },
  { name: 'message_index', type: 'INT32', nullable: false },
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'role', type: 'STRING', nullable: false },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'part_index', type: 'INT32', nullable: false },
  { name: 'part_type', type: 'STRING', nullable: false },
  { name: 'provider_type', type: 'STRING', nullable: true },
  { name: 'provider_subtype', type: 'STRING', nullable: true },
  { name: 'content_text', type: 'STRING', nullable: true },
  { name: 'tool_name', type: 'STRING', nullable: true },
  { name: 'tool_call_id', type: 'STRING', nullable: true },
  { name: 'tool_args', type: 'JSON', nullable: true },
  { name: 'caller_type', type: 'STRING', nullable: true },
  { name: 'tool_result_for', type: 'STRING', nullable: true },
  { name: 'thinking_signature', type: 'STRING', nullable: true },
  { name: 'attachment_type', type: 'STRING', nullable: true },
  { name: 'hook_event', type: 'STRING', nullable: true },
  { name: 'is_error', type: 'BOOLEAN', nullable: true },
  { name: 'is_compact_summary', type: 'BOOLEAN', nullable: true },
  { name: 'compact_metadata', type: 'JSON', nullable: true },
  { name: 'status', type: 'JSON', nullable: true },
  { name: 'attributes', type: 'JSON', nullable: true },
  { name: 'raw_frame', type: 'JSON', nullable: true },
]

/**
 * Prepended to the schema when the output partitioning includes
 * `gateway_id`, mirroring the OTLP writers.
 *
 * @type {ColumnSpec}
 */
export const GATEWAY_ID_COLUMN = { name: 'gateway_id', type: 'STRING', nullable: false }

/**
 * @param {ReadonlyArray<string>} [partitionDimensions]
 * @returns {boolean}
 */
function hasGatewayIdColumn(partitionDimensions) {
  return Array.isArray(partitionDimensions) && partitionDimensions.includes('gateway_id')
}

/**
 * Materialised column list for `proxy_messages`. When the writer is told the
 * partitioning includes `gateway_id`, the partition column is prepended so
 * the on-disk Parquet always carries it as a typed column (callers source the
 * value via `row.gateway_id`).
 *
 * @param {ReadonlyArray<string>} [partitionDimensions]
 * @returns {ReadonlyArray<ColumnSpec>}
 */
export function columnsForMessages(partitionDimensions) {
  if (hasGatewayIdColumn(partitionDimensions)) return [GATEWAY_ID_COLUMN, ...MESSAGES_COLUMNS]
  return MESSAGES_COLUMNS
}

/**
 * Convert a list of message part rows to a Parquet buffer. The rows match
 * the shape emitted by the conversation walker — each property name is a
 * column from {@link MESSAGES_COLUMNS} plus, when included, `gateway_id`.
 *
 * Returns `undefined` for an empty input unless `opts.allowEmpty` is true so
 * callers can choose between skipping the write or emitting an empty
 * partition file.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {ReadonlyArray<string>} [partitionDimensions]
 * @param {{ allowEmpty?: boolean }} [opts]
 * @returns {Promise<Uint8Array | undefined>}
 */
export async function messageRowsToParquet(rows, partitionDimensions, opts = {}) {
  if (rows.length === 0 && !opts.allowEmpty) return undefined
  const { parquetWriteBuffer } = await import('hyparquet-writer')
  const columns = columnsForMessages(partitionDimensions)
  const columnData = columns.map((spec) => ({
    name: spec.name,
    type: spec.type,
    nullable: spec.nullable,
    data: rows.map((row) => coerceCell(spec, row[spec.name])),
  }))
  const arrayBuffer = parquetWriteBuffer({ columnData })
  return new Uint8Array(arrayBuffer)
}

/**
 * @param {ColumnSpec} spec
 * @param {unknown} value
 * @returns {unknown}
 */
function coerceCell(spec, value) {
  if (value === undefined || value === null) {
    if (!spec.nullable) {
      throw new Error(`required column "${spec.name}" got null`)
    }
    return undefined
  }
  switch (spec.type) {
  case 'STRING':
    return typeof value === 'string' ? value : String(value)
  case 'INT32':
    return coerceInt32(value, spec.name)
  case 'INT64':
    return coerceInt64(value, spec.name)
  case 'DOUBLE':
    return coerceDouble(value, spec.name)
  case 'BOOLEAN':
    return Boolean(value)
  case 'TIMESTAMP':
    return coerceTimestamp(value, spec.name)
  case 'JSON':
    return value
  default:
    return value
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function coerceInt32(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  throw new Error(`column "${name}" expected INT32, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint}
 */
function coerceInt64(value, name) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') {
    try { return BigInt(value) } catch { /* fall through */ }
  }
  throw new Error(`column "${name}" expected INT64, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function coerceDouble(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  throw new Error(`column "${name}" expected DOUBLE, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {Date}
 */
function coerceTimestamp(value, name) {
  if (value instanceof Date) return value
  if (typeof value === 'string') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'bigint') return new Date(Number(value))
  throw new Error(`column "${name}" expected TIMESTAMP, got ${typeof value}`)
}

/**
 * Anthropic content-block `type` → schema `part_type`. Unknown types pass
 * through verbatim so analytical queries can see exotic shapes without us
 * silently dropping information.
 *
 * @param {string | undefined} blockType
 * @returns {string}
 */
export function mapPartType(blockType) {
  switch (blockType) {
  case 'text': return 'text'
  case 'thinking': return 'reasoning'
  case 'redacted_thinking': return 'reasoning'
  case 'tool_use': return 'tool_call'
  case 'server_tool_use': return 'tool_call'
  case 'tool_result': return 'tool_result'
  case 'web_search_tool_result': return 'tool_result'
  case 'image': return 'image'
  case 'document': return 'file'
  case 'file': return 'file'
  case 'error': return 'error'
  default: return typeof blockType === 'string' && blockType.length > 0 ? blockType : 'text'
  }
}

/**
 * Anthropic message `stop_reason` → schema `status.finish_reason`. Returns
 * undefined for absent input so callers can omit the key from `status`.
 *
 * @param {string | undefined | null} stopReason
 * @returns {string | undefined}
 */
export function mapFinishReason(stopReason) {
  if (stopReason == null) return undefined
  switch (stopReason) {
  case 'end_turn': return 'stop'
  case 'stop_sequence': return 'stop'
  case 'max_tokens': return 'length'
  case 'tool_use': return 'tool_use'
  case 'pause_turn': return 'pause'
  case 'refusal': return 'refusal'
  case 'error': return 'error'
  default: return stopReason
  }
}

/**
 * Conversation-scoped content hash. Same content in the same conversation
 * always produces the same id; the same content in a different conversation
 * produces a different id, so identical user messages across sessions stay
 * distinct rows.
 *
 * @param {string} conversation_id
 * @param {string} role
 * @param {unknown} content  -- string or content-block array
 * @returns {string}  -- 16-char hex prefix of SHA-256
 */
export function computeMessageId(conversation_id, role, content) {
  const canonical = canonicalJson(content)
  return sha256Hex(`${conversation_id}:${role}:${canonical}`).slice(0, 16)
}

/**
 * Build the nested `attributes` JSON column for one message: request
 * settings, the message's own token usage (assistant only), exchange-level
 * timing, and any raw Anthropic metadata worth preserving.
 *
 * @param {Record<string, unknown> | undefined | null} exchange  -- JSONL exchange row
 * @param {Record<string, unknown> | undefined | null} message
 * @returns {Record<string, unknown> | undefined}
 */
export function extractAttributes(exchange, message) {
  /** @type {Record<string, unknown>} */
  const attrs = {}
  const reqBody = parseMaybeJson(readPath(exchange, ['request', 'body']))

  if (reqBody && typeof reqBody === 'object') {
    /** @type {Record<string, unknown>} */
    const request = {}
    copyIfPresent(reqBody, request, 'max_tokens')
    copyIfPresent(reqBody, request, 'thinking')
    copyIfPresent(reqBody, request, 'output_config')
    copyIfPresent(reqBody, request, 'context_management')
    copyIfPresent(reqBody, request, 'stream')
    if (Object.keys(request).length > 0) attrs.request = request

    /** @type {Record<string, unknown>} */
    const providerRaw = {}
    const rawMetadata = readKey(reqBody, 'metadata')
    if (rawMetadata != null) providerRaw.metadata = rawMetadata
    if (Object.keys(providerRaw).length > 0) attrs.provider_raw = providerRaw
  }

  const usage = readPath(message, ['usage'])
  if (usage && typeof usage === 'object') {
    /** @type {Record<string, unknown>} */
    const u = {}
    copyIfPresent(usage, u, 'input_tokens')
    copyIfPresent(usage, u, 'output_tokens')
    const cacheRead = readKey(usage, 'cache_read_input_tokens')
    if (cacheRead != null) u.cache_read_tokens = cacheRead
    const cacheWrite = readKey(usage, 'cache_creation_input_tokens')
    if (cacheWrite != null) u.cache_write_tokens = cacheWrite
    if (Object.keys(u).length > 0) attrs.usage = u
  }

  /** @type {Record<string, unknown>} */
  const timing = {}
  const latencyMs = readKey(exchange, 'duration_ms')
  if (typeof latencyMs === 'number') timing.latency_ms = latencyMs
  if (Object.keys(timing).length > 0) attrs.timing = timing

  return Object.keys(attrs).length === 0 ? undefined : attrs
}

/**
 * @param {Record<string, unknown> | undefined} attributes
 * @param {string | undefined} claudeVersion
 * @returns {Record<string, unknown> | undefined}
 */
function withClientAttributes(attributes, claudeVersion) {
  if (!claudeVersion) return attributes
  /** @type {Record<string, unknown>} */
  const out = attributes ? { ...attributes } : {}
  const existing = out.client
  const client = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { .../** @type {Record<string, unknown>} */ (existing) }
    : {}
  client.claude_version = claudeVersion
  out.client = client
  return out
}

/**
 * Decompose one message into ordered part rows. Pure — no I/O, no shared
 * state. All conversation-scoped context (ids, indices, lookups) comes in
 * via `ctx`; the walker is responsible for keeping that state coherent
 * across exchanges.
 *
 * The `message` argument is whatever the walker is currently emitting:
 * a system message synthesised from `system[]`, a user/tool message from
 * `request.messages`, or the reconstructed assistant message for this
 * exchange. The function does not care which.
 *
 * @param {Record<string, unknown> | undefined | null} exchange  -- JSONL exchange row this message belongs to
 * @param {Record<string, unknown>} message  -- { role, content, [usage], [stop_reason], ... }
 * @param {MessagePartsContext} ctx
 * @returns {Array<Record<string, unknown>>}  -- ordered rows (one per content block), empty when content is empty
 */
export function extractMessageParts(exchange, message, ctx) {
  const role = String(message.role)
  const content = normalizeContent(message.content)
  if (content.length === 0) return []

  const message_id = computeMessageId(ctx.conversation_id, role, content)
  const transcript = ctx.claude_transcript
  const attributes = withClientAttributes(extractAttributes(exchange, message), ctx.claude_version)
  const stopReason = readKey(message, 'stop_reason')
  const finishReason = typeof stopReason === 'string' ? mapFinishReason(stopReason) : undefined

  /** @type {Record<string, unknown>} */
  const base = {
    schema_version: SCHEMA_VERSION,
    conversation_id: ctx.conversation_id,
    user_id: ctx.user_id,
    provider: ctx.provider,
    model: ctx.model,
    system_text: ctx.system_text,
    tools: ctx.tools,
    conversation_started_at: ctx.conversation_started_at,
    conversation_source: ctx.conversation_source,
    cwd: ctx.cwd,
    git_branch: ctx.git_branch,
    client_version: ctx.claude_version ?? transcript?.client_version,
    entrypoint: transcript?.entrypoint,
    user_type: transcript?.user_type,
    permission_mode: transcript?.permission_mode,
    is_sidechain: transcript?.is_sidechain,
    message_id,
    previous_message_id: ctx.previous_message_id,
    provider_uuid: transcript?.provider_uuid,
    parent_uuid: transcript?.parent_uuid,
    logical_parent_uuid: transcript?.logical_parent_uuid,
    source_tool_assistant_uuid: transcript?.source_tool_assistant_uuid,
    request_id: transcript?.request_id,
    prompt_id: transcript?.prompt_id,
    message_index: ctx.message_index,
    message_created_at: ctx.message_created_at,
    role,
  }

  return content.map((block, part_index) => {
    const isLast = part_index === content.length - 1
    const part_type = mapPartType(typeof block?.type === 'string' ? block.type : undefined)
    const tool_call_id = extractToolCallId(block)
    const tool_name = extractToolName(block, tool_call_id, ctx.tool_call_lookup)
    return {
      ...base,
      part_id: `${message_id}#${part_index}`,
      part_index,
      part_type,
      provider_type: transcript?.provider_type,
      provider_subtype: transcript?.provider_subtype,
      content_text: extractContentText(block),
      tool_name,
      tool_call_id,
      tool_args: block?.type === 'tool_use' || block?.type === 'server_tool_use'
        ? readKey(block, 'input')
        : undefined,
      caller_type: readCallerType(block),
      tool_result_for: block?.type === 'tool_result' || block?.type === 'web_search_tool_result'
        ? tool_call_id
        : undefined,
      thinking_signature: block?.type === 'thinking' || block?.type === 'redacted_thinking'
        ? readKey(block, 'signature')
        : undefined,
      attachment_type: transcript?.attachment_type,
      hook_event: transcript?.hook_event,
      is_error: readKey(block, 'is_error') === true ? true : undefined,
      is_compact_summary: transcript?.is_compact_summary,
      compact_metadata: transcript?.compact_metadata,
      status: buildStatus(block, isLast, role, finishReason),
      attributes,
      raw_frame: transcript?.raw_frame,
    }
  })
}

/**
 * Normalize a message's `content`: strings become a single text block;
 * arrays pass through; everything else is treated as empty.
 *
 * @param {unknown} content
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeContent(content) {
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) return /** @type {Array<Record<string, unknown>>} */ (content)
  return []
}

/**
 * @param {unknown} block
 * @returns {string | undefined}
 */
function extractContentText(block) {
  if (!block || typeof block !== 'object') return undefined
  const b = /** @type {Record<string, unknown>} */ (block)
  switch (b.type) {
  case 'text':
    return typeof b.text === 'string' ? b.text : undefined
  case 'thinking':
    return typeof b.thinking === 'string' ? b.thinking : undefined
  case 'redacted_thinking':
    return typeof b.data === 'string' ? b.data : undefined
  case 'tool_result': {
    const c = b.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const parts = c
        .filter((part) => part && typeof part === 'object' && /** @type {{ type?: unknown }} */ (part).type === 'text')
        .map((part) => /** @type {{ text?: unknown }} */ (part).text)
        .filter((text) => typeof text === 'string')
      return parts.length > 0 ? parts.join('\n') : undefined
    }
    return undefined
  }
  case 'error':
    if (typeof b.message === 'string') return b.message
    if (typeof b.text === 'string') return b.text
    return undefined
  default:
    return undefined
  }
}

/**
 * `tool_call_id` populates from `block.id` on tool_use rows (the
 * `toolu_*` Anthropic returns) and from `block.tool_use_id` on tool_result
 * rows (the user-side reference back to that call).
 *
 * @param {unknown} block
 * @returns {string | undefined}
 */
function extractToolCallId(block) {
  if (!block || typeof block !== 'object') return undefined
  const b = /** @type {Record<string, unknown>} */ (block)
  if (b.type === 'tool_use' || b.type === 'server_tool_use') {
    return typeof b.id === 'string' ? b.id : undefined
  }
  if (b.type === 'tool_result' || b.type === 'web_search_tool_result') {
    return typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined
  }
  return undefined
}

/**
 * `tool_name` is direct on tool_use blocks (`block.name`). On tool_result
 * blocks it must be resolved from the conversation walker's
 * `tool_call_lookup` (call-id → name table the walker maintains as it
 * sees tool_use blocks earlier in the conversation).
 *
 * @param {unknown} block
 * @param {string | undefined} tool_call_id
 * @param {ToolCallLookup | undefined} lookup
 * @returns {string | undefined}
 */
function extractToolName(block, tool_call_id, lookup) {
  if (!block || typeof block !== 'object') return undefined
  const b = /** @type {Record<string, unknown>} */ (block)
  if (b.type === 'tool_use' || b.type === 'server_tool_use') {
    return typeof b.name === 'string' ? b.name : undefined
  }
  if ((b.type === 'tool_result' || b.type === 'web_search_tool_result') && tool_call_id && lookup) {
    const entry = lookup.get(tool_call_id)
    return entry?.tool_name
  }
  return undefined
}

/**
 * @param {unknown} block
 * @returns {string | undefined}
 */
function readCallerType(block) {
  if (!block || typeof block !== 'object') return undefined
  const caller = readKey(block, 'caller')
  if (!caller || typeof caller !== 'object') return undefined
  const type = /** @type {Record<string, unknown>} */ (caller).type
  return typeof type === 'string' && type.length > 0 ? type : undefined
}

/**
 * Sparse status JSON: `tool_status` for tool_result rows, `finish_reason`
 * on the last assistant part, `error_code` / `error_message` on error
 * blocks. Returns undefined when no keys are populated so the column stays
 * null in the resulting Parquet.
 *
 * @param {unknown} block
 * @param {boolean} isLastPart
 * @param {string} role
 * @param {string | undefined} finishReason
 * @returns {Record<string, unknown> | undefined}
 */
function buildStatus(block, isLastPart, role, finishReason) {
  /** @type {Record<string, unknown>} */
  const status = {}
  const b = (block && typeof block === 'object') ? /** @type {Record<string, unknown>} */ (block) : undefined

  if (b && (b.type === 'tool_result' || b.type === 'web_search_tool_result')) {
    status.tool_status = b.is_error === true ? 'error' : 'success'
  }

  if (isLastPart && role === 'assistant' && finishReason) {
    status.finish_reason = finishReason
  }

  if (b && b.type === 'error') {
    if (typeof b.error_code === 'string') status.error_code = b.error_code
    if (typeof b.code === 'string' && status.error_code == null) status.error_code = b.code
    if (typeof b.message === 'string') status.error_message = b.message
    if (typeof b.text === 'string' && status.error_message == null) status.error_message = b.text
  }

  return Object.keys(status).length === 0 ? undefined : status
}

/**
 * Stable JSON serialisation: object keys sorted recursively so the same
 * logical value always produces the same string (and therefore the same
 * `message_id`).
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const obj = /** @type {Record<string, unknown>} */ (value)
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key])
    }
    return out
  }
  return value
}

/**
 * @param {string} input
 * @returns {string}
 */
function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/**
 * @param {unknown} obj
 * @param {string[]} keys
 * @returns {unknown}
 */
function readPath(obj, keys) {
  /** @type {unknown} */
  let cur = obj
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = /** @type {Record<string, unknown>} */ (cur)[key]
  }
  return cur
}

/**
 * @param {unknown} obj
 * @param {string} key
 * @returns {unknown}
 */
function readKey(obj, key) {
  if (obj === null || typeof obj !== 'object') return undefined
  return /** @type {Record<string, unknown>} */ (obj)[key]
}

/**
 * @param {unknown} src
 * @param {Record<string, unknown>} dst
 * @param {string} key
 * @returns {void}
 */
function copyIfPresent(src, dst, key) {
  if (src === null || typeof src !== 'object') return
  const value = /** @type {Record<string, unknown>} */ (src)[key]
  if (value !== undefined && value !== null) dst[key] = value
}

/**
 * @typedef {Map<string, { tool_name?: string }>} ToolCallLookup
 */

/**
 * Per-message conversation context the walker computes and passes in.
 *
 * @typedef {object} MessagePartsContext
 * @property {string} conversation_id
 * @property {Date | string | number} conversation_started_at
 * @property {string | undefined} [conversation_source]
 * @property {string | undefined} [cwd]
 * @property {string | undefined} [git_branch]
 * @property {string | undefined} [claude_version]
 * @property {string | undefined} [user_id]
 * @property {string} provider
 * @property {string | undefined} [model]
 * @property {string | undefined} [system_text]
 * @property {unknown} [tools]
 * @property {number} message_index
 * @property {string | undefined} [previous_message_id]
 * @property {Date | string | number} message_created_at
 * @property {ToolCallLookup | undefined} [tool_call_lookup]
 * @property {ClaudeTranscriptMatch | undefined} [claude_transcript]
 */

/**
 * Matched metadata from a local Claude Code JSONL transcript frame.
 *
 * @typedef {object} ClaudeTranscriptMatch
 * @property {string | undefined} [provider_uuid]
 * @property {string | undefined} [parent_uuid]
 * @property {string | undefined} [logical_parent_uuid]
 * @property {string | undefined} [source_tool_assistant_uuid]
 * @property {string | undefined} [request_id]
 * @property {string | undefined} [prompt_id]
 * @property {string | undefined} [provider_type]
 * @property {string | undefined} [provider_subtype]
 * @property {string | undefined} [entrypoint]
 * @property {string | undefined} [client_version]
 * @property {string | undefined} [user_type]
 * @property {string | undefined} [permission_mode]
 * @property {boolean | undefined} [is_sidechain]
 * @property {string | undefined} [attachment_type]
 * @property {string | undefined} [hook_event]
 * @property {boolean | undefined} [is_compact_summary]
 * @property {unknown} [compact_metadata]
 * @property {unknown} [raw_frame]
 */
