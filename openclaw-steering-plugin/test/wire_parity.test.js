import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ANTHROPIC_CONTEXT_1M_BETA,
  ANTHROPIC_DEFAULT_BETAS,
  ANTHROPIC_OAUTH_BETAS,
  createAnthropicBetaHeadersWrapper,
  createAnthropicServiceTierWrapper,
  isAnthropic1MModel,
  isAnthropicOAuthApiKey,
  mergeAnthropicBetaHeader,
  mergeHeaderList,
  normalizeFastMode,
  parseHeaderList,
  resolveAnthropicFastMode,
  resolveAnthropicServiceTier,
  resolveConfiguredAnthropicBetas,
  shouldMirrorAnthropicBetas,
  stripTrailingAnthropicAssistantPrefillWhenThinking,
  wrapAnthropicShadowStream,
} from '../src/wire_parity.js'

const OAUTH_KEY = 'sk-ant-oat01-abc'
const API_KEY = 'sk-ant-api03-abc'

/**
 * Records what the underlying stream fn was finally called with.
 */
function recordingStreamFn() {
  /** @type {Array<{ model: unknown, context: unknown, options: any }>} */
  const calls = []
  /** @type {any} */
  const streamFn = (model, context, options) => {
    calls.push({ model, context, options })
    return 'stream'
  }
  return { streamFn, calls }
}

function anthropicModel(id = 'claude-opus-4-6') {
  return { id, api: 'anthropic-messages', provider: 'hypaware-anthropic', baseUrl: 'http://127.0.0.1:18521' }
}

test('parseHeaderList splits, trims, and drops blanks', () => {
  assert.deepEqual(parseHeaderList(' a , b ,, c '), ['a', 'b', 'c'])
  assert.deepEqual(parseHeaderList(undefined), [])
})

test('mergeHeaderList unions values under the existing header name spelling', () => {
  const merged = mergeHeaderList({ 'Anthropic-Beta': 'already-there' }, 'anthropic-beta', ['added'])
  assert.deepEqual(merged, { 'Anthropic-Beta': 'already-there,added' })
})

test('mergeHeaderList is idempotent', () => {
  const once = mergeAnthropicBetaHeader({}, ANTHROPIC_DEFAULT_BETAS)
  const twice = mergeAnthropicBetaHeader(once, ANTHROPIC_DEFAULT_BETAS)
  assert.deepEqual(twice, once)
  // R4: a future OpenClaw release that starts setting one of these itself
  // must not produce a duplicate.
  const withUpstream = mergeAnthropicBetaHeader(
    { 'anthropic-beta': ANTHROPIC_DEFAULT_BETAS[0] },
    ANTHROPIC_DEFAULT_BETAS,
  )
  assert.deepEqual(withUpstream, { 'anthropic-beta': ANTHROPIC_DEFAULT_BETAS.join(',') })
})

test('mergeHeaderList leaves unrelated headers untouched', () => {
  const merged = mergeHeaderList({ 'x-app': 'cli' }, 'anthropic-beta', ['b1'])
  assert.deepEqual(merged, { 'x-app': 'cli', 'anthropic-beta': 'b1' })
})

test('isAnthropicOAuthApiKey matches the predicate pi-ai and OpenClaw both use', () => {
  assert.equal(isAnthropicOAuthApiKey(OAUTH_KEY), true)
  assert.equal(isAnthropicOAuthApiKey(API_KEY), false)
  assert.equal(isAnthropicOAuthApiKey(undefined), false)
})

test('the beta wrapper emits the default set under an api key', () => {
  const { streamFn, calls } = recordingStreamFn()
  createAnthropicBetaHeadersWrapper(streamFn, [])(anthropicModel(), {}, { apiKey: API_KEY })
  assert.equal(calls[0].options.headers['anthropic-beta'], ANTHROPIC_DEFAULT_BETAS.join(','))
})

test('the beta wrapper adds the OAuth betas on top of the defaults, never instead of them', () => {
  const { streamFn, calls } = recordingStreamFn()
  createAnthropicBetaHeadersWrapper(streamFn, [])(anthropicModel(), {}, { apiKey: OAUTH_KEY })
  const emitted = parseHeaderList(calls[0].options.headers['anthropic-beta'])
  assert.deepEqual(emitted, [...ANTHROPIC_OAUTH_BETAS])
  for (const beta of ANTHROPIC_DEFAULT_BETAS) assert.ok(emitted.includes(beta))
})

test('the beta wrapper unions configured betas without duplicating the defaults', () => {
  const { streamFn, calls } = recordingStreamFn()
  createAnthropicBetaHeadersWrapper(streamFn, ['custom-beta', ANTHROPIC_DEFAULT_BETAS[0]])(
    anthropicModel(),
    {},
    { apiKey: API_KEY },
  )
  assert.deepEqual(parseHeaderList(calls[0].options.headers['anthropic-beta']), [
    ...ANTHROPIC_DEFAULT_BETAS,
    'custom-beta',
  ])
})

