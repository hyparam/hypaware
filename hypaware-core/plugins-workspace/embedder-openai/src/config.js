// @ts-check

/**
 * Config validation for `@hypaware/embedder-openai`. Mirrors the
 * `@hypaware/s3` validator shape: pure, dependency-free, returns a
 * normalized config or a list of `embedder_config_invalid` errors so it
 * is callable from tests without spinning up observability.
 */

/**
 * @import { EmbedderConfigError, EmbedderConfigResult } from './types.js'
 */

// @ref LLP 0024#embedder-speaks-openai-compatible-base_url-configurable [implements]: defaults cover OpenAI; base_url override covers proxies and localhost servers
export const DEFAULT_BASE_URL = 'https://api.openai.com'
export const DEFAULT_MODEL = 'text-embedding-3-small'
export const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'
export const DEFAULT_MAX_BATCH = 128
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Validate the plugin's config slice. Every field is optional: the
 * zero-config default targets OpenAI with `OPENAI_API_KEY`.
 *
 * @param {unknown} value
 * @returns {EmbedderConfigResult}
 */
export function validateEmbedderConfig(value) {
  /** @type {EmbedderConfigError[]} */
  const errors = []

  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    errors.push(invalid('', 'embedder-openai config must be an object'))
    return { ok: false, errors }
  }

  const raw = /** @type {Record<string, unknown>} */ (value ?? {})

  const baseUrl = readString(raw, 'base_url', errors) ?? DEFAULT_BASE_URL
  const model = readString(raw, 'model', errors) ?? DEFAULT_MODEL
  const apiKeyEnv = readString(raw, 'api_key_env', errors) ?? DEFAULT_API_KEY_ENV
  const dimensions = readPositiveInt(raw, 'dimensions', errors)
  const maxBatch = readPositiveInt(raw, 'max_batch', errors) ?? DEFAULT_MAX_BATCH
  const timeoutMs = readPositiveInt(raw, 'timeout_ms', errors) ?? DEFAULT_TIMEOUT_MS

  if (raw.base_url !== undefined && typeof raw.base_url === 'string') {
    try {
      const u = new URL(/** @type {string} */ (raw.base_url))
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        errors.push(invalid('/base_url', `base_url must be http(s); got '${u.protocol}'`))
      }
    } catch {
      errors.push(invalid('/base_url', `base_url is not a valid URL: '${raw.base_url}'`))
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    config: {
      base_url: stripTrailingSlash(baseUrl),
      model,
      api_key_env: apiKeyEnv,
      ...(dimensions !== undefined ? { dimensions } : {}),
      max_batch: maxBatch,
      timeout_ms: timeoutMs,
    },
  }
}

/**
 * Endpoint for a normalized base_url. Accepts both bare origins
 * (`https://api.openai.com`) and `/v1`-suffixed bases
 * (`http://localhost:11434/v1`, the form Ollama documents) so users can
 * paste either without a double `/v1/v1`.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function embeddingsEndpoint(baseUrl) {
  const base = stripTrailingSlash(baseUrl)
  return base.endsWith('/v1') ? `${base}/embeddings` : `${base}/v1/embeddings`
}

/** @param {string} url */
function stripTrailingSlash(url) {
  return url.replace(/\/+$/, '')
}

/**
 * @param {string} pointer
 * @param {string} message
 * @returns {EmbedderConfigError}
 */
function invalid(pointer, message) {
  return { pointer, message, errorKind: 'embedder_config_invalid' }
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {EmbedderConfigError[]} errors
 * @returns {string | undefined}
 */
function readString(raw, key, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.length === 0) {
    errors.push(invalid(`/${key}`, `${key} must be a non-empty string`))
    return undefined
  }
  return v
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {EmbedderConfigError[]} errors
 * @returns {number | undefined}
 */
function readPositiveInt(raw, key, errors) {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    errors.push(invalid(`/${key}`, `${key} must be a positive integer`))
    return undefined
  }
  return v
}
