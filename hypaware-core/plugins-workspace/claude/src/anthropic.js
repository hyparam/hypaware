// @ts-check

import { createHash } from 'node:crypto'

/**
 * @import { JsonObject, JsonValue } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * Anthropic Messages HTTP + SSE parsing. Ported from the gateway
 * core's pre-2.0 `message_projector.js` — the same logic, scoped to
 * the Anthropic shape (no OpenAI/Codex branches). The projector in
 * `projector.js` calls these to turn a captured `/v1/messages`
 * exchange into the `(messages, model, system_text, tools, …)` shape
 * the gateway's `AiGatewayProjectedExchange` expects.
 */

/**
 * Build the list of canonical Anthropic messages for one captured
 * exchange. The request body's `messages` array is the chat history
 * the client already had; the response (either the JSON assistant
 * body, or — for streamed responses — the reconstructed assistant
 * message from the SSE event stream) is appended as the final entry.
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
  const assistant = isAnthropicAssistant(responseBody)
    ? responseBody
    : reconstructAnthropicAssistantMessage(streamEvents)
  if (assistant) messages.push(assistant)
  return messages
}

/**
 * Stitch a finished assistant message out of a captured Anthropic SSE
 * stream. The Anthropic streaming protocol emits a `message_start`
 * with the message envelope, then a sequence of
 * `content_block_start` / `content_block_delta` / `content_block_stop`
 * frames per block, optional `message_delta` for stop_reason/usage
 * updates, and a final `message_stop`. If the stream ends before
 * `message_stop` we still return what we have but mark
 * `stop_reason = 'error'` so downstream readers know it's partial.
 *
 * @param {Array<{ data: string, event?: string }>} streamEvents
 * @returns {Record<string, unknown> | null}
 */
