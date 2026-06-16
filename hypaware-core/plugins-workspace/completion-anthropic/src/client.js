// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { messagesEndpoint } from './config.js'

/**
 * @import { CompletionCapability, CompletionContentBlock, CompletionDelta, CompletionMessage, CompletionRequest, CompletionResult, HypError, JsonObject } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { AnthropicCompletionConfig, CreateAnthropicCompletionOptions, FetchLike } from './types.d.ts'
 */

const PLUGIN_NAME = '@hypaware/completion-anthropic'

/**
 * Build the `hypaware.completion` capability value: an HTTP client for
 * the Anthropic Messages API (`POST /v1/messages`).
 *
 * There is deliberately no retry layer — callers (an enrichment tick, an
 * interactive command) run on their own cadence, so a failed request
 * surfaces immediately instead of stalling a tick. A `refusal` is NOT an
 * error: the Messages API returns it as a successful HTTP 200, so
 * `complete()`/`stream()` return it as `stopReason: 'refusal'` and the
 * caller decides — exactly as the capability contract requires.
 *
 * @param {CreateAnthropicCompletionOptions} opts
 * @returns {CompletionCapability}
 */
export function createAnthropicCompletion(opts) {
  const { config, env, log } = opts
  const fetchImpl = opts.fetchImpl ?? /** @type {FetchLike} */ (/** @type {unknown} */ (globalThis.fetch))
  const endpoint = messagesEndpoint(config.base_url)

  return {
    provider: 'anthropic',
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
            throw newCompletionError('completion_bad_response', `messages response from ${endpoint} is not JSON: ${message}`)
          }
          const result = parseAnthropicMessageResponse(payload, { model, endpoint })
          span.setAttribute('stop_reason', result.stopReason ?? 'unknown')
          span.setAttribute('output_tokens', result.usage?.output_tokens ?? 0)
          return result
        },
        { component: 'completion' }
      ).catch((/** @type {unknown} */ err) => {
        const errorKind = /** @type {HypError} */ (err)?.hypErrorKind ?? 'completion_failed'
        // Prompt content and key material never reach logs — counts only.
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
        throw newCompletionError('completion_bad_response', `streaming messages response from ${endpoint} has no body`)
      }
      yield* parseAnthropicStream(response.body, { model })
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
 * Compose the request body + headers. The API key resolves from the
 * environment at call time, used only for `x-api-key`; it is never logged,
 * thrown, or stored. `params` is the provider passthrough — `betas` lifts
 * to the `anthropic-beta` header, everything else merges into the body
 * (e.g. `thinking`, `tool_choice`, `output_config.effort`). Explicit
 * fields (messages/system/tools) always win over `params`.
 *
 * @param {{ req: CompletionRequest, config: AnthropicCompletionConfig, env: NodeJS.ProcessEnv, model: string, stream: boolean }} args
 * @returns {{ body: string, headers: Record<string, string> }}
 */
function buildRequest({ req, config, env, model, stream }) {
  const apiKey = env[config.api_key_env]
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': config.anthropic_version,
  }
  if (apiKey) headers['x-api-key'] = apiKey

  const params = /** @type {Record<string, unknown>} */ ({ ...(req.params ?? {}) })
  const betas = params.betas
  delete params.betas
  if (Array.isArray(betas) && betas.length > 0) {
    headers['anthropic-beta'] = betas.map(String).join(',')
  }

  const { system, messages } = toAnthropicMessages(req)
  /** @type {Record<string, unknown>} */
  const body = {
    ...params,
    model,
    max_tokens: req.max_tokens ?? config.max_tokens,
    messages,
  }
  if (stream) body.stream = true
  if (system) body.system = system
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))
  }
  // Provider-neutral tool choice → Anthropic's native shape. Wins over a
  // raw `params.tool_choice` so a portable caller's intent is authoritative.
  if (req.toolChoice !== undefined) body.tool_choice = toAnthropicToolChoice(req.toolChoice)
  if (req.responseFormat !== undefined) {
    const existing = /** @type {Record<string, unknown>} */ (
      params.output_config && typeof params.output_config === 'object' ? params.output_config : {}
    )
    body.output_config = { ...existing, format: req.responseFormat }
  }

  return { body: JSON.stringify(body), headers }
}

/**
 * Translate the provider-neutral `toolChoice` to the Anthropic Messages
 * shape: `'auto'` → `{type:'auto'}`, `'required'` → `{type:'any'}` (call some
 * tool), `{name}` → `{type:'tool',name}` (call this one).
 *
 * @param {NonNullable<CompletionRequest['toolChoice']>} choice
 * @returns {Record<string, unknown>}
 */
function toAnthropicToolChoice(choice) {
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'required') return { type: 'any' }
  return { type: 'tool', name: choice.name }
}

/**
 * Split a completion request's messages into the top-level `system`
 * string and the user/assistant turn list. A `system`-role message folds
 * into the system prompt (the Messages API has no system role in `messages`).
 *
 * @param {CompletionRequest} req
 * @returns {{ system: string | undefined, messages: Array<{ role: string, content: unknown }> }}
 */