test('the legacy context-1m beta never reaches the wire, matching shipped OpenClaw', () => {
  assert.equal(resolveConfiguredAnthropicBetas({ anthropicBeta: ANTHROPIC_CONTEXT_1M_BETA }), undefined)
  const { streamFn, calls } = recordingStreamFn()
  createAnthropicBetaHeadersWrapper(streamFn, [ANTHROPIC_CONTEXT_1M_BETA])(anthropicModel(), {}, { apiKey: API_KEY })
  assert.ok(!calls[0].options.headers['anthropic-beta'].includes(ANTHROPIC_CONTEXT_1M_BETA))
})

test('resolveConfiguredAnthropicBetas reads a string or an array of comma lists', () => {
  assert.deepEqual(resolveConfiguredAnthropicBetas({ anthropicBeta: 'a, b' }), ['a', 'b'])
  assert.deepEqual(resolveConfiguredAnthropicBetas({ anthropicBeta: ['a,b', ' c '] }), ['a', 'b', 'c'])
  assert.equal(resolveConfiguredAnthropicBetas({}), undefined)
})

test('isAnthropic1MModel covers the GA prefixes and the identity-resolved families', () => {
  assert.equal(isAnthropic1MModel('claude-opus-4-6-20260101'), true)
  assert.equal(isAnthropic1MModel('claude-sonnet-4.6'), true)
  assert.equal(isAnthropic1MModel('vertex-claude-sonnet-5'), true)
  assert.equal(isAnthropic1MModel('claude-fable-5-preview'), true)
  assert.equal(isAnthropic1MModel('claude-3-5-haiku'), false)
})

test('the mirror installs only where OpenClaw installs its own beta wrapper', () => {
  // Nothing configured: pi-ai already produces exactly the unsteered wire, so
  // touching the header would change it rather than preserve it.
  assert.equal(shouldMirrorAnthropicBetas(undefined, 'claude-opus-4-6'), false)
  assert.equal(shouldMirrorAnthropicBetas({}, 'claude-opus-4-6'), false)
  assert.equal(shouldMirrorAnthropicBetas({ anthropicBeta: 'custom' }, 'claude-opus-4-6'), true)
  // Configured with only the legacy beta: resolves to no betas, but OpenClaw
  // still installs, so the mirror does too.
  assert.equal(shouldMirrorAnthropicBetas({ anthropicBeta: ANTHROPIC_CONTEXT_1M_BETA }, 'claude-opus-4-6'), true)
  assert.equal(shouldMirrorAnthropicBetas({ context1m: true }, 'claude-opus-4-6'), true)
  assert.equal(shouldMirrorAnthropicBetas({ context1m: true }, 'claude-3-5-haiku'), false)
})

test('wrapAnthropicShadowStream leaves headers alone when nothing is configured', () => {
  const { streamFn, calls } = recordingStreamFn()
  const wrapped = wrapAnthropicShadowStream({ provider: 'hypaware-anthropic', modelId: 'claude-opus-4-6', streamFn })
  wrapped?.(anthropicModel(), {}, { apiKey: OAUTH_KEY })
  assert.equal(calls[0].options.headers, undefined)
})

test('wrapAnthropicShadowStream merges betas once the user configured any', () => {
  const { streamFn, calls } = recordingStreamFn()
  const wrapped = wrapAnthropicShadowStream({
    provider: 'hypaware-anthropic',
    modelId: 'claude-opus-4-6',
    extraParams: { anthropicBeta: 'custom-beta' },
    streamFn,
  })
  wrapped?.(anthropicModel(), {}, { apiKey: OAUTH_KEY })
  assert.deepEqual(parseHeaderList(calls[0].options.headers['anthropic-beta']), [
    ...ANTHROPIC_OAUTH_BETAS,
    'custom-beta',
  ])
})

test('wrapAnthropicShadowStream reports rather than silently skipping with no base stream fn', () => {
  /** @type {string[]} */
  const skipped = []
  const wrapped = wrapAnthropicShadowStream(
    { provider: 'hypaware-anthropic', modelId: 'claude-opus-4-6' },
    { onSkipped: (reason) => skipped.push(reason) },
  )
  assert.equal(wrapped, undefined)
  assert.deepEqual(skipped, ['no_base_stream_fn'])
})

test('resolveAnthropicServiceTier reads both spellings and rejects unknown values', () => {
  assert.equal(resolveAnthropicServiceTier({ serviceTier: 'auto' }), 'auto')
  assert.equal(resolveAnthropicServiceTier({ service_tier: 'STANDARD_ONLY' }), 'standard_only')
  assert.equal(resolveAnthropicServiceTier({ serviceTier: 'priority' }), undefined)
  assert.equal(resolveAnthropicServiceTier(undefined), undefined)
})

