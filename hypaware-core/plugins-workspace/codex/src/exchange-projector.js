// @ts-check

import { createHash } from 'node:crypto'

import { createUsagePolicyResolver, USAGE_POLICY_DROP } from '../../../../src/core/usage-policy/index.js'
import { redactRemoteUserinfo } from './git-remote.js'

/**
 * @import { AiGatewayExchangeInput, AiGatewayExchangeProjector, AiGatewayProjectedExchange, AiGatewayProjectedMessage, JsonObject } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 */

/**
 * Build the `@hypaware/codex` adapter's full exchange projector. The
 * single projector subsumes three transport flavors that all flow
 * through the Codex client:
 *
 *  - OpenAI Chat (`/v1/chat/completions`): non-streaming JSON.
 *  - OpenAI Responses (`/v1/responses`): JSON or SSE.
 *  - ChatGPT Codex (`/backend-api/codex/*`): SSE, with Codex-specific
 *    turn metadata, workspace, and identity headers.
 *
 * The match function is intentionally permissive across these paths
 * so the gateway can route a single Codex install (whether API-key or
 * ChatGPT subscription mode) through one projector without exposing
 * provider semantics to the gateway core.
 *
 * @param {{ resolver?: UsagePolicyResolver }} [opts]
 * @returns {AiGatewayExchangeProjector}
 */
export function createCodexExchangeProjector(opts = {}) {
  // One `.hypignore` resolver per projector instance (one per started
  // listener): the per-cwd cache then spans the listener's lifetime so the
  // capture hot path adds no unbounded fs work (LLP 0049 R6).
  const resolver = opts.resolver ?? createUsagePolicyResolver()

  return {
    name: 'codex-exchange',
    priority: 100,

    /** @param {AiGatewayExchangeInput} input */
    match(input) {
      const path = input.path ?? ''
      if (isOpenAiChatPath(path)) return true
      if (isOpenAiResponsesPath(path)) return true
      if (isCodexNamespacePath(path)) return true
      // Codex Desktop tags requests with a `x-codex-turn-metadata`
      // header even when the path looks generic, so accept the header
      // as a sufficient match signal.
      if (readHeader(input.request_headers, 'x-codex-turn-metadata')) return true
      return false
    },

    /**
     * @param {AiGatewayExchangeInput} input
     * @param {{ log?: { info?: (m: string, f?: Record<string, unknown>) => void } }} [ctx]
     */
    project(input, ctx) {
      const reqBody = parseMaybeJson(input.request_body)
      if (!isPlainObject(reqBody)) return undefined

      const path = input.path ?? ''
      const provider = resolveProvider(input, reqBody, path)
      const codexContext = resolveCodexContext(input, provider, path, reqBody)

      // @ref LLP 0050 [implements]: capture-seam drop, symmetric to the
      // @hypaware/claude projector. Once this exchange's cwd is resolved, an
      // ancestor `.hypignore` of class `ignore` drops the exchange by returning
      // the terminal `USAGE_POLICY_DROP` sentinel (the gateway source's
      // `messageRows.length > 0` write guard then persists nothing). The
      // sentinel (NOT a bare `undefined`) stops the dispatcher's projector walk
      // so no later overlapping projector can record the suppressed exchange,
      // and is logged as a drop rather than a `no_projector_match` miss. The
      // response has already streamed, so the live call is untouched: only
      // persistence is suppressed (LLP 0049 R1/R2). This is the same cwd
      // `resolveRecordedContext` would stamp on the row.
      const cwd = firstString(codexContext?.cwd, readRecordedCwd(reqBody))
      if (cwd) {
        const policy = resolver.resolve(cwd)
        if (policy.class === 'ignore') {
          // `declared` distinguishes an intended `ignore` from a fail-safe clamp
          // of an unimplemented token; on a clamp escalate to warn (R3 SHOULD).
          ctx?.log?.[policy.warn ? 'warn' : 'info']?.('plugin.codex.usage_policy_drop', {
            component: 'codex',
            operation: 'usage_policy_drop',
            class: policy.class,
            declared: policy.declared,
            governed_by: policy.governedBy,
            cwd_sha256: sha256Hex(cwd).slice(0, 16),
            ...(policy.warn ? { warn: policy.warn } : {}),
          })
          return USAGE_POLICY_DROP
        }
      }

      const responseBody = parseMaybeJson(input.response_body)
      const streamEvents = Array.isArray(input.stream_events) ? input.stream_events : []
      const messages = messagesForTransport({ provider, path, reqBody, responseBody, streamEvents })
      if (messages.length === 0) return undefined

      const conversationId = resolveConversationId(reqBody, input, provider, path, codexContext)
      // @ref LLP 0030#decision: session_id is the partition key (always
      // non-null): Codex's `metadata.session_id`, falling back to the
      // thread (conversation_id) when no session id was captured. Keep
      // conversation_id = the thread; both can be set for Codex.
      const sessionId = stringValue(codexContext?.session_id) ?? conversationId
      const recordedContext = resolveRecordedContext(reqBody, codexContext)

      /** @type {JsonObject} */
      const codexAttributes = codexContext?.attributes ? { ...codexContext.attributes } : {}
      // The projector never supplies message_id today, so every row
      // takes the gateway's fallback identity. Stamp the codex-side
      // signal for symmetry with the @hypaware/claude adapter.
      codexAttributes.identity_source = 'gateway_fallback'
      const projectionAttributes = Object.keys(codexAttributes).length > 0
        ? { codex: codexAttributes }
        : undefined

      /** @type {AiGatewayProjectedExchange} */
      const projection = {
        provider,
        session_id: sessionId,
        conversation_id: conversationId,
        conversation_started_at: input.ts_start,
        conversation_source: resolveConversationSource(provider),
        cwd: recordedContext.cwd,
        git_branch: recordedContext.git_branch,
        // @ref LLP 0032#capture: repo identity for the graph bridge (Repo/Commit).
        // repo_root is intentionally omitted for Codex (left null). See
        // resolveCodexContext. @ref LLP 0032#codex-repo-root
        git_remote: codexContext?.git_remote,
        head_sha: codexContext?.head_sha,
        client_name: recordedContext.client_name,
        client_version: recordedContext.client_version,
        entrypoint: recordedContext.entrypoint,
        user_type: recordedContext.user_type,
        permission_mode: recordedContext.permission_mode,
        is_sidechain: recordedContext.is_sidechain,
        parent_thread_id: codexContext?.parent_thread_id,
        user_id: resolveUserId(reqBody, provider),
        request_id: resolveRequestId(input),
        prompt_id: codexContext?.turn_id,
        model: resolveModel(reqBody, responseBody),
        system_text: extractSystemText(reqBody.system ?? reqBody.instructions),
        tools: /** @type {any} */ (reqBody.tools),
        attributes: projectionAttributes,
        messages,
      }
      return stripUndefined(projection)
    },
  }
}