function toAnthropicMessages(req) {
  let system = req.system
  /** @type {Array<{ role: string, content: unknown }>} */
  const messages = []
  for (const m of req.messages) {
    if (m.role === 'system') {
      const text = contentToText(m.content)
      system = system ? `${system}\n\n${text}` : text
      continue
    }
    messages.push({ role: m.role, content: toAnthropicContent(m.content) })
  }
  return { system, messages }
}

/**
 * @param {string | CompletionContentBlock[]} content
 * @returns {unknown}
 */
function toAnthropicContent(content) {
  if (typeof content === 'string') return content
  return content.map((b) =>
    b.type === 'tool_use'
      ? { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }
      : { type: 'text', text: b.text ?? '' }
  )
}

/**
 * @param {string | CompletionContentBlock[]} content
 * @returns {string}
 */
function contentToText(content) {
  if (typeof content === 'string') return content
  return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
}

/**
 * Send the request, mapping transport/HTTP failures to `hypErrorKind`
 * errors. The response body is deliberately never read into an error —
 * a provider may echo prompt content or credential material in its error
 * detail; status + endpoint + kind are enough to diagnose.
 *
 * @param {{ endpoint: string, headers: Record<string, string>, body: string, fetchImpl: FetchLike, config: AnthropicCompletionConfig, signal: AbortSignal | undefined }} args
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
      throw newCompletionError('completion_timeout', `messages request to ${endpoint} timed out after ${config.timeout_ms}ms`)
    }
    const message = err instanceof Error ? err.message : String(err)
    throw newCompletionError('completion_request_failed', `messages request to ${endpoint} failed: ${message}`)
  }

  if (!response.ok) {
    const hasKey = 'x-api-key' in headers
    const hint =
      (response.status === 401 || response.status === 403) && !hasKey
        ? ` (no API key sent: env var for x-api-key is unset)`
        : ''
    const err = newCompletionError(
      `completion_http_${response.status}`,
      `messages request to ${endpoint} failed with HTTP ${response.status}${hint}`
    )
    err.status = response.status
    throw err
  }

  return response
}

/**
 * Convert a non-streaming Messages API payload to a `CompletionResult`.
 * Only `text` and `tool_use` blocks are surfaced (the normalized union);
 * `thinking` and other internal blocks are dropped from the message.
 *
 * @param {unknown} payload
 * @param {{ model: string, endpoint: string }} ctx
 * @returns {CompletionResult}
 */
export function parseAnthropicMessageResponse(payload, ctx) {
  const data = /** @type {{ content?: unknown, model?: unknown, stop_reason?: unknown, usage?: { input_tokens?: number, output_tokens?: number } }} */ (
    payload ?? {}
  )
  if (!Array.isArray(data.content)) {
    throw newCompletionError('completion_bad_response', `messages response from ${ctx.endpoint} has no content array`)
  }
  /** @type {CompletionContentBlock[]} */
  const content = []
  for (const raw of data.content) {
    const block = /** @type {{ type?: unknown, text?: unknown, id?: unknown, name?: unknown, input?: unknown }} */ (raw ?? {})
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_use') {
      content.push({
        type: 'tool_use',
        id: typeof block.id === 'string' ? block.id : undefined,
        name: typeof block.name === 'string' ? block.name : undefined,
        input: /** @type {JsonObject} */ (block.input ?? {}),
      })
    }
  }
  /** @type {CompletionMessage} */
  const message = { role: 'assistant', content }
  return {
    message,
    model: typeof data.model === 'string' ? data.model : ctx.model,
    stopReason: typeof data.stop_reason === 'string' ? data.stop_reason : undefined,
    usage: { input_tokens: data.usage?.input_tokens, output_tokens: data.usage?.output_tokens },
  }
}

/**
 * Normalize an Anthropic Messages SSE stream into `CompletionDelta`s.
 * Yields a `{ text }` delta per `text_delta`; the terminal delta carries
 * `stopReason` (from `message_delta`) and `usage` (input from
 * `message_start`, output from `message_delta`).
 *
 * @param {AsyncIterable<Uint8Array | string>} body
 * @param {{ model: string }} _ctx
 * @returns {AsyncGenerator<CompletionDelta>}
 */
export async function* parseAnthropicStream(body, _ctx) {
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
      /** @type {any} */
      let event
      try {
        event = JSON.parse(data)
      } catch {
        continue
      }
      if (event.type === 'message_start') {
        inputTokens = event.message?.usage?.input_tokens ?? inputTokens
      } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        if (typeof event.delta.text === 'string' && event.delta.text.length > 0) {
          yield { text: event.delta.text }
        }
      } else if (event.type === 'message_delta') {
        stopReason = event.delta?.stop_reason ?? stopReason
        outputTokens = event.usage?.output_tokens ?? outputTokens
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
 * Extract the concatenated `data:` payload from an SSE block, or
 * `undefined` for comment-only / fieldless blocks.
 *
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
