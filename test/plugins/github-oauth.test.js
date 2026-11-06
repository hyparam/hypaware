// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceLogin, githubIdentity, refreshGithubToken, GITHUB_CLIENT_ID } from '../../hypaware-core/plugins-workspace/github/src/oauth.js'

/** @import { HypError } from '../../hypaware-core/plugins-workspace/github/src/types.js' */

const grant = { access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'bearer', scope: 'repo', expires_in: 28800, refresh_token_expires_in: 15897600 }
const device = { device_code: 'device-secret', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }

/** @param {unknown} data */
const json = (data) => new Response(JSON.stringify(data))

/** @param {Record<string, any>[]} replies */
function flow(replies) {
  let time = 0
  const waits = []
  const requests = []
  return {
    waits, requests,
    now: () => time,
    async sleep(ms) { waits.push(ms)
      time += ms },
    async fetchImpl(url, init) {
      requests.push({ url, init })
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
      const data = replies.shift()
      assert.ok(data, 'unexpected request')
      return json(data)
    },
    onCode(code, uri) { assert.equal(code, 'ABCD-EFGH')
      assert.equal(uri, device.verification_uri) },
  }
}

test('device flow waits for the minimum interval and adds five seconds on slowdown', async () => {
  const f = flow([device, { error: 'authorization_pending' }, { error: 'slow_down' }, { error: 'authorization_pending' }, grant])
  const tokens = await deviceLogin(f)
  assert.deepEqual(f.waits, [5000, 5000, 10000, 10000])
  assert.equal(tokens.access_token, grant.access_token)
  assert.equal(tokens.expires_at, 30000 + 28800 * 1000)
  assert.equal(tokens.refresh_expires_at, 30000 + 15897600 * 1000)
  for (const { init } of f.requests) {
    const body = new URLSearchParams(init.body)
    assert.equal(body.get('client_id'), GITHUB_CLIENT_ID)
    assert.equal(body.has('client_secret'), false)
  }
  assert.equal(new URLSearchParams(f.requests[0].init.body).get('scope'), 'repo')
})

test('local expiry stops polling without spending another request', async () => {
  const f = flow([{ ...device, expires_in: 10 }, { error: 'authorization_pending' }])
  await assert.rejects(deviceLogin(f), /code expired/)
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.waits, [5000, 5000])
})

for (const code of ['access_denied', 'expired_token', 'device_flow_disabled', 'incorrect_client_credentials', 'bad_refresh_token', 'unknown-secret']) {
  test(`OAuth ${code} produces a classified error without response details`, async () => {
    const f = flow([device, { error: code, error_description: 'secret-content' }])
    await assert.rejects(deviceLogin(f), (err) => {
      assert.ok(err instanceof Error)
      assert.match(/** @type {HypError} */ (err).hypErrorKind ?? '', /^github_auth_/)
      assert.doesNotMatch(err.message, /secret/)
      return true
    })
  })
}

test('abort while sleeping cancels login without polling', async () => {
  const controller = new AbortController()
  const f = flow([device])
  await assert.rejects(deviceLogin({ ...f, signal: controller.signal, async sleep() { controller.abort() } }), /cancelled/)
  assert.equal(f.requests.length, 1)
})

test('refresh rotates with no client secret and validates repo scope', async () => {
  const f = flow([grant])
  await refreshGithubToken('previous-secret', f)
  const body = new URLSearchParams(f.requests[0].init.body)
  assert.equal(body.get('grant_type'), 'refresh_token')
  assert.equal(body.get('refresh_token'), 'previous-secret')
  assert.equal(body.has('client_secret'), false)
  await assert.rejects(refreshGithubToken('previous-secret', flow([{ ...grant, scope: 'gist' }])), /permission was not granted/)
})

test('non-expiring tokens are supported without fabricating refresh credentials', async () => {
  const f = flow([device, { access_token: 'token', scope: 'repo', token_type: 'bearer' }])
  assert.deepEqual(await deviceLogin(f), { access_token: 'token' })
})

test('identity validation pins the API endpoint and discards unneeded fields', async () => {
  const f = flow([{ login: 'octocat', id: 7, email: 'private@example.com' }])
  assert.deepEqual(await githubIdentity('token', f), { login: 'octocat', id: 7 })
  assert.equal(f.requests[0].url, 'https://api.github.com/user')
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer token')
})

test('untrusted verification URLs, response bodies and network errors stay out of output', async () => {
  await assert.rejects(deviceLogin(flow([{ ...device, verification_uri: 'https://evil.test/secret' }])), /refused/)
  await assert.rejects(githubIdentity('secret', { async fetchImpl() { return new Response('echo-secret', { status: 401 }) } }), /HTTP 401/)
  await assert.rejects(githubIdentity('secret', { async fetchImpl() { throw new Error('echo-secret') } }), /request failed/)
  await assert.rejects(githubIdentity('secret', { async fetchImpl() { return new Response('x'.repeat(65537)) } }), /refused/)
})

test('request timeout is classified without leaking the transport error', async (t) => {
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort())
  await assert.rejects(githubIdentity('secret', { async fetchImpl(_url, init) {
    assert.equal(init?.signal?.aborted, true)
    throw new Error('transport-secret')
  } }), (err) => {
    assert.ok(err instanceof Error)
    assert.equal(/** @type {HypError} */ (err).hypErrorKind, 'github_auth_timeout')
    assert.doesNotMatch(err.message, /transport-secret/)
    return true
  })
})
