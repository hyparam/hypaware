// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  REFRESH_WINDOW_SECONDS,
  orgKeyCredential,
  resolveCredential,
} from '../../hypaware-core/plugins-workspace/claude-account/src/credential.js'
import {
  credentialFilePath,
  readStoredCredential,
  writeStoredCredential,
} from '../../hypaware-core/plugins-workspace/claude-account/src/store.js'

/** @import { SubscriptionOauthRecord } from '../../hypaware-core/plugins-workspace/claude-account/src/types.js' */

function tmpStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-account-cred-'))
}

const NOW_MS = 1_800_000_000_000
const NOW_SEC = NOW_MS / 1000

/**
 * @param {number} expiresAt
 * @returns {SubscriptionOauthRecord}
 */
function storedRecord(expiresAt) {
  return {
    kind: 'subscription_oauth',
    access_token: 'sk-ant-oat01-current',
    refresh_token: 'sk-ant-ort01-current',
    expires_at: expiresAt,
    obtained_at: NOW_SEC - 100,
  }
}

/**
 * A fetch stub for the token endpoint that returns a rotated pair.
 *
 * @param {{ calls: unknown[] }} sink
 * @returns {typeof fetch}
 */
function refreshFetchStub(sink) {
  return /** @type {typeof fetch} */ (async (url, init) => {
    sink.calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return /** @type {Response} */ (/** @type {unknown} */ ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'sk-ant-oat01-rotated',
        refresh_token: 'sk-ant-ort01-rotated',
        expires_in: 3600,
        scope: 'user:inference',
      }),
    }))
  })
}

test('org_key mode uses the configured key with empty headers', () => {
  const credential = orgKeyCredential({ api_key: 'sk-org-key' }, {})
  assert.equal(credential.token, 'sk-org-key')
  assert.deepEqual(credential.headers, {})
  assert.ok(credential.ttlSec > 0)
})

test('org_key mode resolves api_key_env and fails loudly when unset', () => {
  const credential = orgKeyCredential({ api_key_env: 'TEST_ORG_KEY' }, { TEST_ORG_KEY: 'sk-from-env' })
  assert.equal(credential.token, 'sk-from-env')
  assert.throws(() => orgKeyCredential({ api_key_env: 'TEST_ORG_KEY' }, {}), /TEST_ORG_KEY is not set/)
  assert.throws(() => orgKeyCredential({}, {}), /api_key or api_key_env/)
})

test('subscription mode errors with login guidance when not signed in', async () => {
  await assert.rejects(
    resolveCredential({ config: { mode: 'subscription' }, env: {}, stateDir: tmpStateDir() }),
    /claude-account login/,
  )
})

test('subscription mode returns the stored token with the oauth beta header', async () => {
  const stateDir = tmpStateDir()
  writeStoredCredential(credentialFilePath(stateDir), storedRecord(NOW_SEC + 3600))
  const credential = await resolveCredential({
    config: { mode: 'subscription' },
    env: {},
    stateDir,
    now: () => NOW_MS,
    fetchImpl: /** @type {typeof fetch} */ (async () => { throw new Error('must not fetch') }),
  })
  assert.equal(credential.token, 'sk-ant-oat01-current')
  assert.deepEqual(credential.headers, { 'anthropic-beta': 'oauth-2025-04-20' })
  assert.ok(credential.ttlSec >= 60)
  assert.ok(credential.ttlSec <= 3600 - REFRESH_WINDOW_SECONDS)
})

test('subscription mode refreshes inside the expiry window and persists the rotated pair', async () => {
  const stateDir = tmpStateDir()
  const filePath = credentialFilePath(stateDir)
  writeStoredCredential(filePath, storedRecord(NOW_SEC + 60))
  const sink = { calls: /** @type {unknown[]} */ ([]) }
  const credential = await resolveCredential({
    config: { mode: 'subscription' },
    env: {},
    stateDir,
    now: () => NOW_MS,
    fetchImpl: refreshFetchStub(sink),
  })
  assert.equal(credential.token, 'sk-ant-oat01-rotated')
  assert.equal(sink.calls.length, 1)
  const persisted = readStoredCredential(filePath)
  assert.equal(persisted?.access_token, 'sk-ant-oat01-rotated')
  assert.equal(persisted?.refresh_token, 'sk-ant-ort01-rotated')
})

test('subscription refresh failure surfaces as an error, not a stale token', async () => {
  const stateDir = tmpStateDir()
  writeStoredCredential(credentialFilePath(stateDir), storedRecord(NOW_SEC - 10))
  await assert.rejects(
    resolveCredential({
      config: { mode: 'subscription' },
      env: {},
      stateDir,
      now: () => NOW_MS,
      fetchImpl: /** @type {typeof fetch} */ (async () => (/** @type {Response} */ (/** @type {unknown} */ ({
        ok: false,
        status: 401,
        json: async () => ({}),
      })))),
    }),
    /token endpoint returned 401/,
  )
})
