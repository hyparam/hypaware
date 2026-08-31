// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { loginWithBrowser, buildStartUrl } from '../../src/core/remote/oidc_login.js'

/**
 * A scripted poller: captures the args the orchestrator handed the seam and
 * yields a fixed code (or a scripted rejection).
 *
 * @param {{ code?: string, reject?: Error }} [opts]
 */
function scriptedPoller(opts = {}) {
  let closed = false
  /** @type {any[]} */
  const startArgs = []
  const startPoller = /** @type {any} */ ((/** @type {any} */ args) => {
    startArgs.push(args)
    return {
      waitForCode: async () => {
        if (opts.reject) throw opts.reject
        return { code: opts.code ?? 'the-code' }
      },
      close: () => { closed = true },
    }
  })
  return { startPoller, startArgs, wasClosed: () => closed }
}

test('drives PKCE -> poll -> exchange and returns the session', async () => {
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
  const { startPoller, startArgs, wasClosed } = scriptedPoller({ code: 'code-xyz' })

  const session = await loginWithBrowser({
    identityBase: 'https://hyp.internal/v1/identity',
    org: 'acme',
    openBrowser: (url) => { openedUrls.push(url); return true },
    fetchImpl,
    startPoller,
  })

  assert.deepEqual(session, { refreshToken: 'rt', accessJwt: 'jwt', expiresAt: '2026-06-29T12:00:00Z', org: 'acme' })
  // The browser was opened to a /login/start URL carrying the challenge + state + org.
  const opened = new URL(openedUrls[0])
  assert.equal(opened.pathname, '/v1/identity/login/start')
  assert.equal(opened.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(opened.searchParams.get('code_challenge'))
  assert.ok(opened.searchParams.get('state'))
  assert.equal(opened.searchParams.get('org'), 'acme')
  // No redirect_uri: its absence is what selects poll delivery (LLP 0342 D3).
  assert.equal(opened.searchParams.get('redirect_uri'), null)
  // The poller was keyed by the same state the start URL carries.
  assert.equal(startArgs[0].state, opened.searchParams.get('state'))
  assert.equal(startArgs[0].identityBase, 'https://hyp.internal/v1/identity')
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
  const { startPoller } = scriptedPoller()
  /** @type {string[]} */
  const printed = []
  let openCalled = false
  await loginWithBrowser({
    identityBase: 'https://hyp.internal/v1/identity',
    noBrowser: true,
    openBrowser: () => { openCalled = true; return true },
    fetchImpl,
    startPoller,
    print: (line) => printed.push(line),
  })
  assert.equal(openCalled, false)
  assert.match(printed.join('\n'), /Open this URL/)
  assert.match(printed.join('\n'), /\/login\/start/)
})

test('closes the poller even when the flow rejects', async () => {
  const { startPoller, wasClosed } = scriptedPoller({ reject: new Error('login failed: access_denied') })
  await assert.rejects(
    () => loginWithBrowser({ identityBase: 'https://h/v1/identity', openBrowser: () => true, startPoller }),
    /access_denied/,
  )
  assert.equal(wasClosed(), true)
})

test('buildStartUrl omits org when not given, and never carries a redirect_uri', () => {
  const url = new URL(buildStartUrl({ identityBase: 'https://h/v1/identity', challenge: 'c', state: 's' }))
  assert.equal(url.searchParams.get('org'), null)
  assert.equal(url.searchParams.get('redirect_uri'), null)
})