test('normalizeFastMode and resolveAnthropicFastMode mirror OpenClaw coercion', () => {
  assert.equal(normalizeFastMode('on'), true)
  assert.equal(normalizeFastMode('disabled'), false)
  assert.equal(normalizeFastMode('automatic'), 'auto')
  assert.equal(resolveAnthropicFastMode({ fastMode: 'auto' }), undefined)
  assert.equal(resolveAnthropicFastMode({ fast_mode: 'fast' }), true)
  assert.equal(resolveAnthropicFastMode({ fastMode: () => false }), false)
})

/**
 * Drives the payload patch the same way pi-ai does: call the wrapped stream
 * fn, then invoke the `onPayload` hook it installed.
 *
 * @param {any} wrapped
 * @param {any} payload
 * @param {any} options
 * @param {any} [model]
 */
function runPayload(wrapped, payload, options, model = anthropicModel()) {
  const { streamFn, calls } = recordingStreamFn()
  wrapped(streamFn)(model, {}, options)
  calls[0].options.onPayload?.(payload, model)
  return calls[0]
}

test('the service tier wrapper patches the payload for an api-key turn', () => {
  const payload = { messages: [] }
  runPayload((base) => createAnthropicServiceTierWrapper(base, 'auto'), payload, { apiKey: API_KEY })
  assert.equal(payload.service_tier, 'auto')
})

test('the service tier wrapper never overwrites a tier already on the payload', () => {
  const payload = { service_tier: 'standard_only' }
  runPayload((base) => createAnthropicServiceTierWrapper(base, 'auto'), payload, { apiKey: API_KEY })
  assert.equal(payload.service_tier, 'standard_only')
})

test('the service tier wrapper keeps OpenClaw carve-outs: OAuth and Sonnet 5', () => {
  const oauthPayload = {}
  runPayload((base) => createAnthropicServiceTierWrapper(base, 'auto'), oauthPayload, { apiKey: OAUTH_KEY })
  assert.equal(oauthPayload.service_tier, undefined)

  const sonnet5Payload = {}
  runPayload(
    (base) => createAnthropicServiceTierWrapper(base, 'auto'),
    sonnet5Payload,
    { apiKey: API_KEY },
    anthropicModel('claude-sonnet-5-20260101'),
  )
  assert.equal(sonnet5Payload.service_tier, undefined)
})

test('the service tier wrapper preserves a caller-supplied onPayload hook', () => {
  const seen = []
  const payload = {}
  runPayload((base) => createAnthropicServiceTierWrapper(base, 'auto'), payload, {
    apiKey: API_KEY,
    onPayload: (value) => seen.push(value),
  })
  assert.equal(payload.service_tier, 'auto')
  assert.deepEqual(seen, [payload])
})

test('wrapAnthropicShadowStream applies fast mode as a service tier', () => {
  const payload = {}
  const { streamFn, calls } = recordingStreamFn()
  const wrapped = wrapAnthropicShadowStream({
    provider: 'hypaware-anthropic',
    modelId: 'claude-opus-4-6',
    extraParams: { fastMode: true },
    streamFn,
  })
  wrapped?.(anthropicModel(), {}, { apiKey: API_KEY })
  calls[0].options.onPayload?.(payload, anthropicModel())
  assert.equal(payload.service_tier, 'auto')
})

test('trailing assistant prefill is stripped only when thinking is enabled', () => {
  const enabled = {
    thinking: { type: 'enabled' },
    messages: [{ role: 'user' }, { role: 'assistant', content: [{ type: 'text' }] }],
  }
  assert.equal(stripTrailingAnthropicAssistantPrefillWhenThinking(enabled), 1)
  assert.equal(enabled.messages.length, 1)

  const disabled = {
    thinking: { type: 'disabled' },
    messages: [{ role: 'user' }, { role: 'assistant', content: [] }],
  }
  assert.equal(stripTrailingAnthropicAssistantPrefillWhenThinking(disabled), 0)
  assert.equal(disabled.messages.length, 2)
})

test('a trailing assistant tool_use is not a prefill', () => {
  const payload = {
    thinking: { type: 'enabled' },
    messages: [{ role: 'user' }, { role: 'assistant', content: [{ type: 'tool_use' }] }],
  }
  assert.equal(stripTrailingAnthropicAssistantPrefillWhenThinking(payload), 0)
  assert.equal(payload.messages.length, 2)
})

test('the prefill wrapper is always installed, even with nothing configured', () => {
  const payload = {
    thinking: { type: 'enabled' },
    messages: [{ role: 'user' }, { role: 'assistant', content: [] }],
  }
  const { streamFn, calls } = recordingStreamFn()
  const wrapped = wrapAnthropicShadowStream({ provider: 'hypaware-anthropic', modelId: 'claude-opus-4-6', streamFn })
  wrapped?.(anthropicModel(), {}, { apiKey: API_KEY })
  calls[0].options.onPayload?.(payload, anthropicModel())
  assert.equal(payload.messages.length, 1)
})
