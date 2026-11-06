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
      // Session settings totals include multiple turns and sometimes children.
    })
  }
  if (!messages.length) return undefined
  return { provider: 'unknown', session_id: String(session.id), conversation_id: String(session.id),
    conversation_source: 'droid', client_name: 'droid', cwd: String(session.cwd), entrypoint: 'unknown', messages }
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
