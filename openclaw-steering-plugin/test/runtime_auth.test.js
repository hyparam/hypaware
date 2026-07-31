import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BORROWED_OAUTH_REVALIDATE_MS,
  REAL_PROVIDER_FOR_SHADOW,
  SYNTHETIC_AUTH_MARKER,
  createPrepareRuntimeAuth,
  normalizeBorrowedCredential,
  resolveShadowSyntheticAuth,
} from '../src/runtime_auth.js'

const GATEWAY = 'http://127.0.0.1:18521'

/**
 * @param {{ provider: string }} ctx
 */
function contextFor(ctx) {
  return { provider: ctx.provider, modelId: 'claude-sonnet-4-6', authMode: 'api-key' }
}

test('REAL_PROVIDER_FOR_SHADOW is derived from the steering maps, not restated', () => {
  assert.deepEqual(REAL_PROVIDER_FOR_SHADOW, {
    'hypaware-anthropic': 'anthropic',
    'hypaware-openai': 'openai',
  })
})

test('normalizeBorrowedCredential reads OpenClaw ResolvedProviderAuth records', () => {
  assert.deepEqual(normalizeBorrowedCredential({ apiKey: 'sk-ant-abc', mode: 'api-key', source: 'env' }), {
    apiKey: 'sk-ant-abc',
    mode: 'api-key',
    profileId: undefined,
    source: 'env',
  })
})

test('normalizeBorrowedCredential treats a keyless resolution as no credential', () => {
  // The SDK always resolves to an object, so "no credential" is a missing or
  // blank `apiKey`, never a falsy return.
  assert.equal(normalizeBorrowedCredential({ mode: 'api-key', source: 'none' }), undefined)
  assert.equal(normalizeBorrowedCredential({ apiKey: '   ', mode: 'api-key' }), undefined)
  assert.equal(normalizeBorrowedCredential(undefined), undefined)
  assert.equal(normalizeBorrowedCredential(null), undefined)
})

test('normalizeBorrowedCredential accepts a bare key string', () => {
  assert.deepEqual(normalizeBorrowedCredential('sk-ant-abc'), { apiKey: 'sk-ant-abc' })
  assert.equal(normalizeBorrowedCredential('  '), undefined)
})

test('resolveShadowSyntheticAuth only answers for providers this plugin owns', () => {
  assert.deepEqual(resolveShadowSyntheticAuth({ provider: 'hypaware-anthropic' }), {
    apiKey: SYNTHETIC_AUTH_MARKER,
    source: 'hypaware-openclaw-steering (borrowed at request time)',
    mode: 'api-key',
  })
  assert.equal(resolveShadowSyntheticAuth({ provider: 'anthropic' }), undefined)
  assert.equal(resolveShadowSyntheticAuth({ provider: 'openrouter' }), undefined)
})

test('prepareRuntimeAuth borrows the shadowed provider credential and pins the gateway baseUrl', async () => {
  /** @type {string[]} */
  const asked = []
  const prepare = createPrepareRuntimeAuth({
    baseUrl: GATEWAY,
    resolveCredential: ({ provider }) => {
      asked.push(provider)
      return { apiKey: 'sk-ant-real', mode: 'api-key', source: 'auth-profile' }
    },
  })

  const prepared = await prepare(contextFor({ provider: 'hypaware-anthropic' }))

  assert.deepEqual(asked, ['anthropic'], 'borrows for the real provider, not the shadow')
  assert.deepEqual(prepared, { apiKey: 'sk-ant-real', baseUrl: GATEWAY })
})

test('prepareRuntimeAuth borrows openai for the openai-completions shadow', async () => {
  /** @type {string[]} */
  const asked = []
  const prepare = createPrepareRuntimeAuth({
    baseUrl: GATEWAY,
    resolveCredential: ({ provider }) => {
      asked.push(provider)
      return { apiKey: 'sk-openai', mode: 'api-key' }
    },
  })

  await prepare(contextFor({ provider: 'hypaware-openai' }))

  assert.deepEqual(asked, ['openai'])
})