export function reconstructAnthropicAssistantMessage(streamEvents) {
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

/**
 * Pull the conversation-level Anthropic request fields the gateway
 * needs: model, system text (string or block-array shape), and tool
 * declarations.
 *
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 */
export function anthropicConversationFields(reqBody, responseBody) {
  return {
    model: stringValue(reqBody.model) ?? stringValue(readKey(responseBody, 'model')),
    system_text: extractSystemText(reqBody.system),
    tools: reqBody.tools,
  }
}

/**
 * Match an Anthropic Messages API exchange. The Anthropic capture
 * surface is anchored at `/v1/messages`; we also accept anything that
 * carries an `anthropic-version` header, an `x-api-key` header, or an
 * `authorization: Bearer sk-ant-*` so a proxy mounted under a custom
 * prefix still routes here. Keep this in sync with
 * `anthropicUpstreamPreset()`.
 *
 * @param {{ path: string | null, request_headers: string | null }} input
 */
export function isAnthropicExchange(input) {
  if (typeof input.path === 'string' && isAnthropicPath(input.path)) return true
  const headers = parseHeaders(input.request_headers)
  return hasAnthropicHeaderSignature(headers)
}

/**
 * @param {string} path
 */
export function isAnthropicPath(path) {
  return path === '/v1/messages' || path.startsWith('/v1/messages/')
}

/**
 * Anthropic-style request headers. Lowercased lookups; accept either
 * the route-input header shape (`Record<string, string[]>`) or the
 * recorder's `IncomingHttpHeaders`-derived shape (string | string[]).
 *
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
 * Pull the Claude Code session id off either the request body's
 * `metadata.user_id` (Anthropic stuffs it there as a JSON-encoded
 * blob) or the `x-claude-code-session-id` header — same priority as
 * the donor `resolveSessionId`.
 *
 * @param {Record<string, unknown> | undefined} reqBody
 * @param {Record<string, string | string[] | undefined> | undefined} headers
 */
export function resolveClaudeSessionId(reqBody, headers) {
  const metaSession = readMetadataSessionId(reqBody)
  if (metaSession) return metaSession
  return headerValue(headers, 'x-claude-code-session-id')
}

/**
 * Resolve the `conversation_id` for an Anthropic exchange. Mirrors the
 * donor: session id wins; otherwise hash the first message's content;
 * otherwise hash the exchange id so something is always written.
 *
 * @param {Record<string, unknown>} reqBody
 * @param {string} exchangeId
 * @param {string | undefined} sessionId
 */
export function resolveAnthropicConversationId(reqBody, exchangeId, sessionId) {
  if (sessionId) return sessionId
  const messages = Array.isArray(reqBody.messages) ? reqBody.messages : []
  if (messages.length > 0 && isPlainObject(messages[0])) {
    return hashShort(canonicalJson(messages[0].content))
  }
  return hashShort(exchangeId)
}

/**
 * Extract the Claude CLI version from the captured user-agent. The
 * donor used the same `claude-cli/<version>` shape; we surface it as
 * `client_version` on the projection so downstream queries can group
 * by client version.
 *
 * @param {Record<string, string | string[] | undefined> | undefined} headers
 */
export function claudeClientVersion(headers) {
  const ua = headerValue(headers, 'user-agent')
  if (typeof ua !== 'string') return undefined
  const match = /^claude-cli\/([^/\s]+)/.exec(ua)
  return match?.[1]
}

/**
 * Conversation source label: `claude_code` when the User-Agent
 * identifies the CLI, otherwise `api` (generic Anthropic SDK
 * traffic). The donor used this to distinguish first-party Claude
 * Code from third-party Anthropic SDK callers.
 *
 * @param {Record<string, string | string[] | undefined> | undefined} headers
 */
export function anthropicConversationSource(headers) {
  const ua = headerValue(headers, 'user-agent')
  if (typeof ua === 'string' && /^claude-cli\//.test(ua)) return 'claude_code'
  return 'api'
}

/**
 * Pull `metadata.user_id.account_uuid` off the request body if
 * present; Anthropic's Claude Code SDK stuffs both the session id and
 * the account uuid into a JSON-encoded `user_id` field on the
 * top-level `metadata`.
 *
 * @param {Record<string, unknown>} reqBody
 */
export function resolveAnthropicUserId(reqBody) {
  const meta = readKey(reqBody, 'metadata')
  if (!isPlainObject(meta)) return undefined
  const userId = parseMaybeJson(meta.user_id)
  if (!isPlainObject(userId)) return undefined
  return stringValue(userId.account_uuid)
}

// ---------------------------------------------------------------------
// Conversation-level attribute extraction (request/response/usage)
// ---------------------------------------------------------------------

/**
 * Donor's `extractAttributes` reduced to the Anthropic fields we
 * surface on the projection's `attributes` (a JSON-merge under the
 * row's `attributes` column). Per-message `usage` is folded in by the
 * projector caller since usage lands on the assistant message rather
 * than the request body.
 *
 * @param {Record<string, unknown>} reqBody
 * @param {unknown} responseBody
 * @param {number | null | undefined} durationMs
 * @returns {JsonObject | undefined}
 */
export function anthropicExchangeAttributes(reqBody, responseBody, durationMs) {
  /** @type {JsonObject} */
  const attrs = {}
  /** @type {JsonObject} */
  const request = {}
  copyIfPresent(reqBody, request, 'max_tokens')
  copyIfPresent(reqBody, request, 'thinking')
  copyIfPresent(reqBody, request, 'output_config')
  copyIfPresent(reqBody, request, 'context_management')
  copyIfPresent(reqBody, request, 'stream')
  if (Object.keys(request).length > 0) attrs.request = request
  if (reqBody.metadata != null) attrs.provider_raw = { metadata: /** @type {JsonValue} */ (reqBody.metadata) }
  if (isPlainObject(responseBody)) {
    /** @type {JsonObject} */
    const providerRaw = isPlainObject(attrs.provider_raw)
      ? { .../** @type {JsonObject} */ (attrs.provider_raw) }
      : {}
    if (typeof responseBody.id === 'string') providerRaw.response_id = responseBody.id
    if (Object.keys(providerRaw).length > 0) attrs.provider_raw = providerRaw
  }
  if (typeof durationMs === 'number') attrs.timing = { latency_ms: durationMs }
  return Object.keys(attrs).length === 0 ? undefined : attrs
}

/**
 * Build the per-message `attributes.usage` block from an Anthropic
 * message's `usage` field. The donor normalised
 * `cache_read_input_tokens` → `cache_read_tokens` and
 * `cache_creation_input_tokens` → `cache_write_tokens`; we keep that.
 *
 * @param {unknown} message
 * @returns {JsonObject | undefined}
 */
export function anthropicMessageAttributes(message) {
  if (!isPlainObject(message) || !isPlainObject(message.usage)) return undefined
  const usage = /** @type {JsonObject} */ (message.usage)
  /** @type {JsonObject} */
  const out = {}
  if (usage.input_tokens != null) out.input_tokens = usage.input_tokens
  if (usage.output_tokens != null) out.output_tokens = usage.output_tokens
  if (usage.cache_read_input_tokens != null) out.cache_read_tokens = usage.cache_read_input_tokens
  if (usage.cache_creation_input_tokens != null) out.cache_write_tokens = usage.cache_creation_input_tokens
  if (Object.keys(out).length === 0) return undefined
  return { usage: out }
}

// ---------------------------------------------------------------------
// Internal helpers (ported)
// ---------------------------------------------------------------------

/** @param {Record<string, unknown>} m */
function seedAnthropicMessage(m) {
  /** @type {Record<string, unknown>} */
  const msg = { role: 'assistant', content: [], type: 'message' }
  copyIfString(m, msg, 'id')
  copyIfString(m, msg, 'model')
  copyIfString(m, msg, 'stop_reason')
  copyIfString(m, msg, 'stop_sequence')
  if (isPlainObject(m.usage)) msg.usage = { ...m.usage }
  return msg
}

/**
 * @param {Map<number, Record<string, unknown>>} blocksByIndex
 * @param {number} index
 * @param {Record<string, unknown>} delta
 */
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

/**
 * @param {Record<string, unknown>} block
 * @param {Record<string, unknown>} delta
 * @param {number} index
 * @param {Map<number, string>} partialJsonByIndex
 */
function applyAnthropicDelta(block, delta, index, partialJsonByIndex) {
  const dtype = stringValue(delta.type)
  if (dtype === 'text_delta') block.text = `${stringValue(block.text) ?? ''}${stringValue(delta.text) ?? ''}`
  else if (dtype === 'thinking_delta') block.thinking = `${stringValue(block.thinking) ?? ''}${stringValue(delta.thinking) ?? ''}`
  else if (dtype === 'signature_delta') block.signature = stringValue(delta.signature)
  else if (dtype === 'input_json_delta') {
    partialJsonByIndex.set(index, `${partialJsonByIndex.get(index) ?? ''}${stringValue(delta.partial_json) ?? ''}`)
  }
}

/**
 * @param {Map<number, Record<string, unknown>>} blocksByIndex
 * @param {Map<number, string>} partialJsonByIndex
 * @param {number} index
 */
function finalizeAnthropicBlock(blocksByIndex, partialJsonByIndex, index) {
  const block = blocksByIndex.get(index)
  if (!block || !partialJsonByIndex.has(index)) return
  const raw = partialJsonByIndex.get(index) ?? ''
  block.input = parseMaybeJson(raw)
  partialJsonByIndex.delete(index)
}

/**
 * @param {{ data: string, event?: string }} row
 */
function parseEventData(row) {
  const data = row.data
  if (data === '[DONE]') return undefined
  return parseMaybeJson(data)
}

/** @param {Record<string, unknown> | undefined} reqBody */
function readMetadataSessionId(reqBody) {
  if (!reqBody) return undefined
  const meta = readKey(reqBody, 'metadata')
  if (!isPlainObject(meta)) return undefined
  const userId = parseMaybeJson(meta.user_id)
  if (!isPlainObject(userId)) return undefined
  return stringValue(userId.session_id)
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isAnthropicAssistant(value) {
  return isPlainObject(value) && value.role === 'assistant'
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

/** @param {unknown} value */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/**
 * @param {string | null | undefined} raw
 * @returns {Record<string, string | string[]> | undefined}
 */
function parseHeaders(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return /** @type {Record<string, string | string[]>} */ (parsed)
  } catch {
    return undefined
  }
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

/** @param {unknown} obj @param {string} key */
function readKey(obj, key) {
  if (!isPlainObject(obj)) return undefined
  return obj[key]
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

/** @param {Record<string, unknown>} src @param {Record<string, unknown>} dst @param {string} key */
function copyIfString(src, dst, key) {
  const value = stringValue(src[key])
  if (value != null) dst[key] = value
}

/** @param {unknown} src @param {JsonObject} dst @param {string} key */
function copyIfPresent(src, dst, key) {
  if (!isPlainObject(src)) return
  const value = src[key]
  if (value !== undefined && value !== null) dst[key] = /** @type {JsonValue} */ (value)
}

/** @param {unknown} value */
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

/** @param {unknown} value */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (isPlainObject(value)) {
    const obj = /** @type {Record<string, unknown>} */ (value)
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key])
    return out
  }
  return value
}

/** @param {string} input */
function hashShort(input) {
  // 16-char hex prefix of SHA-256; matches the donor's
  // `sha256Hex(...).slice(0, 16)` so conversation ids stay stable
  // across the move from gateway core to this plugin.
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}
