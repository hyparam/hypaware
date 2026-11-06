import { randomUUID } from 'node:crypto'
import { readObservabilityEnv } from '../../../../src/core/observability/env.js'
import { projectContext, SessionProjection } from './projection.js'
import { createPolicy } from './policy.js'
import { encodeEvent, journalPath, publish } from './journal.js'

function message(value) {
  if (Array.isArray(value.content) && value.content.length > 4096) throw new Error('event_limit')
  return { id: value.id, name: value.name, role: value.getType?.() ?? value.type ?? value.role,
    content: Array.isArray(value.content) ? value.content.filter(b => ['text', 'output_text'].includes(b.type)) : value.content,
    tool_calls: value.tool_calls, tool_call_id: value.tool_call_id, usage: value.usage_metadata,
    model: value.response_metadata?.model_name ?? value.response_metadata?.model }
}

/**
 * Create one callback per conversation. Reuse sessionId when resuming it.
 * @param {{ sessionId?: string, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function createHypAwareCallback(options = {}) { return new LangGraphRecorder(options) }

// Duck-types LangChain's public callback contract without a runtime dependency.
export class LangGraphRecorder {
  name = 'hypaware-langgraph'
  awaitHandlers = true
  raiseError = false
  ignoreLLM = false
  ignoreChain = false
  ignoreAgent = false
  ignoreRetriever = false
  ignoreCustomEvent = false
  active = new Map()
  roots = new Set()
  counters = { queued: 0, dropped: 0, policyDrops: 0, lastError: '' }
  /** @param {{ sessionId?: string, cwd?: string, env?: NodeJS.ProcessEnv }} options */
  constructor(options) {
    this.sessionId = options.sessionId ?? randomUUID()
    if (!this.sessionId.trim() || this.sessionId.length > 4096) throw new Error('sessionId must be 1 to 4096 characters')
    this.cwd = options.cwd ?? process.cwd()
    const env = options.env ?? process.env
    const { stateDir } = readObservabilityEnv(env)
    this.policy = createPolicy(env, stateDir)
    this.directory = journalPath(stateDir)
    this.project = projectContext(this.cwd).then(context => new SessionProjection(this.sessionId, context, {}))
  }
  copy() { return this }
  status() { return { ...this.counters, session_id: this.sessionId, active_callbacks: this.active.size } }
  async safe(action) {
    try { await action() } catch (error) {
      this.counters.dropped++
      this.counters.lastError = ['event_limit', 'queue_full', 'active_limit', 'thread_limit', 'message_limit'].includes(error.message)
        ? error.message : 'recording_failed'
    }
  }
  allowed() {
    if (this.policy.allows(this.sessionId, this.cwd)) return true
    this.counters.policyDrops++
    return false
  }
  async save(projection, id, parent, error) {
    if (!projection?.messages.length || !this.allowed()) return
    projection.attributes = { langgraph: { run_id: id, parent_run_id: parent, failed: Boolean(error) } }
    await publish(this.directory, { version: 1, projection })
    this.counters.queued++
    this.counters.lastError = ''
  }
  handleChainStart(chain, inputs, id, parent) {
    if (!parent && this.roots.size < 64) this.roots.add(id)
  }
  handleChainEnd(outputs, id) {
    return this.safe(async () => {
      if (!this.roots.delete(id) || this.roots.size) return
      const project = await this.project
      project.resetRun()
      this.active.clear()
    })
  }
  handleChainError(error, id) { return this.handleChainEnd(undefined, id) }
  handleChatModelStart(llm, messages, id, parent, extra, tags, metadata, name) {
    return this.safe(async () => {
      if (!this.allowed()) return
      if (this.active.size >= 64) throw new Error('active_limit')
      // Reserve before awaiting project lookup, including concurrent model starts.
      this.active.set(id, { parent })
      try {
        if (messages.length > 512 || messages.reduce((n, batch) => n + batch.length, 0) > 512) throw new Error('event_limit')
        const inputs = messages.flat().map(message)
        const params = extra?.invocation_params ?? {}
        const bounded = JSON.parse(encodeEvent({ inputs, params: { tools: params.tools }, metadata }))
        const project = await this.project
        const state = project.modelStart(bounded.inputs, bounded.metadata ?? {}, bounded.params, id)
        this.active.set(id, { state, parent })
      } catch (error) { this.active.delete(id); throw error }
    })
  }
  handleLLMEnd(output, id) {
    return this.safe(async () => {
      const active = this.active.get(id)
      this.active.delete(id)
      if (!active) return
      if (output.generations.length > 512 || output.generations.reduce((n, batch) => n + batch.length, 0) > 512) throw new Error('event_limit')
      const messages = JSON.parse(encodeEvent(output.generations.flat().map(g => message(g.message))))
      const project = await this.project
      await this.save(project.modelEnd(active.state, messages), id, active.parent, undefined)
    })
  }
  handleLLMError(error, id) {
    return this.safe(async () => {
      const active = this.active.get(id)
      this.active.delete(id)
      if (active) await this.save((await this.project).modelError(active.state), id, active.parent, error)
    })
  }
  handleToolStart(tool, input, id, parent, tags, metadata, name, callId) {
    return this.safe(async () => {
      if (!this.allowed()) return
      if (this.active.size >= 64) throw new Error('active_limit')
      this.active.set(id, JSON.parse(encodeEvent({ metadata, parent, callId, name: name ?? tool.id?.at(-1), input })))
    })
  }
  finishTool(id, output, error) {
    return this.safe(async () => {
      const active = this.active.get(id)
      this.active.delete(id)
      if (!active) return
      const project = await this.project
      const result = JSON.parse(encodeEvent({ result: output?.content ?? output })).result
      await this.save(project.toolEnd(active.metadata, id, active.callId ?? output?.tool_call_id, active.name, active.input, result, error), id, active.parent, error)
    })
  }
  handleToolEnd(output, id) { return this.finishTool(id, output, undefined) }
  handleToolError(error, id) { return this.finishTool(id, undefined, error) }
}
