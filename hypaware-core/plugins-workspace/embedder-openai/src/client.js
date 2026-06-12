// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { embeddingsEndpoint } from './config.js'

/**
 * @import { EmbedderCapability, EmbedResult, HypError } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { CreateEmbedderOptions, EmbedderOpenAiConfig, FetchLike } from './types.d.ts'
 */

const PLUGIN_NAME = '@hypaware/embedder-openai'

/**
 * Build the `hypaware.embedder` capability value: an HTTP client for
 * the OpenAI-compatible `POST /v1/embeddings` shape.
 *
 * Batches larger than `max_batch` are chunked into sequential requests;
 * the returned vectors are always aligned with the input order. There
 * is deliberately no retry layer — callers (the vector-search refresh
 * tick, an interactive search) already re-run on their own cadence, so
 * a failed request surfaces immediately instead of stalling a tick.
 *
 * @param {CreateEmbedderOptions} opts
 * @returns {EmbedderCapability}
 */
export function createOpenAiEmbedder(opts) {
  const { config, env, log } = opts
  const fetchImpl = opts.fetchImpl ?? /** @type {FetchLike} */ (/** @type {unknown} */ (globalThis.fetch))
  const endpoint = embeddingsEndpoint(config.base_url)

  return {
    provider: 'openai-compatible',
    model: config.model,

    async embed(texts, embedOpts) {
      if (!Array.isArray(texts) || texts.length === 0) {
        throw newEmbedderError('embedder_empty_input', 'embed() requires a non-empty array of texts')
      }
      return withSpan(
        'embedder.embed',
        {
          [Attr.COMPONENT]: 'embedder',
          [Attr.OPERATION]: 'embedder.embed',
          [Attr.PLUGIN]: PLUGIN_NAME,
          embed_model: config.model,
          text_count: texts.length,
          status: 'ok',
        },
        async (span) => {
          /** @type {Float32Array[]} */
          const vectors = []
          let dimension = 0
          let promptTokens = 0
          let totalTokens = 0
          let requestCount = 0

          for (let i = 0; i < texts.length; i += config.max_batch) {
            const batch = texts.slice(i, i + config.max_batch)
            const result = await requestEmbeddings({
              batch,
              config,
              env,
              endpoint,
              fetchImpl,
              signal: embedOpts?.signal,
            })
            requestCount++
            for (const v of result.vectors) {
              if (dimension === 0) dimension = v.length
              else if (v.length !== dimension) {
                throw newEmbedderError(
                  'embedder_dimension_mismatch',
                  `embedding dimension changed mid-batch (${dimension} -> ${v.length}) for model '${config.model}'`
                )
              }
              vectors.push(v)
            }
            promptTokens += result.usage?.prompt_tokens ?? 0
            totalTokens += result.usage?.total_tokens ?? 0
          }

          span.setAttribute('request_count', requestCount)
          span.setAttribute('dimension', dimension)
          span.setAttribute('prompt_tokens', promptTokens)

          /** @type {EmbedResult} */
          const out = {
            vectors,
            dimension,
            model: config.model,
            usage: { prompt_tokens: promptTokens, total_tokens: totalTokens },
          }
          return out
        },
        { component: 'embedder' }
      ).catch((/** @type {unknown} */ err) => {
        const errorKind = /** @type {HypError} */ (err)?.hypErrorKind ?? 'embedder_failed'
        // Text content and key material never reach logs — counts only.
        log.error('embedder.embed_failed', {
          [Attr.ERROR_KIND]: errorKind,
          embed_model: config.model,
          text_count: texts.length,
          message: err instanceof Error ? err.message : String(err),
        })
        throw err
      })
    },
  }
}

/**
 * One `POST /v1/embeddings` request. The API key resolves from the
 * environment at call time and is used only for the Authorization
 * header — it is never logged, never thrown in a message, and never
 * stored on the embedder. When the configured env var is unset the
 * request goes out without an Authorization header so localhost
 * servers (Ollama, LM Studio) work with zero credential config; a 401
 * from a real provider then names the env var to set.
 *
 * @param {{
 *   batch: string[],
 *   config: EmbedderOpenAiConfig,
 *   env: NodeJS.ProcessEnv,
 *   endpoint: string,
 *   fetchImpl: FetchLike,
 *   signal: AbortSignal | undefined,
 * }} args
 * @returns {Promise<{ vectors: Float32Array[], usage?: { prompt_tokens?: number, total_tokens?: number } }>}
 * @ref LLP 0024#embedder-speaks-openai-compatible-base_url-configurable [implements] — config names the env var; the key resolves at call time and never reaches logs
 */
