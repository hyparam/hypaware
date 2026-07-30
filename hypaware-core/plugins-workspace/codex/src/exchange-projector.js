// @ts-check

import { isAbsolute } from 'node:path'

import { createUsagePolicyResolver, isEqualOrDescendant, USAGE_POLICY_DROP } from '../../../../src/core/usage-policy/index.js'
import { redactRemoteUserinfo } from './git-remote.js'
import {
  copyNumberAlias,
  firstString,
  mergeJsonObjects,
  netInputUsage,
  numberValue,
  reasoningMessageFromPayload,
  setIfString,
  stampUsageOnLastAssistant,
  textBlocksFromContent,
  toolResultBlockFromPayload,
  toolUseBlockFromPayload,
} from './response-items.js'
import { canonicalJson, isPlainObject, parseMaybeJson, sha256Hex, stringValue } from 'hypaware/core/util'

/**
 * @import { AiGatewayExchangeInput, AiGatewayExchangeProjector, AiGatewayProjectedExchange, AiGatewayProjectedMessage, JsonObject, JsonValue } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { UsagePolicyResolver } from '../../../../src/core/usage-policy/types.js'
 * @import { RolloutCwdResolver } from './types.js'
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
 * @param {{ resolver?: UsagePolicyResolver, rolloutCwd?: RolloutCwdResolver, localOnlyListPath?: string }} [opts]
 * @returns {AiGatewayExchangeProjector}
 */