// ---------------------------------------------------------------------
// Provider routing
// ---------------------------------------------------------------------

/**
 * Promote a request to a provider label the projection can carry. We
 * trust the gateway-routed `input.provider` first (it comes from the
 * preset that won routing) and only fall back to path inference for
 * exchanges that arrived without a preset hint.
 *
 * @param {AiGatewayExchangeInput} input
 * @param {Record<string, unknown>} reqBody
 * @param {string} path
 * @returns {string}
 */
function resolveProvider(input, reqBody, path) {
  const direct = stringValue(input.provider ?? undefined)
  if (direct) return direct
  const upstream = stringValue(input.upstream)
  if (upstream === 'openai' || upstream === 'chatgpt') return upstream
  if (isCodexNamespacePath(path)) return 'chatgpt'
  if (isOpenAiChatPath(path) || isOpenAiResponsesPath(path)) return 'openai'
  return upstream || 'openai'
}

/** @param {string} path */
function isOpenAiChatPath(path) {
  return path === '/v1/chat/completions' ||
    path === '/chat/completions' ||
    path.endsWith('/chat/completions') ||
    path.startsWith('/v1/chat/completions/') ||
    path.startsWith('/chat/completions/')
}

/** @param {string} path */
function isOpenAiResponsesPath(path) {
  return path === '/v1/responses' ||
    path === '/responses' ||
    path.endsWith('/responses') ||
    path.startsWith('/v1/responses/') ||
    path.startsWith('/responses/') ||
    path === '/v1/models' ||
    path.startsWith('/v1/models/')
}

/** @param {string} path */
function isCodexNamespacePath(path) {
  return path === '/backend-api/codex' ||
    path.startsWith('/backend-api/codex/')
}

// ---------------------------------------------------------------------
// Message extraction per transport
// ---------------------------------------------------------------------

/**
 * @param {{
 *   provider: string,
 *   path: string,
 *   reqBody: Record<string, unknown>,
 *   responseBody: unknown,
 *   streamEvents: Array<{ event: string, data: string }>,
 * }} ctx
 * @returns {AiGatewayProjectedMessage[]}
 */