async function requestEmbeddings({ batch, config, env, endpoint, fetchImpl, signal }) {
  const apiKey = env[config.api_key_env]
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  const timeoutSignal = AbortSignal.timeout(config.timeout_ms)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  /** @type {Record<string, unknown>} */
  const body = {
    model: config.model,
    input: batch,
    encoding_format: 'float',
  }
  if (config.dimensions !== undefined) body.dimensions = config.dimensions

  /** @type {Awaited<ReturnType<FetchLike>>} */
  let response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: requestSignal,
    })
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw newEmbedderError(
        'embedder_timeout',
        `embeddings request to ${endpoint} timed out after ${config.timeout_ms}ms`
      )
    }
    const message = err instanceof Error ? err.message : String(err)
    throw newEmbedderError('embedder_request_failed', `embeddings request to ${endpoint} failed: ${message}`)
  }

  if (!response.ok) {
    const detail = await safeErrorDetail(response)
    const hint =
      (response.status === 401 || response.status === 403) && !apiKey
        ? ` (no API key sent: env var ${config.api_key_env} is unset)`
        : ''
    const err = newEmbedderError(
      `embedder_http_${response.status}`,
      `embeddings request to ${endpoint} failed with HTTP ${response.status}${hint}${detail ? `: ${detail}` : ''}`
    )
    err.status = response.status
    throw err
  }

  /** @type {unknown} */
  let payload
  try {
    payload = await response.json()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw newEmbedderError('embedder_bad_response', `embeddings response from ${endpoint} is not JSON: ${message}`)
  }

  return parseEmbeddingsPayload(payload, batch.length, endpoint)
}

/**
 * Validate and convert the response payload. `data[]` entries carry an
 * `index` field; sort by it rather than trusting array order, per the
 * OpenAI contract.
 *
 * @param {unknown} payload
 * @param {number} expectedCount
 * @param {string} endpoint
 * @returns {{ vectors: Float32Array[], usage?: { prompt_tokens?: number, total_tokens?: number } }}
 */
export function parseEmbeddingsPayload(payload, expectedCount, endpoint) {
  const data = /** @type {{ data?: unknown, usage?: { prompt_tokens?: number, total_tokens?: number } }} */ (payload ?? {})
  if (!Array.isArray(data.data) || data.data.length !== expectedCount) {
    throw newEmbedderError(
      'embedder_bad_response',
      `embeddings response from ${endpoint} returned ${Array.isArray(data.data) ? data.data.length : 'no'} embeddings for ${expectedCount} inputs`
    )
  }
  /** @type {Float32Array[]} */
  const vectors = new Array(expectedCount)
  for (const entry of data.data) {
    const item = /** @type {{ index?: unknown, embedding?: unknown }} */ (entry ?? {})
    const index = typeof item.index === 'number' ? item.index : -1
    if (index < 0 || index >= expectedCount || !Array.isArray(item.embedding) || item.embedding.length === 0) {
      throw newEmbedderError('embedder_bad_response', `embeddings response from ${endpoint} has a malformed data entry`)
    }
    vectors[index] = Float32Array.from(/** @type {number[]} */ (item.embedding))
  }
  for (let i = 0; i < expectedCount; i++) {
    if (!vectors[i]) {
      throw newEmbedderError('embedder_bad_response', `embeddings response from ${endpoint} is missing index ${i}`)
    }
  }
  return { vectors, usage: data.usage }
}

/**
 * Body excerpt for failed responses: the provider's `error.message`
 * when present, else a short prefix of the body. Bounded so a huge
 * HTML error page cannot flood logs.
 *
 * @param {Awaited<ReturnType<FetchLike>>} response
 * @returns {Promise<string>}
 */
async function safeErrorDetail(response) {
  try {
    const text = await response.text()
    try {
      const parsed = /** @type {{ error?: { message?: string } }} */ (JSON.parse(text))
      if (typeof parsed?.error?.message === 'string') return parsed.error.message.slice(0, 256)
    } catch { /* not JSON — fall through */ }
    return text.slice(0, 256)
  } catch {
    return ''
  }
}

/**
 * @param {string} kind
 * @param {string} message
 * @returns {HypError}
 */
function newEmbedderError(kind, message) {
  const err = /** @type {HypError} */ (new Error(message))
  err.hypErrorKind = kind
  return err
}
