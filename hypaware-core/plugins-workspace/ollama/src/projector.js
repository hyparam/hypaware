// @ts-check

import { isPlainObject, parseMaybeJson } from 'hypaware/core/util'
import { USAGE_POLICY_DROP } from '../../../../src/core/usage-policy/index.js'
import { CAPTURE_BYTES } from '../../ai-gateway/src/process_transport.js'

/**
 * @import { AiGatewayExchangeInput, AiGatewayExchangeProjector, AiGatewayProjectedMessage, AiGatewayUpstreamPreset, JsonObject, PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
 */

const REQUEST_FIELDS = new Set(['model', 'messages', 'stream', 'format', 'options', 'keep_alive'])
const RESPONSE_FIELDS = new Set(['model', 'created_at', 'message', 'done', 'done_reason', 'total_duration', 'load_duration', 'prompt_eval_count', 'prompt_eval_cached_count', 'prompt_eval_duration', 'eval_count', 'eval_duration'])
const MESSAGE_FIELDS = new Set(['role', 'content'])
const COUNTERS = ['prompt_eval_count', 'prompt_eval_cached_count', 'eval_count']

/** @returns {AiGatewayUpstreamPreset} */
export function ollamaUpstreamPreset() {
  return { name: 'ollama', provider: 'ollama', base_url: 'http://127.0.0.1:11434', path_prefix: '/api/chat', match: input => input.method === 'POST' && input.path === '/api/chat' }
}

/** @returns {AiGatewayExchangeProjector} */
export function createOllamaExchangeProjector() {
  return {
    name: 'ollama-native-chat',
    match(input) {
      return input.upstream === 'ollama' && input.provider === 'ollama' && input.method === 'POST' && input.path?.split('?', 1)[0] === '/api/chat'
    },
    // @ref LLP 0399#wire [implements]: completion and admission precede every row; a failed exchange yields no partial history
    project(input, ctx) {
      /** @param {string} reason */
      const drop = reason => {
        ctx.log.warn('plugin.ollama.capture_dropped', { component: 'ollama', operation: 'project_exchange', exchange_id: input.exchange_id, status: 'dropped', reason })
        return undefined
      }
      if (!nonempty(input.exchange_id)) return drop('invalid_request')
      if (ctx.isSessionIgnored?.(input.exchange_id)) {
        ctx.log.info('plugin.ollama.capture_dropped', { component: 'ollama', operation: 'project_exchange', exchange_id: input.exchange_id, status: 'dropped', reason: 'session_ignored' })
        return USAGE_POLICY_DROP
      }
      if (input.error) return drop('transport_error')
      if (input.status_code == null || input.status_code < 200 || input.status_code >= 300) return drop('http_error')
      // @ref LLP 0399#resources-journey [implements]: direct projector calls also reject oversize decoded capture bodies before parsing
      if (Buffer.byteLength(input.request_body ?? '') + Buffer.byteLength(input.response_body ?? '') > CAPTURE_BYTES) return drop('capture_limit')
      const request = parseMaybeJson(input.request_body)
      if (!isPlainObject(request) || !nonempty(request.model) || !Array.isArray(request.messages) || (request.stream !== undefined && typeof request.stream !== 'boolean')) return drop('invalid_request')
      if (hasUnknownFields(request, REQUEST_FIELDS)) return drop('unsupported_shape')
      if (!request.messages.every(message => textMessage(message, false))) return drop('unsupported_shape')
      if (!request.messages.some(message => message.role === 'user')) return drop('invalid_request')
      const response = readResponse(input.response_body ?? '', request.stream !== false)
      if (typeof response === 'string') return drop(response)
      const { terminal, content, model } = response
      const usage = readUsage(terminal, input, ctx.log)
      /** @type {JsonObject} */
      const raw = {}
      if (typeof terminal.done_reason === 'string') raw.done_reason = terminal.done_reason
      for (const key of COUNTERS) {
        const value = terminal[key]
        // Preserve primitive observations, including invalid counters, never nested wire content.
        if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) raw[key] = /** @type {string | number | boolean | null} */ (value)
      }
      /** @type {AiGatewayProjectedMessage[]} */
      const messages = []
      /** @type {string[]} */
      const systems = []
      // @ref LLP 0399#exchange-scope [implements]: explicit blocks preserve empty positions; index identity and immediate links stay exchange-local
      for (let index = 0; index < request.messages.length; index++) {
        const message = request.messages[index]
        messages.push({ role: message.role, content: [{ type: 'text', text: message.content }], message_id: `${input.exchange_id}:request:${index}`, previous_message_id: index === 0 ? [] : [`${input.exchange_id}:request:${index - 1}`], message_created_at: input.ts_start })
        if (message.role === 'system') systems.push(message.content)
      }
      messages.push({
        role: 'assistant', content: [{ type: 'text', text: content }], message_id: `${input.exchange_id}:response`, previous_message_id: [`${input.exchange_id}:request:${request.messages.length - 1}`],
        message_created_at: typeof terminal.created_at === 'string' && Number.isFinite(Date.parse(terminal.created_at)) ? terminal.created_at : input.ts_start,
        stop_reason: typeof terminal.done_reason === 'string' ? terminal.done_reason : undefined,
        raw_frame: raw, attributes: usage ? { usage } : undefined,
      })
      return { provider: 'ollama', session_id: input.exchange_id, request_id: input.exchange_id, client_name: 'ollama', entrypoint: 'ollama-api', conversation_source: 'ollama', model: model ?? request.model, system_text: systems.length ? systems.join('\n') : undefined, messages }
    },
  }
}

