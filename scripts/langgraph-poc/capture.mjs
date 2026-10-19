// Throwaway experiment: synthetic content only, single writer, bounded runs.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { projectContext, SessionProjection } from './projection.mjs'

export const deps = process.env.HYP_LANGGRAPH_POC_DEPS ?? '/tmp/hypaware-langgraph-poc-deps'
export const requireFixture = createRequire(path.join(deps, 'package.json'))
const { BaseCallbackHandler } = requireFixture('@langchain/core/callbacks/base')
const hash = (value, size) => createHash('sha256').update(value).digest('hex').slice(0, size)
const ns = () => String(BigInt(Date.now()) * 1_000_000n)

export function message(value) {
  return {
    id: value.id,
    name: value.name,
    role: value.getType?.() ?? value.type,
    // Responses can carry non-text reasoning items. Only record visible text.
    content: Array.isArray(value.content)
      ? value.content.filter(block => block.type === 'text' || block.type === 'output_text')
      : value.content,
    tool_calls: value.tool_calls,
    tool_call_id: value.tool_call_id,
    usage: value.usage_metadata,
    model: value.response_metadata?.model_name ?? value.response_metadata?.model,
  }
}

export class Capture extends BaseCallbackHandler {
  name = 'hypaware-prototype'
  awaitHandlers = true
  raiseError = true
  active = new Map()
  completed = 0

  constructor(directory, runId, scenario, threadId, cwd = process.cwd()) {
    super()
    Object.assign(this, { directory, runId, scenario, threadId })
    this.project = projectContext(cwd).then(context => new SessionProjection(threadId, context, {
      dev_run_id: runId, smoke_name: 'langgraph_parity_poc', smoke_step: scenario,
    }))
    fs.mkdirSync(directory, { recursive: true })
    this.bytes = fs.readdirSync(directory).filter(f => f.endsWith('.json'))
      .reduce((n, f) => n + fs.statSync(path.join(directory, f)).size, 0)
  }

  start(kind, name, id, parent, metadata = {}, extra = {}) {
    if (this.active.size >= 256) throw new Error('prototype active span limit')
    const ancestor = this.active.get(parent)
    this.active.set(id, {
      traceId: ancestor?.traceId ?? hash(id, 32),
      spanId: hash(id, 16), parentSpanId: parent ? hash(parent, 16) : undefined,
      name, kind: 1, startTimeUnixNano: ns(),
      attributes: {
        dev_run_id: this.runId, smoke_name: 'langgraph_parity_poc', smoke_step: this.scenario,
        'langsmith.span.kind': kind, 'langsmith.span.id': id,
        'langsmith.span.parent_id': parent, 'langsmith.metadata.thread_id': this.threadId,
        langgraph_node: metadata.langgraph_node,
        langgraph_checkpoint_ns: metadata.langgraph_checkpoint_ns,
        'gen_ai.provider.name': metadata.ls_provider,
        'gen_ai.request.model': metadata.ls_model_name,
        ...extra,
      },
    })
  }