function messagesForTransport(ctx) {
  // Chat-completions request bodies carry `messages: [...]`. Responses
  // bodies carry `input: ...` (string or array). Treat path AND body
  // shape as joint signals so a chat-shaped request mis-routed onto a
  // responses path still parses correctly.
  if (isOpenAiChatPath(ctx.path) || Array.isArray(ctx.reqBody.messages)) {
    return openAiChatMessages(ctx.reqBody, ctx.responseBody)
  }
  return openAiResponsesMessages(ctx.reqBody, ctx.responseBody, ctx.streamEvents)
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 * @returns {AiGatewayProjectedMessage[]}
 */
function openAiChatMessages(reqBody, responseBody) {
  const requestMessages = Array.isArray(reqBody.messages) ? reqBody.messages : []
  /** @type {AiGatewayProjectedMessage[]} */
  const messages = []
  for (const raw of requestMessages) {
    if (!isPlainObject(raw)) continue
    const projected = openAiChatMessageToProjected(raw)
    if (projected) messages.push(projected)
  }
  const choice = firstChoice(responseBody)
  if (choice) {
    const responseMessage = isPlainObject(choice.message) ? choice.message : undefined
    if (responseMessage) {
      const assistant = openAiChatMessageToProjected(responseMessage)
      if (assistant) {
        const finish = stringValue(choice.finish_reason)
        if (finish) assistant.raw_frame = { ...assistant.raw_frame, finish_reason: finish }
        const usageAttributes = openAiUsageAttributes(readOpenAiUsage(responseBody))
        if (usageAttributes) assistant.attributes = mergeJsonObjects(assistant.attributes, usageAttributes)
        messages.push(assistant)
      }
    }
  }
  return messages
}

/**
 * @param {Record<string, unknown>} message
 * @returns {AiGatewayProjectedMessage | undefined}
 */
function openAiChatMessageToProjected(message) {
  const role = stringValue(message.role) ?? 'user'
  if (role === 'tool') {
    const toolCallId = stringValue(message.tool_call_id)
    const text = typeof message.content === 'string'
      ? message.content
      : textFromBlocks(openAiContentBlocks(message.content))
    return {
      role,
      content: [{
        type: 'tool_result',
        ...(toolCallId ? { tool_use_id: toolCallId } : {}),
        ...(text ? { content: text } : {}),
      }],
    }
  }
  /** @type {JsonObject[]} */
  const content = openAiContentBlocks(message.content)
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isPlainObject(call)) continue
      const fn = isPlainObject(call.function) ? call.function : {}
      const id = stringValue(call.id)
      const name = stringValue(fn.name)
      if (!id || !name) continue
      content.push({
        type: 'tool_use',
        id,
        name,
        input: parseMaybeJson(fn.arguments) ?? null,
      })
    }
  }
  if (content.length === 0) return undefined
  return { role, content }
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 * @param {Array<{ event: string, data: string }>} streamEvents
 * @returns {AiGatewayProjectedMessage[]}
 */
function openAiResponsesMessages(reqBody, responseBody, streamEvents) {
  /** @type {AiGatewayProjectedMessage[]} */
  const messages = responsesInputMessages(reqBody.input)
  let assistant = responsesAssistantMessagesFromBody(responseBody)
  if (assistant.length === 0) assistant = responsesAssistantMessagesFromStream(streamEvents)
  const usageAttributes = openAiUsageAttributes(
    readOpenAiUsage(responseBody) ?? readOpenAiUsageFromResponsesStream(streamEvents)
  )
  stampUsageOnLastAssistant(assistant, usageAttributes)
  for (const msg of assistant) messages.push(msg)
  return messages
}

/**
 * Mirror `codex/src/backfill.js`: fan items out so each `function_call` /
 * `function_call_output` becomes its own projected message.
 *
 * @param {unknown} input
 * @returns {AiGatewayProjectedMessage[]}
 */
function responsesInputMessages(input) {
  if (typeof input === 'string') {
    if (input.length === 0) return []
    return [{ role: 'user', content: [{ type: 'text', text: input }] }]
  }
  if (!Array.isArray(input)) return []
  /** @type {AiGatewayProjectedMessage[]} */
  const out = []
  for (const item of input) {
    if (!isPlainObject(item)) continue
    const itemType = stringValue(item.type)
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const block = toolUseBlockFromPayload(item)
      if (block) out.push({ role: 'assistant', content: [block] })
      continue
    }
    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      const block = toolResultBlockFromPayload(item)
      if (block) out.push({ role: 'tool', content: [block] })
      continue
    }
    const role = stringValue(item.role) ?? 'user'
    const blocks = openAiContentBlocks(item.content)
    if (blocks.length === 0) continue
    out.push({ role, content: blocks })
  }
  return out
}

/** @param {unknown} content @returns {JsonObject[]} */
function openAiContentBlocks(content) {
  if (typeof content === 'string') {
    if (content.length === 0) return []
    return [{ type: 'text', text: content }]
  }
  if (!Array.isArray(content)) return []
  /** @type {JsonObject[]} */
  const out = []
  for (const item of content) {
    if (!isPlainObject(item)) continue
    const text = stringValue(item.text) ?? stringValue(item.input_text) ?? stringValue(item.output_text)
    if (text != null) out.push({ type: 'text', text })
  }
  return out
}

/**
 * Fan out response `output[]` items so each becomes its own assistant
 * message: same per-item shape `responsesInputMessages` produces for
 * replayed input items, so turn-1 response rows hash equal to turn-2
 * input rows in the kernel's content-hash dedupe.
 *
 * @param {unknown} responseBody
 * @returns {AiGatewayProjectedMessage[]}
 */
