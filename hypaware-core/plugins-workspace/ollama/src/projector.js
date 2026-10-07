// @ts-check

import { isPlainObject, parseMaybeJson } from 'hypaware/core/util'
import { USAGE_POLICY_DROP } from '../../../../src/core/usage-policy/index.js'
import { CAPTURE_BYTES } from '../../ai-gateway/src/process_transport.js'

/**
 * @import { AiGatewayExchangeInput, AiGatewayExchangeProjector, AiGatewayProjectedMessage, AiGatewayUpstreamPreset, JsonObject, PluginLogger } from '../../../../hypaware-plugin-kernel-types.js'
 */

const REQUEST_FIELDS = new Set(['model', 'messages', 'stream', 'format', 'options', 'keep_alive', 'tools', 'think'])
const GENERATE_FIELDS = new Set(['model', 'prompt', 'system', 'suffix', 'template', 'context', 'images', 'stream', 'format', 'options', 'keep_alive', 'think'])
const RESPONSE_FIELDS = new Set(['model', 'created_at', 'message', 'done', 'done_reason', 'total_duration', 'load_duration', 'prompt_eval_count', 'prompt_eval_cached_count', 'prompt_eval_duration', 'eval_count', 'eval_duration'])
const GENERATE_RESPONSE_FIELDS = new Set([...RESPONSE_FIELDS].filter(key => key !== 'message').concat(['response', 'context', 'thinking']))
const MESSAGE_FIELDS = new Set(['role', 'content', 'images', 'thinking', 'tool_calls'])
const COUNTERS = ['prompt_eval_count', 'prompt_eval_cached_count', 'eval_count']
const MAX_MESSAGES = 4096
const MAX_IMAGES = 4096
const MAX_PARTS = 8192

/** @returns {AiGatewayUpstreamPreset} */
export function ollamaUpstreamPreset() {
  return { name: 'ollama', provider: 'ollama', base_url: 'http://127.0.0.1:11434', path_prefix: '/api/chat', match: input => input.method === 'POST' && input.path === '/api/chat' }
}

