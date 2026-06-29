// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { exchangeCode, refreshSession, InvalidGrantError } from '../../src/core/remote/identity_client.js'

/**
 * A fetch stub that records the last request and returns `reply`.
 *
 * @param {{ status?: number, body: any }} reply
 */
function stubFetch(reply) {
  /** @type {{ url: string, init: any }[]} */
  const calls = []
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init })
    const status = reply.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)),
    }
  })
  return { fetchImpl, calls }
}

test('exchangeCode posts the authorization_code grant and maps the response', async () => {
  const { fetchImpl, calls } = stubFetch({
    body: { session_id: 'sess-1', refresh_token: 'rt-1', access_jwt: 'jwt-1', expires_at: '2026-06-29T12:00:00Z', org: 'acme' },
  })
  const session = await exchangeCode({
    identityBase: 'https://hyp.internal/v1/identity',
    code: 'auth-code',
    codeVerifier: 'verifier-1',
    fetchImpl,
  })
  assert.deepEqual(session, { refreshToken: 'rt-1', accessJwt: 'jwt-1', expiresAt: '2026-06-29T12:00:00Z', org: 'acme' })
  assert.equal(calls[0].url, 'https://hyp.internal/v1/identity/token')
  assert.deepEqual(JSON.parse(calls[0].init.body), { grant_type: 'authorization_code', code: 'auth-code', code_verifier: 'verifier-1' })
})

test('refreshSession posts the refresh_token grant and maps the response', async () => {
  const { fetchImpl, calls } = stubFetch({
    body: { access_jwt: 'jwt-2', expires_at: '2026-06-29T13:00:00Z', org: 'acme' },
  })
  const refreshed = await refreshSession({
    identityBase: 'https://hyp.internal/v1/identity',
    refreshToken: 'rt-1',
    fetchImpl,
  })
  // No rotated refresh_token in the response, so refreshToken comes back empty
  // (the caller keeps the one it already stored).
  assert.deepEqual(refreshed, { accessJwt: 'jwt-2', expiresAt: '2026-06-29T13:00:00Z', org: 'acme', refreshToken: '' })
  assert.deepEqual(JSON.parse(calls[0].init.body), { grant_type: 'refresh_token', refresh_token: 'rt-1' })
})

test('refreshSession returns a rotated refresh_token when the server issues one', async () => {
  const { fetchImpl } = stubFetch({
    body: { access_jwt: 'jwt-2', expires_at: '2026-06-29T13:00:00Z', org: 'acme', refresh_token: 'rt-2' },
  })
  const refreshed = await refreshSession({ identityBase: 'https://hyp.internal/v1/identity', refreshToken: 'rt-1', fetchImpl })
  assert.equal(refreshed.refreshToken, 'rt-2')
})

test('refreshSession tolerates a response that omits org (returns org: "")', async () => {
  const { fetchImpl } = stubFetch({ body: { access_jwt: 'jwt-2', expires_at: '2026-06-29T13:00:00Z' } })
  const refreshed = await refreshSession({ identityBase: 'https://hyp.internal/v1/identity', refreshToken: 'rt-1', fetchImpl })
  assert.deepEqual(refreshed, { accessJwt: 'jwt-2', expiresAt: '2026-06-29T13:00:00Z', org: '', refreshToken: '' })
})

test('a 401 invalid_grant surfaces a typed InvalidGrantError', async () => {
  const { fetchImpl } = stubFetch({ status: 401, body: { error: 'invalid_grant' } })
  await assert.rejects(
    () => refreshSession({ identityBase: 'https://hyp.internal/v1/identity', refreshToken: 'stale', fetchImpl }),
    (err) => {
      assert.ok(err instanceof InvalidGrantError)
      assert.equal(/** @type {any} */ (err).code, 'invalid_grant')
      return true
    },
  )
})

test('a non-invalid_grant error throws a generic error, not InvalidGrantError', async () => {
  const { fetchImpl } = stubFetch({ status: 500, body: { error: 'server_error' } })
  await assert.rejects(
    () => refreshSession({ identityBase: 'https://hyp.internal/v1/identity', refreshToken: 'rt', fetchImpl }),
    (err) => {
      assert.ok(!(err instanceof InvalidGrantError))
      assert.match(/** @type {Error} */ (err).message, /HTTP 500/)
      return true
    },
  )
})

test('a response missing access_jwt is rejected', async () => {
  const { fetchImpl } = stubFetch({ body: { expires_at: 'x', org: 'acme' } })
  await assert.rejects(
    () => refreshSession({ identityBase: 'https://hyp.internal/v1/identity', refreshToken: 'rt', fetchImpl }),
    /missing 'access_jwt'/,
  )
})
