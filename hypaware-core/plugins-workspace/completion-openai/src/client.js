// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { chatCompletionsEndpoint } from './config.js'

/**
 * @import { CompletionCapability, CompletionContentBlock, CompletionDelta, CompletionMessage, CompletionRequest, CompletionResult, HypError, JsonObject } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { CreateOpenAiCompletionOptions, FetchLike, OpenAiCompletionConfig } from './types.js'
 */

const PLUGIN_NAME = '@hypaware/completion-openai'

/**
 * Build the `hypaware.completion` capability value: an HTTP client for
 * the OpenAI-compatible Chat Completions API (`POST /v1/chat/completions`).
 *
 * There is deliberately no retry layer: callers run on their own
 * cadence, so a failed request surfaces immediately. The API key resolves
 * from the environment at call time and is sent only as a Bearer header;
 * an unset key sends no Authorization header so localhost servers (Ollama,
 * LM Studio) work with zero credential config.
 *
 * @param {CreateOpenAiCompletionOptions} opts
 * @returns {CompletionCapability}
 */
export function createOpenAiCompletion(opts) {
  const { config, env, log } = opts
  const fetchImpl = opts.fetchImpl ?? /** @type {FetchLike} */ (/** @type {unknown} */ (globalThis.fetch))
  const endpoint = chatCompletionsEndpoint(config.base_url)

  return {
    provider: 'openai-compatible',
    defaultModel: config.model,

    async complete(req, completeOpts) {
      assertMessages(req)
      const model = req.model ?? config.model
      return withSpan(
        'completion.complete',
        {
          [Attr.COMPONENT]: 'completion',
          [Attr.OPERATION]: 'completion.complete',
          [Attr.PLUGIN]: PLUGIN_NAME,
          completion_model: model,
          message_count: req.messages.length,
          status: 'ok',
        },
        async (span) => {
          const { body, headers } = buildRequest({ req, config, env, model, stream: false })
          const response = await sendRequest({ endpoint, headers, body, fetchImpl, config, signal: completeOpts?.signal })
          /** @type {unknown} */
          let payload
          try {
            payload = await response.json()
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            throw newCompletionError('completion_bad_response', `chat response from ${endpoint} is not JSON: ${message}`)
          }
          const result = parseOpenAiChatResponse(payload, { model, endpoint })
          span.setAttribute('stop_reason', result.stopReason ?? 'unknown')
          span.setAttribute('output_tokens', result.usage?.output_tokens ?? 0)
          return result
        },
        { component: 'completion' }
      ).catch((/** @type {unknown} */ err) => {
        const errorKind = /** @type {HypError} */ (err)?.hypErrorKind ?? 'completion_failed'
        log.error('completion.complete_failed', {
          [Attr.ERROR_KIND]: errorKind,
          completion_model: model,
          message_count: req.messages.length,
          message: err instanceof Error ? err.message : String(err),
        })
        throw err
      })
    },

    async *stream(req, streamOpts) {
      assertMessages(req)
      const model = req.model ?? config.model
      const { body, headers } = buildRequest({ req, config, env, model, stream: true })
      const response = await sendRequest({ endpoint, headers, body, fetchImpl, config, signal: streamOpts?.signal })
      if (!response.body) {
        throw newCompletionError('completion_bad_response', `streaming chat response from ${endpoint} has no body`)
      }
      yield* parseOpenAiStream(response.body)
    },
  }
}

/**
 * @param {CompletionRequest} req
 */
function assertMessages(req) {
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw newCompletionError('completion_empty_messages', 'completion requires a non-empty messages array')
  }
}

/**
 * Compose the request body + headers. `params` is the provider passthrough
 * (e.g. `temperature`, `tool_choice`); explicit fields win over it.
 *
 * @param {{ req: CompletionRequest, config: OpenAiCompletionConfig, env: NodeJS.ProcessEnv, model: string, stream: boolean }} args
 * @returns {{ body: string, headers: Record<string, string> }}
 */