function responsesAssistantMessagesFromBody(responseBody) {
  if (!isPlainObject(responseBody)) return []
  /** @type {AiGatewayProjectedMessage[]} */
  const out = []
  let sawMessage = false
  const output = Array.isArray(responseBody.output) ? responseBody.output : []
  for (const item of output) {
    if (!isPlainObject(item)) continue
    const itemType = stringValue(item.type)
    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const block = toolUseBlockFromPayload(item)
      if (block) out.push({ role: 'assistant', content: [block] })
    } else if (itemType === 'message' || item.role === 'assistant') {
      const blocks = openAiContentBlocks(item.content)
      if (blocks.length > 0) {
        out.push({ role: 'assistant', content: blocks })
        sawMessage = true
      }
    }
  }
  if (!sawMessage) {
    const outputText = stringValue(responseBody.output_text)
    if (outputText) out.unshift({ role: 'assistant', content: [{ type: 'text', text: outputText }] })
  }
  return out
}

/**
 * Stitch streamed Responses assistant messages from SSE events. When
 * `response.completed` arrives, its body is preferred (already per-item
 * via `responsesAssistantMessagesFromBody`); streamed text and tool_uses
 * not represented there are merged in so a truncated completed body
 * cannot silently drop captured content.
 *
 * @param {Array<{ event: string, data: string }>} streamEvents
 * @returns {AiGatewayProjectedMessage[]}
 */
function responsesAssistantMessagesFromStream(streamEvents) {
  let text = ''
  /** @type {string | undefined} */
  let responseId
  /** @type {Map<string, JsonObject>} */
  const toolUsesByCallId = new Map()
  /** @type {AiGatewayProjectedMessage[]} */
  let completedMessages = []
  for (const row of streamEvents) {
    const payload = parseEventData(row.data)
    if (!isPlainObject(payload)) continue
    const type = stringValue(payload.type) ?? stringValue(row.event)
    if (type === 'response.output_text.delta' || type === 'response.output_text.annotation.added') {
      const delta = stringValue(payload.delta)
      if (delta) text += delta
    } else if (type === 'response.output_item.done') {
      const item = isPlainObject(payload.item) ? payload.item : undefined
      if (item) {
        const block = toolUseBlockFromPayload(item)
        if (block) {
          const id = stringValue(block.id)
          if (id && !toolUsesByCallId.has(id)) toolUsesByCallId.set(id, block)
        }
      }
    } else if (type === 'response.completed') {
      const response = isPlainObject(payload.response) ? payload.response : payload
      completedMessages = responsesAssistantMessagesFromBody(response)
      const maybeId = stringValue(payload.id) ?? stringValue(/** @type {Record<string, unknown>} */ (response).id)
      if (maybeId) responseId = maybeId
    } else if (type === 'response.created' && !responseId) {
      const maybeId = stringValue(payload.id) ??
        stringValue(/** @type {Record<string, unknown>} */ (isPlainObject(payload.response) ? payload.response : {}).id)
      if (maybeId) responseId = maybeId
    }
  }
  /** @type {AiGatewayProjectedMessage[]} */
  let messages
  if (completedMessages.length > 0) {
    messages = [...completedMessages]
    /** @type {Set<string>} */
    const seenCallIds = new Set()
    let hasTextMessage = false
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        const blockType = stringValue(block.type)
        if (blockType === 'text') hasTextMessage = true
        if (blockType === 'tool_use') {
          const id = stringValue(block.id)
          if (id) seenCallIds.add(id)
        }
      }
    }
    if (!hasTextMessage && text) {
      messages.unshift({ role: 'assistant', content: [{ type: 'text', text }] })
    }
    for (const block of toolUsesByCallId.values()) {
      const id = stringValue(block.id)
      if (id && !seenCallIds.has(id)) messages.push({ role: 'assistant', content: [block] })
    }
  } else {
    messages = []
    if (text) messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
    for (const block of toolUsesByCallId.values()) messages.push({ role: 'assistant', content: [block] })
  }
  if (messages.length === 0) return []
  if (responseId) {
    for (const msg of messages) msg.raw_frame = { ...msg.raw_frame, response_id: responseId }
  }
  return messages
}

// ---------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------

/**
 * @param {unknown} responseBody
 * @returns {Record<string, unknown> | undefined}
 */
function readOpenAiUsage(responseBody) {
  if (!isPlainObject(responseBody)) return undefined
  const usage = readKey(responseBody, 'usage')
  return isPlainObject(usage) ? usage : undefined
}

/**
 * Pull usage from terminal Responses streaming events. The public
 * Responses API carries usage on `response.completed.response.usage`;
 * ChatGPT Codex has used the same event family while sometimes placing
 * the response fields directly on the payload, so accept both shapes.
 *
 * @param {Array<{ event: string, data: string }>} streamEvents
 * @returns {Record<string, unknown> | undefined}
 */
function readOpenAiUsageFromResponsesStream(streamEvents) {
  /** @type {Record<string, unknown> | undefined} */
  let found
  for (const row of streamEvents) {
    const payload = parseEventData(row.data)
    if (!isPlainObject(payload)) continue
    const type = stringValue(payload.type) ?? stringValue(row.event)
    if (type !== 'response.completed' && type !== 'response.incomplete' && type !== 'response.failed') continue
    const response = isPlainObject(payload.response) ? payload.response : payload
    const usage = readOpenAiUsage(response)
    if (usage) found = usage
  }
  return found
}