  finish(id, extra = {}, error) {
    const span = this.active.get(id)
    if (!span) throw new Error(`missing start for ${id}`)
    this.active.delete(id)
    delete span.captureState
    delete span.toolState
    span.endTimeUnixNano = ns()
    span.status = error ? { code: 2, message: error.name } : { code: 1 }
    span.attributes = Object.entries({ ...span.attributes, ...extra }).filter(([, v]) => v !== undefined)
      .map(([key, value]) => ({ key, value: typeof value === 'number'
        ? { doubleValue: value } : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } }))
    const body = JSON.stringify(span)
    const bytes = Buffer.byteLength(body)
    this.bytes += bytes
    if (bytes > 64 * 1024 || this.bytes > 16 * 1024 * 1024 || ++this.completed > 1024) {
      throw new Error('prototype spool limit')
    }
    // Flush each completed span before publishing it to the replay process.
    const target = path.join(this.directory, `${span.spanId}.json`)
    fs.writeFileSync(`${target}.tmp`, body, { mode: 0o600, flush: true })
    fs.renameSync(`${target}.tmp`, target)
  }

  // The installed manager calls handlers with parent fourth, name eighth.
  // Its manager method itself takes a different argument order.
  handleChainStart(chain, inputs, id, parent, tags, metadata, type, name) {
    this.start('chain', name ?? chain.id?.at(-1) ?? 'chain', id, parent, metadata)
  }
  handleChainEnd(outputs, id) { this.finish(id) }
  handleChainError(error, id) { this.finish(id, {}, error) }
  async handleChatModelStart(llm, messages, id, parent, extra, tags, metadata, name) {
    const inputs = messages.flat().map(message)
    const project = await this.project
    this.start('llm', name ?? llm.id.at(-1), id, parent, metadata, {
      'gen_ai.input.messages': inputs,
      'gen_ai.tool.definitions': extra?.invocation_params?.tools,
    })
    this.active.get(id).captureState = project.modelStart(inputs, metadata, extra?.invocation_params, id)
  }
  async handleLLMEnd(output, id) {
    const messages = output.generations.flat().map(g => message(g.message))
    const usage = messages[0]?.usage
    const project = await this.project
    const projection = project.modelEnd(this.active.get(id).captureState, messages)
    this.finish(id, {
      'hypaware.projection': projection,
      'gen_ai.output.messages': messages,
      'gen_ai.response.model': messages[0]?.model,
      'gen_ai.usage.input_tokens': usage?.input_tokens,
      'gen_ai.usage.output_tokens': usage?.output_tokens,
      'gen_ai.usage.input_token_details': usage?.input_token_details,
    })
  }
  handleLLMError(error, id) {
    this.finish(id, { 'hypaware.projection': this.active.get(id)?.captureState?.projection }, error)
  }
  handleToolStart(tool, input, id, parent, tags, metadata, name, callId) {
    this.start('tool', name ?? tool.id.at(-1), id, parent, metadata, {
      'gen_ai.tool.name': name ?? tool.id.at(-1), 'gen_ai.tool.call.id': callId,
      'gen_ai.tool.call.arguments': input,
    })
    this.active.get(id).toolState = { metadata, callId, name: name ?? tool.id.at(-1), input }
  }
  async finishTool(id, output, error) {
    const project = await this.project
    const { metadata, callId, name, input } = this.active.get(id).toolState
    const result = output?.content ?? output
    this.finish(id, { 'gen_ai.tool.call.result': result,
      'hypaware.projection': project.toolEnd(metadata, id, callId, name, input, result, error) }, error)
  }
  handleToolEnd(output, id) { return this.finishTool(id, output) }
  handleToolError(error, id) { return this.finishTool(id, undefined, error) }
}

export function envelope(spans) {
  return { resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: 'langgraph-parity-poc' } }] },
    scopeSpans: [{ scope: { name: 'hypaware-prototype', version: '0' }, spans }],
  }] }
}

export async function flush(directory, endpoint) {
  // Explicit bounded replay, no busy loop and no in-memory retry queue.
  const files = fs.readdirSync(directory).filter(f => f.endsWith('.json')).sort()
  let sent = 0
  for (let i = 0; i < files.length; i += 32) {
    const batch = files.slice(i, i + 32)
    const spans = batch.map(f => JSON.parse(fs.readFileSync(path.join(directory, f), 'utf8')))
    try {
      const response = await fetch(`${endpoint}/v1/traces`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope(spans)), signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const ack = /** @type {any} */ (await response.json())
      if (Number(ack.partialSuccess?.rejectedSpans ?? 0) !== 0) throw new Error('partial rejection')
    } catch (error) {
      return { sent, pending: files.length - sent, error: error.name }
    }
    for (const file of batch) fs.unlinkSync(path.join(directory, file))
    sent += batch.length
  }
  return { sent, pending: 0 }
}