test('prepareRuntimeAuth re-resolves on every call and caches nothing', async () => {
  let calls = 0
  const prepare = createPrepareRuntimeAuth({
    baseUrl: GATEWAY,
    resolveCredential: () => {
      calls += 1
      return { apiKey: `sk-ant-${calls}`, mode: 'api-key' }
    },
  })

  const first = await prepare(contextFor({ provider: 'hypaware-anthropic' }))
  const second = await prepare(contextFor({ provider: 'hypaware-anthropic' }))

  assert.equal(calls, 2)
  assert.equal(first?.apiKey, 'sk-ant-1')
  assert.equal(second?.apiKey, 'sk-ant-2', 'a rotated credential is picked up, so nothing was cached')
})

test('prepareRuntimeAuth declares a re-resolution deadline for OAuth borrows only', async () => {
  const now = () => 1_000_000
  const prepare = createPrepareRuntimeAuth({
    baseUrl: GATEWAY,
    now,
    resolveCredential: () => ({ apiKey: 'sk-ant-oat01-live', mode: 'oauth' }),
  })

  const prepared = await prepare(contextFor({ provider: 'hypaware-anthropic' }))
  assert.equal(prepared?.expiresAt, now() + BORROWED_OAUTH_REVALIDATE_MS)

  const apiKeyPrepare = createPrepareRuntimeAuth({
    baseUrl: GATEWAY,
    now,
    resolveCredential: () => ({ apiKey: 'sk-ant-api03', mode: 'api-key' }),
  })
  assert.equal((await apiKeyPrepare(contextFor({ provider: 'hypaware-anthropic' })))?.expiresAt, undefined)
})

test('the OAuth re-resolution deadline stays clear of OpenClaw refresh margin', () => {
  // OpenClaw schedules the re-preparation at `expiresAt - RUNTIME_AUTH_REFRESH_MARGIN_MS`
  // (5 minutes) and clamps to a 5-second floor, so a TTL at or below the
  // margin would re-prepare in a tight loop.
  const OPENCLAW_REFRESH_MARGIN_MS = 5 * 60 * 1000
  assert.ok(BORROWED_OAUTH_REVALIDATE_MS > 2 * OPENCLAW_REFRESH_MARGIN_MS)
})

test('prepareRuntimeAuth declines for a provider this plugin does not shadow', async () => {
  let called = false
  const prepare = createPrepareRuntimeAuth({
    baseUrl: GATEWAY,
    resolveCredential: () => {
      called = true
      return { apiKey: 'sk-nope', mode: 'api-key' }
    },
  })

  assert.equal(await prepare(contextFor({ provider: 'anthropic' })), undefined)
  assert.equal(called, false, 'never borrows on behalf of a provider it does not own')
})

test('prepareRuntimeAuth returns undefined when nothing can be borrowed', async () => {
  const prepare = createPrepareRuntimeAuth({
    baseUrl: GATEWAY,
    resolveCredential: () => ({ mode: 'api-key', source: 'none' }),
  })

  assert.equal(await prepare(contextFor({ provider: 'hypaware-anthropic' })), undefined)
})

test('prepareRuntimeAuth reports a throwing resolver instead of failing the turn', async () => {
  /** @type {Array<{ provider: string, error: unknown }>} */
  const reported = []
  const prepare = createPrepareRuntimeAuth({
    baseUrl: GATEWAY,
    resolveCredential: () => {
      throw new Error('auth profile store unavailable')
    },
    onError: (info) => reported.push(info),
  })

  assert.equal(await prepare(contextFor({ provider: 'hypaware-anthropic' })), undefined)
  assert.equal(reported.length, 1)
  assert.equal(reported[0].provider, 'anthropic')
})

test('prepareRuntimeAuth never returns anything but the request-scoped triple', async () => {
  const prepare = createPrepareRuntimeAuth({
    baseUrl: GATEWAY,
    resolveCredential: () => ({
      apiKey: 'sk-ant-oat01-live',
      mode: 'oauth',
      profileId: 'anthropic-oauth',
      source: 'auth-profiles.json',
    }),
  })

  const prepared = await prepare(contextFor({ provider: 'hypaware-anthropic' }))

  // Profile id and source are resolution provenance, not request material:
  // leaking them into the prepared auth would put credential-adjacent
  // metadata somewhere OpenClaw persists (LLP 0145: never persist a borrow).
  assert.deepEqual(Object.keys(prepared ?? {}).sort(), ['apiKey', 'baseUrl', 'expiresAt'])
})