/**
 * Normalize OpenAI Chat Completions and Responses usage into the
 * `attributes.usage` shape already used by Claude rows. The provider's
 * usage object is response-scoped, so callers stamp it onto exactly one
 * response assistant message (the LAST one) rather than every fanned-out
 * output item. @ref LLP 0035#one-carrier
 *
 * @param {Record<string, unknown> | undefined} rawUsage
 * @returns {JsonObject | undefined}
 */
function openAiUsageAttributes(rawUsage) {
  if (!isPlainObject(rawUsage)) return undefined
  /** @type {JsonObject} */
  const usage = {}

  // @ref LLP 0035#net-input: OpenAI/Codex report input_tokens INCLUSIVE of
  // cached prompt reads; HypAware stores input_tokens NET of cache so it never
  // double-counts against cache_read_tokens and matches the Claude convention
  // (input + cache_read [+ cache_write] = total prompt). total_tokens stays the
  // provider's raw value, so net_input + cache_read + output == total holds.
  const inputDetails = firstPlainObject(
    readKey(rawUsage, 'input_tokens_details'),
    readKey(rawUsage, 'prompt_tokens_details')
  )
  const cachedInput = inputDetails ? numberValue(inputDetails.cached_tokens) : undefined
  const grossInput = numberValue(rawUsage.input_tokens) ?? numberValue(rawUsage.prompt_tokens)
  if (grossInput !== undefined) {
    usage.input_tokens = cachedInput !== undefined ? Math.max(0, grossInput - cachedInput) : grossInput
  }
  if (cachedInput !== undefined) usage.cache_read_tokens = cachedInput

  copyNumberAlias(rawUsage, usage, 'output_tokens', 'output_tokens')
  copyNumberAlias(rawUsage, usage, 'completion_tokens', 'output_tokens')
  copyNumberAlias(rawUsage, usage, 'total_tokens', 'total_tokens')

  if (inputDetails) {
    copyNumberAlias(inputDetails, usage, 'audio_tokens', 'input_audio_tokens')
  }

  const outputDetails = firstPlainObject(
    readKey(rawUsage, 'output_tokens_details'),
    readKey(rawUsage, 'completion_tokens_details')
  )
  if (outputDetails) {
    copyNumberAlias(outputDetails, usage, 'reasoning_tokens', 'reasoning_tokens')
    copyNumberAlias(outputDetails, usage, 'audio_tokens', 'output_audio_tokens')
    copyNumberAlias(outputDetails, usage, 'accepted_prediction_tokens', 'accepted_prediction_tokens')
    copyNumberAlias(outputDetails, usage, 'rejected_prediction_tokens', 'rejected_prediction_tokens')
  }

  return Object.keys(usage).length === 0 ? undefined : { usage }
}

/**
 * Stamp response-level usage onto the LAST assistant message of the response
 * that carries text or a tool_use (the terminal output item, a tool_use on
 * tool-calling turns, else the final text). One carrier per response keeps a
 * SUM over rows honest, and "last text/tool_use assistant" is the SAME
 * predicate the backfill path applies (`backfill.js#stampUsageOnTurn` →
 * `hasTextOrToolUse`), so live and backfilled rows fold usage onto the same
 * logical row and dedupe to one. Sharing the predicate means the rule no longer
 * rests on the implicit invariant that a live Responses reply never ends in a
 * reasoning-only assistant message. Today it never does (reasoning isn't
 * projected as an assistant message live), and if that ever changed the usage
 * would be dropped rather than mis-attributed, exactly as backfill does.
 * @ref LLP 0035#one-carrier
 *
 * @param {AiGatewayProjectedMessage[]} messages
 * @param {JsonObject | undefined} usageAttributes
 */
function stampUsageOnLastAssistant(messages, usageAttributes) {
  if (!usageAttributes) return
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant' || !hasTextOrToolUse(message)) continue
    message.attributes = mergeJsonObjects(message.attributes, usageAttributes)
    return
  }
}

/**
 * A message is an eligible usage carrier when it has a text or tool_use block.
 * Mirrors `backfill.js#hasTextOrToolUse` so the live and backfill carrier
 * predicates stay identical. @ref LLP 0035#one-carrier
 *
 * @param {AiGatewayProjectedMessage} message
 */
function hasTextOrToolUse(message) {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => {
    const type = isPlainObject(block) ? block.type : undefined
    return type === 'text' || type === 'tool_use'
  })
}

/**
 * @param {unknown[]} values
 * @returns {Record<string, unknown> | undefined}
 */
function firstPlainObject(...values) {
  return values.find(isPlainObject)
}

/**
 * @param {Record<string, unknown>} source
 * @param {JsonObject} target
 * @param {string} sourceKey
 * @param {string} targetKey
 */
