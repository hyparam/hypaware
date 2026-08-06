// @ts-check

import { isPlainObject, parseMaybeJson, sha256Hex, stringValue } from 'hypaware/core/util'

import { wireMatchKey } from './match_key.js'

/**
 * @import { AiGatewayExchangeProjector, AiGatewayProjectedExchange, AiGatewayProjectedMessage, AiGatewayUpstreamPreset, JsonObject } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * OpenClaw exchange projector: a minimal, self-contained parser for the
 * two API shapes OpenClaw's steered traffic can carry, Anthropic
 * Messages and OpenAI Chat Completions (plugins never import each
 * other, so neither the Claude plugin's Anthropic parsing nor the Codex
 * plugin's OpenAI parsing is reused). Deliberately lean; v1 skips:
 *
 *  - per-content-block message decomposition (messages project whole;
 *    the gateway computes fallback hash identity for every row),
 *  - native transcript/DAG identity and cwd/git enrichment (OpenClaw
 *    forwards no cwd channel, so there is no `.hypignore` capture-seam
 *    resolution either),
 *  - native session identity (no session id header; see session hash
 *    below).
 */

const CLIENT_NAME = 'openclaw'
const CLIENT_HEADER = 'x-hypaware-client'

/**
 * Written into `openclaw.json`'s `models.providers` entry by this adapter's
 * own `attach()` (the config-override write, not a shadow-provider steer),
 * as a static `headers` field on the provider OpenClaw itself calls with no
 * further plugin involved. Names the real upstream provider (`'anthropic'`
 * or `'openai'`), never a `hypaware-*` shadow id, so the gateway's upstream
 * presets know which static `base_url` to forward to regardless of which
 * path the request happened to hit. The header has two independent readers
 * here, the presets' `match()` and this projector's `project()`, and both
 * tolerate its absence.
 *
 * @ref LLP 0167#override-entries [implements]: the one wire contract attach's config write and this adapter agree on byte-for-byte
 */
const UPSTREAM_HEADER = 'x-hypaware-upstream'

/**
 * The provider a request that never went through the steering plugin
 * projects as. Anthropic Messages is the only shape the OpenClaw adapter
 * spoke before the steering plugin existed, so it is also the shape the
 * parse branch defaults to.
 */
const DEFAULT_PROVIDER = 'anthropic'

/** The one `x-hypaware-upstream` value that selects the OpenAI parse. */
const OPENAI_PROVIDER = 'openai'

/**
 * How much of the system prompt feeds the session hash. The head is
 * stable across the turns of one OpenClaw agent conversation while the
 * tail can grow with injected context, so a bounded prefix keys the
 * session without hashing the whole prompt on every exchange.
 */
const SESSION_HASH_HEAD_CHARS = 256

/**
 * Build the OpenClaw exchange projector.
 *
 * `match()` keys on the `x-hypaware-client: openclaw` request header
 * that the attach-injected provider adds to every request, so matching
 * is deterministic (no user-agent sniffing). Priority sits above the
 * Claude projector's 100: OpenClaw traffic shares the `/v1/messages`
 * path and Anthropic header signature, so without the higher priority
 * the Claude projector would claim (and misattribute) these exchanges.
 *
 * `project()` is shape-aware where `match()` is not: one projector with
 * an internal branch, rather than two projectors behind the same header
 * gate, because session identity, the fallback-id chain, and the match
 * gate itself are identical across shapes and only the wire parse
 * differs.
 *
 * @ref LLP 0109#gateway-capture [implements]: header-gated projector with priority above the Claude projector
 * @ref LLP 0161#projector-shape [implements]: one projector, internal shape dispatch on `x-hypaware-upstream`
 * @returns {AiGatewayExchangeProjector}
 */
export function createOpenclawExchangeProjector() {
  return {
    name: 'openclaw',
    priority: 110,
    match(input) {
      const headers = parseHeaders(input.request_headers)
      return headerValue(headers, CLIENT_HEADER) === CLIENT_NAME
    },
    project(input, ctx) {
      const reqBody = parseMaybeJson(input.request_body)
      if (!isPlainObject(reqBody)) {
        ctx.log.warn('plugin.openclaw.projector_skip', {
          reason: 'unparseable_request_body',
          exchange_id: input.exchange_id,
        })
        return undefined
      }

      // @ref LLP 0161#projector-shape [implements]: the header picks both
      // the parse branch and the recorded provider; absent, both fall back
      // to Anthropic, so traffic that never reached the steering plugin
      // still projects instead of being dropped.
      const provider = headerValue(parseHeaders(input.request_headers), UPSTREAM_HEADER) ?? DEFAULT_PROVIDER
      // Only the exact `openai` value selects the OpenAI parse. An
      // unrecognized provider name is still recorded verbatim (R6: the row
      // says what the traffic really was) while its body is read as
      // Anthropic Messages, the shape this adapter has always spoken.
      const openaiShape = provider === OPENAI_PROVIDER

      const responseBody = parseMaybeJson(input.response_body)
      const streamEvents = Array.isArray(input.stream_events) ? input.stream_events : []
      // The OpenAI provider speaks two wire dialects. OpenClaw's own client
      // uses the Responses API (`/v1/responses`) for every model that
      // supports it, and falls back to Chat Completions only when told to;
      // both route through the same overlay baseUrl, so the shape has to be
      // detected per exchange, not per provider (LLP 0176).
      const responsesShape = openaiShape && isOpenaiResponsesExchange(input.path, reqBody, responseBody)
      const messages = responsesShape
        ? openaiResponsesMessages(reqBody, responseBody, streamEvents)
        : openaiShape
          ? openaiMessages(reqBody, responseBody, streamEvents)
          : anthropicMessages(reqBody, responseBody, streamEvents)
      if (messages.length === 0) {
        ctx.log.debug?.('plugin.openclaw.projector_skip', {
          reason: 'no_messages_in_exchange',
          exchange_id: input.exchange_id,
        })
        return undefined
      }

      const systemText = responsesShape
        ? openaiResponsesSystemText(reqBody)
        : openaiShape
          ? openaiSystemText(reqBody)
          : extractSystemText(reqBody.system)
      /** @type {AiGatewayProjectedMessage[]} */
      const projectedMessages = []
      for (const message of messages) {
        const role = stringValue(message.role)
        if (!role) continue
        /** @type {AiGatewayProjectedMessage} */
        const projected = { role, content: /** @type {any} */ (message.content) }
        const usage = usageAttributes(message)
        if (usage) projected.attributes = usage
        const stopReason = stringValue(message.stop_reason)
        if (stopReason) projected.stop_reason = stopReason
        projectedMessages.push(projected)
      }
      if (projectedMessages.length === 0) return undefined

      // Every OpenClaw row is a fallback-identity row (this projector
      // supplies no `message_id`; the gateway hashes one), so every row
      // carries the LLP 0159 match key the settlement enricher looks up
      // once the session line lands on disk. The `message_id` guard keeps
      // the rule true, not merely true today, if a future branch ever
      // supplies native identity here.
      //
      // @ref LLP 0157#requirements [implements]: R8, stamp the LLP 0159
      // match key on every fallback-identity row
      for (const projected of projectedMessages) {
        if (projected.message_id) continue
        projected.attributes = mergeAttributes(projected.attributes, {
          openclaw: { match_key: wireMatchKey(projected.role, projected.content) },
        })
      }

      /** @type {AiGatewayProjectedExchange} */
      const projection = {
        // @ref LLP 0157#requirements [implements]: R6, the row records the
        // true upstream, never the `hypaware-*` shadow the client resolved.
        provider,
        // @ref LLP 0109#gateway-capture [implements]: OpenClaw forwards no
        // session id, so v1 keys the session on a stable hash of the
        // system-prompt head; message ids stay unset so the gateway's
        // hash-fallback convention supplies identity.
        session_id: openclawSessionId(reqBody, systemText, input.exchange_id),
        conversation_source: CLIENT_NAME,
        client_name: CLIENT_NAME,
        messages: projectedMessages,
      }
      const model = stringValue(reqBody.model) ??
        (isPlainObject(responseBody) ? stringValue(responseBody.model) : undefined)
      if (model) projection.model = model
      if (systemText) projection.system_text = systemText
      if (reqBody.tools !== undefined) projection.tools = /** @type {any} */ (reqBody.tools)
      if (typeof input.duration_ms === 'number') {
        projection.attributes = { timing: { latency_ms: input.duration_ms } }
      }
      if (input.ts_start) projection.conversation_started_at = input.ts_start

      return projection
    },
  }
}

