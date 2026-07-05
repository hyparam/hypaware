// @ts-check

import { isPlainObject, parseMaybeJson, stringValue } from 'hypaware/core/util'

/**
 * Projection of OpenAI Responses items into gateway content blocks:
 * the shared core of the batch backfill (`backfill.js`) and the live
 * exchange projector (`exchange-projector.js`). Living here, rather
 * than mirrored in both by hand, is what keeps live-captured and
 * backfilled rows for the same conversation shape-identical so the
 * kernel's content-hash dedupe folds them to one row.
 */

/**
 * @import { AiGatewayProjectedMessage, JsonObject, JsonValue } from '../../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Message content blocks use `input_text` / `output_text` (the
 * Responses API), which both normalize to the gateway's `text` block.
 * A bare string entry (or a bare string in a content array) is
 * tolerated for older/leaner records.
 *
 * @param {unknown} content
 * @returns {JsonObject[]}
 */
export function textBlocksFromContent(content) {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  /** @type {JsonObject[]} */
  const blocks = []
  for (const raw of content) {
    if (typeof raw === 'string') {
      if (raw.length > 0) blocks.push({ type: 'text', text: raw })
      continue
    }
    if (!isPlainObject(raw)) continue
    const text = stringValue(raw.text) ?? stringValue(raw.input_text) ?? stringValue(raw.output_text)
    if (text) blocks.push({ type: 'text', text })
  }
  return blocks
}

/**
 * `function_call` (arguments as a JSON string) and `custom_tool_call`
 * (input string) both become a `tool_use` block keyed on the Codex
 * `call_id`, so the gateway can pair it with the matching output.
 *
 * @param {Record<string, unknown>} payload
 * @returns {JsonObject | undefined}
 */
export function toolUseBlockFromPayload(payload) {
  const name = stringValue(payload.name)
  const callId = stringValue(payload.call_id) ?? stringValue(payload.id)
  if (!name || !callId) return undefined
  const rawArgs = payload.arguments !== undefined ? payload.arguments : payload.input
  return { type: 'tool_use', id: callId, name, input: normalizeToolInput(rawArgs) }
}

/**
 * `function_call_output` / `custom_tool_call_output` become a
 * `tool_result` block referencing the originating `call_id`. The
 * gateway maps it to a `tool_result` part and back-fills the tool name
 * from the earlier call.
 *
 * @param {Record<string, unknown>} payload
 * @returns {JsonObject | undefined}
 */
export function toolResultBlockFromPayload(payload) {
  const callId = stringValue(payload.call_id) ?? stringValue(payload.id)
  if (!callId) return undefined
  const text = toolOutputText(payload.output)
  /** @type {JsonObject} */
  const block = { type: 'tool_result', tool_use_id: callId }
  if (text !== undefined) block.content = text
  return block
}

/**
 * Tool call arguments arrive as a JSON string on the wire; parse them
 * so the block carries structured input, keeping the raw string when
 * it is not JSON.
 *
 * @param {unknown} value
 * @returns {JsonValue}
 */
export function normalizeToolInput(value) {
  if (typeof value === 'string') {
    const parsed = parseMaybeJson(value)
    return parsed === value ? value : /** @type {JsonValue} */ (parsed)
  }
  if (value === undefined) return null
  return /** @type {JsonValue} */ (value)
}

/**
 * Codex tool output is usually a string, sometimes a wrapper object
 * (`{ output | content | text: "..." }`) or a structured payload.
 * Reduce it to display text best-effort; structured payloads are
 * JSON-stringified so the row keeps a faithful, queryable trace.
 *
 * @param {unknown} output
 * @returns {string | undefined}
 */
export function toolOutputText(output) {
  if (typeof output === 'string') return output.length > 0 ? output : undefined
  if (isPlainObject(output)) {
    const inner = stringValue(output.output) ?? stringValue(output.content) ?? stringValue(output.text)
    return inner ?? JSON.stringify(output)
  }
  if (output === undefined || output === null) return undefined
  return JSON.stringify(output)
}

/**
 * `reasoning` items carry plaintext `summary` and/or `content` plus
 * opaque `encrypted_content`. Only the plaintext is projected (as a
 * `thinking` block → `reasoning` part); encrypted reasoning is never
 * decoded or stored. No plaintext → no message.
 *
 * @param {Record<string, unknown>} payload
 * @returns {AiGatewayProjectedMessage | undefined}
 */
