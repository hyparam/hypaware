// @ts-check

import { createHash } from 'node:crypto'
import path from 'node:path'
import { isPlainObject, stringValue } from '../../../../src/core/util/index.js'

/** @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, JsonObject } from '../../../../hypaware-plugin-kernel-types.js' */

/** @param {unknown} value */
export function piSessionHeader(value) {
  if (!isPlainObject(value) || value.type !== 'session' || value.version !== 3) return undefined
  if (!stringValue(value.id) || !stringValue(value.cwd) || !path.isAbsolute(String(value.cwd))) return undefined
  if (!iso(value.timestamp)) return undefined
  return value
}

/** @param {Record<string, any>} session @param {string} id */
export function piMessageId(session, id) {
  return `pi:${createHash('sha256').update(JSON.stringify([session.id, session.cwd, id])).digest('hex')}`
}

/** Ignore the parentId that Pi re-chains when copying a branch. @param {Record<string, any>} entry */
export function piEntryFingerprint(entry) {
  return createHash('sha256').update(JSON.stringify([
    entry.id, entry.timestamp, entry.type, entry.message ?? entry.content ?? entry.summary, entry.usage,
  ])).digest('hex')
}

/**
 * @param {unknown} raw
 * @param {{ entrypoint?: string, inherited?: Map<string, string> }} [opts]
 * @returns {AiGatewayProjectedExchange | undefined}
 * @ref LLP 0416#identity: native session entries give both lanes identical IDs and usage
 */
export function projectPiEntries(raw, opts = {}) {
  if (!isPlainObject(raw)) return undefined
  const session = piSessionHeader(raw.session)
  if (!session || !Array.isArray(raw.entries)) return undefined
  /** @type {AiGatewayProjectedMessage[]} */
  const messages = []
  for (const entry of raw.entries) {
    if (!isPlainObject(entry) || !stringValue(entry.id) || !iso(entry.timestamp)) continue
    const parentFingerprint = opts.inherited?.get(String(entry.id))
    const inherited = parentFingerprint !== undefined && parentFingerprint === piEntryFingerprint(entry)
    const projected = projectEntry(session, entry, inherited)
    if (projected) messages.push(projected)
  }
  if (!messages.length) return undefined
  return {
    provider: 'unknown', session_id: String(session.id), conversation_id: String(session.id),
    conversation_started_at: String(session.timestamp), conversation_source: 'pi', client_name: 'pi',
    cwd: String(session.cwd), entrypoint: opts.entrypoint ?? 'unknown', messages,
  }
}

/** @param {Record<string, any>} session @param {Record<string, any>} entry @param {boolean} inherited */
function projectEntry(session, entry, inherited) {
  const summary = entry.type === 'compaction' || entry.type === 'branch_summary'
  const custom = entry.type === 'custom_message'
  /** @type {Record<string, any> | undefined} */
  const msg = summary ? { role: 'assistant', content: entry.summary, usage: entry.usage }
    : custom ? { role: 'user', content: entry.content }
      : entry.type === 'message' && isPlainObject(entry.message) ? entry.message : undefined
  if (!msg || msg.stopReason === 'pending') return undefined
  const role = msg.role === 'toolResult' || msg.role === 'bashExecution' ? 'tool' : msg.role
  if (!['user', 'assistant', 'tool', 'system'].includes(role)) return undefined
  /** @type {JsonObject[]} */
  let content = []
  if (msg.role === 'toolResult') {
    content = [{ type: 'tool_result', tool_use_id: msg.toolCallId ?? '', name: msg.toolName ?? 'unknown', content: textBlocks(msg.content), is_error: msg.isError === true }]
  } else if (msg.role === 'bashExecution') {
    content = [{ type: 'text', text: String(msg.output ?? '') }]
  } else if (typeof msg.content === 'string') content = [{ type: 'text', text: msg.content }]
  else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!isPlainObject(block)) continue
      if (block.type === 'text') content.push({ type: 'text', text: String(block.text ?? '') })
      else if (block.type === 'thinking') content.push({ type: 'thinking', thinking: String(block.thinking ?? '') })
      else if (block.type === 'toolCall') content.push({ type: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? 'unknown'), input: /** @type {JsonObject} */ (isPlainObject(block.arguments) ? block.arguments : {}) })
      else if (block.type === 'image') content.push({ type: 'image', mime_type: String(block.mimeType ?? '') })
    }
  }
  // Empty error/aborted responses may still carry billed usage.
  if (!content.length) content = [{ type: 'text', text: '' }]
  const usage = piUsage(msg.usage)
  /** @type {JsonObject} */
  const attributes = {}
  if (usage && !inherited && msg.role === 'assistant') attributes.usage = usage
  if (usage && msg.role === 'toolResult') attributes.raw_usage = usage
  if (inherited) attributes.is_inherited = true
  if (typeof msg.errorMessage === 'string') attributes.error = msg.errorMessage
  if (msg.role === 'bashExecution') attributes.command = String(msg.command ?? '')
  /** @type {AiGatewayProjectedMessage} */
  const result = {
    role, content, message_id: piMessageId(session, entry.id),
    previous_message_id: entry.parentId ? [piMessageId(session, entry.parentId)] : [],
    provider_uuid: entry.id, parent_uuid: stringValue(entry.parentId),
    message_created_at: iso(entry.timestamp),
    provider: stringValue(msg.provider), model: stringValue(msg.model),
    stop_reason: stringValue(msg.stopReason), attributes,
    ...(summary ? { is_compact_summary: true, provider_subtype: entry.type } : {}),
  }
  return result
}

/** @param {unknown} value @returns {JsonObject | undefined} */
export function piUsage(value) {
  if (!isPlainObject(value)) return undefined
  /** @type {JsonObject} */
  const usage = {}
  for (const [from, to] of [['input', 'input_tokens'], ['output', 'output_tokens'], ['cacheRead', 'cache_read_tokens'], ['cacheWrite', 'cache_write_tokens'], ['totalTokens', 'total_tokens'], ['reasoning', 'reasoning_tokens']]) {
    const n = value[from]
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) usage[to] = n
  }
  const cost = isPlainObject(value.cost) ? value.cost.total : undefined
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) usage.cost_usd = cost
  return Object.keys(usage).length ? usage : undefined
}

/** @param {unknown} value */
function iso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined
  return new Date(value).toISOString()
}

/** @param {unknown} value */
function textBlocks(value) {
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value.filter(isPlainObject).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n') : ''
}