/**
 * The Anthropic upstream preset, registered by this plugin so an
 * OpenClaw-only install (no Claude plugin active) still routes
 * `/v1/messages` upstream. Same `anthropic` name, base URL, path prefix
 * and priority as the Claude plugin's `anthropicUpstreamPreset()`.
 *
 * KNOWN DIVERGENCE: the `x-hypaware-upstream` rung below exists only on
 * this copy. `registerUpstreamPreset` is a name-keyed last-write-wins
 * `Map.set`, so on an install where `@hypaware/claude` activates after
 * this plugin, the Claude copy wins the slot and the rung is silently
 * dropped. Harmless for Anthropic specifically (a steered
 * `anthropic-messages` turn still matches on the `/v1/messages` path,
 * which is what routed OpenClaw before the header existed), but see
 * {@link openaiUpstreamPreset}, where the same divergence is not
 * harmless.
 *
 * @ref LLP 0109#gateway-capture [constrained-by]: the preset is identical and the name must stay `anthropic` (LLP 0016)
 * @ref LLP 0161#upstream-presets [implements]: the x-hypaware-upstream precedence rung sits above the existing path/header checks
 * @returns {AiGatewayUpstreamPreset}
 */
export function anthropicUpstreamPreset() {
  return {
    name: 'anthropic',
    base_url: 'https://api.anthropic.com',
    provider: 'anthropic',
    path_prefix: '/v1/messages',
    priority: 100,
    match(input) {
      if (steersTo(input.headers, 'anthropic')) return true
      if (isAnthropicPath(input.path)) return true
      return hasAnthropicHeaderSignature(input.headers)
    },
  }
}

/**
 * The OpenAI upstream preset, registered by this plugin so an
 * OpenClaw-only install (no Codex plugin active) still routes OpenAI
 * Chat Completions-shaped traffic upstream once the steering plugin
 * starts sending it. `name`, `base_url`, `provider` and `path_prefix`
 * match `@hypaware/codex`'s existing `openai` registration, so it points
 * at the same real endpoint.
 *
 * NO `priority`. It deliberately compiles at the default 0, the same
 * rung as a TOML-config upstream. `match()` falls through to
 * {@link isOpenaiPath}, which is the whole `/v1` tree, so it also
 * answers `/v1/messages`; at `priority: 100` it sorted above a
 * configured `anthropic` and swallowed Claude traffic, sending the
 * prompts and their `x-api-key` / `Bearer sk-ant-` credentials to
 * `api.openai.com`. At 0 the prefix-length tiebreak puts the narrower
 * `/v1/messages` first and the steering header still reaches this
 * preset on the bare-origin `/chat/completions` path.
 *
 * KNOWN DIVERGENCE: Codex's registration declares no `match()`, so this
 * copy is NOT interchangeable with it, and `registerUpstreamPreset`'s
 * name-keyed last-write-wins `Map.set` makes which one survives an
 * activation-order accident. When Codex's wins, the
 * `x-hypaware-upstream` rung is gone and a steered `openai-completions`
 * turn (whose shadow `baseUrl` is the bare gateway origin, so its path
 * is `/chat/completions`, not `/v1/chat/completions`) matches no
 * upstream at all. Closing that needs the rung on Codex's registration
 * too, a change to Codex's routing that is not made here.
 *
 * @ref LLP 0161#upstream-presets [implements]: openai preset registration, byte-identical in shape to @hypaware/codex's, plus the x-hypaware-upstream precedence rung
 * @returns {AiGatewayUpstreamPreset}
 */
export function openaiUpstreamPreset() {
  return {
    name: 'openai',
    base_url: 'https://api.openai.com',
    provider: 'openai',
    path_prefix: '/v1',
    match(input) {
      if (steersTo(input.headers, 'openai')) return true
      return isOpenaiPath(input.path)
    },
  }
}

