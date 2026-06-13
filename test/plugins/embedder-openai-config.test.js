// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_BATCH,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  embeddingsEndpoint,
  validateEmbedderConfig,
} from '../../hypaware-core/plugins-workspace/embedder-openai/src/config.js'

test('validateEmbedderConfig defaults to OpenAI with OPENAI_API_KEY', () => {
  const result = validateEmbedderConfig(undefined)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.base_url, DEFAULT_BASE_URL)
  assert.equal(result.config.model, DEFAULT_MODEL)
  assert.equal(result.config.api_key_env, DEFAULT_API_KEY_ENV)
  assert.equal(result.config.max_batch, DEFAULT_MAX_BATCH)
  assert.equal(result.config.timeout_ms, DEFAULT_TIMEOUT_MS)
  assert.equal(result.config.dimensions, undefined)
})

test('validateEmbedderConfig accepts a localhost override (Ollama shape)', () => {
  const result = validateEmbedderConfig({
    base_url: 'http://localhost:11434/v1/',
    model: 'nomic-embed-text',
    api_key_env: 'MY_KEY',
    max_batch: 16,
    timeout_ms: 5000,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.base_url, 'http://localhost:11434/v1')
  assert.equal(result.config.model, 'nomic-embed-text')
  assert.equal(result.config.api_key_env, 'MY_KEY')
})

test('validateEmbedderConfig accepts dimensions for v3 shortening', () => {
  const result = validateEmbedderConfig({ dimensions: 256 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.dimensions, 256)
})

test('validateEmbedderConfig rejects a non-object config', () => {
  const result = validateEmbedderConfig('nope')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].errorKind, 'embedder_config_invalid')
})

test('validateEmbedderConfig rejects a non-http base_url', () => {
  const result = validateEmbedderConfig({ base_url: 'ftp://example.com' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/base_url')
})

test('validateEmbedderConfig rejects a malformed base_url', () => {
  const result = validateEmbedderConfig({ base_url: 'not a url' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/base_url')
})

test('validateEmbedderConfig rejects non-positive numeric fields', () => {
  for (const key of ['dimensions', 'max_batch', 'timeout_ms']) {
    const result = validateEmbedderConfig({ [key]: 0 })
    assert.equal(result.ok, false, `${key}=0 must fail`)
    if (result.ok) continue
    assert.equal(result.errors[0].pointer, `/${key}`)
  }
})

test('embeddingsEndpoint appends /v1/embeddings to a bare origin', () => {
  assert.equal(embeddingsEndpoint('https://api.openai.com'), 'https://api.openai.com/v1/embeddings')
})

test('embeddingsEndpoint does not double /v1 on a /v1-suffixed base', () => {
  assert.equal(embeddingsEndpoint('http://localhost:11434/v1'), 'http://localhost:11434/v1/embeddings')
  assert.equal(embeddingsEndpoint('http://localhost:11434/v1/'), 'http://localhost:11434/v1/embeddings')
})