export function createCodexExchangeProjector(opts = {}) {
  // One `.hypignore` resolver per projector instance (one per started
  // listener): the per-cwd cache then spans the listener's lifetime so the
  // capture hot path adds no unbounded fs work (LLP 0049 R6).
  // @ref LLP 0103 [implements]: the machine-local list is the resolver's second
  // source, so a `--private` (`ignore`) dir drops at capture, not just export.
  const resolver = opts.resolver ?? createUsagePolicyResolver({ localOnlyListPath: opts.localOnlyListPath })
  // @ref LLP 0083 [implements]: the ChatGPT-subscription route carries no
  // in-band cwd, so fall back to the session rollout's session_meta.cwd. Left
  // undefined (no fallback) when the caller does not wire it, e.g. unit tests
  // that don't exercise the rollout path; the plugin wires it in index.js.
  const rolloutCwd = opts.rolloutCwd

  return {
    name: 'codex-exchange',
    priority: 100,

    /** @param {AiGatewayExchangeInput} input */
    match(input) {
      const path = input.path ?? ''
      if (isOpenAiChatPath(path)) return true
      if (isOpenAiResponsesPath(path)) return true
      if (isCodexNamespacePath(path)) return true
      // Any Codex client tags a turn-metadata-carrying request with
      // `x-codex-turn-metadata`, even when the path looks generic, so accept the
      // header as a sufficient match signal. It is NOT a Desktop-only signal.
      // @ref LLP 0151#real-header-names [constrained-by]: every Codex client
      // emits it, so the match is client-independent.
      if (readHeader(input.request_headers, X_CODEX_TURN_METADATA)) return true
      // NOTE this gate deliberately does not consult the body, while
      // `resolveCodexContext` treats a Codex-owned `client_metadata` as a
      // sufficient Codex signal. The two only stay consistent because the path
      // set above covers every route Codex posts to, so a body-only Codex
      // request is always matched here first. A test pins that: see
      // `test/plugins/codex-exchange-projector.test.js` ("every route Codex
      // posts to is matched..."). Widen the path set, do not start reading the
      // body here, if Codex adds a route.
      return false
    },

    /**
     * @param {AiGatewayExchangeInput} input
     * @param {{
     *   log?: {
     *     info?: (m: string, f?: Record<string, unknown>) => void,
     *     warn?: (m: string, f?: Record<string, unknown>) => void,
     *   },
     *   isSessionIgnored?: (sessionId: string) => boolean,
     * }} [ctx]
     */
    project(input, ctx) {
      const reqBody = parseMaybeJson(input.request_body)
      if (!isPlainObject(reqBody)) return undefined

      const path = input.path ?? ''
      const provider = resolveProvider(input, reqBody, path)
      const codexContext = resolveCodexContext(input, provider, path, reqBody)

      // `resolveConversationId` needs nothing from the built messages, so it
      // (and the session id derived from it) is resolved here, ABOVE the cwd
      // check: the session id keys BOTH the rollout cwd fallback below and the
      // session opt-out drop, and both drop checks run before message-shaping.
      const conversationId = resolveConversationId(reqBody, input, provider, path, codexContext)
      // @ref LLP 0030#decision: session_id is the partition key (always
      // non-null): Codex's `metadata.session_id`, falling back to the
      // thread (conversation_id) when no session id was captured. Keep
      // conversation_id = the thread; both can be set for Codex.
      const sessionId = stringValue(codexContext?.session_id) ?? conversationId

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
      // `resolveRecordedContext` stamps on the row.
      //
      // @ref LLP 0083 [implements]: the in-band cwd (Responses `metadata`, the
      // API-key route) is the fast path; only when it is absent (the
      // ChatGPT-subscription route) fall back to the session rollout's
      // session_meta.cwd so `.hypignore` coverage is client-independent and live
      // rows carry the same cwd the codex backfill reads. The `??` keeps the
      // rollout lookup LAZY (a fresh in-band cwd never scans), and it is keyed on
      // the codex session id — only a real Codex session has a rollout — so
      // non-codex traffic never scans.
      const cwd = usableInBandCwd(firstString(codexContext?.cwd, readRecordedCwd(reqBody)), ctx)
        ?? (codexContext?.session_id ? rolloutCwd?.resolve(codexContext.session_id) : undefined)
      // @ref LLP 0083#decision [implements]: a refused workspace substitution is
      // observable, not silent - it means the gate is measuring a directory
      // whose verdict does not imply the discarded key's.
      // @ref LLP 0160#decision [constrained-by]: which is narrower than "a
      // different directory", so this stays rare enough to be worth a `warn`.
      // Paths are hashed: this seam sees LLM traffic.
      if (codexContext?.refused_workspace_cwd) {
        ctx?.log?.warn?.('plugin.codex.usage_policy_workspace_cwd_refused', {
          component: 'codex',
          operation: 'usage_policy_workspace_cwd_refused',
          error_kind: 'workspace_cwd_mismatch',
          workspace_sha256: sha256Hex(codexContext.refused_workspace_cwd).slice(0, 16),
          cwd_sha256: cwd ? sha256Hex(cwd).slice(0, 16) : undefined,
          exchange_id: input.exchange_id,
        })
      }
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

      // @ref LLP 0066#enforcement [implements]: session opt-out drop. Keyed on
      // the stamped session_id (metadata.session_id ?? thread id), the exact
      // value the row would be stamped with (R5). NOTE the documented
      // over-drop (LLP 0066#scope): one Codex session_id contains multiple
      // conversation_id threads, so an ignored session suppresses ALL of
      // them; per-thread grain is a spec non-goal.
      // @ref LLP 0050: second match key, same adapter seam as the .hypignore
      // drop above; either match suppresses (R7), they do not interact.
      if (ctx?.isSessionIgnored?.(sessionId)) {
        ctx?.log?.info?.('plugin.codex.usage_policy_drop', {
          component: 'codex',
          operation: 'usage_policy_drop',
          policy_source: 'session_opt_out',
          session_id: sessionId,
          exchange_id: input.exchange_id,
        })
        return USAGE_POLICY_DROP
      }

      const responseBody = parseMaybeJson(input.response_body)
      const streamEvents = Array.isArray(input.stream_events) ? input.stream_events : []
      const messages = messagesForTransport({ provider, path, reqBody, responseBody, streamEvents })
      if (messages.length === 0) return undefined

      const recordedContext = resolveRecordedContext(reqBody, codexContext, cwd)

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
      : textFromBlocks(textBlocksFromContent(message.content))
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
  const content = textBlocksFromContent(message.content)
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
        input: /** @type {JsonValue} */ (parseMaybeJson(fn.arguments) ?? null),
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
 * Fan items out so each `function_call` / `function_call_output` /
 * `reasoning` becomes its own projected message: the same per-item
 * projection the backfill applies to rollout items (shared via
 * `response-items.js`), so a turn-2 input replay hashes equal to the
 * backfilled session.
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
    if (itemType === 'reasoning') {
      // A replayed reasoning item carries no `role`; without this case it
      // would fall through below and project as a `user` text message,
      // diverging from the backfill's assistant `thinking` shape.
      const msg = reasoningMessageFromPayload(item)
      if (msg) out.push(msg)
      continue
    }
    const role = stringValue(item.role) ?? 'user'
    const blocks = textBlocksFromContent(item.content)
    if (blocks.length === 0) continue
    out.push({ role, content: blocks })
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
      const blocks = textBlocksFromContent(item.content)
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
  // OpenAI input_tokens/prompt_tokens are gross: they include the cached
  // reads reported in *_tokens_details (@ref LLP 0035#net-input,
  // netInputUsage).
  const inputDetails = firstPlainObject(
    readKey(rawUsage, 'input_tokens_details'),
    readKey(rawUsage, 'prompt_tokens_details')
  )
  const usage = netInputUsage(
    numberValue(rawUsage.input_tokens) ?? numberValue(rawUsage.prompt_tokens),
    inputDetails ? numberValue(inputDetails.cached_tokens) : undefined
  )

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
 * @param {unknown[]} values
 * @returns {Record<string, unknown> | undefined}
 */
function firstPlainObject(...values) {
  return values.find(isPlainObject)
}

// ---------------------------------------------------------------------
// Codex header + workspace metadata
// ---------------------------------------------------------------------

// The Codex-owned request headers this file may read. `compatibility_headers` in
// `codex-rs/core/src/responses_metadata.rs` builds exactly four names
// (`x-codex-window-id`, `x-codex-turn-metadata`, `x-codex-parent-thread-id`,
// `x-openai-subagent`), and `readHeader` matches a full name, so any other
// spelling can never match. The other names read in this file (`originator`,
// `user-agent`, `x-client-request-id`, and the response's `x-oai-request-id`)
// are real too, from the shared default client and `codex-api`.
// @ref LLP 0151#real-header-names [constrained-by]: named constants so a
// fictional header name cannot be reintroduced by a typo.
const X_CODEX_TURN_METADATA = 'x-codex-turn-metadata'
const X_CODEX_WINDOW_ID = 'x-codex-window-id'
const X_CODEX_PARENT_THREAD_ID = 'x-codex-parent-thread-id'

/**
 * @param {AiGatewayExchangeInput} input
 * @param {string} provider
 * @param {string} path
 * @param {Record<string, unknown>} reqBody
 */
function resolveCodexContext(input, provider, path, reqBody) {
  // @ref LLP 0151#body-is-a-codex-signal [implements]: a Codex-owned body map
  // identifies the exchange on its own, so the API-key route's generic
  // `/v1/responses` resolves with no Codex header at all. The transport signal is
  // resolved first because it is also what corroborates the body's ambiguous
  // flat identity pair (see `readCodexClientMetadata`).
  const transportIsCodex = hasCodexTransportSignal(input, provider, path)
  // @ref LLP 0151#body-is-authority [implements]: the flat body map first, the
  // turn-metadata blob second. Both are projections of one Codex snapshot, so
  // they agree whenever both are present; the body is preferred because it is
  // the only one present for every request kind.
  const clientMetadata = readCodexClientMetadata(reqBody, transportIsCodex)
  if (!transportIsCodex && clientMetadata === undefined) return undefined
  const metadata = readCodexTurnMetadata(input, clientMetadata)
  const userAgent = readHeader(input.request_headers, 'user-agent')
  const client = codexClientFromUserAgent(userAgent)
  const inBandCwd = firstString(readRecordedCwd(reqBody), readStringKey(metadata, 'cwd'))
  const workspace = selectCodexWorkspace(metadata, inBandCwd)
  const workspaceInfo = workspace?.info
  const remoteUrls = isPlainObject(workspaceInfo?.associated_remote_urls)
    ? workspaceInfo.associated_remote_urls
    : undefined
  const thread_id = firstString(
    readStringKey(clientMetadata, 'thread_id'),
    readStringKey(metadata, 'thread_id'),
  )
  const session_id = firstString(
    readStringKey(clientMetadata, 'session_id'),
    readStringKey(metadata, 'session_id'),
  )
  const turn_id = firstString(
    readStringKey(clientMetadata, 'turn_id'),
    readStringKey(metadata, 'turn_id'),
  )
  const thread_source = readStringKey(metadata, 'thread_source')
  // Subagent lineage: the parent thread that spawned this one. Set for subagent
  // turns, absent on a root thread. Codex projects it onto all three surfaces
  // under two different spellings: `x-codex-parent-thread-id` in the body map
  // and as a header, `parent_thread_id` inside the turn-metadata blob.
  const parent_thread_id = firstString(
    readStringKey(clientMetadata, X_CODEX_PARENT_THREAD_ID),
    readStringKey(metadata, 'parent_thread_id'),
    readHeader(input.request_headers, X_CODEX_PARENT_THREAD_ID),
  )
  const originator = firstString(
    readHeader(input.request_headers, 'originator'),
    client.entrypoint,
  )
  const sandbox = readStringKey(metadata, 'sandbox')
  const turn_started_at_unix_ms = numberValue(readKey(metadata, 'turn_started_at_unix_ms'))
  const window_id = firstString(
    readHeader(input.request_headers, X_CODEX_WINDOW_ID),
    readStringKey(clientMetadata, X_CODEX_WINDOW_ID),
  )
  // Which surface stated the identity this row is keyed on. Recorded so a
  // future Codex version that stops sending one of them is visible in a query
  // instead of showing up as a silent drift in `conversation_id`.
  // @ref LLP 0151#lineage-source [implements]: make version drift queryable.
  const lineage_source = lineageSource(clientMetadata, metadata)
  // The precedence above trusts the two surfaces to agree. Nothing here can
  // verify that, so when they do not, say so on the row.
  // @ref LLP 0151#lineage-conflict [implements]: the tie-break leaves evidence.
  const lineage_conflict = lineageConflict(clientMetadata, metadata)
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
  setIfString(attributes, 'lineage_source', lineage_source)
  setIfString(attributes, 'lineage_conflict', lineage_conflict)
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
    // @ref LLP 0083#decision [implements]: an explicit in-band cwd outranks the
    // workspace key for the ONE resolved cwd (gate + stamp). `selectCodexWorkspace`
    // substitutes the first `workspaces` key when none matches, which is a guess
    // about a directory the session may never have run in, so it must not decide
    // a `.hypignore` verdict. The key still enriches (`attributes.codex.workspace`,
    // git_*) and still supplies the cwd on the subscription route, where the
    // request states none and the key is the only in-band source there is.
    cwd: firstString(inBandCwd, workspace?.path),
    // Set only when the substitution was refused, so the caller can log it
    // rather than let a discarded guess vanish. Refused is narrower than
    // "different bytes": see `workspaceCoversCwd`.
    // @ref LLP 0160#decision [implements]: an ancestor key was never a guess.
    refused_workspace_cwd: workspace && inBandCwd && !workspaceCoversCwd(workspace.path, inBandCwd)
      ? workspace.path
      : undefined,
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
 * Whether the transport alone identifies this exchange as Codex, before any part
 * of the request body is consulted: the ChatGPT upstream, the Codex route
 * namespace, a Codex-namespaced compatibility header, or a Codex user-agent
 * product. Every one of these is a name only a Codex client produces.
 *
 * Kept separate from the body signal because it is also what corroborates a
 * `client_metadata` map carrying no Codex-owned key of its own.
 * @ref LLP 0151#body-is-a-codex-signal [implements]
 *
 * @param {AiGatewayExchangeInput} input
 * @param {string} provider
 * @param {string} path
 */
function hasCodexTransportSignal(input, provider, path) {
  if (provider === 'chatgpt') return true
  if (isCodexNamespacePath(path)) return true
  if (readHeader(input.request_headers, X_CODEX_TURN_METADATA)) return true
  if (readHeader(input.request_headers, X_CODEX_WINDOW_ID)) return true
  const userAgent = readHeader(input.request_headers, 'user-agent')
  return codexClientFromUserAgent(userAgent).entrypoint !== undefined
}

/**
 * The request body's flat `client_metadata` map: the surface Codex fills for
 * every Responses request kind, so the one lineage surface always present.
 *
 * Declines a map carrying no Codex-owned key, so a `client_metadata` an
 * unrelated client happens to send cannot masquerade as Codex lineage. An
 * `x-codex-` prefixed key is Codex-exclusive and is accepted on its own; Codex
 * writes `x-codex-installation-id` and `x-codex-window-id` into this map on
 * every request, so that branch alone covers every request real Codex makes.
 *
 * The flat `session_id` + `thread_id` pair is NOT Codex-exclusive: those are
 * ordinary names any agent framework may put in a `client_metadata` map, and the
 * matched path set includes the generic `/v1/responses` and
 * `/v1/chat/completions`. Honouring the pair on its own would therefore let an
 * unrelated client be stamped `client_name: 'codex'` and dictate this row's
 * `conversation_id` and `session_id`, which is the same defect class as the
 * fictional `thread-id` header this document removed, only through the body. So
 * the pair is trusted only once `corroborated` says the transport already
 * identified the exchange as Codex, where it adds lineage detail to a client
 * that is already known rather than naming the client.
 * @ref LLP 0151#body-is-authority: the always-present lineage surface.
 * @ref LLP 0151#body-is-a-codex-signal [constrained-by]: which keys of the map
 * are evidence of Codex, and which only carry detail.
 *
 * @param {unknown} reqBody
 * @param {boolean} corroborated Whether the transport (upstream, route, Codex
 *   header, or Codex user-agent) already identified this exchange as Codex.
 * @returns {Record<string, unknown> | undefined}
 */
function readCodexClientMetadata(reqBody, corroborated) {
  const clientMetadata = readKey(reqBody, 'client_metadata')
  if (!isPlainObject(clientMetadata)) return undefined
  const hasCodexKey = Object.keys(clientMetadata)
    .some((key) => key.toLowerCase().startsWith('x-codex-'))
  if (hasCodexKey) return clientMetadata
  if (!corroborated) return undefined
  const hasFlatIdentity = readStringKey(clientMetadata, 'thread_id') !== undefined &&
    readStringKey(clientMetadata, 'session_id') !== undefined
  return hasFlatIdentity ? clientMetadata : undefined
}

/**
 * The turn-metadata blob. Codex transports it twice per HTTP request: as the
 * `x-codex-turn-metadata` header, and as the same-named string entry of the
 * body's `client_metadata` map. The header is read first so already-recorded
 * rows keep their exact identity (@ref LLP 0151#row-identity); the body entry
 * is the fallback for a hop that dropped the header. Absent entirely for
 * request kinds Codex marks as carrying no turn metadata, which is why the flat
 * body keys, not this blob, are the lineage authority.
 *
 * @param {AiGatewayExchangeInput} input
 * @param {Record<string, unknown> | undefined} clientMetadata
 */
function readCodexTurnMetadata(input, clientMetadata) {
  const raw = readHeader(input.request_headers, X_CODEX_TURN_METADATA)
    ?? readStringKey(clientMetadata, X_CODEX_TURN_METADATA)
  const parsed = parseMaybeJson(raw)
  return isPlainObject(parsed) ? parsed : undefined
}

// The lineage fields that both surfaces carry, as each surface spells them: the
// flat body-map key first, the turn-metadata blob key second.
const LINEAGE_SPELLINGS = [
  ['thread_id', 'thread_id'],
  ['session_id', 'session_id'],
  ['turn_id', 'turn_id'],
  [X_CODEX_PARENT_THREAD_ID, 'parent_thread_id'],
]

/**
 * Name the surface that stated this row's identity, or `undefined` when no
 * surface did (the row then keeps the gateway's content-hash fallback).
 *
 * The checks walk `thread_id` before `session_id` and body before blob, which is
 * the same order the values above resolve in, so the recorded name is the
 * surface the identity actually came from. Answering from "did the body state
 * anything at all" would mislabel a turn whose `thread_id` (what
 * `conversation_id` keys on) came from the blob while only its `session_id` came
 * from the body.
 *
 * @param {Record<string, unknown> | undefined} clientMetadata
 * @param {Record<string, unknown> | undefined} metadata
 * @returns {'body_client_metadata' | 'turn_metadata' | undefined}
 */
function lineageSource(clientMetadata, metadata) {
  for (const key of ['thread_id', 'session_id']) {
    if (readStringKey(clientMetadata, key) !== undefined) return 'body_client_metadata'
    if (readStringKey(metadata, key) !== undefined) return 'turn_metadata'
  }
  return undefined
}

/**
 * Name every lineage field the two surfaces state differently, comma-joined in
 * turn-metadata spelling, or `undefined` when they agree or only one spoke.
 *
 * The precedence rests on Codex projecting one metadata snapshot onto both
 * surfaces, so that a body value and a blob value for the same field are always
 * equal. That is a claim about another program's internals which this code
 * cannot check, and the body-wins tie-break would otherwise discard the
 * counter-evidence without trace. Recording it makes a Codex version that began
 * filling the two surfaces from different state a queryable fact rather than a
 * silent preference. The row still keys on the body, so this adds a signal and
 * changes no identity.
 * @ref LLP 0151#lineage-conflict [implements]: an unverifiable agreement
 * assumption gets a recorded signal.
 *
 * @param {Record<string, unknown> | undefined} clientMetadata
 * @param {Record<string, unknown> | undefined} metadata
 * @returns {string | undefined}
 */
function lineageConflict(clientMetadata, metadata) {
  const disagreed = LINEAGE_SPELLINGS
    .filter(([bodyKey, blobKey]) => {
      const fromBody = readStringKey(clientMetadata, bodyKey)
      const fromBlob = readStringKey(metadata, blobKey)
      return fromBody !== undefined && fromBlob !== undefined && fromBody !== fromBlob
    })
    .map(([, blobKey]) => blobKey)
  return disagreed.length > 0 ? disagreed.join(',') : undefined
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
  // @ref LLP 0151#real-header-names [implements]: the thread comes from the
  // context's own resolution (body map, then turn-metadata blob) and nowhere
  // else. The `thread-id` / `session-id` header names that used to be consulted
  // here are names Codex never emits, so they could only ever have let a
  // non-Codex hop dictate this row's identity.
  if (codexContext?.thread_id) return codexContext.thread_id
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
 * @param {string | undefined} cwd The cwd the caller already resolved (in-band
 *   fast path, else the rollout fallback). Passed in — not recomputed — so the
 *   row's stamped cwd is exactly the value the `.hypignore` check used, and so
 *   the subscription route records the rollout cwd instead of NULL.
 *   @ref LLP 0083 [implements]
 */
function resolveRecordedContext(reqBody, codexContext, cwd) {
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

/**
 * The in-band cwd, or `undefined` when what the client sent is not a directory
 * this process can find. A `cwd` is not merely a non-empty string here: it is
 * the input to the `.hypignore` gate, whose first act is `path.resolve(cwd)`
 * (`src/core/usage-policy/matcher.js`). For a relative value that silently
 * supplies the **daemon's** process cwd as the base, so a session that said
 * `sub` gets a confident verdict governed by whatever sits under wherever the
 * daemon was started. Nothing in the request says what the value is relative to,
 * so the base would have to be guessed, and guessing is wrong in both directions
 * at once: it can drop a session no `.hypignore` covers, and it can record a
 * session whose real directory *is* ignored, because the verdict was computed
 * for some other directory entirely. It also stamps that bogus value on the row.
 *
 * Refusing costs the ordinary "no cwd" fail-open: the caller's `if (cwd)` skips
 * the check and the row records `cwd = NULL` (LLP 0049 R1 as extended by
 * LLP 0085), a state the system already models. It does NOT make this path fail
 * closed; whether an unconfirmable cwd should drop is a separate, larger call.
 *
 * That fail-open is not free, so state the one case it costs: when the daemon's
 * own process cwd sits under an ignoring `.hypignore` (a foreground start from a
 * project dir, or a `--user` unit that renders no `WorkingDirectory=` and so
 * inherits `$HOME`), guessing happened to reach the right verdict, and refusing
 * now records where accepting dropped. It was still a guess - the same base also
 * produced false drops for every session that ran elsewhere - so refusing is the
 * right call, but it is a real narrowing of coverage, not a strict improvement.
 * A drop that only holds while the daemon runs from the right directory is what
 * fail-closed would have to replace, and that is the larger call above.
 *
 * The same two checks guard the rollout-stated cwd as `sessionMetaCwd`
 * (`src/core/codex/rollout_session_meta.js`, LLP 0150 `#usable-cwd`). They are
 * restated here rather than borrowed from there: LLP 0150 scopes the in-band path
 * out of its own mandate (in-band is a separate source, and its value is also
 * stamped on the row), and the `error_kind` split below needs the two conjuncts
 * apart, which that predicate's single answer does not give.
 *
 * One thing this does NOT reach, so nobody reads it as the whole gate: when the
 * request states no `cwd` at all, the value passed in is the workspace key
 * `selectCodexWorkspace` picked for it, and that falls back to the first
 * workspace when none matches, which is absolute and so accepted here even when
 * the session ran elsewhere. A request that DOES state one no longer reaches
 * here through the key (#476, closed), so the residue is the narrower ranking
 * question: the key still outranks the rollout fallback (#480). The rollout
 * fallback at the call site sits outside this call, but it is not unguarded:
 * `rollout-cwd.js` reads it through `readRolloutSessionMeta`, which applies
 * `sessionMetaCwd`.
 * @ref LLP 0160#corrections-0083 [constrained-by]: LLP 0083's own statement of
 * this limit predates its amendment landing, so read that correction with it.
 *
 * @ref LLP 0083#decision [implements]: an unusable in-band cwd counts as a miss,
 * so the rollout fallback still gets its turn
 * @param {string | undefined} cwd
 * @param {{
 *   log?: {
 *     info?: (m: string, f?: Record<string, unknown>) => void,
 *     warn?: (m: string, f?: Record<string, unknown>) => void,
 *   },
 * }} [ctx]
 * @returns {string | undefined}
 */
function usableInBandCwd(cwd, ctx) {
  if (cwd === undefined) return undefined
  // Byte-identical when it passes: the trim is only the emptiness test, and a
  // path is not ours to normalize. The trim gates nothing on its own - a blank
  // string is never absolute on either platform, so `isAbsolute` already refuses
  // it - it is here to split `error_kind` below, which is the only thing that
  // tells blank apart from relative. Keep both conjuncts or that split dies.
  if (cwd.trim().length > 0 && isAbsolute(cwd)) return cwd
  // Never silently: a refused cwd means this exchange reached the gate with
  // nothing to match, which is indistinguishable from "no cwd at all" in the
  // row. Hash it - a cwd is user data (LLP 0049), and the drop log above uses
  // the same digest so the two are correlatable.
  // One gap, deliberate: a `cwd` of exactly `''` never arrives, because
  // `readStringKey` and `firstString` both require a non-empty string, so it is
  // refused upstream with no log. Same outcome (absent cwd, NULL column, and it
  // was already absent before this predicate existed), no diagnostic. Closing it
  // means loosening a helper with 16 other callers here, which is not worth it.
  ctx?.log?.warn?.('plugin.codex.usage_policy_cwd_unusable', {
    component: 'codex',
    operation: 'usage_policy_cwd',
    status: 'refused',
    error_kind: cwd.trim().length === 0 ? 'cwd_blank' : 'cwd_not_absolute',
    cwd_sha256: sha256Hex(cwd).slice(0, 16),
  })
  return undefined
}

/** @param {AiGatewayExchangeInput} input */
function resolveRequestId(input) {
  return readHeader(input.response_headers, 'x-oai-request-id')
    ?? readHeader(input.request_headers, 'x-client-request-id')
}

/**
 * Whether the selected `workspaces` key is the directory the session ran in or
 * an ancestor of it, i.e. whether refusing the substitution can have changed the
 * `.hypignore` verdict at all.
 *
 * This is the predicate behind `refused_workspace_cwd`, and it is deliberately
 * not byte-equality. When the key is an ancestor of the in-band `cwd`, the
 * `cwd`'s ancestor walk passes through the key and every machine-local entry
 * that governs the key also governs the `cwd`, so resolving the `cwd` is
 * *at least as restrictive* as resolving the key would have been: the refusal
 * can only tighten, never loosen, and there is nothing to report. A session
 * running in a subdirectory of its declared workspace is exactly that shape, and
 * it is the commonest Codex shape there is, so reporting it warned once per turn
 * on the common case and devalued the privacy warns beside it (#481). Off the
 * ancestor chain the two walks are incomparable - a sibling tree, or a key
 * *below* the `cwd`, whose own walk covers strictly more - and that is the guess
 * about a directory the session never ran in that the signal exists for.
 *
 * Trailing slashes are trimmed on both sides, the one normalization the old
 * byte comparison did; a path is not otherwise ours to normalize, and the
 * spelling-agnostic predicates next door (`scopeGoverns`) buy their extra reach
 * with `realpath` syscalls this per-exchange seam must not spend (LLP 0049 R6).
 * The cost is that a symlinked spelling of the same tree still reads as a
 * refusal, which is the status quo and errs toward reporting.
 *
 * @ref LLP 0069#requirements [implements]: R8, the one shared equal-or-descendant
 * test, never a second copy of the path rule
 * @ref LLP 0160#decision [implements]: the refusal signal reports a discarded
 * guess, not a spelling difference
 * @param {string} workspacePath
 * @param {string} cwd
 * @returns {boolean}
 */
function workspaceCoversCwd(workspacePath, cwd) {
  return isEqualOrDescendant(trimTrailingSlash(cwd), trimTrailingSlash(workspacePath))
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