function copyNumberAlias(source, target, sourceKey, targetKey) {
  const value = numberValue(source[sourceKey])
  if (value !== undefined) target[targetKey] = value
}

// ---------------------------------------------------------------------
// Codex header + workspace metadata
// ---------------------------------------------------------------------

/**
 * @param {AiGatewayExchangeInput} input
 * @param {string} provider
 * @param {string} path
 */
function resolveCodexContext(input, provider, path, reqBody) {
  if (!isCodexExchange(input, provider, path)) return undefined
  const metadata = readCodexTurnMetadata(input)
  const userAgent = readHeader(input.request_headers, 'user-agent')
  const client = codexClientFromUserAgent(userAgent)
  const workspace = selectCodexWorkspace(
    metadata,
    firstString(readRecordedCwd(reqBody), readStringKey(metadata, 'cwd'))
  )
  const workspaceInfo = workspace?.info
  const remoteUrls = isPlainObject(workspaceInfo?.associated_remote_urls)
    ? workspaceInfo.associated_remote_urls
    : undefined
  const thread_id = firstString(
    readStringKey(metadata, 'thread_id'),
    readHeader(input.request_headers, 'thread-id'),
  )
  const session_id = firstString(
    readStringKey(metadata, 'session_id'),
    readHeader(input.request_headers, 'session-id'),
  )
  const turn_id = readStringKey(metadata, 'turn_id')
  const thread_source = readStringKey(metadata, 'thread_source')
  // Subagent lineage: the parent thread that spawned this one. Codex puts
  // it in the same turn-metadata blob as thread_id (set for subagent
  // turns; absent on the root thread).
  const parent_thread_id = firstString(
    readStringKey(metadata, 'parent_thread_id'),
    readHeader(input.request_headers, 'parent-thread-id'),
  )
  const originator = firstString(
    readHeader(input.request_headers, 'originator'),
    client.entrypoint,
  )
  const sandbox = readStringKey(metadata, 'sandbox')
  const turn_started_at_unix_ms = numberValue(readKey(metadata, 'turn_started_at_unix_ms'))
  const window_id = readHeader(input.request_headers, 'x-codex-window-id')
  // Strip any credential userinfo at ingress, before it reaches the first-class
  // `git_remote` field or the `attributes.codex.git_origin_url` mirror.
  // @ref LLP 0032#remote-redaction
  const git_origin_url = redactRemoteUserinfo(readStringKey(remoteUrls, 'origin'))
  const git_commit = readStringKey(workspaceInfo, 'latest_git_commit_hash')
  const has_changes = typeof workspaceInfo?.has_changes === 'boolean'
    ? workspaceInfo.has_changes
    : undefined

  /** @type {JsonObject} */
  const attributes = {}
  setIfString(attributes, 'thread_id', thread_id)
  setIfString(attributes, 'session_id', session_id)
  setIfString(attributes, 'parent_thread_id', parent_thread_id)
  setIfString(attributes, 'turn_id', turn_id)
  setIfString(attributes, 'thread_source', thread_source)
  setIfString(attributes, 'originator', originator)
  setIfString(attributes, 'window_id', window_id)
  setIfString(attributes, 'sandbox', sandbox)
  if (turn_started_at_unix_ms !== undefined) attributes.turn_started_at_unix_ms = turn_started_at_unix_ms
  setIfString(attributes, 'workspace', workspace?.path)
  setIfString(attributes, 'git_origin_url', git_origin_url)
  setIfString(attributes, 'git_commit', git_commit)
  if (has_changes !== undefined) attributes.has_changes = has_changes

  return {
    thread_id,
    session_id,
    parent_thread_id,
    turn_id,
    thread_source,
    cwd: workspace?.path,
    client_version: client.version,
    entrypoint: originator,
    sandbox,
    // @ref LLP 0032#capture: repo identity for the graph bridge, already in the
    // turn metadata (also kept in attributes.codex.* for provenance). Only
    // git_remote/head_sha are first-class: they feed Repo/Commit convergence and
    // need no repo root. repo_root is deliberately NOT derived from the workspace
    // path. Codex exposes no verified git toplevel, and the workspace may be a
    // repo *subdir*, which would mis-relativize (or collide) File keys. Codex
    // File nodes therefore keep absolute keys in V1. @ref LLP 0032#codex-repo-root
    git_remote: git_origin_url,
    head_sha: git_commit,
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
  }
}

/**
 * @param {AiGatewayExchangeInput} input
 * @param {string} provider
 * @param {string} path
 */
function isCodexExchange(input, provider, path) {
  if (provider === 'chatgpt') return true
  if (isCodexNamespacePath(path)) return true
  if (readHeader(input.request_headers, 'x-codex-turn-metadata')) return true
  if (readHeader(input.request_headers, 'x-codex-window-id')) return true
  const userAgent = readHeader(input.request_headers, 'user-agent')
  return codexClientFromUserAgent(userAgent).entrypoint !== undefined
}