/**
 * Unconditional match when the steering plugin's `x-hypaware-upstream`
 * header names this preset's provider: lets steered OpenClaw traffic
 * route correctly even on a path or header signature shared with
 * another adapter (e.g. Claude's `/v1/messages`), without changing how
 * Claude/Codex traffic (which never sends this header) is routed today.
 *
 * @param {Record<string, string | string[] | undefined> | undefined} headers
 * @param {string} provider
 */
function steersTo(headers, provider) {
  return headerValue(headers, UPSTREAM_HEADER) === provider
}

/** @param {string} path */
export function isAnthropicPath(path) {
  return path === '/v1/messages' || path.startsWith('/v1/messages/')
}

/** @param {string} path */
export function isOpenaiPath(path) {
  return path === '/v1' || path.startsWith('/v1/')
}

/**
 * @param {Record<string, string | string[] | undefined> | undefined} headers
 */
export function hasAnthropicHeaderSignature(headers) {
  if (!headers) return false
  if (headerValue(headers, 'anthropic-version') !== undefined) return true
  if (headerValue(headers, 'x-api-key') !== undefined) return true
  const auth = headerValue(headers, 'authorization')
  if (typeof auth === 'string' && /^Bearer\s+sk-ant-/i.test(auth)) return true
  return false
}

/**
 * Stable session key: the 16-hex-char SHA-256 prefix (the gateway's
 * hash-id convention) of the system-prompt head; without a system
 * prompt, of the first message's content (`messages` on the chat wires,
 * `input` on the Responses wire, which never carries `messages`); without
 * either, of the exchange id, so the partition key is never null. The
 * `input` branch exists so an instruction-less Responses request still
 * groups by conversation instead of fragmenting into a per-exchange
 * session id.
 *
 * @param {Record<string, unknown>} reqBody
 * @param {string | undefined} systemText
 * @param {string} exchangeId
 * @returns {string}
 */
export function openclawSessionId(reqBody, systemText, exchangeId) {
  if (systemText) return hashShort(systemText.slice(0, SESSION_HASH_HEAD_CHARS))
  const messages = Array.isArray(reqBody.messages) ? reqBody.messages
    : Array.isArray(reqBody.input) ? reqBody.input
    : []
  if (messages.length > 0 && isPlainObject(messages[0])) {
    // A message with absent `content` stringifies to undefined, which
    // sha256Hex cannot digest: fall back to the exchange id so a
    // content-less first message degrades to a stable session key
    // instead of throwing and dropping the exchange.
    return hashShort(JSON.stringify(messages[0].content) ?? exchangeId)
  }
  return hashShort(exchangeId)
}

/**
 * Canonical message list for one exchange: the request's chat history
 * plus the assistant response (JSON body, or reconstructed from the
 * SSE event stream when the response was streamed).
 *
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 * @param {Array<{ data: string, event?: string }>} streamEvents
 * @returns {Record<string, unknown>[]}
 */
export function anthropicMessages(reqBody, responseBody, streamEvents) {
  /** @type {Record<string, unknown>[]} */
  const messages = Array.isArray(reqBody.messages)
    ? reqBody.messages.filter(isPlainObject).map((message) => ({ ...message }))
    : []
  const assistant = isPlainObject(responseBody) && responseBody.role === 'assistant'
    ? responseBody
    : reconstructAssistantMessage(streamEvents)
  if (assistant) messages.push(assistant)
  return messages
}

/**
 * Stitch a finished assistant message out of a captured Anthropic SSE
 * stream: `message_start` seeds the envelope, `content_block_start` /
 * `content_block_delta` / `content_block_stop` build each block,
 * `message_delta` folds in stop_reason and usage updates, and
 * `message_stop` marks completion. A stream that ends early still
 * yields what arrived, marked `stop_reason = 'error'`.
 *
 * @param {Array<{ data: string, event?: string }>} streamEvents
 * @returns {Record<string, unknown> | null}
 */
