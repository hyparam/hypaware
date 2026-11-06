// Normalize visible callbacks into the existing session schema.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { redactRemoteUserinfo } from '../../codex/src/git-remote.js'

const exec = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const text = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => ['text', 'output_text'].includes(block.type)).map(block => block.text ?? '').join('\n')
  : content == null ? '' : JSON.stringify(content)

// @ref LLP 0032#capture: capture on the producer, never reconstruct historical HEAD at replay time
/** @param {string} [cwd] @param {Function} [run] */
export async function projectContext(cwd = process.cwd(), run = exec) {
  cwd = path.resolve(cwd)
  const fields = [
    ['repo_root', ['rev-parse', '--show-toplevel']],
    ['git_remote', ['config', '--get', 'remote.origin.url']],
    ['git_branch', ['symbolic-ref', '--quiet', '--short', 'HEAD']],
    ['head_sha', ['rev-parse', '--verify', 'HEAD']],
  ]
  const results = await Promise.allSettled(fields.map(([, args]) =>
    run('git', ['-C', cwd, ...args], { timeout: 2000, maxBuffer: 8192 })))
  const context = { cwd }
  results.forEach((result, i) => {
    if (result.status !== 'fulfilled') return
    let value = result.value.stdout.trim()
    const [key] = fields[i]
    if (key === 'head_sha' && !/^[a-f0-9]{40,64}$/i.test(value)) return
    if (key === 'git_remote') value = redactRemoteUserinfo(value)?.split(/[?#]/)[0] ?? ''
    if (value) context[key] = value
  })
  return context
}

// LangChain normalizes both providers to gross input, including cache writes.
// @ref LLP 0035#net-input: the session table stores uncached input separately
export function usageAttributes(usage) {
  if (!usage) return undefined
  const read = usage.input_token_details?.cache_read ?? 0
  const write = usage.input_token_details?.cache_creation ?? 0
  return {
    input_tokens: Math.max(0, usage.input_tokens - read - write),
    output_tokens: usage.output_tokens,
    cache_read_tokens: read, cache_write_tokens: write,
    reasoning_tokens: usage.output_token_details?.reasoning,
    total_tokens: usage.total_tokens,
  }
}

export function contentBlocks(message) {
  if (message.role === 'tool') return [{ type: 'tool_result',
    tool_use_id: message.tool_call_id, content: text(message.content), name: message.name }]
  const visible = text(message.content)
  return [
    ...(visible ? [{ type: 'text', text: visible }] : []),
    ...(message.tool_calls ?? []).map(call => ({ type: 'tool_use', id: call.id,
      name: call.name, input: call.args })),
  ]
}

export class SessionProjection {
  threads = new Map()
  toolContexts = new Map()
  count = 0
  runCount = 0
  constructor(sessionId, context, attributes) {
    this.sessionId = sessionId
    this.context = context
    this.attributes = attributes
    this.started = new Date().toISOString()
  }

  resetRun() {
    // Retain a bounded root conversation history across graph invocations.
    const root = this.threads.get('')
    this.threads.clear()
    this.toolContexts.clear()
    if (root) this.threads.set('', root)
    this.runCount = 0
  }

  /** @param {any} [metadata] */
  thread(metadata = {}) {
    // A node's checkpoint namespace includes its enclosing graph invocations.
    // Drop only the leaf node, preserving arbitrarily nested graph ancestry.
    const parts = (metadata.langgraph_checkpoint_ns ?? '').split('|').filter(Boolean)
    parts.pop()
    const scope = parts.join('|')
    if (!this.threads.has(scope)) {
      if (this.threads.size >= 256) throw new Error('thread_limit')
      this.threads.set(scope, { id: scope ? `${this.sessionId}:${hash(scope)}` : this.sessionId,
        parent: scope ? (parts.length > 1 ? `${this.sessionId}:${hash(parts.slice(0, -1).join('|'))}` : this.sessionId) : undefined,
        messages: new Map(), last: undefined })
    }
    return this.threads.get(scope)
  }

  /** @param {any} thread @param {any} [config] @returns {any} */
  exchange(thread, config = {}) {
    return { ...this.context, ...config, session_id: this.sessionId,
      conversation_id: thread.id, agent_id: thread.parent ? thread.id : undefined,
      parent_thread_id: thread.parent, is_sidechain: Boolean(thread.parent),
      conversation_started_at: this.started, conversation_source: 'langgraph_callbacks',
      client_name: 'langgraph', attributes: this.attributes, messages: [] }
  }

  add(thread, key, message) {
    const dedupKey = hash(key)
    if (thread.messages.has(dedupKey)) return undefined
    if (++this.runCount > 4096) throw new Error('message_limit')
    const item = { ...message, message_id: `langgraph:${hash(`${thread.id}:${key}`)}`,
      message_index: this.count++, previous_message_id: thread.last ? [thread.last] : [],
      message_created_at: new Date().toISOString() }
    if (thread.messages.size >= 4096) thread.messages.delete(thread.messages.keys().next().value)
    thread.messages.set(dedupKey, item.message_id)
    thread.last = item.message_id
    return item
  }

  addMessage(thread, message, position, provider, model, responseId) {
    const content = contentBlocks(message)
    if (!content.length) return undefined
    const historyKey = message.role === 'tool' ? `tool:${message.tool_call_id}` :
      `message:${message.id ?? position}:${hash(JSON.stringify({ role: message.role, content }))}`
    // Identical outputs from distinct model calls are distinct billed events.
    const item = this.add(thread, responseId ? `response:${responseId}` : historyKey, {
      role: ({ human: 'user', ai: 'assistant' })[message.role] ?? message.role,
      content, provider_uuid: message.id, provider, model: message.model ?? model,
      attributes: message.role === 'ai' ? { usage: usageAttributes(message.usage) } : undefined,
    })
    return item
  }

  /** @param {any[]} messages @param {any} metadata @param {any} [params] @param {string} [runId] */
  modelStart(messages, metadata, params = {}, runId = randomUUID()) {
    const thread = this.thread(metadata)
    thread.config = { provider: metadata?.ls_provider ?? 'unknown', model: metadata?.ls_model_name,
      system_text: messages.filter(m => m.role === 'system').map(m => text(m.content)).join('\n') || undefined,
      tools: params.tools }
    const projection = this.exchange(thread, thread.config)
    for (const [i, message] of messages.entries()) {
      // Checkpoint history is context, not a new response or billable event.
      if (!['human', 'user', 'system'].includes(message.role)) continue
      const item = this.addMessage(thread, message, i, projection.provider, projection.model, undefined)
      if (item) projection.messages.push(item)
    }
    return { thread, projection, inputCount: messages.length, runId }
  }

  modelEnd(state, messages) {
    for (const [i, message] of messages.entries()) {
      const item = this.addMessage(state.thread, message, state.inputCount + i,
        state.projection.provider, state.projection.model, `${state.runId}:${i}`)
      if (item) state.projection.messages.push(item)
      const config = { provider: state.projection.provider, model: message.model ?? state.projection.model,
        tools: state.projection.tools, system_text: state.projection.system_text }
      for (const call of message.tool_calls ?? []) {
        if (!call.id) continue
        const key = hash(`${state.thread.id}\0${call.id}`)
        if (!this.toolContexts.has(key) && this.toolContexts.size >= 64) {
          this.toolContexts.delete(this.toolContexts.keys().next().value)
        }
        this.toolContexts.set(key, config)
      }
    }
    return state.projection
  }

  modelError(state) {
    const item = this.add(state.thread, `error:${state.runId}`, {
      role: 'assistant', content: [{ type: 'error', message: 'Model call failed', is_error: true }],
    })
    if (item) state.projection.messages.push(item)
    return state.projection
  }

  toolEnd(metadata, id, callId, name, args, result, error) {
    const thread = this.thread(metadata)
    const key = callId ? hash(`${thread.id}\0${callId}`) : undefined
    const config = key ? this.toolContexts.get(key) : thread.config
    const projection = this.exchange(thread, config ?? { provider: 'unknown' })
    if (key && !error) this.toolContexts.delete(key)
    let input = args
    if (typeof args === 'string') { try { input = JSON.parse(args) } catch { /* string-valued tool input */ } }
    const item = this.add(thread, error ? `tool-error:${id}` : `tool:${callId ?? id}`, {
      role: 'tool', content: [{ type: 'tool_result', tool_use_id: callId, name,
        input,
        content: error ? error.name : text(result), is_error: Boolean(error) }],
      attributes: { langgraph: { span_id: id } },
    })
    if (item) projection.messages.push(item)
    return projection
  }
}
