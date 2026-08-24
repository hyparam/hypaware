// @ts-check

import { isPlainObject, stringValue } from 'hypaware/core/util'

/** @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, JsonObject, JsonValue } from '../../../../hypaware-plugin-kernel-types.js' */

/**
 * Project an SDK/export session snapshot without sorting either array.
 *
 * @param {unknown} raw
 * @param {{ entrypoint?: string, entrypointSource?: string }} [opts]
 * @returns {AiGatewayProjectedExchange | undefined}
 * @ref LLP 0306#recovery-lane [implements]: SDK/export array order and exact
 *   session/message/part/tool ids are authoritative across both lanes
 */
export function projectOpenCodeSnapshot(raw, opts = {}) {
  if (!isPlainObject(raw)) return undefined
  const session = isPlainObject(raw.info) ? raw.info : isPlainObject(raw.session) ? raw.session : undefined
  const messages = Array.isArray(raw.messages) ? raw.messages : undefined
  const sessionId = stringValue(session?.id)
  if (!session || !messages || !sessionId) return undefined
  const cwd = stringValue(session.directory)
  if (!cwd) return undefined

  /** @type {AiGatewayProjectedMessage[]} */
  const projected = []
  for (const rawMessage of messages) {
    if (!isPlainObject(rawMessage)) continue
    const info = isPlainObject(rawMessage.info) ? rawMessage.info : rawMessage
    const parts = Array.isArray(rawMessage.parts) ? rawMessage.parts : []
    const message = projectMessage(info, parts, projected.length)
    if (message) projected.push(message)
  }
  if (projected.length === 0) return undefined

  const entrypoint = opts.entrypoint && opts.entrypoint.length > 0 ? opts.entrypoint : 'unknown'
  const created = epochIso(readTime(session.time, 'created'))
  const model = isPlainObject(session.model) ? stringValue(session.model.id) : undefined
  const provider = isPlainObject(session.model) ? stringValue(session.model.providerID) : undefined
  return {
    provider: provider ?? firstMessageProvider(projected) ?? 'unknown',
    session_id: sessionId,
    conversation_id: sessionId,
    conversation_started_at: created,
    conversation_source: 'opencode',
    client_name: 'opencode',
    client_version: stringValue(session.version),
    entrypoint,
    cwd,
    model,
    attributes: {
      opencode: {
        entrypoint_source: opts.entrypointSource ?? 'historical-export',
        project_id: stringValue(session.projectID) ?? null,
        workspace_id: stringValue(session.workspaceID) ?? null,
        parent_session_id: stringValue(session.parentID) ?? null,
      },
    },
    messages: projected,
  }
}

/**
 * An OpenCode assistant message MUTATES under a stable id: its text streams in
 * and its tool parts settle after the id already exists. The shared
 * projected-exchange writer dedupes at MESSAGE grain (`state.seenMessages`), so
 * the first snapshot that projects an in-flight message freezes it: a later
 * snapshot of the same id writes nothing, and neither does the recovery lane,
 * whose seed reads the same committed message ids. Waiting for a terminal
 * assistant message is the message-grain form of the part-grain rule below, and
 * for the same reason: whatever lands first wins forever, so it must be the
 * complete one. A user message is terminal the moment it exists.
 *
 * @param {Record<string, unknown>} info @param {unknown[]} parts @param {number} index
 * @ref LLP 0306#recovery-lane [implements]: an unsettled turn is not persisted,
 *   because the append-only dedupe would keep its final state from landing
 */
function projectMessage(info, parts, index) {
  const role = stringValue(info.role) ?? stringValue(info.type)
  const id = stringValue(info.id)
  if (!role || !id) return undefined
  if (role === 'assistant' && !isSettledAssistantMessage(info)) return undefined
  /** @type {JsonObject[]} */
  const content = []
  for (const rawPart of parts) {
    if (!isPlainObject(rawPart)) continue
    const block = projectPart(rawPart)
    if (block) content.push(block)
  }
  if (content.length === 0) return undefined
  const parent = stringValue(info.parentID)
  const provider = stringValue(info.providerID) ?? (isPlainObject(info.model) ? stringValue(info.model.providerID) : undefined)
  const model = stringValue(info.modelID) ?? (isPlainObject(info.model) ? stringValue(info.model.modelID) : undefined)
  /** @type {AiGatewayProjectedMessage} */
  const message = {
    role,
    message_id: id,
    previous_message_id: parent ? [parent] : index === 0 ? [] : undefined,
    message_created_at: epochIso(readTime(info.time, 'created')),
    provider_uuid: id,
    parent_uuid: parent,
    provider,
    model,
    content,
    stop_reason: stringValue(info.finish),
    ...(stringValue(info.mode) ? { permission_mode: stringValue(info.mode) } : {}),
  }
  const usage = usageAttributes(info)
  if (usage) message.attributes = { usage }
  if (isPlainObject(info.error)) message.raw_frame = { error: jsonObject(info.error) }
  return message
}

