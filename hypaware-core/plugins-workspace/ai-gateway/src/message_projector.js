// @ts-check

import { createHash } from 'node:crypto'

export const SCHEMA_VERSION = 4

/**
 * @import { AiGatewayExchangeInput, AiGatewayProjectedExchange, AiGatewayProjectedMessage, ColumnSpec, PluginLogger } from '../../../../collectivus-plugin-kernel-types'
 * @import { RegisteredProjector } from './api.js'
 */

/**
 * HypAware's normalized AI gateway message-part query schema.
 *
 * Unchanged across `hypaware.ai-gateway@1.x` → `2.0.0`: the row shape
 * is the contract the dataset advertises and downstream queries lock
 * onto. The gateway always emits this column set, regardless of which
 * adapter projector produced the messages — projector-defined fields
 * map onto these named columns directly.
 *
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const AI_GATEWAY_MESSAGE_COLUMNS = Object.freeze([
  { name: 'gateway_id', type: 'STRING', nullable: false },
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
  { name: 'previous_message_id', type: 'JSON', nullable: true },
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
  { name: 'date', type: 'STRING', nullable: false },
])

const SCHEMA_COLUMN_NAMES = new Set(AI_GATEWAY_MESSAGE_COLUMNS.map((column) => column.name))

/**
 * Build the exchange-projector dispatcher. The dispatcher is owned by
 * the source layer (one instance per started listener); every
 * finalized exchange is fed through `projectExchange`, which:
 *
 *  1. Selects projectors whose `match()` returns true for the input.
 *  2. Sorts them by descending `priority` then registration order
 *     (the `_seq` tiebreaker the API records when the projector was
 *     registered).
 *  3. Walks the sorted list and calls `project()`; the first
 *     successful, non-empty projection wins. Projectors that throw,
 *     return `undefined`, or return an invalid shape are warned and
 *     skipped.
 *  4. Applies fallback identity (hash `message_id`, linear
 *     `previous_message_id`) ONLY when the chosen projection omitted
 *     identity — projector-supplied IDs and history are authoritative.
 *  5. Expands each projected message into the per-part rows the
 *     `ai_gateway_messages` schema advertises, merges
 *     `attributes.gateway.*` provenance, and strips to schema columns.
 *
 * If no projector matches or every match fails, the dispatcher
 * returns an empty row array — the source still emits pass-through
 * telemetry (`aigw.exchange` log + `aigw.exchange_bytes` meter), it
 * just does not write any rows.
 *
 * @param {{
 *   gatewayId: string,
 *   projectors: RegisteredProjector[],
 *   log?: PluginLogger | { warn(message: string, fields?: Record<string, unknown>): void, info?: (m: string, f?: Record<string, unknown>) => void },
 * }} opts
 */
