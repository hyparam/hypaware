// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_ANTHROPIC_VERSION,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  messagesEndpoint,
  validateAnthropicCompletionConfig,
} from '../../hypaware-core/plugins-workspace/completion-anthropic/src/config.js'

test('validateAnthropicCompletionConfig defaults to Anthropic with ANTHROPIC_API_KEY and Opus', () => {
  const result = validateAnthropicCompletionConfig(undefined)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.base_url, DEFAULT_BASE_URL)
  assert.equal(result.config.model, DEFAULT_MODEL)
  assert.equal(result.config.api_key_env, DEFAULT_API_KEY_ENV)
  assert.equal(result.config.anthropic_version, DEFAULT_ANTHROPIC_VERSION)
  assert.equal(result.config.max_tokens, DEFAULT_MAX_TOKENS)
  assert.equal(result.config.timeout_ms, DEFAULT_TIMEOUT_MS)
})

test('validateAnthropicCompletionConfig accepts a proxy/localhost override', () => {
  const result = validateAnthropicCompletionConfig({
    base_url: 'http://localhost:8787/v1/',
    model: 'claude-haiku-4-5',
    api_key_env: 'MY_KEY',
    max_tokens: 1024,
    timeout_ms: 5000,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.config.base_url, 'http://localhost:8787/v1')
  assert.equal(result.config.model, 'claude-haiku-4-5')
  assert.equal(result.config.api_key_env, 'MY_KEY')
})

test('validateAnthropicCompletionConfig rejects a non-object config', () => {
  const result = validateAnthropicCompletionConfig('nope')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].errorKind, 'completion_config_invalid')
})

test('validateAnthropicCompletionConfig rejects a non-http base_url', () => {
  const result = validateAnthropicCompletionConfig({ base_url: 'ftp://example.com' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/base_url')
})

test('validateAnthropicCompletionConfig rejects non-positive numeric fields', () => {
  for (const key of ['max_tokens', 'timeout_ms']) {
    const result = validateAnthropicCompletionConfig({ [key]: 0 })
    assert.equal(result.ok, false, `${key}=0 must fail`)
    if (result.ok) continue
    assert.equal(result.errors[0].pointer, `/${key}`)
  }
})

test('messagesEndpoint appends /v1/messages to a bare origin and does not double /v1', () => {
  assert.equal(messagesEndpoint('https://api.anthropic.com'), 'https://api.anthropic.com/v1/messages')
  assert.equal(messagesEndpoint('http://localhost:8787/v1'), 'http://localhost:8787/v1/messages')
  assert.equal(messagesEndpoint('http://localhost:8787/v1/'), 'http://localhost:8787/v1/messages')
})
