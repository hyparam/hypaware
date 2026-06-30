// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { exchangeCode, refreshSession, describeRefreshError, InvalidGrantError, sessionExpiredMessage } from '../../src/core/remote/identity_client.js'

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

test('sessionExpiredMessage names the target for re-login', () => {
  assert.equal(sessionExpiredMessage('prod'), "remote session expired - re-run 'hyp remote login prod'")
})

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

test('a 401 with an empty body still surfaces InvalidGrantError (re-login guidance)', async () => {
  // An edge proxy may answer the revoked refresh row with a bare 401, no OAuth
  // error object. It must still map to session-expired, not a generic error.
  const { fetchImpl } = stubFetch({ status: 401, body: '' })
  await assert.rejects(
    () => refreshSession({ identityBase: 'https://hyp.internal/v1/identity', refreshToken: 'stale', fetchImpl }),
    (err) => err instanceof InvalidGrantError,
  )
})

test('a 401 with a non-JSON body still surfaces InvalidGrantError', async () => {
  const { fetchImpl } = stubFetch({ status: 401, body: '<html>unauthorized</html>' })
  await assert.rejects(
    () => refreshSession({ identityBase: 'https://hyp.internal/v1/identity', refreshToken: 'stale', fetchImpl }),
    (err) => err instanceof InvalidGrantError,
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

test('a 2xx with an empty body fails as transient, not a misleading missing-field error', async () => {
  // safeText returns '' for both an empty body and a mid-body read failure; on a
  // success status that is a transient truncation, so it must not surface as
  // "missing 'access_jwt'" (which reads like a permanent contract violation).
  const { fetchImpl } = stubFetch({ status: 200, body: '' })
  await assert.rejects(
    () => refreshSession({ identityBase: 'https://hyp.internal/v1/identity', refreshToken: 'rt', fetchImpl }),
    (err) => {
      assert.match(/** @type {Error} */ (err).message, /empty response/)
      assert.doesNotMatch(/** @type {Error} */ (err).message, /missing/)
      return true
    },
  )
})

test('a non-date expires_at is rejected at refresh time, not stored to loop forever', async () => {
  const { fetchImpl } = stubFetch({ body: { access_jwt: 'jwt', expires_at: '1719600000', org: 'acme' } })
  await assert.rejects(
    () => refreshSession({ identityBase: 'https://hyp.internal/v1/identity', refreshToken: 'rt', fetchImpl }),
    /'expires_at' is not a valid timestamp/,
  )
})

test('describeRefreshError maps invalid_grant to session-expired re-login guidance', () => {
  assert.deepEqual(describeRefreshError(new InvalidGrantError(), 'prod'), {
    sessionExpired: true,
    message: "remote session expired - re-run 'hyp remote login prod'",
  })
})

test('describeRefreshError passes a non-invalid_grant error through as a generic message', () => {
  assert.deepEqual(describeRefreshError(new Error('identity endpoint rejected the grant (HTTP 500)'), 'prod'), {
    sessionExpired: false,
    message: 'identity endpoint rejected the grant (HTTP 500)',
  })
})
