// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// @ref LLP 0099#decision [tests]: auth.json shape decides the attach route
import {
  providerRouteForAuthMode,
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