/**
 * The three ways OpenCode reports that an assistant turn will not change again:
 * `time.completed` on a normal finish, `finish` alongside it, and `error` for an
 * aborted or failed turn. Any one of them settles the message.
 *
 * @param {Record<string, unknown>} info
 */
function isSettledAssistantMessage(info) {
  if (readTime(info.time, 'completed') !== undefined) return true
  if (stringValue(info.finish)) return true
  return isPlainObject(info.error)
}

/** @param {Record<string, unknown>} part @returns {JsonObject | undefined} */
export function projectOpenCodePart(part) {
  return projectPart(part)
}

function projectPart(part) {
  const id = stringValue(part.id)
  const type = stringValue(part.type)
  if (!id || !type) return undefined
  if (type === 'tool') {
    const state = isPlainObject(part.state) ? part.state : undefined
    const status = stringValue(state?.status)
    // Append-only canonical part ids cannot safely store an intermediate state.
    // @ref LLP 0306#recovery-lane [implements]: wait for completed/error so a
    //   pending row never wins the part-id dedupe over its final result
    if (status !== 'completed' && status !== 'error') return undefined
    const output = status === 'error'
      ? stringValue(state?.error)
      : stringValue(state?.output) ?? jsonText(state?.result) ?? jsonText(state?.structured)
    return /** @type {JsonObject} */ ({
      type: 'tool_result',
      part_id: id,
      tool_use_id: stringValue(part.callID) ?? id,
      name: stringValue(part.tool) ?? 'unknown',
      input: jsonValue(state?.input),
      content: output ?? '',
      is_error: status === 'error',
      raw_frame: jsonObject(part),
    })
  }
  if (type === 'text') {
    return /** @type {JsonObject} */ ({ type: 'text', part_id: id, text: stringValue(part.text) ?? '', raw_frame: jsonObject(part) })
  }
  if (type === 'reasoning') {
    return /** @type {JsonObject} */ ({ type: 'thinking', part_id: id, thinking: stringValue(part.text) ?? '', raw_frame: jsonObject(part) })
  }
  if (type === 'file') return /** @type {JsonObject} */ ({ type: 'file', part_id: id, raw_frame: jsonObject(part) })
  return /** @type {JsonObject} */ ({ type, part_id: id, raw_frame: jsonObject(part) })
}

/** @param {Record<string, unknown>} info @returns {JsonObject | undefined} */
function usageAttributes(info) {
  const tokens = isPlainObject(info.tokens) ? info.tokens : undefined
  const cache = isPlainObject(tokens?.cache) ? tokens.cache : undefined
  /** @type {JsonObject} */
  const usage = {}
  copyNumber(usage, 'input_tokens', tokens?.input)
  copyNumber(usage, 'output_tokens', tokens?.output)
  copyNumber(usage, 'reasoning_tokens', tokens?.reasoning)
  copyNumber(usage, 'cache_read_tokens', cache?.read)
  copyNumber(usage, 'cache_write_tokens', cache?.write)
  copyNumber(usage, 'total_tokens', tokens?.total)
  copyNumber(usage, 'cost_usd', info.cost)
  return Object.keys(usage).length > 0 ? usage : undefined
}

/** @param {JsonObject} out @param {string} key @param {unknown} value */
function copyNumber(out, key, value) {
  if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
}

/** @param {unknown} value */
function epochIso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return new Date(value).toISOString()
}

/** @param {unknown} value @param {string} key */
function readTime(value, key) {
  return isPlainObject(value) ? value[key] : undefined
}

/** @param {AiGatewayProjectedMessage[]} messages */
function firstMessageProvider(messages) {
  for (const message of messages) if (message.provider) return message.provider
  return undefined
}

/** @param {unknown} value */
function jsonText(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) } catch { return undefined }
}

/** @param {unknown} value */
function jsonValue(value) {
  if (value === undefined) return null
  try {
    return /** @type {JsonValue} */ (
      JSON.parse(JSON.stringify(value))
    )
  } catch {
    return null
  }
}

/** @param {Record<string, unknown>} value @returns {JsonObject} */
function jsonObject(value) {
  const normalized = jsonValue(value)
  return isPlainObject(normalized) ? /** @type {JsonObject} */ (normalized) : {}
}