function reconstructAssistantMessage(streamEvents) {
  /** @type {Record<string, unknown> | null} */
  let message = null
  /** @type {Map<number, Record<string, unknown>>} */
  const blocksByIndex = new Map()
  /** @type {Map<number, string>} */
  const partialJsonByIndex = new Map()
  let sawMessageStop = false

  for (const row of streamEvents) {
    if (row.data === '[DONE]') continue
    const payload = parseMaybeJson(row.data)
    if (!isPlainObject(payload)) continue
    const type = stringValue(payload.type)
    switch (type) {
    case 'message_start': {
      const m = isPlainObject(payload.message) ? payload.message : undefined
      if (m) {
        message = { role: 'assistant', content: [], type: 'message' }
        const id = stringValue(m.id)
        if (id) message.id = id
        const model = stringValue(m.model)
        if (model) message.model = model
        if (isPlainObject(m.usage)) message.usage = { ...m.usage }
      }
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
      const block = blocksByIndex.get(index) ?? { type: 'text', text: '' }
      blocksByIndex.set(index, block)
      const dtype = stringValue(delta.type)
      if (dtype === 'text_delta') {
        block.text = `${stringValue(block.text) ?? ''}${stringValue(delta.text) ?? ''}`
      } else if (dtype === 'thinking_delta') {
        block.type = 'thinking'
        block.thinking = `${stringValue(block.thinking) ?? ''}${stringValue(delta.thinking) ?? ''}`
      } else if (dtype === 'input_json_delta') {
        partialJsonByIndex.set(index, `${partialJsonByIndex.get(index) ?? ''}${stringValue(delta.partial_json) ?? ''}`)
      }
      break
    }
    case 'content_block_stop': {
      const index = numberValue(payload.index)
      if (index != null) finalizeBlock(blocksByIndex, partialJsonByIndex, index)
      break
    }
    case 'message_delta': {
      if (!message) break
      const delta = isPlainObject(payload.delta) ? payload.delta : undefined
      if (delta && 'stop_reason' in delta) message.stop_reason = stringValue(delta.stop_reason)
      if (isPlainObject(payload.usage)) {
        const existing = isPlainObject(message.usage) ? message.usage : {}
        message.usage = { ...existing, ...payload.usage }
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
  for (const index of Array.from(blocksByIndex.keys())) finalizeBlock(blocksByIndex, partialJsonByIndex, index)
  message.content = Array.from(blocksByIndex.entries())
    .sort(([a], [b]) => a - b)
    .map(([, block]) => block)
  if (!sawMessageStop && message.stop_reason == null) message.stop_reason = 'error'
  return message
}

/**
 * @param {Map<number, Record<string, unknown>>} blocksByIndex
 * @param {Map<number, string>} partialJsonByIndex
 * @param {number} index
 */
function finalizeBlock(blocksByIndex, partialJsonByIndex, index) {
  const block = blocksByIndex.get(index)
  if (!block || !partialJsonByIndex.has(index)) return
  const partial = partialJsonByIndex.get(index) ?? ''
  // Only overwrite the block's input when the stream actually carried
  // input_json_delta bytes. A tool_use block with no deltas is a valid
  // empty-input call: keep the input the content_block_start seeded (or
  // default to {}), never clobber it with parseMaybeJson('') === ''.
  if (partial.length > 0) block.input = parseMaybeJson(partial)
  else if (block.input === undefined) block.input = {}
  partialJsonByIndex.delete(index)
}

/**
 * Canonical message list for one OpenAI Chat Completions exchange: the
 * sibling of {@link anthropicMessages}, same output contract (the
 * request's chat history plus the assistant response, whether the
 * response arrived as JSON or as an SSE stream), different wire format.
 *
 * The blocks it emits are the *Anthropic* block vocabulary
 * (`text` / `tool_use` / `tool_result`), not OpenAI's `tool_calls` array
 * and `role: "tool"` envelopes. That is the point rather than an
 * inconsistency: `wireMatchKey`'s per-block `{kind, identity}` reduction
 * only recognizes tool calls and tool results under those kind names, so
 * an OpenAI-shaped turn left in its native shape would hash through the
 * generic fallback and could never match the same turn read back out of
 * the session file. One block vocabulary in, one match key out, for both
 * wire shapes.
 *
 * Leading system/developer messages are lifted out into `system_text`
 * (see {@link openaiSystemText}) rather than projected as rows, so the
 * same conversation produces the same row set whichever shape carried
 * it, and so no row exists that the session file has no record for.
 *
 * @ref LLP 0161#projector-shape [implements]: "a new sibling openaiMessages()
 * that builds the same message list shape from an OpenAI Chat Completions-shaped
 * request/response pair"
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 * @param {Array<{ data: string, event?: string }>} streamEvents
 * @returns {Record<string, unknown>[]}
 */
export function openaiMessages(reqBody, responseBody, streamEvents) {
  const requestMessages = Array.isArray(reqBody.messages) ? reqBody.messages.filter(isPlainObject) : []
  /** @type {Record<string, unknown>[]} */
  const messages = []
  for (const message of requestMessages.slice(leadingSystemCount(requestMessages))) {
    const normalized = openaiWireMessage(message)
    if (normalized) messages.push(normalized)
  }
  const assistant = openaiAssistantFromBody(responseBody) ?? reconstructOpenaiAssistantMessage(streamEvents)
  if (assistant) messages.push(assistant)
  return messages
}

/**
 * The system prompt of an OpenAI Chat Completions request. Anthropic
 * carries it in its own top-level `system` field; OpenAI carries it as
 * the leading `system`/`developer` messages of the chat array, so this
 * is `extractSystemText`'s counterpart for the other shape, and feeds
 * the same `system_text` column and the same session hash.
 *
 * @param {Record<string, unknown>} reqBody
 * @returns {string | undefined}
 */
export function openaiSystemText(reqBody) {
  const messages = Array.isArray(reqBody.messages) ? reqBody.messages.filter(isPlainObject) : []
  const texts = []
  for (const message of messages.slice(0, leadingSystemCount(messages))) {
    const text = textFromBlocks(openaiContentBlocks(message.content))
    if (text) texts.push(text)
  }
  return texts.length === 0 ? undefined : texts.join('\n\n')
}

/**
 * How many messages at the head of the chat array are system prompt.
 * Only the *leading* run counts: a `system`/`developer` message that
 * appears mid-conversation is a real turn (a steering instruction the
 * model saw at that point), so it stays a row rather than being folded
 * into the session-keying system text.
 *
 * @param {Record<string, unknown>[]} messages
 * @returns {number}
 */
function leadingSystemCount(messages) {
  let count = 0
  for (const message of messages) {
    const role = stringValue(message.role)
    if (role !== 'system' && role !== 'developer') break
    count += 1
  }
  return count
}

/**
 * One OpenAI Chat Completions message, normalized into the shared block
 * vocabulary: `role: "tool"` becomes a single `tool_result` block (the
 * Anthropic wire nests exactly that inside a user turn), `tool_calls`
 * become `tool_use` blocks appended after the message's own content, and
 * everything else passes through as content blocks. A message with no
 * role is skipped, matching how `project()` skips a roleless Anthropic
 * message rather than inventing one.
 *
 * @param {Record<string, unknown>} message
 * @returns {Record<string, unknown> | undefined}
 */
function openaiWireMessage(message) {
  const role = stringValue(message.role)
  if (!role) return undefined
  if (role === 'tool') {
    const toolCallId = stringValue(message.tool_call_id)
    const text = textFromBlocks(openaiContentBlocks(message.content))
    /** @type {Record<string, unknown>} */
    const block = { type: 'tool_result' }
    if (toolCallId) block.tool_use_id = toolCallId
    if (text !== undefined) block.content = text
    return { role, content: [block] }
  }
  const content = openaiContentBlocks(message.content)
  for (const block of openaiToolUseBlocks(message.tool_calls)) content.push(block)
  return { role, content }
}

/**
 * OpenAI message content as blocks: a bare string is one text block, an
 * array passes its parts through unchanged (an already-canonical
 * `{ type: "text", text }` part needs no rewriting, and an image part is
 * preserved rather than dropped).
 *
 * @param {unknown} content
 * @returns {Record<string, unknown>[]}
 */
function openaiContentBlocks(content) {
  if (typeof content === 'string') return content.length === 0 ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  /** @type {Record<string, unknown>[]} */
  const blocks = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.length > 0) blocks.push({ type: 'text', text: part })
    } else if (isPlainObject(part)) {
      blocks.push({ ...part })
    }
  }
  return blocks
}

/**
 * `tool_use` blocks for an OpenAI `tool_calls` array. `function.arguments`
 * is a JSON *string* on the wire; it is parsed so the block's `input`
 * matches the object an Anthropic `tool_use` block carries (and so the
 * match key hashes the arguments, not their serialization).
 *
 * @param {unknown} toolCalls
 * @returns {Record<string, unknown>[]}
 */
function openaiToolUseBlocks(toolCalls) {
  if (!Array.isArray(toolCalls)) return []
  /** @type {Record<string, unknown>[]} */
  const blocks = []
  for (const call of toolCalls) {
    if (!isPlainObject(call)) continue
    const fn = isPlainObject(call.function) ? call.function : {}
    /** @type {Record<string, unknown>} */
    const block = { type: 'tool_use' }
    const id = stringValue(call.id)
    if (id) block.id = id
    const name = stringValue(fn.name)
    if (name) block.name = name
    block.input = openaiToolArguments(fn.arguments)
    blocks.push(block)
  }
  return blocks
}

/**
 * A tool call's arguments as an object. An empty (or absent) argument
 * string is an empty-input call, `{}`, never the empty string
 * `parseMaybeJson('')` yields; a string that does not parse is kept
 * verbatim rather than discarded, since a truncated argument stream is
 * still evidence of what was sent.
 *
 * @param {unknown} raw
 * @returns {unknown}
 */
function openaiToolArguments(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return isPlainObject(raw) ? { ...raw } : {}
  return parseMaybeJson(raw)
}

/**
 * The assistant message of a non-streamed Chat Completions response:
 * the first choice's `message`, plus the finish reason and the
 * response-scoped usage object it must carry for `usageAttributes` to
 * find (@ref LLP 0035#one-carrier: one usage carrier per response).
 *
 * @param {unknown} responseBody
 * @returns {Record<string, unknown> | undefined}
 */
function openaiAssistantFromBody(responseBody) {
  if (!isPlainObject(responseBody)) return undefined
  const choices = Array.isArray(responseBody.choices) ? responseBody.choices : []
  const choice = choices.find(isPlainObject)
  if (!isPlainObject(choice)) return undefined
  const raw = isPlainObject(choice.message) ? choice.message : undefined
  if (!raw) return undefined
  const message = openaiWireMessage({ role: 'assistant', ...raw })
  if (!message) return undefined
  const finish = stringValue(choice.finish_reason)
  if (finish) message.stop_reason = finish
  const id = stringValue(responseBody.id)
  if (id) message.id = id
  const model = stringValue(responseBody.model)
  if (model) message.model = model
  if (isPlainObject(responseBody.usage)) message.usage = { ...responseBody.usage }
  return message
}

/**
 * Stitch a finished assistant message out of a captured OpenAI Chat
 * Completions SSE stream: the counterpart of
 * {@link reconstructAssistantMessage} for the other wire format. Where
 * Anthropic streams typed lifecycle events, Chat Completions streams one
 * event family (`chat.completion.chunk`) whose `choices[].delta` carries
 * either a slice of the assistant text or a slice of one tool call's
 * arguments, keyed by the tool call's `index` (its `id` and `name`
 * usually arrive only on that call's first chunk, so both are latched).
 * `usage` rides a final chunk when the caller asked for it. A stream
 * that ends without a `finish_reason` still yields what arrived, marked
 * `stop_reason = 'error'`, exactly as the Anthropic side does for a
 * stream with no `message_stop`.
 *
 * @param {Array<{ data: string, event?: string }>} streamEvents
 * @returns {Record<string, unknown> | null}
 */
function reconstructOpenaiAssistantMessage(streamEvents) {
  let sawChunk = false
  let sawFinish = false
  let text = ''
  /** @type {Map<number, { id?: string, name?: string, args: string }>} */
  const toolCallsByIndex = new Map()
  /** @type {string | undefined} */
  let stopReason
  /** @type {Record<string, unknown> | undefined} */
  let usage
  /** @type {string | undefined} */
  let id
  /** @type {string | undefined} */
  let model

  for (const row of streamEvents) {
    if (row.data === '[DONE]') continue
    const payload = parseMaybeJson(row.data)
    if (!isPlainObject(payload)) continue
    const choices = Array.isArray(payload.choices) ? payload.choices : undefined
    if (!choices && !isPlainObject(payload.usage)) continue
    sawChunk = true
    const chunkId = stringValue(payload.id)
    if (chunkId) id = chunkId
    const chunkModel = stringValue(payload.model)
    if (chunkModel) model = chunkModel
    if (isPlainObject(payload.usage)) usage = { ...payload.usage }
    for (const choice of choices ?? []) {
      if (!isPlainObject(choice)) continue
      const finish = stringValue(choice.finish_reason)
      if (finish) {
        stopReason = finish
        sawFinish = true
      }
      const delta = isPlainObject(choice.delta) ? choice.delta : undefined
      if (!delta) continue
      text += textFromBlocks(openaiContentBlocks(delta.content)) ?? ''
      accumulateOpenaiToolCallDeltas(toolCallsByIndex, delta.tool_calls)
    }
  }

  if (!sawChunk) return null
  /** @type {Record<string, unknown>[]} */
  const content = []
  if (text.length > 0) content.push({ type: 'text', text })
  for (const [, call] of Array.from(toolCallsByIndex.entries()).sort(([a], [b]) => a - b)) {
    /** @type {Record<string, unknown>} */
    const block = { type: 'tool_use' }
    if (call.id) block.id = call.id
    if (call.name) block.name = call.name
    block.input = openaiToolArguments(call.args)
    content.push(block)
  }

  /** @type {Record<string, unknown>} */
  const message = { role: 'assistant', content }
  if (id) message.id = id
  if (model) message.model = model
  if (usage) message.usage = usage
  if (stopReason) message.stop_reason = stopReason
  else if (!sawFinish) message.stop_reason = 'error'
  return message
}

/**
 * Fold one chunk's `delta.tool_calls` into the per-index accumulator.
 * `index` is the wire's own slot for the call being streamed; a chunk
 * that omits it is folded into the slot its arrival order implies rather
 * than being dropped.
 *
 * @param {Map<number, { id?: string, name?: string, args: string }>} byIndex
 * @param {unknown} toolCalls
 */
function accumulateOpenaiToolCallDeltas(byIndex, toolCalls) {
  if (!Array.isArray(toolCalls)) return
  for (const call of toolCalls) {
    if (!isPlainObject(call)) continue
    const index = numberValue(call.index) ?? byIndex.size
    const entry = byIndex.get(index) ?? { args: '' }
    const id = stringValue(call.id)
    if (id) entry.id = id
    const fn = isPlainObject(call.function) ? call.function : undefined
    if (fn) {
      const name = stringValue(fn.name)
      if (name) entry.name = name
      if (typeof fn.arguments === 'string') entry.args += fn.arguments
    }
    byIndex.set(index, entry)
  }
}

/**
 * Whether an OpenAI-provider exchange spoke the Responses API rather than
 * Chat Completions. The path is the authoritative signal (OpenClaw's
 * client appends `/responses` to the overlay baseUrl); the body shapes
 * are fallbacks for a capture whose path was not recorded: a Responses
 * request carries `input` where Chat Completions carries `messages`, and
 * a Responses response self-identifies as `object: "response"`.
 *
 * @ref LLP 0176#fix-direction [implements]: fix 1, the Responses decoder,
 *   dispatched per exchange because both dialects ride one provider
 * @param {string | null | undefined} path
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 * @returns {boolean}
 */
export function isOpenaiResponsesExchange(path, reqBody, responseBody) {
  if (typeof path === 'string' && /\/responses(\?|$)/.test(path)) return true
  if (reqBody.input !== undefined && !Array.isArray(reqBody.messages)) return true
  return isPlainObject(responseBody) && responseBody.object === 'response'
}

/**
 * Canonical message list for one OpenAI Responses exchange: the third
 * sibling of {@link anthropicMessages} / {@link openaiMessages}, same
 * output contract, third wire format. Emits the shared Anthropic block
 * vocabulary for the same reason `openaiMessages` does: one block
 * vocabulary in, one match key out, whichever dialect carried the turn.
 *
 * Request-side `input` items map as:
 *  - a bare string: one user text turn (the API's shorthand);
 *  - `message` items (or items with a `role` and no `type`): text parts
 *    (`input_text` / `output_text` / `refusal`) become text blocks,
 *    other parts pass through; the LEADING `system`/`developer` run is
 *    lifted into `system_text` (see {@link openaiResponsesSystemText}),
 *    mirroring the Chat Completions fold;
 *  - `function_call` items: an assistant turn holding one `tool_use`
 *    block (the Responses wire splits calls out of the message);
 *  - `function_call_output` items: a user turn holding one `tool_result`
 *    block, the same nesting the Anthropic wire uses;
 *  - `reasoning` items are SKIPPED: on the request side they are opaque
 *    replay artifacts (often only an encrypted payload) with no stable
 *    content identity for a match key, and the session file records the
 *    visible reasoning on the assistant turn that produced it.
 *
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 * @param {Array<{ data: string, event?: string }>} streamEvents
 * @returns {Record<string, unknown>[]}
 */
export function openaiResponsesMessages(reqBody, responseBody, streamEvents) {
  /** @type {Record<string, unknown>[]} */
  const messages = []
  const input = reqBody.input
  if (typeof input === 'string') {
    if (input.length > 0) messages.push({ role: 'user', content: [{ type: 'text', text: input }] })
  } else if (Array.isArray(input)) {
    const items = input.filter(isPlainObject)
    for (const item of items.slice(leadingResponsesSystemCount(items))) {
      const message = responsesInputItemMessage(item)
      if (message) messages.push(message)
    }
  }
  const assistant = openaiResponsesAssistant(responseBody) ?? responsesAssistantFromStream(streamEvents)
  if (assistant) messages.push(assistant)
  return messages
}

/**
 * The system prompt of a Responses request: the top-level `instructions`
 * string, then the leading `system`/`developer` message items of the
 * `input` array, joined the same way the Chat Completions fold joins its
 * leading run. Same rule about position: a mid-conversation
 * system/developer item is a real turn and stays a row.
 *
 * @param {Record<string, unknown>} reqBody
 * @returns {string | undefined}
 */
export function openaiResponsesSystemText(reqBody) {
  /** @type {string[]} */
  const texts = []
  const instructions = stringValue(reqBody.instructions)
  if (instructions) texts.push(instructions)
  const input = Array.isArray(reqBody.input) ? reqBody.input.filter(isPlainObject) : []
  for (const item of input.slice(0, leadingResponsesSystemCount(input))) {
    const text = textFromBlocks(responsesContentBlocks(item.content))
    if (text) texts.push(text)
  }
  return texts.length === 0 ? undefined : texts.join('\n\n')
}

/**
 * How many items at the head of a Responses `input` array are system
 * prompt: the leading run of message-shaped items with a
 * `system`/`developer` role. A `function_call`/`function_call_output`
 * item ends the run (it is conversation, not preamble).
 *
 * @param {Record<string, unknown>[]} items
 * @returns {number}
 */
function leadingResponsesSystemCount(items) {
  let count = 0
  for (const item of items) {
    const type = stringValue(item.type)
    if (type !== undefined && type !== 'message') break
    const role = stringValue(item.role)
    if (role !== 'system' && role !== 'developer') break
    count += 1
  }
  return count
}

/**
 * One request-side Responses `input` item as a message, or `undefined`
 * for the item kinds that project nothing (reasoning replays, item
 * references, unrecognized future kinds - skipped rather than guessed,
 * the same fail-closed posture the backfill takes for a record whose
 * backend is unresolvable).
 *
 * @param {Record<string, unknown>} item
 * @returns {Record<string, unknown> | undefined}
 */
function responsesInputItemMessage(item) {
  const type = stringValue(item.type)
  if (type === undefined || type === 'message') {
    const role = stringValue(item.role)
    if (!role) return undefined
    return { role, content: responsesContentBlocks(item.content) }
  }
  if (type === 'function_call') {
    /** @type {Record<string, unknown>} */
    const block = { type: 'tool_use' }
    const id = stringValue(item.call_id) ?? stringValue(item.id)
    if (id) block.id = id
    const name = stringValue(item.name)
    if (name) block.name = name
    block.input = openaiToolArguments(item.arguments)
    return { role: 'assistant', content: [block] }
  }
  if (type === 'function_call_output') {
    /** @type {Record<string, unknown>} */
    const block = { type: 'tool_result' }
    const callId = stringValue(item.call_id)
    if (callId) block.tool_use_id = callId
    const text = typeof item.output === 'string'
      ? item.output
      : textFromBlocks(responsesContentBlocks(item.output))
    if (text !== undefined) block.content = text
    return { role: 'user', content: [block] }
  }
  return undefined
}

/**
 * Responses content parts as shared-vocabulary blocks: `input_text`,
 * `output_text`, and plain `text` parts become text blocks; a `refusal`
 * part becomes a text block carrying the refusal (it is what the user
 * saw); other parts (images, files) pass through as-is, the same
 * preservation choice {@link openaiContentBlocks} makes.
 *
 * @param {unknown} content
 * @returns {Record<string, unknown>[]}
 */
function responsesContentBlocks(content) {
  if (typeof content === 'string') return content.length === 0 ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  /** @type {Record<string, unknown>[]} */
  const blocks = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.length > 0) blocks.push({ type: 'text', text: part })
      continue
    }
    if (!isPlainObject(part)) continue
    const type = stringValue(part.type)
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      const text = stringValue(part.text)
      if (text !== undefined) blocks.push({ type: 'text', text })
      continue
    }
    if (type === 'refusal') {
      const refusal = stringValue(part.refusal)
      if (refusal !== undefined) blocks.push({ type: 'text', text: refusal })
      continue
    }
    blocks.push({ ...part })
  }
  return blocks
}