function buildRequest({ req, config, env, model, stream }) {
  const apiKey = env[config.api_key_env]
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  const params = /** @type {Record<string, unknown>} */ ({ ...(req.params ?? {}) })
  /** @type {Record<string, unknown>} */
  const body = {
    ...params,
    model,
    max_tokens: req.max_tokens ?? config.max_tokens,
    messages: toOpenAiMessages(req),
  }
  if (stream) {
    body.stream = true
    body.stream_options = { include_usage: true }
  }
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))
  }
  // Provider-neutral tool choice → OpenAI's native shape. Wins over a raw
  // `params.tool_choice` so a portable caller's intent is authoritative.
  if (req.toolChoice !== undefined) body.tool_choice = toOpenAiToolChoice(req.toolChoice)
  if (req.responseFormat !== undefined) body.response_format = req.responseFormat

  return { body: JSON.stringify(body), headers }
}

/**
 * Translate the provider-neutral `toolChoice` to the OpenAI Chat Completions
 * shape: `'auto'`/`'required'` pass through; `{name}` →
 * `{type:'function',function:{name}}` (force this tool).
 *
 * @param {NonNullable<CompletionRequest['toolChoice']>} choice
 * @returns {unknown}
 */
function toOpenAiToolChoice(choice) {
  if (choice === 'auto' || choice === 'required') return choice
  return { type: 'function', function: { name: choice.name } }
}

/**
 * Map completion messages to the Chat Completions shape. A `system` field
 * becomes a leading system message. Text blocks join into a string;
 * `tool_use` blocks on an assistant turn become `tool_calls`.
 *
 * @param {CompletionRequest} req
 * @returns {Array<Record<string, unknown>>}
 */
function toOpenAiMessages(req) {
  /** @type {Array<Record<string, unknown>>} */
  const messages = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content })
      continue
    }
    /** @type {string[]} */
    const textParts = []
    /** @type {Array<Record<string, unknown>>} */
    const toolCalls = []
    for (const b of m.content) {
      if (b.type === 'text') textParts.push(b.text ?? '')
      else if (b.type === 'tool_use') {
        toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })
      }
    }
    /** @type {Record<string, unknown>} */
    const msg = { role: m.role, content: textParts.length > 0 ? textParts.join('\n') : null }
    if (toolCalls.length > 0) msg.tool_calls = toolCalls
    messages.push(msg)
  }
  return messages
}

/**
 * @param {{ endpoint: string, headers: Record<string, string>, body: string, fetchImpl: FetchLike, config: OpenAiCompletionConfig, signal: AbortSignal | undefined }} args
 * @returns {Promise<Awaited<ReturnType<FetchLike>>>}
 */
async function sendRequest({ endpoint, headers, body, fetchImpl, config, signal }) {
  const timeoutSignal = AbortSignal.timeout(config.timeout_ms)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  /** @type {Awaited<ReturnType<FetchLike>>} */
  let response
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers, body, signal: requestSignal })
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw newCompletionError('completion_timeout', `chat request to ${endpoint} timed out after ${config.timeout_ms}ms`)
    }
    const message = err instanceof Error ? err.message : String(err)
    throw newCompletionError('completion_request_failed', `chat request to ${endpoint} failed: ${message}`)
  }

  if (!response.ok) {
    const apiKeySet = 'authorization' in headers
    const hint =
      (response.status === 401 || response.status === 403) && !apiKeySet
        ? ` (no API key sent: env var ${config.api_key_env} is unset)`
        : ''
    const err = newCompletionError(
      `completion_http_${response.status}`,
      `chat request to ${endpoint} failed with HTTP ${response.status}${hint}`
    )
    err.status = response.status
    throw err
  }

  return response
}

/**
 * Convert a non-streaming Chat Completions payload to a `CompletionResult`.
 *
 * @param {unknown} payload
 * @param {{ model: string, endpoint: string }} ctx
 * @returns {CompletionResult}
 */
