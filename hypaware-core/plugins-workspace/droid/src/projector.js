// @ts-check

import { createHash } from 'node:crypto'
import path from 'node:path'
import { isPlainObject, stringValue } from '../../../../src/core/util/index.js'

/** @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, JsonObject } from '../../../../hypaware-plugin-kernel-types.js' */

/** @param {unknown} value */
export function droidSessionHeader(value) {
  if (!isPlainObject(value) || value.type !== 'session_start' || value.version !== 2) return undefined
  if (!stringValue(value.id) || !stringValue(value.cwd) || !path.isAbsolute(String(value.cwd))) return undefined
  return value
}

/** @param {Record<string, any>} session @param {string} id */
export function droidMessageId(session, id) {
  return `droid:${createHash('sha256').update(JSON.stringify([session.id, session.cwd, id])).digest('hex')}`
}

/**
 * @param {Record<string, any>} session
 * @param {Record<string, any>[]} entries
 * @param {number[]} positions
 * @returns {AiGatewayProjectedExchange | undefined}
 * @ref LLP 0551#identity: native message identities and positions are shared by both lanes
 */
export function projectDroidEntries(session, entries, positions) {
  if (!droidSessionHeader(session) || entries.length !== positions.length) return undefined
  /** @type {AiGatewayProjectedMessage[]} */
  const messages = []
  for (const [index, entry] of entries.entries()) {
    const msg = entry.message
    if (entry.type !== 'message' || !stringValue(entry.id) || !isPlainObject(msg) || !['user', 'assistant'].includes(String(msg.role))) continue
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    const position = positions[index]
    if (!Number.isFinite(at) || !Number.isInteger(position) || position < 0 || position > 2147483647) throw new Error('invalid_message')
    const content = blocks(msg.content)
    if (!content.length) continue
    messages.push({
      role: String(msg.role), content, message_id: droidMessageId(session, String(entry.id)),
      previous_message_id: stringValue(entry.parentId) ? [droidMessageId(session, String(entry.parentId))] : [],
      provider_uuid: String(entry.id), parent_uuid: stringValue(entry.parentId),
      message_index: position, message_created_at: new Date(at).toISOString(),
      model: stringValue(msg.modelId), provider: stringValue(msg.apiProvider),
      // The record's `tokens` is a context estimate, not billed token usage.
    })
  }
  if (!messages.length) return undefined
  return { provider: 'unknown', session_id: String(session.id), conversation_id: String(session.id),
    conversation_source: 'droid', client_name: 'droid', cwd: String(session.cwd), entrypoint: 'unknown',
    parent_thread_id: stringValue(session.callingSessionId), messages }
}

/** @param {Record<string, any>} session */
export function droidUsageScope(session) {
  return { client_name: 'droid', session_id: String(session.id), message_id: `droid-usage:${droidMessageId(session, 'usage')}` }
}

/**
 * @ref LLP 0598#accounting: own-session totals, never child-inclusive or per-message estimates
 * @param {Record<string, any>} session
 * @param {unknown} settings
 * @param {string} startedAt
 * @param {string} observedAt
 * @returns {AiGatewayProjectedExchange | undefined}
 */
export function projectDroidUsage(session, settings, startedAt, observedAt) {
  if (!isPlainObject(settings) || !isPlainObject(settings.tokenUsage)) return undefined
  const native = settings.tokenUsage
  /** @type {JsonObject} */
  const usage = {}
  for (const [from, to] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'],
    ['cacheCreationTokens', 'cache_write_tokens'], ['cacheReadTokens', 'cache_read_tokens'], ['thinkingTokens', 'reasoning_tokens']]) {
    if (native[from] === undefined || native[from] === null) continue
    if (typeof native[from] !== 'number' || !Number.isSafeInteger(native[from]) || native[from] < 0) throw new Error('invalid_usage_counter')
    usage[to] = native[from]
  }
  if (!Object.keys(usage).length) return undefined
  /** @type {JsonObject} */
  const droid = { usage_observed_at: observedAt }
  if (typeof native.factoryCredits === 'number' && Number.isSafeInteger(native.factoryCredits) && native.factoryCredits >= 0) droid.factory_credits = native.factoryCredits
  const messageId = droidUsageScope(session).message_id
  // @ref LLP 0598#remote: each revision needs its own part_id, or central ingest's part_id dedup keeps only the first snapshot.
  const revision = createHash('sha256').update(JSON.stringify([usage, droid])).digest('hex').slice(0, 16)
  return {
    provider: 'unknown', client_name: 'droid', conversation_source: 'droid',
    session_id: String(session.id), conversation_id: String(session.id), cwd: String(session.cwd),
    conversation_started_at: startedAt, parent_thread_id: stringValue(session.callingSessionId),
    messages: [{ role: 'system', provider_subtype: 'session_usage',
      message_id: messageId, message_created_at: startedAt,
      message_index: 0, previous_message_id: [], content: [{ type: 'status', status: 'session_usage', part_id: `${messageId}#${revision}` }],
      attributes: { usage, droid } }],
  }
}

/** @param {unknown} value @returns {JsonObject[]} */
function blocks(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) return []
  const result = []
  for (const block of value) {
    if (!isPlainObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') result.push({ type: 'text', text: block.text })
    else if (block.type === 'tool_use' && stringValue(block.id) && stringValue(block.name)) {
      result.push({ type: 'tool_use', id: String(block.id), name: String(block.name), input: /** @type {JsonObject} */ (isPlainObject(block.input) ? block.input : {}) })
    } else if (block.type === 'tool_result' && stringValue(block.tool_use_id)) {
      if (block.content === '__TOOL_RESULT_PENDING__') continue
      const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
        ? block.content.filter(isPlainObject).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n') : ''
      result.push({ type: 'tool_result', tool_use_id: String(block.tool_use_id), content, is_error: block.is_error === true })
    } else if (block.type === 'image') result.push({ type: 'image', mime_type: isPlainObject(block.source) ? String(block.source.media_type ?? '') : '' })
    else if (block.type === 'document' && isPlainObject(block.source) && block.source.type === 'text' && typeof block.source.data === 'string') {
      result.push({ type: 'text', text: block.source.data })
    }
    // Do not copy signatures, encrypted reasoning, or load referenced files.
  }
  return result
}