/**
 * The assistant message of a non-streamed Responses body: the `output`
 * array folded into one assistant turn, in output order. `message` items
 * contribute their text parts, `function_call` items become `tool_use`
 * blocks, `reasoning` items become `thinking` blocks (summary text as
 * the thinking, `encrypted_content` latched as the signature so a
 * summary-less reasoning item still hashes stably).
 *
 * `usage` is re-keyed to the Chat Completions field names before it is
 * latched, deliberately: Responses `input_tokens` is GROSS (it includes
 * `input_tokens_details.cached_tokens`), and `usageAttributes` already
 * knows how to net a gross prompt count via the
 * `prompt_tokens`/`cached_tokens` pair, so translating the keys reuses
 * the one existing netting path instead of growing a third (LLP 0035
 * net-input).
 *
 * @param {unknown} responseBody
 * @returns {Record<string, unknown> | undefined}
 */
export function openaiResponsesAssistant(responseBody) {
  if (!isPlainObject(responseBody)) return undefined
  const output = Array.isArray(responseBody.output) ? responseBody.output : undefined
  if (!output && responseBody.object !== 'response') return undefined
  /** @type {Record<string, unknown>[]} */
  const content = []
  for (const item of output ?? []) {
    if (!isPlainObject(item)) continue
    const type = stringValue(item.type)
    if (type === 'message') {
      for (const block of responsesContentBlocks(item.content)) content.push(block)
    } else if (type === 'function_call') {
      /** @type {Record<string, unknown>} */
      const block = { type: 'tool_use' }
      const id = stringValue(item.call_id) ?? stringValue(item.id)
      if (id) block.id = id
      const name = stringValue(item.name)
      if (name) block.name = name
      block.input = openaiToolArguments(item.arguments)
      content.push(block)
    } else if (type === 'reasoning') {
      /** @type {Record<string, unknown>} */
      const block = { type: 'thinking', thinking: reasoningSummaryText(item) ?? '' }
      const signature = stringValue(item.encrypted_content)
      if (signature) block.signature = signature
      content.push(block)
    }
  }

  /** @type {Record<string, unknown>} */
  const message = { role: 'assistant', content }
  const id = stringValue(responseBody.id)
  if (id) message.id = id
  const model = stringValue(responseBody.model)
  if (model) message.model = model
  const incomplete = isPlainObject(responseBody.incomplete_details)
    ? stringValue(responseBody.incomplete_details.reason)
    : undefined
  const status = stringValue(responseBody.status)
  const stopReason = incomplete ?? (status && status !== 'completed' ? status : undefined)
  if (stopReason) message.stop_reason = stopReason
  const usage = responsesUsageAsChatUsage(responseBody.usage)
  if (usage) message.usage = usage
  return message
}

