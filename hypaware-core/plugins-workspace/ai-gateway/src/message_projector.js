// @ts-check

import { createHash } from 'node:crypto'

export const SCHEMA_VERSION = 3

/** @typedef {import('../../../../collectivus-plugin-kernel-types').ColumnSpec} ColumnSpec */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayMessageEnricher} AiGatewayMessageEnricher */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').AiGatewayMessageEnricherContext} AiGatewayMessageEnricherContext */

/**
 * Exact Collectivus `proxy_messages` query schema, exposed under
 * HypAware's `ai_gateway_messages` dataset name.
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
  { name: 'date', type: 'STRING', nullable: false },
])

const SCHEMA_COLUMN_NAMES = new Set(AI_GATEWAY_MESSAGE_COLUMNS.map((column) => column.name))

/**
 * @param {{
 *   gatewayId: string,
 *   enrichers?: AiGatewayMessageEnricher[],
 *   enricherContext?: AiGatewayMessageEnricherContext,
 *   log?: { warn(message: string, fields?: Record<string, unknown>): void },
 * }} opts
 */
export function createAiGatewayMessageProjector(opts) {
  const gatewayId = opts.gatewayId || 'hypaware-local'
  const enrichers = opts.enrichers ?? []
  const enricherContext = opts.enricherContext
  /** @type {Map<string, { conversation_id: string, message_index: number }>} */
  const seenMessages = new Map()
  /** @type {Map<string, unknown>} */
  const conversationStartedAt = new Map()
  /** @type {Map<string, Map<string, { tool_name?: string, conversation_id: string }>>} */
  const toolCallLookupByConversation = new Map()

  return {
    /**
     * @param {Record<string, unknown>} exchange
     * @returns {Promise<Record<string, unknown>[]>}
     */
    async projectExchange(exchange) {
      const projection = buildProjection(exchange)
      if (!projection) {
        opts.log?.warn('aigw.message_projection_skipped', {
          exchange_id: stringValue(exchange.exchange_id) ?? '',
          upstream: stringValue(exchange.upstream) ?? '',
          reason: 'unrecognized_or_unparseable_exchange',
        })
        return []
      }

      if (!conversationStartedAt.has(projection.conversation_id)) {
        conversationStartedAt.set(projection.conversation_id, projection.ts_start)
      }

      let conversationLookup = toolCallLookupByConversation.get(projection.conversation_id)
      if (!conversationLookup) {
        conversationLookup = new Map()
        toolCallLookupByConversation.set(projection.conversation_id, conversationLookup)
      }

      /** @type {Record<string, unknown>[]} */
      const rows = []
      /** @type {string | undefined} */
      let previous_message_id

      for (let i = 0; i < projection.messages.length; i++) {
        const message = projection.messages[i]
        const role = stringValue(message.role)
        if (!role) continue
        const content = normalizeContent(message.content)
        if (content.length === 0) continue

        const message_id = computeMessageId(projection.conversation_id, role, content)
        if (seenMessages.has(message_id)) {
          previous_message_id = message_id
          continue
        }

        const ctx = {
          conversation_id: projection.conversation_id,
          conversation_started_at: conversationStartedAt.get(projection.conversation_id) ?? projection.ts_start,
          conversation_source: projection.conversation_source,
          cwd: projection.cwd,
          git_branch: projection.git_branch,
          claude_version: projection.claude_version,
          user_id: projection.user_id,
          provider: projection.provider,
          model: projection.model,
          system_text: projection.system_text,
          tools: projection.tools,
          message_index: i,
          previous_message_id,
          message_created_at: projection.ts_start,
          tool_call_lookup: conversationLookup,
        }

        const partRows = extractMessageParts(exchange, message, ctx)
        const gatewayAttributes = buildGatewayAttributes(exchange)
        for (const row of partRows) {
          if (
            row.part_type === 'tool_call' &&
            typeof row.tool_call_id === 'string' &&
            typeof row.tool_name === 'string'
          ) {
            conversationLookup.set(row.tool_call_id, {
              tool_name: row.tool_name,
              conversation_id: projection.conversation_id,
            })
          }
          row.gateway_id = gatewayId
          row.date = utcDate(row.message_created_at)
          row.session_id = projection.session_id
          row.content = content
          row.attributes = mergeJsonObjects(row.attributes, gatewayAttributes)

          /** @type {Record<string, unknown>} */
          let enriched = row
          for (const enricher of enrichers) {
            try {
              enriched = await enricher.enrich(enriched, enricherContext)
            } catch (err) {
              opts.log?.warn('aigw.message_enrichment_failed', {
                enricher: enricher.name,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
          rows.push(stripToSchema(enriched))
        }

        seenMessages.set(message_id, {
          conversation_id: projection.conversation_id,
          message_index: i,
        })
        previous_message_id = message_id
      }

      return rows
    },
  }
}

/**
 * @param {Record<string, unknown>} exchange
 */
function buildProjection(exchange) {
  const reqBody = parseMaybeJson(readRawRequestBody(exchange))
  if (!isPlainObject(reqBody)) return undefined
  const requestPath = stringValue(exchange.path) ?? stringValue(readPath(exchange, ['request', 'path'])) ?? ''
  const provider = resolveProvider(exchange, reqBody, requestPath)
  const responseBody = parseMaybeJson(readRawResponseBody(exchange))
  const ts_start = stringValue(exchange.ts_start) ?? new Date().toISOString()
  const messages = messagesForProvider(provider, requestPath, reqBody, responseBody, exchange)
  if (messages.length === 0) return undefined

  const conversation_id = resolveConversationId(reqBody, exchange)
  const session_id = resolveSessionId(reqBody, exchange)
  const recordedContext = resolveRecordedContext(reqBody, exchange)
  return {
    provider,
    conversation_id,
    session_id,
    user_id: resolveUserId(reqBody, provider),
    conversation_source: resolveConversationSource(exchange, provider),
    cwd: recordedContext.cwd,
    git_branch: recordedContext.git_branch,
    claude_version: recordedContext.claude_version,
    model: resolveModel(reqBody, responseBody),
    system_text: extractSystemText(reqBody.system),
    tools: reqBody.tools,
    ts_start,
    messages,
  }
}

/**
 * @param {string} provider
 * @param {string} path
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 * @param {Record<string, unknown>} exchange
 * @returns {Record<string, unknown>[]}
 */
function messagesForProvider(provider, path, reqBody, responseBody, exchange) {
  if (provider === 'openai' || provider === 'chatgpt' || isOpenAiChatPath(path) || isOpenAiResponsesPath(path)) {
    if (isOpenAiChatPath(path) || Array.isArray(reqBody.messages)) {
      return openAiChatMessages(reqBody, responseBody)
    }
    return openAiResponsesMessages(reqBody, responseBody, readStreamEvents(exchange))
  }
  return anthropicMessages(reqBody, responseBody, readStreamEvents(exchange))
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 * @param {Record<string, unknown>[]} streamEvents
 * @returns {Record<string, unknown>[]}
 */
function anthropicMessages(reqBody, responseBody, streamEvents) {
  const messages = Array.isArray(reqBody.messages)
    ? reqBody.messages.filter(isPlainObject).map((message) => ({ ...message }))
    : []
  const assistant = isAnthropicAssistant(responseBody)
    ? responseBody
    : reconstructAnthropicAssistantMessage(streamEvents)
  if (assistant) messages.push(assistant)
  return messages
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 * @returns {Record<string, unknown>[]}
 */
function openAiChatMessages(reqBody, responseBody) {
  const messages = Array.isArray(reqBody.messages)
    ? reqBody.messages.filter(isPlainObject).map(openAiMessageToProxyMessage)
    : []
  const choice = firstChoice(responseBody)
  const message = isPlainObject(choice?.message) ? choice.message : undefined
  if (message) {
    const assistant = openAiMessageToProxyMessage({
      ...message,
      stop_reason: stringValue(choice?.finish_reason),
    })
    if (isPlainObject(responseBody) && isPlainObject(responseBody.usage)) assistant.usage = responseBody.usage
    messages.push(assistant)
  }
  return messages
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 * @param {Record<string, unknown>[]} streamEvents
 * @returns {Record<string, unknown>[]}
 */
function openAiResponsesMessages(reqBody, responseBody, streamEvents) {
  const messages = responsesInputMessages(reqBody.input)
  const assistant = responsesAssistantMessage(responseBody) ?? responsesAssistantFromStream(streamEvents)
  if (assistant) messages.push(assistant)
  return messages
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Record<string, unknown>}
 */
function openAiMessageToProxyMessage(message) {
  const role = stringValue(message.role) ?? 'user'
  const content = openAiContentBlocks(message.content)
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(isPlainObject).map(openAiToolCallBlock)
    : []
  const out = {
    role,
    content: [...content, ...toolCalls],
  }
  if (typeof message.stop_reason === 'string') out.stop_reason = mapOpenAiFinishReason(message.stop_reason)
  if (role === 'tool') {
    out.content = [{
      type: 'tool_result',
      tool_use_id: stringValue(message.tool_call_id),
      content: typeof message.content === 'string' ? message.content : textFromContentBlocks(content),
    }]
  }
  return out
}

/**
 * @param {unknown} content
 * @returns {Record<string, unknown>[]}
 */
function openAiContentBlocks(content) {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  /** @type {Record<string, unknown>[]} */
  const out = []
  for (const item of content) {
    if (!isPlainObject(item)) continue
    const text = stringValue(item.text) ?? stringValue(item.input_text) ?? stringValue(item.output_text)
    if (text != null) out.push({ type: 'text', text })
  }
  return out
}

/**
 * @param {Record<string, unknown>} call
 */
function openAiToolCallBlock(call) {
  const fn = isPlainObject(call.function) ? call.function : {}
  return {
    type: 'tool_use',
    id: stringValue(call.id),
    name: stringValue(fn.name),
    input: parseMaybeJson(fn.arguments),
  }
}

/**
 * @param {unknown} input
 * @returns {Record<string, unknown>[]}
 */
function responsesInputMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []
  /** @type {Record<string, unknown>[]} */
  const out = []
  for (const item of input) {
    if (!isPlainObject(item)) continue
    const role = stringValue(item.role) ?? 'user'
    out.push({ role, content: responsesContentBlocks(item.content) })
  }
  return out
}

/**
 * @param {unknown} content
 * @returns {Record<string, unknown>[]}
 */
function responsesContentBlocks(content) {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  /** @type {Record<string, unknown>[]} */
  const out = []
  for (const item of content) {
    if (!isPlainObject(item)) continue
    const text = stringValue(item.text) ?? stringValue(item.input_text) ?? stringValue(item.output_text)
    if (text != null) out.push({ type: 'text', text })
  }
  return out
}

/**
 * @param {unknown} responseBody
 * @returns {Record<string, unknown> | undefined}
 */
function responsesAssistantMessage(responseBody) {
  if (!isPlainObject(responseBody)) return undefined
  const outputText = stringValue(responseBody.output_text)
  if (outputText) return { role: 'assistant', content: [{ type: 'text', text: outputText }], stop_reason: 'end_turn' }
  const output = Array.isArray(responseBody.output) ? responseBody.output : []
  /** @type {Record<string, unknown>[]} */
  const content = []
  for (const item of output) {
    if (!isPlainObject(item)) continue
    if (item.type === 'message' || item.role === 'assistant') {
      content.push(...responsesContentBlocks(item.content))
    }
  }
  if (content.length === 0) return undefined
  return { role: 'assistant', content, stop_reason: 'end_turn', usage: responseBody.usage }
}

/**
 * @param {Record<string, unknown>[]} streamEvents
 * @returns {Record<string, unknown> | undefined}
 */
function responsesAssistantFromStream(streamEvents) {
  let text = ''
  /** @type {Record<string, unknown> | undefined} */
  let usage
  for (const row of streamEvents) {
    const payload = parseEventData(row)
    if (!isPlainObject(payload)) continue
    const type = stringValue(payload.type) ?? stringValue(row.event)
    if (type === 'response.output_text.delta' || type === 'response.output_text.annotation.added') {
      const delta = stringValue(payload.delta)
      if (delta) text += delta
    } else if (type === 'response.completed') {
      const response = isPlainObject(payload.response) ? payload.response : payload
      if (isPlainObject(response.usage)) usage = response.usage
      const completed = responsesAssistantMessage(response)
      const completedText = completed ? textFromContentBlocks(normalizeContent(completed.content)) : undefined
      if (!text && typeof completedText === 'string') text = completedText
    }
  }
  if (!text) return undefined
  const message = { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }
  if (usage) message.usage = usage
  return message
}

/**
 * @param {unknown} responseBody
 */
function firstChoice(responseBody) {
  if (!isPlainObject(responseBody) || !Array.isArray(responseBody.choices)) return undefined
  const choice = responseBody.choices.find(isPlainObject)
  return choice
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isAnthropicAssistant(value) {
  return isPlainObject(value) && value.role === 'assistant'
}

/**
 * @param {unknown} exchange
 * @param {Record<string, unknown>} reqBody
 * @param {string} path
 * @returns {string}
 */
function resolveProvider(exchange, reqBody, path) {
  const direct = stringValue(readKey(exchange, 'provider'))
  if (direct) return direct
  const upstream = stringValue(readKey(exchange, 'upstream'))
  if (upstream === 'openai' || upstream === 'chatgpt' || upstream === 'anthropic') return upstream
  if (isOpenAiChatPath(path) || isOpenAiResponsesPath(path)) return upstream || 'openai'
  if (Array.isArray(reqBody.input)) return upstream || 'openai'
  if (path === '/v1/messages' || path.startsWith('/v1/messages/')) return upstream || 'anthropic'
  return upstream || 'anthropic'
}

/** @param {string} path */
function isOpenAiChatPath(path) {
  return path === '/v1/chat/completions' || path.endsWith('/chat/completions')
}

/** @param {string} path */
function isOpenAiResponsesPath(path) {
  return path === '/v1/responses' ||
    path.endsWith('/responses') ||
    path === '/backend-api/codex/responses' ||
    path.startsWith('/backend-api/codex/responses/')
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {Record<string, unknown>} exchange
 * @returns {string}
 */
function resolveConversationId(reqBody, exchange) {
  const sessionId = resolveSessionId(reqBody, exchange)
  if (sessionId) return sessionId
  const messages = Array.isArray(reqBody.messages) ? reqBody.messages : responsesInputMessages(reqBody.input)
  if (messages.length > 0 && isPlainObject(messages[0])) {
    return sha256Hex(canonicalJson(messages[0].content)).slice(0, 16)
  }
  const exchangeId = stringValue(exchange.exchange_id) ?? ''
  return sha256Hex(exchangeId).slice(0, 16)
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {Record<string, unknown>} exchange
 */
function resolveSessionId(reqBody, exchange) {
  return readMetadataSessionId(reqBody) ?? readHeader(exchange, 'x-claude-code-session-id')
}

/**
 * @param {Record<string, unknown>} reqBody
 */
function readMetadataSessionId(reqBody) {
  const meta = readKey(reqBody, 'metadata')
  if (!isPlainObject(meta)) return undefined
  const userId = parseMaybeJson(meta.user_id)
  if (!isPlainObject(userId)) return undefined
  return stringValue(userId.session_id)
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {string} provider
 */
function resolveUserId(reqBody, provider) {
  const meta = readKey(reqBody, 'metadata')
  if (isPlainObject(meta)) {
    const userId = parseMaybeJson(meta.user_id)
    if (isPlainObject(userId)) {
      const accountUuid = stringValue(userId.account_uuid)
      if (accountUuid) return accountUuid
    }
  }
  if (provider === 'openai' || provider === 'chatgpt') return stringValue(reqBody.user)
  return undefined
}

/**
 * @param {Record<string, unknown>} exchange
 * @param {string} provider
 */
function resolveConversationSource(exchange, provider) {
  const ua = stringValue(readPath(exchange, ['client', 'user_agent'])) ?? readHeader(exchange, 'user-agent')
  if (ua && /^claude-cli\//.test(ua)) return 'claude_code'
  if (provider === 'chatgpt') return 'codex'
  return 'api'
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {Record<string, unknown>} exchange
 */
function resolveRecordedContext(reqBody, exchange) {
  const meta = readKey(reqBody, 'metadata')
  const userId = isPlainObject(meta) ? parseMaybeJson(meta.user_id) : undefined
  return {
    cwd: firstString(
      readStringKey(exchange, 'cwd'),
      readStringKey(reqBody, 'cwd'),
      readStringKey(meta, 'cwd'),
      readStringKey(userId, 'cwd')
    ),
    git_branch: firstString(
      readStringKey(exchange, 'git_branch'),
      readStringKey(exchange, 'gitBranch'),
      readStringKey(reqBody, 'git_branch'),
      readStringKey(reqBody, 'gitBranch'),
      readStringKey(meta, 'git_branch'),
      readStringKey(meta, 'gitBranch'),
      readStringKey(userId, 'git_branch'),
      readStringKey(userId, 'gitBranch')
    ),
    claude_version: firstString(
      readStringKey(exchange, 'claude_version'),
      readStringKey(exchange, 'claudeVersion'),
      readStringKey(reqBody, 'claude_version'),
      readStringKey(reqBody, 'claudeVersion'),
      readStringKey(meta, 'claude_version'),
      readStringKey(meta, 'claudeVersion'),
      readStringKey(userId, 'claude_version'),
      readStringKey(userId, 'claudeVersion'),
      claudeVersionFromUserAgent(readPath(exchange, ['client', 'user_agent']))
    ),
  }
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 */
function resolveModel(reqBody, responseBody) {
  return stringValue(reqBody.model) ?? stringValue(readKey(responseBody, 'model'))
}

/** @param {unknown} system */
function extractSystemText(system) {
  if (typeof system === 'string') return system.length === 0 ? undefined : system
  if (!Array.isArray(system)) return undefined
  const texts = []
  for (const block of system) {
    if (isPlainObject(block) && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.length === 0 ? undefined : texts.join('\n\n')
}

/**
 * @param {Record<string, unknown> | undefined | null} exchange
 * @param {Record<string, unknown>} message
 * @param {Record<string, unknown>} ctx
 * @returns {Array<Record<string, unknown>>}
 */
export function extractMessageParts(exchange, message, ctx) {
  const role = String(message.role)
  const content = normalizeContent(message.content)
  if (content.length === 0) return []

  const message_id = computeMessageId(String(ctx.conversation_id), role, content)
  const attributes = withClientAttributes(extractAttributes(exchange, message), stringValue(ctx.claude_version))
  const finishReason = mapFinishReason(stringValue(message.stop_reason))

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
    client_version: ctx.claude_version,
    message_id,
    previous_message_id: ctx.previous_message_id,
    message_index: ctx.message_index,
    message_created_at: ctx.message_created_at,
    role,
  }

  return content.map((block, part_index) => {
    const isLast = part_index === content.length - 1
    const part_type = mapPartType(typeof block?.type === 'string' ? block.type : undefined)
    const tool_call_id = extractToolCallId(block)
    const tool_name = extractToolName(block, tool_call_id, /** @type {Map<string, { tool_name?: string }> | undefined} */ (ctx.tool_call_lookup))
    return {
      ...base,
      part_id: `${message_id}#${part_index}`,
      part_index,
      part_type,
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
      is_error: readKey(block, 'is_error') === true ? true : undefined,
      status: buildStatus(block, isLast, role, finishReason),
      attributes,
    }
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

/** @param {string | undefined} value */
function mapOpenAiFinishReason(value) {
  if (value === 'stop') return 'end_turn'
  if (value === 'length') return 'max_tokens'
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use'
  return value
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
 * @param {Record<string, unknown> | undefined | null} exchange
 * @param {Record<string, unknown>} message
 */
function extractAttributes(exchange, message) {
  /** @type {Record<string, unknown>} */
  const attrs = {}
  const reqBody = parseMaybeJson(readRawRequestBody(exchange))
  if (isPlainObject(reqBody)) {
    /** @type {Record<string, unknown>} */
    const request = {}
    copyIfPresent(reqBody, request, 'max_tokens')
    copyIfPresent(reqBody, request, 'thinking')
    copyIfPresent(reqBody, request, 'output_config')
    copyIfPresent(reqBody, request, 'context_management')
    copyIfPresent(reqBody, request, 'stream')
    if (Object.keys(request).length > 0) attrs.request = request
    if (reqBody.metadata != null) attrs.provider_raw = { metadata: reqBody.metadata }
  }
  const respBody = parseMaybeJson(readRawResponseBody(exchange))
  if (isPlainObject(respBody)) {
    const providerRaw = isPlainObject(attrs.provider_raw) ? { ...attrs.provider_raw } : {}
    if (Array.isArray(respBody.choices)) providerRaw.choice_count = respBody.choices.length
    if (typeof respBody.id === 'string') providerRaw.response_id = respBody.id
    if (Object.keys(providerRaw).length > 0) attrs.provider_raw = providerRaw
  }
  if (isPlainObject(message.usage)) {
    /** @type {Record<string, unknown>} */
    const usage = {}
    copyIfPresent(message.usage, usage, 'input_tokens')
    copyIfPresent(message.usage, usage, 'output_tokens')
    if (message.usage.cache_read_input_tokens != null) usage.cache_read_tokens = message.usage.cache_read_input_tokens
    if (message.usage.cache_creation_input_tokens != null) usage.cache_write_tokens = message.usage.cache_creation_input_tokens
    if (Object.keys(usage).length > 0) attrs.usage = usage
  }
  const latencyMs = readKey(exchange, 'duration_ms')
  if (typeof latencyMs === 'number') attrs.timing = { latency_ms: latencyMs }
  return Object.keys(attrs).length === 0 ? undefined : attrs
}

/**
 * @param {Record<string, unknown> | undefined} attributes
 * @param {string | undefined} claudeVersion
 */
function withClientAttributes(attributes, claudeVersion) {
  if (!claudeVersion) return attributes
  const out = attributes ? { ...attributes } : {}
  const client = isPlainObject(out.client) ? { ...out.client } : {}
  client.claude_version = claudeVersion
  out.client = client
  return out
}

/** @param {Record<string, unknown>} exchange */
function buildGatewayAttributes(exchange) {
  /** @type {Record<string, unknown>} */
  const attrs = {}
  const devRunId = readDevRunId(exchange)
  if (devRunId) attrs.dev_run_id = devRunId
  attrs.gateway = {
    exchange_id: stringValue(exchange.exchange_id),
    upstream: stringValue(exchange.upstream),
    method: stringValue(exchange.method),
    path: stringValue(exchange.path),
    status_code: readKey(exchange, 'status_code'),
    request_bytes: readKey(exchange, 'request_bytes'),
    response_bytes: readKey(exchange, 'response_bytes'),
    is_sse: readKey(exchange, 'is_sse'),
    stream_event_count: readKey(exchange, 'stream_event_count'),
    request_headers: parseMaybeJson(exchange.request_headers),
    response_headers: parseMaybeJson(exchange.response_headers),
    error: stringValue(exchange.error),
  }
  return attrs
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {Record<string, unknown> | undefined}
 */
function mergeJsonObjects(a, b) {
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

/** @param {Record<string, unknown>} exchange */
function readDevRunId(exchange) {
  const metadata = parseMaybeJson(exchange.metadata)
  if (isPlainObject(metadata)) {
    const fromMetadata = stringValue(metadata.dev_run_id)
    if (fromMetadata) return fromMetadata
  }
  return readHeader(exchange, 'x-hyp-dev-run-id')
}

/** @param {unknown} exchange */
function readRawRequestBody(exchange) {
  return readKey(exchange, 'request_body') ?? readPath(exchange, ['request', 'body'])
}

/** @param {unknown} exchange */
function readRawResponseBody(exchange) {
  return readKey(exchange, 'response_body') ?? readPath(exchange, ['response', 'body'])
}

/** @param {unknown} exchange */
function readStreamEvents(exchange) {
  const events = readKey(exchange, 'stream_events')
  return Array.isArray(events) ? events.filter(isPlainObject) : []
}

/** @param {unknown} exchange @param {string} name */
function readHeader(exchange, name) {
  const headers = parseMaybeJson(readKey(exchange, 'request_headers')) ?? readPath(exchange, ['request', 'headers'])
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

/** @param {unknown} userAgent */
function claudeVersionFromUserAgent(userAgent) {
  if (typeof userAgent !== 'string') return undefined
  const match = /^claude-cli\/([^/\s]+)/.exec(userAgent)
  return match?.[1]
}

/** @param {...(string | undefined)} values */
function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0)
}

/** @param {unknown} obj @param {string} key */
function readStringKey(obj, key) {
  const value = readKey(obj, key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {Record<string, unknown>[]} streamEvents
 * @returns {Record<string, unknown> | null}
 */
function reconstructAnthropicAssistantMessage(streamEvents) {
  /** @type {Record<string, unknown> | null} */
  let message = null
  /** @type {Map<number, Record<string, unknown>>} */
  const blocksByIndex = new Map()
  /** @type {Map<number, string>} */
  const partialJsonByIndex = new Map()
  let sawMessageStop = false

  for (const row of streamEvents) {
    const payload = parseEventData(row)
    if (!isPlainObject(payload)) continue
    const type = stringValue(payload.type)
    switch (type) {
    case 'message_start': {
      const m = isPlainObject(payload.message) ? payload.message : undefined
      if (m) message = seedAnthropicMessage(m)
      break
    }
    case 'content_block_start': {
      const index = numberValue(payload.index)
      const block = isPlainObject(payload.content_block) ? payload.content_block : undefined
      if (index == null || !block) break
      blocksByIndex.set(index, { ...block })
      if (block.type === 'tool_use' || block.type === 'server_tool_use') partialJsonByIndex.set(index, '')
      break
    }
    case 'content_block_delta': {
      const index = numberValue(payload.index)
      const delta = isPlainObject(payload.delta) ? payload.delta : undefined
      if (index == null || !delta) break
      applyAnthropicDelta(ensureAnthropicBlock(blocksByIndex, index, delta), delta, index, partialJsonByIndex)
      break
    }
    case 'content_block_stop': {
      const index = numberValue(payload.index)
      if (index != null) finalizeAnthropicBlock(blocksByIndex, partialJsonByIndex, index)
      break
    }
    case 'message_delta': {
      if (!message) break
      const delta = isPlainObject(payload.delta) ? payload.delta : undefined
      if (delta && 'stop_reason' in delta) message.stop_reason = stringValue(delta.stop_reason)
      if (delta && 'stop_sequence' in delta) message.stop_sequence = stringValue(delta.stop_sequence)
      if (isPlainObject(payload.usage)) {
        const existingUsage = isPlainObject(message.usage) ? message.usage : {}
        message.usage = { ...existingUsage, ...payload.usage }
      }
      break
    }
    case 'message_stop':
      sawMessageStop = true
      break
    default:
      break
    }
  }

  if (!message) return null
  for (const index of Array.from(blocksByIndex.keys())) finalizeAnthropicBlock(blocksByIndex, partialJsonByIndex, index)
  message.content = Array.from(blocksByIndex.entries())
    .sort(([a], [b]) => a - b)
    .map(([, block]) => block)
  if (!sawMessageStop && message.stop_reason == null) message.stop_reason = 'error'
  return message
}

/** @param {Record<string, unknown>} m */
function seedAnthropicMessage(m) {
  const msg = { role: 'assistant', content: [], type: 'message' }
  copyIfString(m, msg, 'id')
  copyIfString(m, msg, 'model')
  copyIfString(m, msg, 'stop_reason')
  copyIfString(m, msg, 'stop_sequence')
  if (isPlainObject(m.usage)) msg.usage = { ...m.usage }
  return msg
}

/** @param {Map<number, Record<string, unknown>>} blocksByIndex @param {number} index @param {Record<string, unknown>} delta */
function ensureAnthropicBlock(blocksByIndex, index, delta) {
  const existing = blocksByIndex.get(index)
  if (existing) return existing
  const dtype = stringValue(delta.type)
  const block = dtype === 'input_json_delta'
    ? { type: 'tool_use', input: {} }
    : dtype === 'thinking_delta' || dtype === 'signature_delta'
      ? { type: 'thinking', thinking: '' }
      : { type: 'text', text: '' }
  blocksByIndex.set(index, block)
  return block
}

/** @param {Record<string, unknown>} block @param {Record<string, unknown>} delta @param {number} index @param {Map<number, string>} partialJsonByIndex */
function applyAnthropicDelta(block, delta, index, partialJsonByIndex) {
  const dtype = stringValue(delta.type)
  if (dtype === 'text_delta') block.text = `${stringValue(block.text) ?? ''}${stringValue(delta.text) ?? ''}`
  else if (dtype === 'thinking_delta') block.thinking = `${stringValue(block.thinking) ?? ''}${stringValue(delta.thinking) ?? ''}`
  else if (dtype === 'signature_delta') block.signature = stringValue(delta.signature)
  else if (dtype === 'input_json_delta') {
    partialJsonByIndex.set(index, `${partialJsonByIndex.get(index) ?? ''}${stringValue(delta.partial_json) ?? ''}`)
  }
}

/** @param {Map<number, Record<string, unknown>>} blocksByIndex @param {Map<number, string>} partialJsonByIndex @param {number} index */
function finalizeAnthropicBlock(blocksByIndex, partialJsonByIndex, index) {
  const block = blocksByIndex.get(index)
  if (!block || !partialJsonByIndex.has(index)) return
  const raw = partialJsonByIndex.get(index) ?? ''
  block.input = parseMaybeJson(raw)
  partialJsonByIndex.delete(index)
}

/** @param {Record<string, unknown>} row */
function parseEventData(row) {
  const data = row.data
  if (data === '[DONE]') return undefined
  return parseMaybeJson(data)
}

/** @param {unknown} value */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/** @param {unknown} obj @param {string[]} keys */
function readPath(obj, keys) {
  /** @type {unknown} */
  let cur = obj
  for (const key of keys) {
    if (!isPlainObject(cur)) return undefined
    cur = cur[key]
  }
  return cur
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

/** @param {unknown} value */
function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
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

/** @param {unknown} src @param {Record<string, unknown>} dst @param {string} key */
function copyIfPresent(src, dst, key) {
  if (!isPlainObject(src)) return
  const value = src[key]
  if (value !== undefined && value !== null) dst[key] = value
}

/** @param {Record<string, unknown>} src @param {Record<string, unknown>} dst @param {string} key */
function copyIfString(src, dst, key) {
  const value = stringValue(src[key])
  if (value != null) dst[key] = value
}
