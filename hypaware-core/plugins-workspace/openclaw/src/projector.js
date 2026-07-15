// @ts-check

import { isPlainObject, parseMaybeJson, sha256Hex, stringValue } from 'hypaware/core/util'

/**
 * @import { AiGatewayExchangeProjector, AiGatewayProjectedExchange, AiGatewayProjectedMessage, AiGatewayUpstreamPreset, JsonObject } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * OpenClaw exchange projector: a minimal, self-contained Anthropic
 * Messages parser (plugins never import each other, so none of the
 * Claude plugin's parsing is reused). Deliberately lean; v1 skips:
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
 * @ref LLP 0109#gateway-capture [implements]: header-gated projector with priority above the Claude projector
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

      const responseBody = parseMaybeJson(input.response_body)
      const messages = anthropicMessages(
        reqBody,
        responseBody,
        Array.isArray(input.stream_events) ? input.stream_events : []
      )
      if (messages.length === 0) {
        ctx.log.debug?.('plugin.openclaw.projector_skip', {
          reason: 'no_messages_in_exchange',
          exchange_id: input.exchange_id,
        })
        return undefined
      }

      const systemText = extractSystemText(reqBody.system)
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

      /** @type {AiGatewayProjectedExchange} */
      const projection = {
        provider: 'anthropic',
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
 * `/v1/messages` upstream. MUST stay byte-equivalent in meaning to the
 * Claude plugin's `anthropicUpstreamPreset()`: same `anthropic` name,
 * base URL, path prefix, priority, and match surface, because whichever
 * plugin registers last wins the preset-map slot and routing must not
 * depend on plugin activation order.
 *
 * @ref LLP 0109#gateway-capture [constrained-by]: the preset is identical and the name must stay `anthropic` (LLP 0016)
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
      if (isAnthropicPath(input.path)) return true
      return hasAnthropicHeaderSignature(input.headers)
    },
  }
}

/** @param {string} path */
export function isAnthropicPath(path) {
  return path === '/v1/messages' || path.startsWith('/v1/messages/')
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
 * prompt, of the first message's content; without messages, of the
 * exchange id, so the partition key is never null.
 *
 * @param {Record<string, unknown>} reqBody
 * @param {string | undefined} systemText
 * @param {string} exchangeId
 * @returns {string}
 */
export function openclawSessionId(reqBody, systemText, exchangeId) {
  if (systemText) return hashShort(systemText.slice(0, SESSION_HASH_HEAD_CHARS))
  const messages = Array.isArray(reqBody.messages) ? reqBody.messages : []
  if (messages.length > 0 && isPlainObject(messages[0])) {
    return hashShort(JSON.stringify(messages[0].content))
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
  block.input = parseMaybeJson(partialJsonByIndex.get(index) ?? '')
  partialJsonByIndex.delete(index)
}

/**
 * `attributes.usage` for a message carrying Anthropic `usage`, with the
 * cache fields normalized to the gateway-wide names
 * (`cache_read_tokens` / `cache_write_tokens`), matching the Claude and
 * Codex adapters so token queries aggregate across clients.
 *
 * @ref LLP 0035#one-carrier [implements]: usage rides the assistant response message only
 * @param {Record<string, unknown>} message
 * @returns {JsonObject | undefined}
 */
function usageAttributes(message) {
  if (!isPlainObject(message.usage)) return undefined
  const usage = message.usage
  /** @type {JsonObject} */
  const out = {}
  if (usage.input_tokens != null) out.input_tokens = /** @type {any} */ (usage.input_tokens)
  if (usage.output_tokens != null) out.output_tokens = /** @type {any} */ (usage.output_tokens)
  if (usage.cache_read_input_tokens != null) out.cache_read_tokens = /** @type {any} */ (usage.cache_read_input_tokens)
  if (usage.cache_creation_input_tokens != null) out.cache_write_tokens = /** @type {any} */ (usage.cache_creation_input_tokens)
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