/**
 * @param {Record<string, unknown>} item
 * @returns {string | undefined}
 */
function reasoningSummaryText(item) {
  if (typeof item.summary === 'string') return item.summary.length === 0 ? undefined : item.summary
  if (!Array.isArray(item.summary)) return undefined
  const texts = []
  for (const part of item.summary) {
    if (isPlainObject(part) && typeof part.text === 'string' && part.text.length > 0) texts.push(part.text)
  }
  return texts.length === 0 ? undefined : texts.join('\n\n')
}

/**
 * Responses usage under Chat Completions keys, so `usageAttributes` nets
 * the gross input count against the cached read through its existing
 * `prompt_tokens`/`prompt_tokens_details.cached_tokens` path.
 *
 * @param {unknown} usage
 * @returns {Record<string, unknown> | undefined}
 */
function responsesUsageAsChatUsage(usage) {
  if (!isPlainObject(usage)) return undefined
  /** @type {Record<string, unknown>} */
  const out = {}
  const input = numberValue(usage.input_tokens)
  if (input !== undefined) out.prompt_tokens = input
  const output = numberValue(usage.output_tokens)
  if (output !== undefined) out.completion_tokens = output
  const inputDetails = isPlainObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined
  const cached = inputDetails ? numberValue(inputDetails.cached_tokens) : undefined
  if (cached !== undefined) out.prompt_tokens_details = { cached_tokens: cached }
  const outputDetails = isPlainObject(usage.output_tokens_details) ? usage.output_tokens_details : undefined
  const reasoning = outputDetails ? numberValue(outputDetails.reasoning_tokens) : undefined
  if (reasoning !== undefined) out.completion_tokens_details = { reasoning_tokens: reasoning }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * The assistant message of a streamed Responses exchange. The Responses
 * SSE stream ends with a terminal event (`response.completed` /
 * `response.incomplete` / `response.failed`) whose payload carries the
 * ENTIRE final response object, so the happy path is a single reuse of
 * {@link openaiResponsesAssistant} on that payload rather than a delta
 * stitch. A stream that died before its terminal event degrades to the
 * `response.output_item.done` items that did finish (each carries its
 * complete item), marked `stop_reason = 'error'` like both sibling
 * reconstructions; per-delta stitching of a half-finished item is
 * deliberately not attempted, and a cut stream with ZERO finished items
 * yields no assistant row at all.
 *
 * @param {Array<{ data: string, event?: string }>} streamEvents
 * @returns {Record<string, unknown> | undefined}
 */
function responsesAssistantFromStream(streamEvents) {
  /** @type {Record<string, unknown> | undefined} */
  let terminal
  /** @type {Record<string, unknown>[]} */
  const doneItems = []
  let sawResponsesEvent = false
  for (const row of streamEvents) {
    if (row.data === '[DONE]') continue
    const payload = parseMaybeJson(row.data)
    if (!isPlainObject(payload)) continue
    const type = stringValue(payload.type)
    if (!type || !type.startsWith('response.')) continue
    sawResponsesEvent = true
    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      if (isPlainObject(payload.response)) terminal = payload.response
    } else if (type === 'response.output_item.done' && isPlainObject(payload.item)) {
      doneItems.push(payload.item)
    }
  }
  if (terminal) return openaiResponsesAssistant(terminal)
  // A cut stream with no finished items has nothing to degrade to: emit
  // no assistant row rather than an empty-content row that would still
  // carry a match key and be eligible for the ordinal settlement fallback.
  if (!sawResponsesEvent || doneItems.length === 0) return undefined
  const partial = openaiResponsesAssistant({ object: 'response', output: doneItems })
  if (!partial) return undefined
  partial.stop_reason = 'error'
  return partial
}