export function createAiGatewayMessageProjector(opts) {
  const gatewayId = opts.gatewayId || 'hypaware-local'
  const projectors = Array.isArray(opts.projectors) ? opts.projectors : []
  const log = opts.log

  /** @type {Map<string, string[]>} */
  const messageIdsByConversation = new Map()
  /** @type {Map<string, string>} */
  const conversationStartedAt = new Map()
  /** @type {Set<string>} */
  const seenMessages = new Set()
  /** @type {Map<string, Map<string, { tool_name?: string }>>} */
  const toolCallLookupByConversation = new Map()

  return {
    /**
     * @param {AiGatewayExchangeInput | Record<string, unknown>} exchange
     * @returns {Promise<Record<string, unknown>[]>}
     */
    async projectExchange(exchange) {
      const input = /** @type {AiGatewayExchangeInput} */ (exchange)
      const projection = await dispatchProjector(projectors, input, log)
      if (!projection) {
        log?.warn?.('aigw.message_projection_skipped', {
          exchange_id: stringValue(input.exchange_id) ?? '',
          upstream: stringValue(input.upstream) ?? '',
          reason: 'no_projector_match',
        })
        return []
      }

      const tsStart = stringValue(input.ts_start) ?? new Date().toISOString()
      const conversationId = projection.conversation_id
      if (!conversationStartedAt.has(conversationId)) {
        conversationStartedAt.set(
          conversationId,
          stringValue(projection.conversation_started_at) ?? tsStart
        )
      }
      const conversationStarted = conversationStartedAt.get(conversationId) ?? tsStart

      let conversationLookup = toolCallLookupByConversation.get(conversationId)
      if (!conversationLookup) {
        conversationLookup = new Map()
        toolCallLookupByConversation.set(conversationId, conversationLookup)
      }
      let conversationMessageIds = messageIdsByConversation.get(conversationId)
      if (!conversationMessageIds) {
        conversationMessageIds = []
        messageIdsByConversation.set(conversationId, conversationMessageIds)
      }

      const gatewayAttributes = buildGatewayAttributes(input)
      /** @type {Record<string, unknown>[]} */
      const rows = []

      for (let i = 0; i < projection.messages.length; i++) {
        const message = projection.messages[i]
        const role = stringValue(message.role)
        if (!role) continue
        const content = normalizeContent(message.content)
        if (content.length === 0) continue

        const identity = resolveIdentity({
          message,
          conversationId,
          role,
          content,
          conversationMessageIds,
        })

        if (seenMessages.has(identity.messageId)) {
          if (!conversationMessageIds.includes(identity.messageId)) {
            conversationMessageIds.push(identity.messageId)
          }
          continue
        }

        const parts = expandMessageParts({
          message,
          role,
          content,
          conversationId,
          conversationStarted,
          messageIndex: i,
          tsStart,
          projection,
          identity,
          conversationLookup,
        })

        for (const row of parts) {
          row.gateway_id = gatewayId
          row.date = utcDate(row.message_created_at)
          row.attributes = mergeJsonObjects(
            mergeJsonObjects(/** @type {Record<string, unknown> | undefined} */ (row.attributes), projection.attributes),
            identity.fromFallback
              ? mergeJsonObjects(
                gatewayAttributes,
                { gateway: { identity_source: 'gateway_fallback' } }
              )
              : gatewayAttributes
          )
          rows.push(stripToSchema(row))
        }

        seenMessages.add(identity.messageId)
        if (!conversationMessageIds.includes(identity.messageId)) {
          conversationMessageIds.push(identity.messageId)
        }
      }

      return rows
    },
  }
}

/**
 * @param {RegisteredProjector[]} projectors
 * @param {AiGatewayExchangeInput} input
 * @param {{ warn?: (m: string, f?: Record<string, unknown>) => void } | undefined} log
 * @returns {Promise<AiGatewayProjectedExchange | undefined>}
 */