/** @param {AiGatewayExchangeInput} input */
function readCodexTurnMetadata(input) {
  const raw = readHeader(input.request_headers, 'x-codex-turn-metadata')
  const parsed = parseMaybeJson(raw)
  return isPlainObject(parsed) ? parsed : undefined
}

/**
 * @param {string | undefined} userAgent
 * @returns {{ entrypoint?: string, version?: string }}
 */
function codexClientFromUserAgent(userAgent) {
  if (typeof userAgent !== 'string') return {}
  const match = /^([^/]+)\/([^/\s]+)/.exec(userAgent)
  if (!match) return {}
  const product = match[1].trim()
  if (!/^codex(?:\b|[-_\s])/i.test(product)) return {}
  return { entrypoint: product, version: match[2] }
}

/**
 * @param {Record<string, unknown> | undefined} metadata
 * @returns {{ path: string, info?: Record<string, unknown> } | undefined}
 */
function selectCodexWorkspace(metadata, cwd) {
  const workspaces = readKey(metadata, 'workspaces')
  if (!isPlainObject(workspaces)) return undefined
  const workspacePaths = Object.keys(workspaces).filter((key) => key.length > 0)
  const workspacePath = workspacePaths.find((key) => pathsEqual(key, cwd)) ?? workspacePaths[0]
  if (!workspacePath) return undefined
  const info = readKey(workspaces, workspacePath)
  return {
    path: workspacePath,
    info: isPlainObject(info) ? info : undefined,
  }
}

// ---------------------------------------------------------------------
// Conversation, user, model
// ---------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} reqBody
 * @param {AiGatewayExchangeInput} input
 * @param {string} provider
 * @param {string} path
 * @param {ReturnType<typeof resolveCodexContext>} codexContext
 */
function resolveConversationId(reqBody, input, provider, path, codexContext) {
  if (codexContext) {
    const codexConversationId = firstString(
      codexContext.thread_id,
      readHeader(input.request_headers, 'thread-id'),
      readHeader(input.request_headers, 'session-id'),
    )
    if (codexConversationId) return codexConversationId
  }
  const sessionId = readMetadataSessionId(reqBody)
  if (sessionId) return sessionId
  const messages = Array.isArray(reqBody.messages)
    ? reqBody.messages
    : responsesInputMessages(reqBody.input)
  if (messages.length > 0) {
    const first = messages[0]
    const content = isPlainObject(first) ? first.content : undefined
    return sha256Hex(canonicalJson(content)).slice(0, 16)
  }
  const exchangeId = stringValue(input.exchange_id) ?? ''
  return sha256Hex(exchangeId).slice(0, 16)
}

/** @param {Record<string, unknown>} reqBody */
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
  if (provider === 'openai' || provider === 'chatgpt') {
    return stringValue(reqBody.user)
  }
  return undefined
}

