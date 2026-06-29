// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { loginWithBrowser, buildStartUrl } from '../../src/core/remote/oidc_login.js'

/**
 * A scripted loopback receiver: captures the start URL the orchestrator built
 * (via the redirectUri it hands back) and yields a fixed code.
 *
 * @param {{ code?: string, reject?: Error }} [opts]
 */
function scriptedReceiver(opts = {}) {
  let closed = false
  const startReceiver = /** @type {any} */ (async (/** @type {{ state: string }} */ args) => ({
    redirectUri: 'http://127.0.0.1:54321/callback',
    port: 54321,
    state: args.state,
    waitForCode: async () => {
      if (opts.reject) throw opts.reject
      return { code: opts.code ?? 'the-code' }
    },
    close: () => { closed = true },
  }))
  return { startReceiver, wasClosed: () => closed }
}

test('drives PKCE -> loopback -> exchange and returns the session', async (t) => {
  /** @type {any[]} */
  const tokenCalls = []
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => {
    tokenCalls.push({ url, body: JSON.parse(init.body) })
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ session_id: 's', refresh_token: 'rt', access_jwt: 'jwt', expires_at: '2026-06-29T12:00:00Z', org: 'acme' }),
    }
  })
  /** @type {string[]} */
  const openedUrls = []
  const { startReceiver, wasClosed } = scriptedReceiver({ code: 'code-xyz' })

  const session = await loginWithBrowser({
    identityBase: 'https://hyp.internal/v1/identity',
    org: 'acme',
    openBrowser: (url) => { openedUrls.push(url); return true },
    fetchImpl,
    startReceiver,
  })

  assert.deepEqual(session, { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2026-06-29T12:00:00Z', org: 'acme' })
  // The browser was opened to a /login/start URL carrying the challenge + state + org.
  const opened = new URL(openedUrls[0])
  assert.equal(opened.pathname, '/v1/identity/login/start')
  assert.equal(opened.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(opened.searchParams.get('code_challenge'))
  assert.ok(opened.searchParams.get('state'))
  assert.equal(opened.searchParams.get('org'), 'acme')
  assert.equal(opened.searchParams.get('redirect_uri'), 'http://127.0.0.1:54321/callback')
  // The code was exchanged with the held verifier.
  assert.equal(tokenCalls[0].body.grant_type, 'authorization_code')
  assert.equal(tokenCalls[0].body.code, 'code-xyz')
  assert.ok(tokenCalls[0].body.code_verifier)
  assert.equal(wasClosed(), true)
})

test('--no-browser prints the URL instead of opening it', async () => {
  const fetchImpl = /** @type {any} */ (async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ refresh_token: 'rt', access_jwt: 'jwt', expires_at: '2026-06-29T12:00:00Z', org: 'acme' }),
  }))
  const { startReceiver } = scriptedReceiver()
  /** @type {string[]} */
  const printed = []
  let openCalled = false
  await loginWithBrowser({
    identityBase: 'https://hyp.internal/v1/identity',
    noBrowser: true,
    openBrowser: () => { openCalled = true; return true },
    fetchImpl,
    startReceiver,
    print: (line) => printed.push(line),
  })
  assert.equal(openCalled, false)
  assert.match(printed.join('\n'), /Open this URL/)
  assert.match(printed.join('\n'), /\/login\/start/)
})

test('closes the loopback even when the flow rejects', async () => {
  const { startReceiver, wasClosed } = scriptedReceiver({ reject: new Error('login failed: access_denied') })
  await assert.rejects(
    () => loginWithBrowser({ identityBase: 'https://h/v1/identity', openBrowser: () => true, startReceiver }),
    /access_denied/,
  )
  assert.equal(wasClosed(), true)
})

test('buildStartUrl omits org when not given', () => {
  const url = new URL(buildStartUrl({ identityBase: 'https://h/v1/identity', redirectUri: 'http://127.0.0.1:1/callback', challenge: 'c', state: 's' }))
  assert.equal(url.searchParams.get('org'), null)
})