export function reasoningMessageFromPayload(payload) {
  const text = reasoningText(payload.summary) ?? reasoningText(payload.content)
  if (!text) return undefined
  return { role: 'assistant', content: [{ type: 'thinking', thinking: text }] }
}

/** @param {unknown} value @returns {string | undefined} */
export function reasoningText(value) {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (!Array.isArray(value)) return undefined
  /** @type {string[]} */
  const parts = []
  for (const raw of value) {
    if (typeof raw === 'string') {
      if (raw) parts.push(raw)
      continue
    }
    if (!isPlainObject(raw)) continue
    const text = stringValue(raw.text) ?? stringValue(raw.summary_text)
    if (text) parts.push(text)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

// ---------------------------------------------------------------------
// Usage (LLP 0035)
// ---------------------------------------------------------------------

/**
 * Start a normalized `attributes.usage` object with input tokens NET
 * of cached prompt reads.
 *
 * @ref LLP 0035#net-input: OpenAI/Codex report input_tokens INCLUSIVE
 * of cached prompt reads; HypAware stores input_tokens net of cache so
 * it never double-counts against cache_read_tokens and matches the
 * Claude convention (input + cache_read [+ cache_write] = total
 * prompt). total_tokens stays the provider's raw value, so
 * net_input + cache_read + output == total holds.
 *
 * @param {number | undefined} grossInput
 * @param {number | undefined} cachedInput
 * @returns {JsonObject}
 */
export function netInputUsage(grossInput, cachedInput) {
  /** @type {JsonObject} */
  const usage = {}
  if (grossInput !== undefined) {
    usage.input_tokens = cachedInput !== undefined ? Math.max(0, grossInput - cachedInput) : grossInput
  }
  if (cachedInput !== undefined) usage.cache_read_tokens = cachedInput
  return usage
}

/**
 * Stamp response/turn usage onto the LAST assistant message at or
 * after `startIndex` that carries text or a tool_use (the terminal
 * output item, a tool_use on tool-calling turns, else the final text).
 * One carrier per response keeps a SUM over rows honest, and because
 * live and backfill share this exact function they fold usage onto the
 * same logical row and dedupe to one. Reasoning-only (thinking)
 * messages are skipped; if no eligible message exists (e.g. windowed
 * out) the usage is dropped rather than mis-attributed.
 * @ref LLP 0035#one-carrier
 *
 * @param {AiGatewayProjectedMessage[]} messages
 * @param {JsonObject | undefined} usageAttributes
 * @param {number} [startIndex]
 */
export function stampUsageOnLastAssistant(messages, usageAttributes, startIndex = 0) {
  if (!usageAttributes) return
  for (let i = messages.length - 1; i >= startIndex; i--) {
    const message = messages[i]
    if (message.role !== 'assistant' || !hasTextOrToolUse(message)) continue
    message.attributes = mergeJsonObjects(message.attributes, usageAttributes)
    return
  }
}

/**
 * A message is an eligible usage carrier when it has a text or
 * tool_use block. @ref LLP 0035#one-carrier
 *
 * @param {AiGatewayProjectedMessage} message
 */
export function hasTextOrToolUse(message) {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => {
    const type = isPlainObject(block) ? block.type : undefined
    return type === 'text' || type === 'tool_use'
  })
}

/**
 * @param {JsonObject | undefined} a
 * @param {JsonObject | undefined} b
 * @returns {JsonObject | undefined}
 */
export function mergeJsonObjects(a, b) {
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

// ---------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------

/** @param {unknown} value @returns {number | undefined} */
export function numberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * @param {Record<string, unknown>} source
 * @param {JsonObject} target
 * @param {string} sourceKey
 * @param {string} targetKey
 */
export function copyNumberAlias(source, target, sourceKey, targetKey) {
  const value = numberValue(source[sourceKey])
  if (value !== undefined) target[targetKey] = value
}

/** @param {JsonObject} target @param {string} key @param {string | undefined} value */
export function setIfString(target, key, value) {
  if (value !== undefined) target[key] = value
}

/** @param {...(string | undefined)} values */
export function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0)
}
