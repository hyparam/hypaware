// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  chatCompletionsEndpoint,
  validateOpenAiCompletionConfig,
} from '../../hypaware-core/plugins-workspace/completion-openai/src/config.js'

test('validateOpenAiCompletionConfig defaults to OpenAI with OPENAI_API_KEY', () => {
  const result = validateOpenAiCompletionConfig(undefined)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.base_url, DEFAULT_BASE_URL)
  assert.equal(result.config.model, DEFAULT_MODEL)
  assert.equal(result.config.api_key_env, DEFAULT_API_KEY_ENV)
  assert.equal(result.config.max_tokens, DEFAULT_MAX_TOKENS)
  assert.equal(result.config.timeout_ms, DEFAULT_TIMEOUT_MS)
})

test('validateOpenAiCompletionConfig accepts an Ollama-shaped localhost override', () => {
  const result = validateOpenAiCompletionConfig({
    base_url: 'http://localhost:11434/v1/',
    model: 'llama3.1',
    api_key_env: 'MY_KEY',
    max_tokens: 1024,
    timeout_ms: 5000,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.base_url, 'http://localhost:11434/v1')
  assert.equal(result.config.model, 'llama3.1')
})

test('validateOpenAiCompletionConfig rejects a non-object config', () => {
  const result = validateOpenAiCompletionConfig('nope')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].errorKind, 'completion_config_invalid')
})

test('validateOpenAiCompletionConfig rejects a non-http base_url', () => {
  const result = validateOpenAiCompletionConfig({ base_url: 'ftp://example.com' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/base_url')
})

test('chatCompletionsEndpoint appends /v1/chat/completions and does not double /v1', () => {
  assert.equal(chatCompletionsEndpoint('https://api.openai.com'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(chatCompletionsEndpoint('http://localhost:11434/v1'), 'http://localhost:11434/v1/chat/completions')
  assert.equal(chatCompletionsEndpoint('http://localhost:11434/v1/'), 'http://localhost:11434/v1/chat/completions')
})