/** @param {unknown} value @returns {value is string} */
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0 }

/** @param {Record<string, unknown>} value @param {ReadonlySet<string>} allowed */
function hasUnknownFields(value, allowed) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) return true
  return false
}

/** @param {unknown} value @param {boolean} assistantOnly @returns {value is { role: string, content: string }} */
function textMessage(value, assistantOnly) {
  return isPlainObject(value) && !hasUnknownFields(value, MESSAGE_FIELDS) && typeof value.content === 'string' && (assistantOnly ? value.role === 'assistant' : ['system', 'user', 'assistant'].includes(/** @type {string} */ (value.role)))
}

/**
 * @param {string} body
 * @param {boolean} stream
 * @returns {string | { content: string, terminal: Record<string, unknown>, model?: string }}
 */
function readResponse(body, stream) {
  /** @type {string[]} */
  const fragments = []
  /** @type {Record<string, unknown> | undefined} */
  let terminal
  /** @type {string | undefined} */
  let model
  /** @param {string} line @returns {string | undefined} */
  const consume = line => {
    if (terminal) return 'trailing_record'
    const record = parseMaybeJson(line)
    if (!isPlainObject(record)) return stream ? 'malformed_stream' : 'invalid_response'
    if ('error' in record || typeof record.done !== 'boolean') return 'invalid_response'
    if (hasUnknownFields(record, RESPONSE_FIELDS) || !textMessage(record.message, true)) return 'unsupported_shape'
    if ('model' in record) {
      if (!nonempty(record.model) || (model !== undefined && model !== record.model)) return 'invalid_response'
      model = record.model
    }
    if ('done_reason' in record && !nonempty(record.done_reason)) return 'invalid_response'
    fragments.push(record.message.content)
    if (record.done) terminal = record
    return undefined
  }
  // @ref LLP 0399#resources-journey [implements]: parse each record once, release nonterminal objects, join fragments once
  if (stream) {
    let start = 0
    while (start < body.length) {
      const newline = body.indexOf('\n', start)
      const end = newline < 0 ? body.length : newline
      const line = body.slice(start, end).trim()
      if (line) {
        const reason = consume(line)
        if (reason) return reason
      }
      start = end + 1
    }
  } else {
    const reason = consume(body)
    if (reason) return reason
  }
  if (!terminal) return 'missing_terminal'
  return { content: fragments.join(''), terminal, model }
}

/**
 * @param {Record<string, unknown>} terminal
 * @param {AiGatewayExchangeInput} input
 * @param {PluginLogger} log
 * @returns {JsonObject | undefined}
 */
function readUsage(terminal, input, log) {
  /** @type {Record<string, number>} */
  const counts = {}
  /** @param {string} field @param {string} reason */
  const invalid = (field, reason) => log.warn('plugin.ollama.invalid_usage', { component: 'ollama', operation: 'normalize_usage', exchange_id: input.exchange_id, status: 'omitted', field, reason })
  for (const key of COUNTERS) {
    if (!(key in terminal)) continue
    const value = terminal[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) counts[key] = value
    else invalid(key, 'invalid_count')
  }
  // @ref LLP 0399#usage-privacy [implements]: input is net only with observed cache, inconsistent pairs are omitted; only new response carries usage
  const usage = /** @type {JsonObject} */ ({})
  const prompt = counts.prompt_eval_count
  const cache = counts.prompt_eval_cached_count
  if (prompt !== undefined && cache !== undefined && cache > prompt) invalid('prompt_eval_cached_count', 'cache_exceeds_prompt')
  else {
    if (cache !== undefined) usage.cache_read_tokens = cache
    if (prompt !== undefined && cache !== undefined) usage.input_tokens = prompt - cache
  }
  if (counts.eval_count !== undefined) usage.output_tokens = counts.eval_count
  return Object.keys(usage).length ? usage : undefined
}
