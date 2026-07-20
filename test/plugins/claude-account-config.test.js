// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLAUDE_ACCOUNT_MODES,
  DEFAULT_MODE,
  resolveMode,
  validateClaudeAccountConfig,
} from '../../hypaware-core/plugins-workspace/claude-account/src/config.js'

test('validateClaudeAccountConfig accepts an empty / absent config', () => {
  assert.deepEqual(validateClaudeAccountConfig(undefined), { ok: true })
  assert.deepEqual(validateClaudeAccountConfig(null), { ok: true })
  assert.deepEqual(validateClaudeAccountConfig({}), { ok: true })
})

test('validateClaudeAccountConfig accepts both modes', () => {
  assert.deepEqual(validateClaudeAccountConfig({ mode: 'subscription' }), { ok: true })
  assert.deepEqual(validateClaudeAccountConfig({ mode: 'org_key', api_key: 'sk-test' }), { ok: true })
  assert.deepEqual(validateClaudeAccountConfig({ mode: 'org_key', api_key_env: 'ANTHROPIC_ORG_KEY' }), { ok: true })
})

test('validateClaudeAccountConfig rejects a non-object config', () => {
  const result = validateClaudeAccountConfig('org_key')
  assert.equal(result.ok, false)
})

test('validateClaudeAccountConfig rejects an unknown mode', () => {
  const result = validateClaudeAccountConfig({ mode: 'keychain' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '/mode')
})

test('validateClaudeAccountConfig requires a key source in org_key mode', () => {
  const result = validateClaudeAccountConfig({ mode: 'org_key' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors[0].message, /api_key or api_key_env/)
})

test('validateClaudeAccountConfig rejects api_key together with api_key_env', () => {
  const result = validateClaudeAccountConfig({ mode: 'org_key', api_key: 'a', api_key_env: 'B' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors[0].message, /mutually exclusive/)
})

test('validateClaudeAccountConfig rejects empty strings and unknown keys', () => {
  for (const bad of [{ api_key: '' }, { api_key_env: '' }, { api_key_evn: 'X' }]) {
    const result = validateClaudeAccountConfig(bad)
    assert.equal(result.ok, false, JSON.stringify(bad))
  }
})

test('resolveMode defaults to subscription and honors the config', () => {
  assert.equal(DEFAULT_MODE, 'subscription')
  assert.equal(resolveMode(undefined), 'subscription')
  assert.equal(resolveMode({}), 'subscription')
  assert.equal(resolveMode({ mode: 'org_key' }), 'org_key')
  assert.deepEqual([...CLAUDE_ACCOUNT_MODES].sort(), ['org_key', 'subscription'])
})