/**
 * The concatenated text of a block list, or `undefined` when it carries
 * no text at all (so a tool result with only an image does not become an
 * empty-string content).
 *
 * @param {Record<string, unknown>[]} blocks
 * @returns {string | undefined}
 */
function textFromBlocks(blocks) {
  const texts = []
  for (const block of blocks) {
    const text = stringValue(block.text)
    if (text) texts.push(text)
  }
  return texts.length === 0 ? undefined : texts.join('')
}

/**
 * `attributes.usage` for a message carrying a wire `usage` object, in
 * either shape, with the token fields normalized to the gateway-wide
 * names (`input_tokens` / `output_tokens` / `cache_read_tokens` /
 * `cache_write_tokens`), matching the Claude and Codex adapters so token
 * queries aggregate across clients.
 *
 * The two wires differ in more than spelling: Anthropic's `input_tokens`
 * already excludes the cache reads it reports beside it, while OpenAI's
 * `prompt_tokens` is gross (it includes `prompt_tokens_details.cached_tokens`),
 * so the OpenAI branch subtracts before it stores. Reading both spellings
 * here, rather than pre-rewriting the usage object in `openaiMessages()`,
 * keeps the intermediate messages wire-shaped and leaves exactly one
 * place where a token name is normalized.
 *
 * @ref LLP 0035#one-carrier [implements]: usage rides the assistant response message only
 * @ref LLP 0035#net-input [implements]: the stored input count is net of cache reads on both wires
 * @param {Record<string, unknown>} message
 * @returns {JsonObject | undefined}
 */