async function dispatchProjector(projectors, input, log) {
  if (projectors.length === 0) return undefined
  const matching = projectors
    .filter((p) => safeMatch(p, input, log))
    .sort(byPriorityThenSeq)
  for (const projector of matching) {
    let result
    try {
      result = await Promise.resolve(projector.project(input, { log: log ?? noopLogger() }))
    } catch (err) {
      log?.warn?.('aigw.projector_error', {
        projector: projector.name,
        exchange_id: stringValue(input.exchange_id) ?? '',
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    if (!isValidProjection(result)) {
      if (result !== undefined) {
        log?.warn?.('aigw.projector_invalid_output', {
          projector: projector.name,
          exchange_id: stringValue(input.exchange_id) ?? '',
        })
      }
      continue
    }
    if (result.messages.length === 0) continue
    return result
  }
  return undefined
}

/**
 * @param {RegisteredProjector} projector
 * @param {AiGatewayExchangeInput} input
 * @param {{ warn?: (m: string, f?: Record<string, unknown>) => void } | undefined} log
 */
function safeMatch(projector, input, log) {
  try {
    return projector.match(input) === true
  } catch (err) {
    log?.warn?.('aigw.projector_match_error', {
      projector: projector.name,
      exchange_id: stringValue(input.exchange_id) ?? '',
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * @param {RegisteredProjector} a
 * @param {RegisteredProjector} b
 */
function byPriorityThenSeq(a, b) {
  const ap = typeof a.priority === 'number' ? a.priority : 0
  const bp = typeof b.priority === 'number' ? b.priority : 0
  if (ap !== bp) return bp - ap
  return a._seq - b._seq
}

/**
 * @param {unknown} value
 * @returns {value is AiGatewayProjectedExchange}
 */
function isValidProjection(value) {
  if (!isPlainObject(value)) return false
  if (typeof value.provider !== 'string' || value.provider.length === 0) return false
  if (typeof value.conversation_id !== 'string' || value.conversation_id.length === 0) return false
  if (!Array.isArray(value.messages)) return false
  return true
}

/**
 * @param {{
 *   message: AiGatewayProjectedMessage,
 *   conversationId: string,
 *   role: string,
 *   content: Array<Record<string, unknown>>,
 *   conversationMessageIds: string[],
 * }} ctx
 */
function resolveIdentity(ctx) {
  const supplied = stringValue(ctx.message.message_id)
  if (supplied) {
    const previous = Array.isArray(ctx.message.previous_message_id)
      ? ctx.message.previous_message_id.filter((id) => typeof id === 'string')
      : undefined
    return {
      messageId: supplied,
      previousMessageId: previous,
      fromFallback: false,
    }
  }
  const messageId = computeMessageId(ctx.conversationId, ctx.role, ctx.content)
  const previousFromMessage = Array.isArray(ctx.message.previous_message_id)
    ? ctx.message.previous_message_id.filter((id) => typeof id === 'string')
    : undefined
  return {
    messageId,
    previousMessageId: previousFromMessage ?? [...ctx.conversationMessageIds],
    fromFallback: true,
  }
}

/**
 * Expand one projected message into its per-part rows. The gateway
 * is opinionated about how a normalized `content` block maps onto the
 * `ai_gateway_messages` part columns (role/tool_use/tool_result/etc.)
 * because the part schema is gateway-owned. Adapter projectors
 * decide WHAT messages look like; this function decides HOW they
 * become rows.
 *
 * @param {{
 *   message: AiGatewayProjectedMessage,
 *   role: string,
 *   content: Array<Record<string, unknown>>,
 *   conversationId: string,
 *   conversationStarted: string,
 *   messageIndex: number,
 *   tsStart: string,
 *   projection: AiGatewayProjectedExchange,
 *   identity: { messageId: string, previousMessageId: string[] | undefined, fromFallback: boolean },
 *   conversationLookup: Map<string, { tool_name?: string }>,
 * }} ctx
 * @returns {Record<string, unknown>[]}
 */
function expandMessageParts(ctx) {
  const finishReason = mapFinishReason(stringValue(ctx.message.stop_reason))
  const messageCreatedAt = stringValue(ctx.message.message_created_at) ?? ctx.tsStart
  const messageAttributes = ctx.message.attributes
  const baseClientAttributes = withClientAttributes(
    undefined,
    stringValue(ctx.projection.client_version),
    stringValue(ctx.projection.client_name)
  )

  const base = {
    schema_version: SCHEMA_VERSION,
    conversation_id: ctx.conversationId,
    user_id: ctx.projection.user_id,
    provider: ctx.projection.provider,
    model: ctx.projection.model,
    system_text: ctx.projection.system_text,
    tools: ctx.projection.tools,
    conversation_started_at: ctx.conversationStarted,
    conversation_source: ctx.projection.conversation_source,
    cwd: ctx.projection.cwd,
    git_branch: ctx.projection.git_branch,
    client_version: ctx.projection.client_version,
    entrypoint: stringValue(ctx.message.entrypoint) ?? ctx.projection.entrypoint,
    user_type: stringValue(ctx.message.user_type) ?? ctx.projection.user_type,
    permission_mode: stringValue(ctx.message.permission_mode) ?? ctx.projection.permission_mode,
    is_sidechain: typeof ctx.message.is_sidechain === 'boolean'
      ? ctx.message.is_sidechain
      : ctx.projection.is_sidechain,
    message_id: ctx.identity.messageId,
    previous_message_id: ctx.identity.previousMessageId,
    provider_uuid: stringValue(ctx.message.provider_uuid),
    parent_uuid: stringValue(ctx.message.parent_uuid),
    logical_parent_uuid: stringValue(ctx.message.logical_parent_uuid),
    source_tool_assistant_uuid: stringValue(ctx.message.source_tool_assistant_uuid),
    request_id: stringValue(ctx.message.request_id) ?? ctx.projection.request_id,
    prompt_id: stringValue(ctx.message.prompt_id) ?? ctx.projection.prompt_id,
    message_index: ctx.messageIndex,
    message_created_at: messageCreatedAt,
    role: ctx.role,
    attachment_type: stringValue(ctx.message.attachment_type),
    hook_event: stringValue(ctx.message.hook_event),
    is_compact_summary: typeof ctx.message.is_compact_summary === 'boolean'
      ? ctx.message.is_compact_summary
      : undefined,
    compact_metadata: ctx.message.compact_metadata,
  }

  return ctx.content.map((block, partIndex) => {
    const isLast = partIndex === ctx.content.length - 1
    const blockType = typeof block?.type === 'string' ? block.type : undefined
    const partType = mapPartType(blockType)
    const toolCallId = extractToolCallId(block)
    const toolName = extractToolName(block, toolCallId, ctx.conversationLookup)
    const row = {
      ...base,
      part_id: `${ctx.identity.messageId}#${partIndex}`,
      part_index: partIndex,
      part_type: partType,
      provider_type: stringValue(ctx.message.provider_type),
      provider_subtype: stringValue(ctx.message.provider_subtype) ?? blockType,
      content_text: extractContentText(block),
      tool_name: toolName,
      tool_call_id: toolCallId,
      tool_args: blockType === 'tool_use' || blockType === 'server_tool_use'
        ? readKey(block, 'input')
        : undefined,
      caller_type: readCallerType(block),
      tool_result_for: blockType === 'tool_result' || blockType === 'web_search_tool_result'
        ? toolCallId
        : undefined,
      thinking_signature: blockType === 'thinking' || blockType === 'redacted_thinking'
        ? stringValue(readKey(block, 'signature'))
        : undefined,
      is_error: readKey(block, 'is_error') === true ? true : undefined,
      status: buildStatus(block, isLast, ctx.role, finishReason),
      attributes: mergeJsonObjects(baseClientAttributes, messageAttributes),
      raw_frame: isPlainObject(ctx.message.raw_frame) ? ctx.message.raw_frame : undefined,
    }
    if (
      partType === 'tool_call' &&
      typeof toolCallId === 'string' &&
      typeof toolName === 'string'
    ) {
      ctx.conversationLookup.set(toolCallId, { tool_name: toolName })
    }
    return row
  })
}

/**
 * @param {string} conversation_id
 * @param {string} role
 * @param {unknown} content
 */
export function computeMessageId(conversation_id, role, content) {
  return sha256Hex(`${conversation_id}:${role}:${canonicalJson(content)}`).slice(0, 16)
}

/** @param {string | undefined | null} stopReason */
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

/** @param {string | undefined} blockType */
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

/** @param {unknown} content */
function normalizeContent(content) {
  if (typeof content === 'string') return content.length === 0 ? [] : [{ type: 'text', text: content }]
  if (Array.isArray(content)) return /** @type {Array<Record<string, unknown>>} */ (content)
  return []
}

/** @param {unknown} block */
function extractContentText(block) {
  if (!isPlainObject(block)) return undefined
  switch (block.type) {
  case 'text':
    return stringValue(block.text)
  case 'thinking':
    return stringValue(block.thinking)
  case 'redacted_thinking':
    return stringValue(block.data)
  case 'tool_result': {
    const c = block.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return textFromContentBlocks(c)
    return undefined
  }
  case 'error':
    return stringValue(block.message) ?? stringValue(block.text)
  default:
    return undefined
  }
}

/** @param {unknown[]} blocks */
function textFromContentBlocks(blocks) {
  const parts = blocks
    .filter(isPlainObject)
    .map((part) => stringValue(part.text))
    .filter((text) => typeof text === 'string')
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** @param {unknown} block */
function extractToolCallId(block) {
  if (!isPlainObject(block)) return undefined
  if (block.type === 'tool_use' || block.type === 'server_tool_use') return stringValue(block.id)
  if (block.type === 'tool_result' || block.type === 'web_search_tool_result') return stringValue(block.tool_use_id)
  return undefined
}

/**
 * @param {unknown} block
 * @param {string | undefined} tool_call_id
 * @param {Map<string, { tool_name?: string }> | undefined} lookup
 */
function extractToolName(block, tool_call_id, lookup) {
  if (!isPlainObject(block)) return undefined
  if (block.type === 'tool_use' || block.type === 'server_tool_use') return stringValue(block.name)
  if ((block.type === 'tool_result' || block.type === 'web_search_tool_result') && tool_call_id && lookup) {
    return lookup.get(tool_call_id)?.tool_name
  }
  return undefined
}

/** @param {unknown} block */
function readCallerType(block) {
  if (!isPlainObject(block)) return undefined
  const caller = block.caller
  if (!isPlainObject(caller)) return undefined
  return stringValue(caller.type)
}

/**
 * @param {unknown} block
 * @param {boolean} isLastPart
 * @param {string} role
 * @param {string | undefined} finishReason
 */
function buildStatus(block, isLastPart, role, finishReason) {
  /** @type {Record<string, unknown>} */
  const status = {}
  const b = isPlainObject(block) ? block : undefined
  if (b && (b.type === 'tool_result' || b.type === 'web_search_tool_result')) {
    status.tool_status = b.is_error === true ? 'error' : 'success'
  }
  if (isLastPart && role === 'assistant' && finishReason) status.finish_reason = finishReason
  if (b && b.type === 'error') {
    if (typeof b.error_code === 'string') status.error_code = b.error_code
    if (typeof b.code === 'string' && status.error_code == null) status.error_code = b.code
    if (typeof b.message === 'string') status.error_message = b.message
    if (typeof b.text === 'string' && status.error_message == null) status.error_message = b.text
  }
  return Object.keys(status).length === 0 ? undefined : status
}

/**
 * Stamp `attributes.client.{name,version}` on every emitted row when
 * the projector supplied client identity. The 1.x gateway carried a
 * special-case for Anthropic's `claude_version` field; that wart is
 * gone — adapters now choose what `client.name` is and the gateway
 * just propagates it.
 *
 * @param {Record<string, unknown> | undefined} attributes
 * @param {string | undefined} clientVersion
 * @param {string | undefined} clientName
 */
function withClientAttributes(attributes, clientVersion, clientName) {
  if (!clientVersion && !clientName) return attributes
  const out = attributes ? { ...attributes } : {}
  const client = isPlainObject(out.client) ? { ...out.client } : {}
  if (clientName) client.name = clientName
  if (clientVersion) client.version = clientVersion
  out.client = client
  return out
}

/** @param {AiGatewayExchangeInput} exchange */
function buildGatewayAttributes(exchange) {
  /** @type {Record<string, unknown>} */
  const attrs = {}
  const devRunId = readDevRunId(exchange)
  if (devRunId) attrs.dev_run_id = devRunId
  attrs.gateway = {
    exchange_id: stringValue(exchange.exchange_id),
    upstream: stringValue(exchange.upstream),
    method: stringValue(exchange.method ?? undefined),
    path: stringValue(exchange.path ?? undefined),
    status_code: exchange.status_code ?? undefined,
    request_bytes: exchange.request_bytes ?? undefined,
    response_bytes: exchange.response_bytes ?? undefined,
    is_sse: exchange.is_sse ?? undefined,
    stream_event_count: exchange.stream_event_count ?? undefined,
    request_headers: parseMaybeJson(exchange.request_headers),
    response_headers: parseMaybeJson(exchange.response_headers),
    error: stringValue(exchange.error ?? undefined),
  }
  return attrs
}

/**
 * Right-biased deep merge for one level of nested objects. Used both
 * to fold projection-level attributes into per-row attributes and to
 * stamp `attributes.gateway.*` provenance on top of whatever the
 * adapter supplied.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {Record<string, unknown> | undefined}
 */
function mergeJsonObjects(a, b) {
  /** @type {Record<string, unknown>} */
  const out = {}
  if (isPlainObject(a)) Object.assign(out, a)
  if (isPlainObject(b)) {
    for (const [key, value] of Object.entries(b)) {
      if (isPlainObject(value) && isPlainObject(out[key])) {
        out[key] = { ...out[key], ...value }
      } else {
        out[key] = value
      }
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** @param {Record<string, unknown>} row */
function stripToSchema(row) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const column of AI_GATEWAY_MESSAGE_COLUMNS) {
    if (SCHEMA_COLUMN_NAMES.has(column.name)) out[column.name] = row[column.name]
  }
  return out
}

/** @param {unknown} value */
function utcDate(value) {
  const date = new Date(typeof value === 'bigint' ? Number(value) : /** @type {any} */ (value))
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10)
  return date.toISOString().slice(0, 10)
}

/** @param {AiGatewayExchangeInput} exchange */
function readDevRunId(exchange) {
  const metadata = parseMaybeJson(exchange.metadata)
  if (isPlainObject(metadata)) {
    const fromMetadata = stringValue(metadata.dev_run_id)
    if (fromMetadata) return fromMetadata
  }
  const headers = parseMaybeJson(exchange.request_headers)
  return readHeaderValue(headers, 'x-hyp-dev-run-id')
}

/** @param {unknown} headers @param {string} name */
function readHeaderValue(headers, name) {
  if (!isPlainObject(headers)) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value)) {
      const found = value.find((entry) => typeof entry === 'string' && entry.length > 0)
      if (typeof found === 'string') return found
    }
  }
  return undefined
}

/** @param {unknown} value */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/** @param {unknown} obj @param {string} key */
function readKey(obj, key) {
  if (!isPlainObject(obj)) return undefined
  return obj[key]
}

/** @param {unknown} value */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** @param {string} input */
function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex')
}

/** @param {unknown} value */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

/** @param {unknown} value */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key])
    return out
  }
  return value
}

function noopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }
}
