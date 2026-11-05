// @ts-check

import { createHash } from 'node:crypto'
import { isPlainObject, stringValue } from '../../../../src/core/util/index.js'

/** @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, JsonObject } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { GrokSession } from '../../../../hypaware-core/plugins-workspace/grok/src/types.js' */

const MAX_RUN_BYTES = 8 * 1024 * 1024
const RUN_KINDS = /** @type {Record<string, string>} */ ({ user_message_chunk: 'user', agent_message_chunk: 'assistant', agent_thought_chunk: 'thinking' })
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'error'])
const TOOL_META_KEY = 'x.ai/tool'

/**
 * @param {string} sessionId
 * @param {number} line
 * @ref LLP 0585#identity: session and line, not event ids or cwd
 */
export function grokMessageId(sessionId, line) {
  return `grok:${createHash('sha256').update(JSON.stringify([sessionId, line])).digest('hex')}`
}

/** @param {any} entry @param {any} meta @returns {number | undefined} */
function timestampOf(entry, meta) {
  if (Number.isFinite(meta.agentTimestampMs) && meta.agentTimestampMs > 0) return meta.agentTimestampMs
  // Envelope seconds, written by every current update. Zero means unset.
  if (Number.isFinite(entry.timestamp) && entry.timestamp > 0) return entry.timestamp * 1000
  return undefined
}

/**
 * Folds the update stream into whole messages. An item stays open until a
 * later update settles it, so the caller holds its cursor before the earliest
 * open line and a re-read always rebuilds the same messages.
 *
 * @param {GrokSession} session
 * @ref LLP 0585#folding: runs and tool lifecycles settle at deterministic lines
 */
export function createGrokFolder(session) {
  /** @type {any} */
  let run
  /** @type {Map<string, any>} */
  const tools = new Map()

  /** @param {any} partial */
  function message(partial) {
    /** @type {AiGatewayProjectedMessage} */
    const out = { role: partial.role, content: partial.content, message_id: grokMessageId(session.id, partial.line), message_index: partial.line }
    if (partial.at !== undefined) out.message_created_at = new Date(partial.at).toISOString()
    if (partial.eventId) out.provider_uuid = partial.eventId
    if (partial.promptId) out.prompt_id = partial.promptId
    if (partial.role === 'assistant') {
      const model = partial.model ?? session.model
      if (model) out.model = model
    }
    return { message: out, atMs: partial.at, bytes: partial.bytes ?? 0 }
  }

  function closeRun() {
    if (!run) return []
    const closed = run
    run = undefined
    const content = []
    if (closed.kind === 'thinking') content.push({ type: 'thinking', thinking: closed.text })
    else if (closed.text) content.push({ type: 'text', text: closed.text })
    content.push(...closed.images)
    if (!content.length) return []
    return [message({ ...closed, role: closed.kind === 'user' ? 'user' : 'assistant', content })]
  }

  /** @param {any} tool */
  function useBlock(tool) {
    return { type: 'tool_use', id: tool.id, name: tool.name || 'unknown', input: tool.input ?? {} }
  }

  /** @param {any} tool */
  function useMessage(tool) {
    return message({ ...tool, role: 'assistant', content: [useBlock(tool)] })
  }

  function closeTools() {
    const closed = [...tools.values()].map(useMessage)
    tools.clear()
    return closed
  }

  return {
    /**
     * @param {any} entry
     * @param {{ line: number, offset: number, bytes: number }} at
     */
    push(entry, at) {
      const params = isPlainObject(entry.params) ? entry.params : entry
      const update = isPlainObject(params.update) ? params.update : params
      // Timing and event ids ride the envelope. Grok puts modelId, promptIndex
      // and hostTurn on the update itself.
      const meta = /** @type {any} */ ({ ...(isPlainObject(params._meta) ? params._meta : {}), ...(isPlainObject(update._meta) ? update._meta : {}) })
      const kind = update.sessionUpdate
      const when = timestampOf(entry, meta)
      const common = { line: at.line, offset: at.offset, at: when, eventId: stringValue(meta.eventId), promptId: stringValue(meta.promptId), promptIndex: meta.promptIndex, model: stringValue(meta.modelId), bytes: at.bytes }
      // Slash-command output the host displayed. The model never saw it.
      if (meta.hostTurn === true) return []
      if (RUN_KINDS[kind]) return pushChunk(kind, update, common)
      if (kind === 'tool_call') {
        const out = closeRun()
        const id = stringValue(update.toolCallId)
        if (id) {
          tools.set(id, { ...common, id, name: toolName(update), input: toolInput(update) })
          if (TERMINAL.has(update.status)) out.push(...settleTool(id, update, common))
        }
        return out
      }
      if (kind === 'tool_call_update') {
        const id = stringValue(update.toolCallId)
        if (!id) return []
        const tool = tools.get(id)
        if (tool) {
          tool.name = toolName(update) || tool.name
          tool.input = toolInput(update) ?? tool.input
          tool.bytes += at.bytes
        }
        if (!TERMINAL.has(update.status)) return []
        return [...closeRun(), ...settleTool(id, update, common)]
      }
      // A finished turn has no more chunks or lifecycle updates to wait for,
      // apart from a background tool, whose late result still links by id.
      if (kind === 'turn_completed') return [...closeRun(), ...closeTools()]
      return []
    },
    /** The earliest line still open, where a re-read must resume. */
    earliestOpen() {
      /** @type {any} */
      let earliest = run
      for (const tool of tools.values()) if (!earliest || tool.line < earliest.line) earliest = tool
      return earliest ? { line: earliest.line, offset: earliest.offset } : undefined
    },
    /** Settle everything left open, for a session that has gone quiet. */
    flush() { return [...closeRun(), ...closeTools()] },
  }

  /** @param {string} kind @param {any} update @param {any} common */
  function pushChunk(kind, update, common) {
    const out = []
    const runKind = RUN_KINDS[kind]
    const boundary = !run || run.kind !== runKind || run.promptId !== common.promptId || run.promptIndex !== common.promptIndex || run.bytes + common.bytes > MAX_RUN_BYTES
    if (boundary) out.push(...closeRun())
    // A new prompt ends the last turn. Older files have no turn_completed.
    if (runKind === 'user' && boundary) out.push(...closeTools())
    if (!run) run = { ...common, kind: runKind, text: '', images: [], bytes: 0 }
    run.bytes += common.bytes
    const content = update.content
    if (isPlainObject(content)) {
      if (content.type === 'text' && typeof content.text === 'string') run.text += content.text
      // Never copy image bytes into rows.
      else if (content.type === 'image') run.images.push({ type: 'image', mime_type: String(content.mimeType ?? '') })
    }
    return out
  }

  /** @param {string} id @param {any} update @param {any} common */
  function settleTool(id, update, common) {
    const tool = tools.get(id)
    tools.delete(id)
    const block = { type: 'tool_result', tool_use_id: id, content: toolOutput(update), is_error: update.status !== 'completed' }
    // A tool_call that arrives already finished owns one line, so one message
    // carries both halves and the line stays a unique identity.
    if (tool?.line === common.line) return [message({ ...tool, role: 'assistant', content: [useBlock(tool), block] })]
    const result = message({ ...common, role: 'user', content: [block] })
    return tool ? [useMessage(tool), result] : [result]
  }
}