/** @returns {AiGatewayExchangeProjector} */
export function createOllamaExchangeProjector() {
  return {
    name: 'ollama-native-chat',
    match(input) {
      return input.provider === 'ollama' && input.method === 'POST' && nativePath(input) !== undefined
    },
    // @ref LLP 0469#wire [implements]: completion and admission precede every row; a failed exchange yields no partial history
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
      // @ref LLP 0469#resources-journey [implements]: direct projector calls also reject oversize decoded capture bodies before parsing
      if (Buffer.byteLength(input.request_body ?? '') + Buffer.byteLength(input.response_body ?? '') > CAPTURE_BYTES) return drop('capture_limit')
      const path = nativePath(input)
      if (!path) return drop('invalid_request')
      const generate = path === '/api/generate'
      const request = parseMaybeJson(input.request_body)
      if (!isPlainObject(request) || !nonempty(request.model) || (request.stream != null && typeof request.stream !== 'boolean')) return drop('invalid_request')
      if (hasUnknownFields(request, generate ? GENERATE_FIELDS : REQUEST_FIELDS) || !defaultControls(request)) return drop('unsupported_shape')
      // @ref LLP 0474#resources [implements]: count native positions before allocating projected blocks or canonical rows
      let messageCount = 1 // the current response, even when its text is empty
      let imageCount = 0
      if (generate) {
        if ((request.prompt != null && typeof request.prompt !== 'string') || (request.system != null && typeof request.system !== 'string') || !emptyText(request.suffix) || !emptyText(request.template) || !tokenContext(request.context) || !images(request.images)) return drop('unsupported_shape')
        messageCount += nonempty(request.system) ? 2 : 1
        imageCount = request.images?.length ?? 0
      } else {
        if (!Array.isArray(request.messages)) return drop('invalid_request')
        messageCount += request.messages.length
        if (messageCount > MAX_MESSAGES) return drop('capture_limit')
        if (!emptyArray(request.tools)) return drop('unsupported_shape')
        for (const message of request.messages) {
          if (!nativeMessage(message, false)) return drop('unsupported_shape')
          imageCount += message.images?.length ?? 0
          if (imageCount > MAX_IMAGES) return drop('capture_limit')
        }
        if (!request.messages.some(message => message.role === 'user')) return drop('invalid_request')
      }
      if (imageCount > MAX_IMAGES || messageCount + imageCount > MAX_PARTS) return drop('capture_limit')
      const response = readResponse(input.response_body ?? '', request.stream !== false, generate, Math.min(MAX_IMAGES - imageCount, MAX_PARTS - messageCount - imageCount))
      if (typeof response === 'string') return drop(response)
      const { terminal, content, model, imageCount: responseImages } = response
      // @ref LLP 0474#projection [implements]: completed model load/unload is intentional control traffic, never a persisted conversation
      if (generate && (terminal.done_reason === 'load' || terminal.done_reason === 'unload')) {
        if (nonempty(request.prompt) || nonempty(request.system) || imageCount || content.length) return drop('invalid_response')
        ctx.log.info('plugin.ollama.capture_control', { component: 'ollama', operation: 'project_exchange', exchange_id: input.exchange_id, status: 'control', reason: terminal.done_reason })
        return undefined
      }
      const usage = readUsage(terminal, input, ctx.log)
      /** @type {JsonObject} */
      const raw = {}
      if (typeof terminal.done_reason === 'string') raw.done_reason = terminal.done_reason
      for (const key of COUNTERS) {
        const value = terminal[key]
        // Preserve primitive count observations, including numeric strings, without copying arbitrary wire payloads.
        if (value === null || typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 64 && /^[+-]?\d+(\.\d+)?$/.test(value))) raw[key] = /** @type {string | number | boolean | null} */ (value)
      }
      /** @type {AiGatewayProjectedMessage[]} */
      const messages = []
      // @ref LLP 0469#exchange-scope [implements]: explicit blocks preserve empty positions; index identity and immediate links stay exchange-local
      /** @param {string} role @param {string} text @param {number} count */
      const addRequest = (role, text, count) => {
        const index = messages.length
        messages.push({ role, content: omittedMediaContent(text, count), message_id: `${input.exchange_id}:request:${index}`, previous_message_id: index === 0 ? [] : [`${input.exchange_id}:request:${index - 1}`], message_created_at: input.ts_start })
      }
      if (generate) {
        if (nonempty(request.system)) addRequest('system', request.system, 0)
        addRequest('user', typeof request.prompt === 'string' ? request.prompt : '', imageCount)
      } else {
        for (const message of /** @type {Array<{ role: string, content: string, images?: string[] }>} */ (request.messages)) addRequest(message.role, message.content, message.images?.length ?? 0)
      }
      messages.push({
        role: 'assistant', content: omittedMediaContent(content, responseImages), message_id: `${input.exchange_id}:response`, previous_message_id: [`${input.exchange_id}:request:${messages.length - 1}`],
        message_created_at: typeof terminal.created_at === 'string' && Number.isFinite(Date.parse(terminal.created_at)) ? terminal.created_at : input.ts_start,
        stop_reason: typeof terminal.done_reason === 'string' ? terminal.done_reason : undefined,
        raw_frame: raw, attributes: usage ? { usage } : undefined,
      })
      ctx.log.info('plugin.ollama.capture_projected', { component: 'ollama', operation: 'project_exchange', exchange_id: input.exchange_id, status: 'projected', reason: imageCount + responseImages ? 'media_omitted' : 'text' })
      // @ref LLP 0469#resources-journey [implements]: system text stays in ordered rows; an exchange-wide copy would multiply serialized bytes by row count
      return { provider: 'ollama', session_id: input.exchange_id, request_id: input.exchange_id, client_name: 'ollama', entrypoint: 'ollama-api', conversation_source: 'ollama', model: model ?? request.model, messages }
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

/** @param {unknown} value @param {boolean} assistantOnly @returns {value is { role: string, content: string, images?: string[] }} */
function nativeMessage(value, assistantOnly) {
  return isPlainObject(value) && !hasUnknownFields(value, MESSAGE_FIELDS) && typeof value.content === 'string' && images(value.images) && emptyText(value.thinking) && emptyArray(value.tool_calls) && (assistantOnly ? value.role === 'assistant' : ['system', 'user', 'assistant'].includes(/** @type {string} */ (value.role)))
}

/** @param {AiGatewayExchangeInput} input */
function nativePath(input) {
  const path = input.path?.split('?', 1)[0]
  const native = input.upstream === 'ollama-native' && path?.startsWith('/ollama/') ? path.slice('/ollama'.length) : input.upstream === 'ollama' ? path : undefined
  return native === '/api/chat' || native === '/api/generate' ? native : undefined
}

/** @param {unknown} value */
function emptyText(value) { return value == null || value === '' }
/** @param {unknown} value */
function emptyArray(value) { return value == null || (Array.isArray(value) && value.length === 0) }
/** @param {unknown} value */
function images(value) { return value == null || (Array.isArray(value) && value.every(image => typeof image === 'string')) }
/** @param {unknown} value */
function tokenContext(value) { return value == null || (Array.isArray(value) && value.every(token => Number.isSafeInteger(token) && token >= 0)) }

// @ref LLP 0474#projection [implements]: false/null and empty defaults add no unsupported thinking/tool semantics; present control types still validate
/** @param {Record<string, unknown>} request */
function defaultControls(request) {
  return (request.think == null || request.think === false) &&
    (request.options == null || isPlainObject(request.options)) &&
    (request.format == null || typeof request.format === 'string' || isPlainObject(request.format)) &&
    (request.keep_alive == null || typeof request.keep_alive === 'string' || (typeof request.keep_alive === 'number' && Number.isFinite(request.keep_alive)))
}

// @ref LLP 0474#projection [implements]: only empty existing image blocks survive, native media supplies no trustworthy MIME or filename
/** @param {string} text @param {number} count @returns {JsonObject[]} */
function omittedMediaContent(text, count) {
  /** @type {JsonObject[]} */
  const content = [{ type: 'text', text }]
  for (let index = 0; index < count; index++) content.push({ type: 'image' })
  return content
}

/**
 * @param {string} body
 * @param {boolean} stream
 * @param {boolean} generate
 * @param {number} imageBudget
 * @returns {string | { content: string, terminal: Record<string, unknown>, model?: string, imageCount: number }}
 */
function readResponse(body, stream, generate, imageBudget) {
  /** @type {string[]} */
  const fragments = []
  /** @type {Record<string, unknown> | undefined} */
  let terminal
  /** @type {string | undefined} */
  let model
  let imageCount = 0
  /** @param {string} line @returns {string | undefined} */
  const consume = line => {
    if (terminal) return 'trailing_record'
    const record = parseMaybeJson(line)
    if (!isPlainObject(record)) return stream ? 'malformed_stream' : 'invalid_response'
    if ('error' in record || typeof record.done !== 'boolean') return 'invalid_response'
    if (hasUnknownFields(record, generate ? GENERATE_RESPONSE_FIELDS : RESPONSE_FIELDS)) return 'unsupported_shape'
    if (generate) {
      if (typeof record.response !== 'string' || !emptyText(record.thinking) || !tokenContext(record.context)) return 'unsupported_shape'
      if (record.response.length) fragments.push(record.response)
    } else {
      if (!nativeMessage(record.message, true)) return 'unsupported_shape'
      imageCount += record.message.images?.length ?? 0
      if (imageCount > imageBudget) return 'capture_limit'
      if (record.message.content.length) fragments.push(record.message.content)
    }
    if ('model' in record) {
      if (!nonempty(record.model) || (model !== undefined && model !== record.model)) return 'invalid_response'
      model = record.model
    }
    if ('done_reason' in record && (typeof record.done_reason !== 'string' || !/^[a-z_]{1,64}$/.test(record.done_reason))) return 'invalid_response'
    if (record.done) {
      // Keep only terminal observations used below, not context tokens, content or media payloads.
      terminal = {}
      for (const key of ['created_at', 'done_reason', ...COUNTERS]) if (key in record) terminal[key] = record[key]
    }
    return undefined
  }
  // @ref LLP 0469#resources-journey [implements]: parse each record once, release nonterminal objects, join fragments once
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
  return { content: fragments.join(''), terminal, model, imageCount }
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
  // @ref LLP 0469#usage-privacy [implements]: input is net only with observed cache, inconsistent pairs are omitted; only new response carries usage
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