export function parseOpenAiChatResponse(payload, ctx) {
  const data = /** @type {{ choices?: unknown, model?: unknown, usage?: { prompt_tokens?: number, completion_tokens?: number } }} */ (
    payload ?? {}
  )
  if (!Array.isArray(data.choices) || data.choices.length === 0) {
    throw newCompletionError('completion_bad_response', `chat response from ${ctx.endpoint} has no choices`)
  }
  const choice = /** @type {{ message?: { content?: unknown, tool_calls?: unknown }, finish_reason?: unknown }} */ (data.choices[0] ?? {})
  const message = choice.message ?? {}
  /** @type {CompletionContentBlock[]} */
  const content = []
  if (typeof message.content === 'string' && message.content.length > 0) {
    content.push({ type: 'text', text: message.content })
  }
  if (Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      const tc = /** @type {{ id?: unknown, function?: { name?: unknown, arguments?: unknown } }} */ (raw ?? {})
      let input = /** @type {JsonObject} */ ({})
      if (typeof tc.function?.arguments === 'string' && tc.function.arguments.length > 0) {
        try {
          input = /** @type {JsonObject} */ (JSON.parse(tc.function.arguments))
        } catch {
          input = /** @type {JsonObject} */ ({})
        }
      }
      content.push({
        type: 'tool_use',
        id: typeof tc.id === 'string' ? tc.id : undefined,
        name: typeof tc.function?.name === 'string' ? tc.function.name : undefined,
        input,
      })
    }
  }
  /** @type {CompletionMessage} */
  const out = { role: 'assistant', content }
  return {
    message: out,
    model: typeof data.model === 'string' ? data.model : ctx.model,
    stopReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined,
    usage: { input_tokens: data.usage?.prompt_tokens, output_tokens: data.usage?.completion_tokens },
  }
}

/**
 * Normalize an OpenAI chat SSE stream into `CompletionDelta`s. Yields a
 * `{ text }` delta per content delta; the terminal delta carries
 * `stopReason` (last `finish_reason`) and `usage` (from the final usage
 * chunk, when `stream_options.include_usage` is honored). Stops on the
 * `[DONE]` sentinel.
 *
 * @param {AsyncIterable<Uint8Array | string>} body
 * @returns {AsyncGenerator<CompletionDelta>}
 */
export async function* parseOpenAiStream(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  let inputTokens = 0
  let outputTokens = 0
  /** @type {string | undefined} */
  let stopReason
  for await (const chunk of body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let sep
    while ((sep = nextSeparator(buffer)) !== undefined) {
      const block = buffer.slice(0, sep.idx)
      buffer = buffer.slice(sep.idx + sep.len)
      const data = sseData(block)
      if (data === undefined) continue
      if (data === '[DONE]') {
        yield { stopReason, usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
        return
      }
      /** @type {any} */
      let event
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }
      const choice = event.choices?.[0]
      if (typeof choice?.delta?.content === 'string' && choice.delta.content.length > 0) {
        yield { text: choice.delta.content }
      }
      if (typeof choice?.finish_reason === 'string') stopReason = choice.finish_reason
      if (event.usage) {
        inputTokens = event.usage.prompt_tokens ?? inputTokens
        outputTokens = event.usage.completion_tokens ?? outputTokens
      }
    }
  }
  yield { stopReason, usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
}

/**
 * @param {string} buf
 * @returns {{ idx: number, len: number } | undefined}
 */
function nextSeparator(buf) {
  const a = buf.indexOf('\n\n')
  const b = buf.indexOf('\r\n\r\n')
  if (a === -1 && b === -1) return undefined
  if (a === -1) return { idx: b, len: 4 }
  if (b === -1) return { idx: a, len: 2 }
  return a < b ? { idx: a, len: 2 } : { idx: b, len: 4 }
}

/**
 * @param {string} block
 * @returns {string | undefined}
 */
function sseData(block) {
  /** @type {string[]} */
  const parts = []
  for (const line of block.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(':')) continue
    if (!line.startsWith('data:')) continue
    let value = line.slice('data:'.length)
    if (value.startsWith(' ')) value = value.slice(1)
    parts.push(value)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * @param {string} kind
 * @param {string} message
 * @returns {HypError}
 */
function newCompletionError(kind, message) {
  const err = /** @type {HypError} */ (new Error(message))
  err.hypErrorKind = kind
  return err
}