/** @param {any} update */
function toolName(update) {
  const tool = isPlainObject(update._meta) ? update._meta[TOOL_META_KEY] : undefined
  return (isPlainObject(tool) ? stringValue(tool.name) : undefined) ?? stringValue(update.title)
}

/** @param {any} update @returns {JsonObject | undefined} */
function toolInput(update) {
  if (isPlainObject(update.rawInput)) return update.rawInput
  const tool = isPlainObject(update._meta) ? update._meta[TOOL_META_KEY] : undefined
  return isPlainObject(tool) && isPlainObject(tool.input) ? /** @type {JsonObject} */ (tool.input) : undefined
}

/** @param {any} update */
function toolOutput(update) {
  // Prefer the rendered text. rawOutput repeats it inside a typed wrapper with
  // several concise and absolute-path variants, often at triple the size.
  if (Array.isArray(update.content) && update.content.length) {
    return update.content.map((/** @type {any} */ block) => {
      if (block?.type === 'content' && block.content?.type === 'text') return String(block.content.text ?? '')
      return JSON.stringify(block)
    }).join('\n')
  }
  if (typeof update.rawOutput === 'string') return update.rawOutput
  return update.rawOutput === undefined || update.rawOutput === null ? '' : JSON.stringify(update.rawOutput)
}

/**
 * @param {GrokSession} session
 * @param {AiGatewayProjectedMessage[]} messages
 * @returns {AiGatewayProjectedExchange | undefined}
 */
export function grokExchange(session, messages) {
  if (!messages.length) return undefined
  return { provider: 'unknown', session_id: session.id, conversation_id: session.id,
    ...(session.parent_thread_id ? { parent_thread_id: session.parent_thread_id } : {}),
    conversation_source: 'grok', client_name: 'grok', cwd: session.cwd, entrypoint: 'unknown', messages }
}
