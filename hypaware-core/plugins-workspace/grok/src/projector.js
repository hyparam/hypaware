// @ts-check

import { createHash } from 'node:crypto'
import { isPlainObject, stringValue } from '../../../../src/core/util/index.js'

/** @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, JsonObject } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { GrokSession } from '../../../../hypaware-core/plugins-workspace/grok/src/types.js' */

const MAX_RUN_BYTES = 8 * 1024 * 1024
const RUN_KINDS = /** @type {Record<string, string>} */ ({ user_message_chunk: 'user', agent_message_chunk: 'assistant', agent_thought_chunk: 'thinking' })
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'error'])
const TOOL_META_KEY = 'x.ai/tool'
// A tool still running after this many lines stops holding the cursor back.
const MAX_OPEN_TOOL_LINES = 1024
// How many recent prompts a rewind can return to and still chain correctly.
const MAX_REWIND_PROMPTS = 256

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
 * @param {{ model?: string, previous?: string, prompts?: Map<number, string | undefined> }} [start] the model in force, last message built and prompt starts where this read begins
 * @ref LLP 0585#folding: runs and tool lifecycles settle at deterministic lines
 */
export function createGrokFolder(session, start = {}) {
  /** @type {any} */
  let run
  // Only user chunks name a model, so replies inherit the one in force.
  let currentModel = start.model
  // Written explicitly because reads are split into batches, each with its own
  // writer state, and the chain has to come out the same however they fall.
  let lastId = start.previous
  // What each prompt followed, which is where a rewind to that prompt continues.
  const prompts = new Map(start.prompts)
  /** @type {Map<string, any>} */
  const tools = new Map()

  /** @param {any} partial */
  function message(partial) {
    /** @type {AiGatewayProjectedMessage} */
    const out = { role: partial.role, content: partial.content, message_id: grokMessageId(session.id, partial.line), message_index: partial.line }
    if (partial.at !== undefined) out.message_created_at = new Date(partial.at).toISOString()
    if (partial.eventId) out.provider_uuid = partial.eventId
    if (partial.promptId) out.prompt_id = partial.promptId
    out.previous_message_id = lastId ? [lastId] : []
    lastId = out.message_id
    if (partial.role === 'assistant') {
      const model = partial.model ?? partial.currentModel ?? session.model
      if (model) out.model = model
    }
    return { message: out, atMs: partial.at, bytes: partial.bytes ?? 0, offset: partial.offset }
  }

  function closeRun() {
    if (!run) return []
    const closed = run
    run = undefined
    const content = []
    if (closed.kind === 'thinking') content.push({ type: 'thinking', thinking: closed.text })
    else if (closed.text) content.push({ type: 'text', text: closed.text })
    content.push(...closed.attachments)
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

  /**
   * @param {any} entry
   * @param {{ line: number, offset: number, bytes: number }} at
   */
  function fold(entry, at) {
      const params = isPlainObject(entry.params) ? entry.params : entry
      const update = isPlainObject(params.update) ? params.update : params
      // Timing and event ids ride the envelope. Grok puts modelId, promptIndex
      // and hostTurn on the update itself.
      const meta = /** @type {any} */ ({ ...(isPlainObject(params._meta) ? params._meta : {}), ...(isPlainObject(update._meta) ? update._meta : {}) })
      const kind = update.sessionUpdate
      const when = timestampOf(entry, meta)
      /** @type {any} */
      const common = { line: at.line, offset: at.offset, at: when, eventId: stringValue(meta.eventId), promptId: stringValue(meta.promptId), promptIndex: meta.promptIndex, model: stringValue(meta.modelId), bytes: at.bytes }
      // Slash-command output the host displayed. The model never saw it.
      if (meta.hostTurn === true) return []
      if (kind === 'user_message_chunk' && common.model) currentModel = common.model
      common.currentModel = currentModel
      if (RUN_KINDS[kind]) return pushChunk(kind, update, common)
      if (kind === 'tool_call') {
        const out = closeRun()
        const id = stringValue(update.toolCallId)
        if (id) {
          tools.set(id, { ...common, previous: lastId, id, name: toolName(update), input: toolInput(update) })
          if (TERMINAL.has(update.status)) out.push(...settleTool(id, update, common))
        }
        return out
      }
      if (kind === 'tool_call_update') {
        const id = stringValue(update.toolCallId)
        if (!id) return []
        const tool = tools.get(id)
        if (tool) {
          // A later title describes the call, such as a shell command line.
          tool.name = metaToolName(update) || tool.name || stringValue(update.title)
          tool.input = toolInput(update) ?? tool.input
          tool.bytes += at.bytes
        }
        if (!TERMINAL.has(update.status)) return []
        return [...closeRun(), ...settleTool(id, update, common)]
      }
      // A finished turn has no more chunks or lifecycle updates to wait for,
      // apart from a background tool, whose late result still links by id.
      if (kind === 'turn_completed') return [...closeRun(), ...closeTools()]
      if (kind === 'rewind_marker') return rewind(update.target_prompt_index)
      return []
  }

  return {
    /**
     * @param {any} entry
     * @param {{ line: number, offset: number, bytes: number }} at
     */
    push(entry, at) {
      const out = fold(entry, at)
      // @ref LLP 0585#bounds: a long tool must not make every hook reread the turn.
      // Insertion order, so only the oldest needs checking.
      for (const [id, tool] of tools) {
        if (at.line - tool.line < MAX_OPEN_TOOL_LINES) break
        tools.delete(id)
        out.push(useMessage(tool))
      }
      return out
    },
    /** The earliest line still open, where a re-read must resume. */
    earliestOpen() {
      /** @type {any} */
      let earliest = run
      for (const tool of tools.values()) if (!earliest || tool.line < earliest.line) earliest = tool
      return earliest ? { line: earliest.line, offset: earliest.offset, model: earliest.currentModel, previous: earliest.previous } : undefined
    },
    model() { return currentModel },
    previous() { return lastId },
    prompts() { return prompts },
    /** Settle everything left open, for a session that has gone quiet. */
    flush() { return [...closeRun(), ...closeTools()] },
  }

  /**
   * The log keeps the abandoned turns, but what follows continues from before
   * the target prompt, and the chain should say so.
   * @param {unknown} target
   * @ref LLP 0585#identity: dead branches stay recorded, off the live chain
   */
  function rewind(target) {
    const out = [...closeRun(), ...closeTools()]
    if (typeof target === 'number' && prompts.has(target)) {
      lastId = prompts.get(target)
      for (const index of prompts.keys()) if (index >= target) prompts.delete(index)
    }
    return out
  }

  /** @param {string} kind @param {any} update @param {any} common */
  function pushChunk(kind, update, common) {
    const out = []
    const runKind = RUN_KINDS[kind]
    const boundary = !run || run.kind !== runKind || run.promptId !== common.promptId || run.promptIndex !== common.promptIndex || run.bytes + common.bytes > MAX_RUN_BYTES
    if (boundary) out.push(...closeRun())
    // A new prompt ends the last turn. Older files have no turn_completed.
    if (runKind === 'user' && boundary) out.push(...closeTools())
    if (!run) {
      run = { ...common, previous: lastId, kind: runKind, text: '', attachments: [], bytes: 0 }
      if (runKind === 'user' && typeof common.promptIndex === 'number' && !prompts.has(common.promptIndex)) {
        if (prompts.size >= MAX_REWIND_PROMPTS) prompts.delete(prompts.keys().next().value ?? 0)
        prompts.set(common.promptIndex, lastId)
      }
    }
    run.bytes += common.bytes
    const content = update.content
    if (isPlainObject(content)) {
      if (content.type === 'text' && typeof content.text === 'string') run.text += content.text
      // Never copy image bytes into rows.
      else if (content.type === 'image') run.attachments.push({ type: 'image', mime_type: String(content.mimeType ?? '') })
      else if (content.type === 'resource_link') run.attachments.push({ type: 'text', text: resourceLabel(content) })
      // Embedded text is part of the prompt the model saw. A blob stays out.
      else if (content.type === 'resource') {
        const body = isPlainObject(content.resource) ? content.resource.text : undefined
        run.attachments.push({ type: 'text', text: typeof body === 'string' ? `${resourceLabel(content)}\n${body}` : resourceLabel(content) })
      }
    }
    return out
  }

  /** @param {string} id @param {any} update @param {any} common */
  function settleTool(id, update, common) {
    const tool = tools.get(id)
    tools.delete(id)
    // Named here because a batch boundary can separate a result from its call.
    const block = { type: 'tool_result', tool_use_id: id, ...(tool?.name ? { name: tool.name } : {}), content: toolOutput(update), is_error: update.status !== 'completed' || nonZeroExit(update) }
    // A tool_call that arrives already finished owns one line, so one message
    // carries both halves and the line stays a unique identity.
    if (tool?.line === common.line) return [message({ ...tool, role: 'assistant', content: [useBlock(tool), block] })]
    const use = tool ? [useMessage(tool)] : []
    return [...use, message({ ...common, role: 'user', content: [block] })]
  }
}

/** @param {any} update */
function metaToolName(update) {
  const tool = isPlainObject(update._meta) ? update._meta[TOOL_META_KEY] : undefined
  return isPlainObject(tool) ? stringValue(tool.name) : undefined
}

/** @param {any} update */
function toolName(update) {
  return metaToolName(update) ?? stringValue(update.title)
}

/** @param {any} block */
function resourceLabel(block) {
  return `[resource ${String(block.resource?.uri ?? block.uri ?? '')}]`.replace(' ]', ']')
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
  if (Array.isArray(update.content) && update.content.length) return update.content.map(blockText).join('\n')
  if (typeof update.rawOutput === 'string') return update.rawOutput
  return update.rawOutput === undefined || update.rawOutput === null ? '' : JSON.stringify(update.rawOutput)
}

/**
 * Text for one tool content block. Never copy image, audio or file bytes into rows.
 * @param {any} block
 */
function blockText(block) {
  if (block?.type !== 'content') return JSON.stringify(block)
  const inner = block.content
  if (inner?.type === 'text') return String(inner.text ?? '')
  if (inner?.type === 'image' || inner?.type === 'audio') return `[${inner.type} ${String(inner.mimeType ?? '')}]`.replace(' ]', ']')
  if (inner?.type === 'resource' || inner?.type === 'resource_link') return resourceLabel(inner)
  return `[${String(inner?.type ?? 'unknown')}]`
}

/**
 * Grok marks a shell command that ran and exited non-zero as `completed`.
 * @param {any} update
 */
function nonZeroExit(update) {
  const code = update.rawOutput?.exit_code
  return typeof code === 'number' && code !== 0
}

/**
 * @param {GrokSession} session
 * @param {AiGatewayProjectedMessage[]} messages
 * @returns {AiGatewayProjectedExchange | undefined}
 */
export function grokExchange(session, messages) {
  if (!messages.length) return undefined
  return { provider: 'unknown', session_id: session.id, conversation_id: session.id,
    ...(session.parent_thread_id ? { parent_thread_id: session.parent_thread_id, is_sidechain: true } : {}),
    ...(session.git ?? {}),
    // Otherwise the gateway stamps the time of each write.
    conversation_started_at: session.started_at ?? messages[0].message_created_at,
    conversation_source: 'grok', client_name: 'grok', cwd: session.cwd, entrypoint: 'unknown', messages }
}