function usageAttributes(message) {
  if (!isPlainObject(message.usage)) return undefined
  const usage = message.usage
  const promptDetails = isPlainObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined
  const completionDetails = isPlainObject(usage.completion_tokens_details) ? usage.completion_tokens_details : undefined
  const cacheRead = numberValue(usage.cache_read_input_tokens) ??
    (promptDetails ? numberValue(promptDetails.cached_tokens) : undefined)
  const grossInput = numberValue(usage.prompt_tokens)
  const input = numberValue(usage.input_tokens) ??
    (grossInput === undefined ? undefined : Math.max(0, grossInput - (cacheRead ?? 0)))
  const output = numberValue(usage.output_tokens) ?? numberValue(usage.completion_tokens)
  const reasoning = completionDetails ? numberValue(completionDetails.reasoning_tokens) : undefined

  /** @type {JsonObject} */
  const out = {}
  if (input !== undefined) out.input_tokens = input
  if (output !== undefined) out.output_tokens = output
  if (cacheRead !== undefined) out.cache_read_tokens = cacheRead
  if (usage.cache_creation_input_tokens != null) out.cache_write_tokens = /** @type {any} */ (usage.cache_creation_input_tokens)
  if (reasoning !== undefined) out.reasoning_tokens = reasoning
  if (Object.keys(out).length === 0) return undefined
  return { usage: out }
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
 * @param {string | null | undefined} raw
 * @returns {Record<string, string | string[]> | undefined}
 */
function parseHeaders(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const parsed = parseMaybeJson(raw)
  if (!isPlainObject(parsed)) return undefined
  return /** @type {Record<string, string | string[]>} */ (parsed)
}

/**
 * @param {Record<string, string | string[] | undefined> | undefined} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function headerValue(headers, name) {
  if (!headers) return undefined
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

/**
 * Merge one attribute namespace into a message's existing attributes,
 * one level deep, so stamping `openclaw.match_key` never clobbers the
 * `usage` namespace already on the same message (and vice versa).
 *
 * @param {JsonObject | undefined} base
 * @param {JsonObject} extra
 * @returns {JsonObject}
 */
function mergeAttributes(base, extra) {
  if (!base) return extra
  /** @type {JsonObject} */
  const out = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    const existing = out[key]
    out[key] = isPlainObject(value) && isPlainObject(existing)
      ? { ...existing, ...value }
      : value
  }
  return out
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
function hashShort(input) {
  // 16-char hex prefix of SHA-256, the same shape the gateway's
  // fallback identity uses; changing it would re-key old sessions.
  return sha256Hex(input).slice(0, 16)
}
