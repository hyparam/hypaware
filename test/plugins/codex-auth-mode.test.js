// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// @ref LLP 0099#decision [tests]: auth.json shape decides the attach route
import {
  providerRouteForAuthMode,
  providerRouteKeyForAuthMode,
  readCodexAuthMode,
} from '../../hypaware-core/plugins-workspace/codex/src/index.js'

/** @param {unknown} contents */
async function writeAuthFile(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-codex-auth-'))
  const authPath = path.join(dir, 'auth.json')
  await fs.writeFile(authPath, JSON.stringify(contents))
  return authPath
}

test('readCodexAuthMode returns an explicit auth_mode verbatim', async () => {
  const authPath = await writeAuthFile({ auth_mode: 'chatgpt', tokens: {} })
  assert.equal(await readCodexAuthMode(authPath), 'chatgpt')

  const apiKeyPath = await writeAuthFile({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' })
  assert.equal(await readCodexAuthMode(apiKeyPath), 'apikey')
})

test('readCodexAuthMode infers chatgpt from tokens without an API key', async () => {
  const authPath = await writeAuthFile({
    OPENAI_API_KEY: null,
    tokens: { id_token: 'x', access_token: 'y', refresh_token: 'z', account_id: 'a' },
    last_refresh: '2026-07-11T00:00:00Z',
  })
  assert.equal(await readCodexAuthMode(authPath), 'chatgpt')
})

test('readCodexAuthMode does not infer chatgpt when an API key is present', async () => {
  const authPath = await writeAuthFile({ OPENAI_API_KEY: 'sk-test', tokens: {} })
  assert.equal(await readCodexAuthMode(authPath), undefined)
})

test('readCodexAuthMode returns undefined for missing or malformed files', async () => {
  assert.equal(await readCodexAuthMode('/nonexistent/auth.json'), undefined)

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-codex-auth-'))
  const badPath = path.join(dir, 'auth.json')
  await fs.writeFile(badPath, 'not json')
  assert.equal(await readCodexAuthMode(badPath), undefined)

  const emptyPath = await writeAuthFile({})
  assert.equal(await readCodexAuthMode(emptyPath), undefined)
})

test('providerRouteForAuthMode maps chatgpt to the backend-api route', () => {
  assert.deepEqual(providerRouteForAuthMode('chatgpt', 4388), {
    baseUrl: 'http://127.0.0.1:4388/backend-api/codex',
    providerName: 'HypAware ChatGPT Gateway',
  })
  assert.deepEqual(providerRouteForAuthMode(undefined, 4388), {
    baseUrl: 'http://127.0.0.1:4388/v1',
    providerName: 'HypAware OpenAI Gateway',
  })
})

// @ref LLP 0308#the-key-is-the-route-not-the-auth-mode [tests]: the attach
// freshness key names the route, so only a change that would write a different
// base_url counts as drift
test('providerRouteKeyForAuthMode keys on the route, not on the raw auth mode', () => {
  assert.equal(providerRouteKeyForAuthMode('chatgpt'), '/backend-api/codex')
  assert.equal(providerRouteKeyForAuthMode('apikey'), '/v1')
  // A Codex version that stops writing `auth_mode` for an API-key login is not
  // drift: both spellings route to /v1, so the key does not move and the
  // reconciler does not re-attach.
  assert.equal(
    providerRouteKeyForAuthMode(undefined),
    providerRouteKeyForAuthMode('apikey'),
    'an absent auth_mode and an explicit apikey key the same, so neither re-attaches over the other'
  )
  // The switch that IS drift.
  assert.notEqual(providerRouteKeyForAuthMode('chatgpt'), providerRouteKeyForAuthMode('apikey'))
})

test('the attach key and the written base_url are the same decision (#996)', () => {
  for (const mode of ['chatgpt', 'apikey', undefined]) {
    const route = providerRouteForAuthMode(mode, 4388)
    assert.equal(
      route.baseUrl,
      `http://127.0.0.1:4388${providerRouteKeyForAuthMode(mode)}`,
      `the key must be the path the attach writes for mode ${String(mode)}`
    )
  }
})
