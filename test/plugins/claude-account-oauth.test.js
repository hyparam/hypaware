// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
  buildAuthorizeUrl,
  createAuthorizationAttempt,
  exchangeAuthorizationCode,
  parsePastedAuthorization,
} from '../../hypaware-core/plugins-workspace/claude-account/src/oauth.js'

test('createAuthorizationAttempt derives the S256 challenge from the verifier', () => {
  const attempt = createAuthorizationAttempt()
  const expected = createHash('sha256').update(attempt.verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  assert.equal(attempt.challenge, expected)
  assert.notEqual(attempt.state, attempt.verifier)
})

test('buildAuthorizeUrl carries the PKCE and state parameters', () => {
  const attempt = { challenge: 'chal', state: 'st4te' }
  const url = new URL(buildAuthorizeUrl(attempt))
  assert.equal(url.origin, 'https://claude.com')
  assert.equal(url.searchParams.get('client_id'), OAUTH_CLIENT_ID)
  assert.equal(url.searchParams.get('redirect_uri'), OAUTH_REDIRECT_URI)
  assert.equal(url.searchParams.get('code_challenge'), 'chal')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('state'), 'st4te')
  assert.equal(url.searchParams.get('response_type'), 'code')
})

test('parsePastedAuthorization handles code#state and full URLs', () => {
  assert.deepEqual(parsePastedAuthorization(' abc#def \n'), { code: 'abc', state: 'def' })
  assert.deepEqual(
    parsePastedAuthorization('https://example.com/cb?code=abc&state=def'),
    { code: 'abc', state: 'def' },
  )
  assert.throws(() => parsePastedAuthorization(''), /empty/)
  assert.throws(() => parsePastedAuthorization('justacode'), /code#state/)
  assert.throws(() => parsePastedAuthorization('https://example.com/cb?code=abc'), /missing/)
})

test('exchangeAuthorizationCode verifies state before spending the code', async () => {
  await assert.rejects(
    exchangeAuthorizationCode({
      code: 'abc',
      state: 'wrong',
      attempt: { verifier: 'v', state: 'right' },
      fetchImpl: /** @type {typeof fetch} */ (async () => { throw new Error('must not fetch') }),
    }),
    /state mismatch/,
  )
})

test('exchangeAuthorizationCode maps the grant into a stored record', async () => {
  /** @type {unknown[]} */
  const bodies = []
  const record = await exchangeAuthorizationCode({
    code: 'abc',
    state: 'st',
    attempt: { verifier: 'ver1f1er', state: 'st' },
    now: () => 1_800_000_000_000,
    fetchImpl: /** @type {typeof fetch} */ (async (url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return /** @type {Response} */ (/** @type {unknown} */ ({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'sk-ant-oat01-new',
          refresh_token: 'sk-ant-ort01-new',
          expires_in: 3600,
          scope: 'user:profile user:inference',
        }),
      }))
    }),
  })
  assert.equal(record.kind, 'subscription_oauth')
  assert.equal(record.access_token, 'sk-ant-oat01-new')
  assert.equal(record.expires_at, 1_800_000_000 + 3600)
  assert.deepEqual(record.scopes, ['user:profile', 'user:inference'])
  const body = /** @type {Record<string, unknown>} */ (bodies[0])
  assert.equal(body.grant_type, 'authorization_code')
  assert.equal(body.code_verifier, 'ver1f1er')
  assert.equal(body.client_id, OAUTH_CLIENT_ID)
})

test('exchangeAuthorizationCode rejects an unrecognized token response', async () => {
  await assert.rejects(
    exchangeAuthorizationCode({
      code: 'abc',
      state: 'st',
      attempt: { verifier: 'v', state: 'st' },
      fetchImpl: /** @type {typeof fetch} */ (async () => (/** @type {Response} */ (/** @type {unknown} */ ({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'only-this' }),
      })))),
    }),
    /unrecognized shape/,
  )
})
