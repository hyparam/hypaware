// @ts-check

/** @import { AiGatewayProjectedExchange, AiGatewayProjectedMessage, JsonObject } from '../../../../hypaware-plugin-kernel-types.js' */
/** @import { CopilotSpan } from '../../../../hypaware-core/plugins-workspace/copilot/src/types.js' */

/** @param {string | undefined} value */
function parsed(value) {
  if (value === undefined) return undefined
  try { return JSON.parse(value) } catch { throw new Error('content_json_invalid') }
}
/** @param {unknown} value */
function finite(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined }

/**
 * @ref LLP 0549#identity: terminal span IDs own occurrences, model context is not replayed
 * @param {CopilotSpan} span @param {Record<string, string>} attrs @param {string} sessionId @param {string} cwd @param {string} harness
 * @returns {AiGatewayProjectedExchange}
 */
export function projectSpan(span, attrs, sessionId, cwd, harness) {
  const identity = `copilot:${sessionId}:${span.trace_id}:${span.span_id}`
  const provider = span.provider_name || 'unknown'
  const model = span.response_model || span.request_model || undefined
  /** @type {AiGatewayProjectedMessage[]} */
  const messages = []
  const base = { trace_id: span.trace_id, span_id: span.span_id, parent_span_id: span.parent_span_id ?? null,
    operation_name: span.operation_name ?? null, duration_ms: Math.max(0, span.end_time_ms - span.start_time_ms), status_code: span.status_code, harness }
  /** @param {string} role @param {string | JsonObject[]} content @param {string} suffix */
  function add(role, content, suffix) {
    messages.push({ role, content, message_id: identity + ':' + suffix, message_created_at: new Date(span.start_time_ms).toISOString(), model,
      provider_uuid: role === 'assistant' ? attrs['gen_ai.response.id'] || undefined : undefined, attributes: { copilot: base } })
  }
  if (span.operation_name === 'invoke_agent') {
    // Root inputs carry the submitted turn. Never reproduce the chat span's
    // repeated model history, nor the root's duplicate assistant/usage totals.
    const input = parsed(attrs['gen_ai.input.messages'])
    if (Array.isArray(input) && input.length === 1 && input[0]?.role === 'user') {
      const parts = input[0].parts
      if (Array.isArray(parts)) {
        if (parts.length > 2048) throw new Error('part_count_limit')
        const content = parts.filter(p => p?.type === 'text' && typeof p.content === 'string').map(p => ({ type: 'text', text: p.content }))
        if (content.length) add('user', content, 'user')
      }
    }
  } else if (span.operation_name === 'chat') {
    // Context is retained on one dedicated row, never copied onto each output
    // part or interpreted as another submitted human message.
    const context = {}
    let systemText = ''
    for (const [key, field] of [['gen_ai.system_instructions', 'system_instructions'], ['gen_ai.tool.definitions', 'tool_definitions']]) {
      if (attrs[key] === undefined) continue
      try { context[field] = parsed(attrs[key]) }
      catch {
        context[field] = attrs[key]
        context.content_incomplete = true
      }
    }
    if (Array.isArray(context.system_instructions)) systemText = context.system_instructions.filter(part => part?.type === 'text' && typeof part.content === 'string').map(part => part.content).join('\n')
    if (Object.keys(context).length) {
      add('system', [{ type: 'text', text: systemText || 'Model context' }], 'context')
      const message = messages.at(-1)
      if (message?.attributes) message.attributes.copilot_context = context
    }
    const output = parsed(attrs['gen_ai.output.messages'])
    if (output !== undefined && !Array.isArray(output)) throw new Error('output_schema')
    const separateReasoning = attrs['copilot_chat.reasoning_content']
    if (separateReasoning && !(output ?? []).some(message => message?.parts?.some(part => part?.type === 'reasoning'))) add('assistant', [{ type: 'thinking', thinking: separateReasoning }], 'reasoning')
    let i = 0
    let selectedParts = 0
    for (const message of output ?? []) {
      if (message?.role !== 'assistant' || !Array.isArray(message.parts)) throw new Error('output_schema')
      if (message.parts.length > 2048) throw new Error('part_count_limit')
      const content = []
      for (const part of message.parts) {
        if (part?.type === 'text' && typeof part.content === 'string') content.push({ type: 'text', text: part.content })
        else if (part?.type === 'reasoning' && typeof part.content === 'string') content.push({ type: 'thinking', thinking: part.content })
        else if (part?.type === 'tool_call' && typeof part.id === 'string' && typeof part.name === 'string') content.push({ type: 'tool_use', id: part.id, name: part.name, input: part.arguments ?? {} })
        else throw new Error('output_part_schema')
      }
      selectedParts += content.length
      if (selectedParts > 2048) throw new Error('part_count_limit')
      if (content.length) {
        add('assistant', content, 'output:' + i)
        const last = messages.at(-1)
        if (last) last.stop_reason = message.finish_reason
      }
      i++
      if (i > 1024) throw new Error('message_count_limit')
    }
    /** @type {JsonObject} */
    const usage = {}
    const read = finite(span.cached_tokens)
    const created = attrs['gen_ai.usage.cache_creation.input_tokens'] === undefined ? undefined : finite(Number(attrs['gen_ai.usage.cache_creation.input_tokens']))
    if (finite(span.input_tokens) !== undefined) usage.input_tokens = Math.max(0, (span.input_tokens ?? 0) - (read ?? 0) - (created ?? 0))
    if (finite(span.output_tokens) !== undefined) usage.output_tokens = span.output_tokens ?? 0
    if (read !== undefined) usage.cache_read_tokens = read
    if (created !== undefined) usage.cache_write_tokens = created
    const reasoning = finite(span.reasoning_tokens) ?? finite(Number(attrs['gen_ai.usage.reasoning.output_tokens']))
    if (reasoning !== undefined) usage.reasoning_tokens = reasoning
    // A terminal error or content-disabled response still owns its accounting.
    if (!messages.some(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(part => ['text', 'tool_use'].includes(String(part.type)))) && (Object.keys(usage).length || span.status_code === 2)) add('assistant', [{ type: 'text', text: '' }], 'accounting')
    const carrier = messages.findLast(message => message.role === 'assistant')
    if (carrier?.attributes && Object.keys(usage).length) carrier.attributes.usage = usage
  } else if (span.operation_name === 'execute_tool' && span.tool_call_id) {
    if (attrs['gen_ai.tool.call.result'] !== undefined) {
      let input
      try { input = parsed(attrs['gen_ai.tool.call.arguments']) } catch { input = attrs['gen_ai.tool.call.arguments'] }
      add('tool', [{ type: 'tool_result', name: span.tool_name ?? '', tool_use_id: span.tool_call_id, input: input ?? {}, content: attrs['gen_ai.tool.call.result'], is_error: span.status_code === 2 }], 'result')
    }
  }
  return { provider, session_id: sessionId, cwd, client_name: 'copilot', entrypoint: `vscode_copilot_${harness.replace('-', '_')}`,
    request_id: attrs['gen_ai.response.id'] || undefined, parent_thread_id: attrs['copilot_chat.parent_chat_session_id'] || undefined, model, messages }
}
