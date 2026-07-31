import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CANONICAL_PROVIDER_FOR_SHAPE,
  DEFERRED_SET,
  SHADOW_FOR_SHAPE,
  WARNING_CAUSES,
  resolveSteering,
  tryResolveApiKeyForProvider,
} from '../src/steering.js'

/**
 * @param {string|undefined} credential
 */
function ctxReturning(credential) {
  return { resolveCredential: async () => credential }
}

function ctxThrowing() {
  return {
    resolveCredential: async () => {
      throw new Error('boom')
    },
  }
}

test('resolveSteering: steers a canonical anthropic candidate with a resolvable credential', async () => {
  const result = await resolveSteering(
    { provider: 'anthropic', api: 'anthropic-messages' },
    ctxReturning('sk-ant-abc123'),
  )

  assert.deepEqual(result, {
    steer: true,
    providerOverride: SHADOW_FOR_SHAPE['anthropic-messages'],
    requestMeta: { 'x-hypaware-upstream': 'anthropic' },
  })
})

test('resolveSteering: steers a canonical openai candidate with a resolvable credential', async () => {
  const result = await resolveSteering(
    { provider: 'openai', api: 'openai-completions' },
    ctxReturning('sk-openai-abc123'),
  )

  assert.deepEqual(result, {
    steer: true,
    providerOverride: SHADOW_FOR_SHAPE['openai-completions'],
    requestMeta: { 'x-hypaware-upstream': 'openai' },
  })
})

test('resolveSteering: warns no_preset when no shadow covers the api shape at all', async () => {
  const result = await resolveSteering(
    { provider: 'anthropic', api: 'some-future-shape' },
    ctxReturning('sk-ant-abc123'),
  )

  assert.deepEqual(result, { steer: false, cause: WARNING_CAUSES.NO_PRESET, provider: 'anthropic' })
})

test('resolveSteering: warns deferred for every DEFERRED_SET member sharing a canonical shape', async () => {
  const deferredAnthropicShaped = ['anthropic-vertex', 'cloudflare-ai-gateway', 'vercel-ai-gateway']

  for (const provider of deferredAnthropicShaped) {
    assert.ok(DEFERRED_SET.has(provider), `expected ${provider} in DEFERRED_SET`)
    const result = await resolveSteering({ provider, api: 'anthropic-messages' }, ctxReturning('irrelevant'))
    assert.deepEqual(result, { steer: false, cause: WARNING_CAUSES.DEFERRED, provider })
  }
})

test('resolveSteering: warns deferred for the Google family sharing the openai-completions shape', async () => {
  for (const provider of ['google', 'google-vertex', 'google-gemini-cli']) {
    assert.ok(DEFERRED_SET.has(provider), `expected ${provider} in DEFERRED_SET`)
    const result = await resolveSteering({ provider, api: 'openai-completions' }, ctxReturning('irrelevant'))
    assert.deepEqual(result, { steer: false, cause: WARNING_CAUSES.DEFERRED, provider })
  }
})

test('resolveSteering: warns deferred for amazon-bedrock even though its shape is unspecified in LLP 0146, using the anthropic-messages shape it is verified to declare', async () => {
  assert.ok(DEFERRED_SET.has('amazon-bedrock'))
  const result = await resolveSteering(
    { provider: 'amazon-bedrock', api: 'anthropic-messages' },
    ctxReturning('irrelevant'),
  )
  assert.deepEqual(result, { steer: false, cause: WARNING_CAUSES.DEFERRED, provider: 'amazon-bedrock' })
})

test('resolveSteering: warns no_preset for a shape-matching, non-canonical, non-deferred vendor (e.g. minimax, synthetic, kimi-coding)', async () => {
  for (const provider of ['minimax', 'synthetic', 'kimi-coding']) {
    assert.ok(!DEFERRED_SET.has(provider), `expected ${provider} to NOT be in DEFERRED_SET`)
    const result = await resolveSteering({ provider, api: 'anthropic-messages' }, ctxReturning('irrelevant'))
    assert.deepEqual(result, { steer: false, cause: WARNING_CAUSES.NO_PRESET, provider })
  }
})

test('resolveSteering: warns no_preset for a shape-matching, non-canonical, non-deferred openai-family vendor', async () => {
  const result = await resolveSteering(
    { provider: 'openrouter', api: 'openai-completions' },
    ctxReturning('irrelevant'),
  )
  assert.deepEqual(result, { steer: false, cause: WARNING_CAUSES.NO_PRESET, provider: 'openrouter' })
})

test('resolveSteering: warns no_credential when the canonical provider has no resolvable credential', async () => {
  const result = await resolveSteering({ provider: 'anthropic', api: 'anthropic-messages' }, ctxReturning(undefined))
  assert.deepEqual(result, { steer: false, cause: WARNING_CAUSES.NO_CREDENTIAL, provider: 'anthropic' })
})

test('resolveSteering: warns no_credential (not a throw) when credential resolution itself throws', async () => {
  const result = await resolveSteering({ provider: 'openai', api: 'openai-completions' }, ctxThrowing())
  assert.deepEqual(result, { steer: false, cause: WARNING_CAUSES.NO_CREDENTIAL, provider: 'openai' })
})

test('resolveSteering: credential check never runs for a candidate that already failed an earlier branch', async () => {
  let called = false
  const ctx = {
    resolveCredential: async () => {
      called = true
      return 'sk-should-not-be-reached'
    },
  }

  await resolveSteering({ provider: 'anthropic', api: 'some-future-shape' }, ctx)
  assert.equal(called, false, 'no_preset (unknown shape) must not resolve a credential')

  await resolveSteering({ provider: 'minimax', api: 'anthropic-messages' }, ctx)
  assert.equal(called, false, 'no_preset (wrong vendor) must not resolve a credential')

  await resolveSteering({ provider: 'anthropic-vertex', api: 'anthropic-messages' }, ctx)
  assert.equal(called, false, 'deferred must not resolve a credential')
})

test('SHADOW_FOR_SHAPE and CANONICAL_PROVIDER_FOR_SHAPE cover exactly the two known shapes', () => {
  assert.deepEqual(Object.keys(SHADOW_FOR_SHAPE).sort(), ['anthropic-messages', 'openai-completions'])
  assert.deepEqual(Object.keys(CANONICAL_PROVIDER_FOR_SHAPE).sort(), ['anthropic-messages', 'openai-completions'])
  assert.equal(SHADOW_FOR_SHAPE['anthropic-messages'], 'hypaware-anthropic')
  assert.equal(SHADOW_FOR_SHAPE['openai-completions'], 'hypaware-openai')
})

test('tryResolveApiKeyForProvider: returns undefined for an empty-string credential, not the empty string', async () => {
  const credential = await tryResolveApiKeyForProvider('anthropic', ctxReturning(''))
  assert.equal(credential, undefined)
})

test('tryResolveApiKeyForProvider: passes a real credential through unchanged', async () => {
  const credential = await tryResolveApiKeyForProvider('anthropic', ctxReturning('sk-ant-abc123'))
  assert.equal(credential, 'sk-ant-abc123')
})