/** @param {string} provider */
function resolveConversationSource(provider) {
  if (provider === 'chatgpt') return 'codex'
  return 'api'
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {ReturnType<typeof resolveCodexContext>} codexContext
 */
function resolveRecordedContext(reqBody, codexContext) {
  const cwd = firstString(
    codexContext?.cwd,
    readRecordedCwd(reqBody),
  )
  const meta = readKey(reqBody, 'metadata')
  const userIdMeta = isPlainObject(meta) ? parseMaybeJson(meta.user_id) : undefined
  const git_branch = firstString(
    readStringKey(reqBody, 'git_branch'),
    readStringKey(meta, 'git_branch'),
    readStringKey(userIdMeta, 'git_branch'),
  )
  return {
    cwd,
    git_branch,
    client_version: codexContext?.client_version,
    client_name: codexContext ? 'codex' : undefined,
    entrypoint: codexContext?.entrypoint,
    user_type: codexContext?.thread_source,
    permission_mode: codexContext?.sandbox,
    is_sidechain: codexContext?.thread_source
      ? codexContext.thread_source === 'subagent'
      : undefined,
  }
}

/** @param {Record<string, unknown>} reqBody */
function readRecordedCwd(reqBody) {
  const meta = readKey(reqBody, 'metadata')
  const userIdMeta = isPlainObject(meta) ? parseMaybeJson(meta.user_id) : undefined
  return firstString(
    readStringKey(reqBody, 'cwd'),
    readStringKey(meta, 'cwd'),
    readStringKey(userIdMeta, 'cwd'),
  )
}

/** @param {AiGatewayExchangeInput} input */
function resolveRequestId(input) {
  return readHeader(input.response_headers, 'x-oai-request-id')
    ?? readHeader(input.request_headers, 'x-client-request-id')
}

/**
 * @param {string} candidate
 * @param {string | undefined} wanted
 */
function pathsEqual(candidate, wanted) {
  if (!wanted) return false
  return trimTrailingSlash(candidate) === trimTrailingSlash(wanted)
}

/** @param {string} value */
function trimTrailingSlash(value) {
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

/**
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 */
function resolveModel(reqBody, responseBody) {
  return stringValue(reqBody.model) ?? stringValue(readKey(responseBody, 'model'))
}

/**
 * Accepts the Chat Completions `system` field (string or content blocks)
 * or the Responses API top-level `instructions` string. Codex traffic
 * uses the latter, so without it `system_text` is empty for every
 * Responses-shaped exchange.
 *
 * @param {unknown} system
 */
function extractSystemText(system) {
  if (typeof system === 'string' && system.length > 0) return system
  if (Array.isArray(system)) {
    const parts = system
      .filter(isPlainObject)
      .map((block) => stringValue(block.text))
      .filter((text) => typeof text === 'string')
    if (parts.length > 0) return parts.join('\n')
  }
  return undefined
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * @param {unknown} responseBody
 * @returns {Record<string, unknown> | undefined}
 */
function firstChoice(responseBody) {
  if (!isPlainObject(responseBody) || !Array.isArray(responseBody.choices)) return undefined
  const choice = responseBody.choices.find(isPlainObject)
  return isPlainObject(choice) ? choice : undefined
}

/**
 * Mirror `codex/src/backfill.js` so live-captured tool calls land in the
 * same shape as backfilled ones.
 *
 * @param {Record<string, unknown>} payload
 * @returns {JsonObject | undefined}
 */
function toolUseBlockFromPayload(payload) {
  const name = stringValue(payload.name)
  const callId = stringValue(payload.call_id) ?? stringValue(payload.id)
  if (!name || !callId) return undefined
  const rawArgs = payload.arguments !== undefined ? payload.arguments : payload.input
  return { type: 'tool_use', id: callId, name, input: normalizeToolInput(rawArgs) }
}

/**
 * @param {Record<string, unknown>} payload
 * @returns {JsonObject | undefined}
 */
function toolResultBlockFromPayload(payload) {
  const callId = stringValue(payload.call_id) ?? stringValue(payload.id)
  if (!callId) return undefined
  const text = toolOutputText(payload.output)
  /** @type {JsonObject} */
  const block = { type: 'tool_result', tool_use_id: callId }
  if (text !== undefined) block.content = text
  return block
}

/** @param {unknown} value */
function normalizeToolInput(value) {
  if (typeof value === 'string') {
    const parsed = parseMaybeJson(value)
    return parsed === value ? value : /** @type {any} */ (parsed)
  }
  if (value === undefined) return null
  return /** @type {any} */ (value)
}

/**
 * Codex tool output can arrive as a string, a `{ output | content | text }`
 * wrapper, or a structured payload. Fall back to JSON.stringify so the
 * row keeps a faithful trace.
 *
 * @param {unknown} output
 * @returns {string | undefined}
 */
function toolOutputText(output) {
  if (typeof output === 'string') return output.length > 0 ? output : undefined
  if (isPlainObject(output)) {
    const inner = stringValue(output.output) ?? stringValue(output.content) ?? stringValue(output.text)
    return inner ?? JSON.stringify(output)
  }
  if (output === undefined || output === null) return undefined
  return JSON.stringify(output)
}

/** @param {JsonObject[]} blocks */
function textFromBlocks(blocks) {
  const parts = blocks
    .map((block) => stringValue(block.text))
    .filter((text) => typeof text === 'string')
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** @param {string | null | undefined} headersJson @param {string} name */
function readHeader(headersJson, name) {
  const parsed = parseMaybeJson(headersJson ?? undefined)
  if (!isPlainObject(parsed)) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(parsed)) {
    if (key.toLowerCase() !== wanted) continue
    if (typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value)) {
      const found = value.find((entry) => typeof entry === 'string' && entry.length > 0)
      if (typeof found === 'string') return found
    }
  }
  return undefined
}

/** @param {string} data */
function parseEventData(data) {
  if (typeof data !== 'string' || data.length === 0 || data === '[DONE]') return undefined
  try { return JSON.parse(data) } catch { return undefined }
}

/** @param {unknown} value */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/**
 * @param {JsonObject | undefined} a
 * @param {JsonObject | undefined} b
 * @returns {JsonObject | undefined}
 */
function mergeJsonObjects(a, b) {
  if (!a) return b
  if (!b) return a
  /** @type {JsonObject} */
  const out = { ...a }
  for (const [key, value] of Object.entries(b)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = { ...(/** @type {JsonObject} */ (out[key])), ...value }
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
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

/** @param {unknown} obj @param {string} key */
function readKey(obj, key) {
  if (!isPlainObject(obj)) return undefined
  return obj[key]
}

/** @param {unknown} obj @param {string} key */
function readStringKey(obj, key) {
  const value = readKey(obj, key)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** @param {JsonObject} target @param {string} key @param {string | undefined} value */
function setIfString(target, key, value) {
  if (value !== undefined) target[key] = value
}

/** @param {...(string | undefined)} values */
function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0)
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

/**
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function stripUndefined(obj) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (obj))) {
    if (value !== undefined) out[key] = value
  }
  return /** @type {T} */ (out)
}
