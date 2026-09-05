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

/**
 * A poller whose wait is held open until the test releases it, so the output
 * written *during* the poll can be observed.
 */
function gatedPoller() {
  let release = /** @type {() => void} */ (() => {})
  const gate = /** @type {Promise<void>} */ (new Promise((resolve) => { release = () => resolve() }))
  const startPoller = /** @type {any} */ (() => ({
    waitForCode: async () => { await gate; return { code: 'the-code' } },
    close: () => {},
  }))
  return { startPoller, release }
}

/** A fake TTY that records everything written to it. */
function recordingTty() {
  /** @type {string[]} */
  const chunks = []
  return { chunks, stdout: { isTTY: true, write: (/** @type {string} */ chunk) => { chunks.push(chunk); return true } } }
}

/** A /token endpoint that always mints a session. */
function tokenFetch() {
  return /** @type {any} */ (async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ refresh_token: 'rt', access_jwt: 'jwt', expires_at: '2026-06-29T12:00:00Z', org: 'acme' }),
  }))
}

test('compact shows a live waiting indication for the whole poll, then clears it', async () => {
  const { startPoller, release } = gatedPoller()
  const { chunks, stdout } = recordingTty()

  const flow = loginWithBrowser({
    identityBase: 'https://hyp.internal/v1/identity',
    openBrowser: () => true,
    fetchImpl: tokenFetch(),
    startPoller,
    compact: true,
    stdout,
    env: {},
  })
  // The spinner renders its first frame before the poll is awaited, so the
  // wait is announced from the moment it starts, not after it settles.
  assert.match(chunks.join(''), /Waiting for the sign-in to complete/)

  release()
  await flow
  // And it is gone once the sign-in settles: the last write clears the line,
  // so whatever the lane prints next lands on a clean one.
  assert.equal(chunks.at(-1), '\r\x1b[2K')
})

test('the plain lane writes nothing to stdout, spinner or otherwise', async () => {
  const { startPoller } = scriptedPoller()
  const { chunks, stdout } = recordingTty()

  await loginWithBrowser({
    identityBase: 'https://hyp.internal/v1/identity',
    openBrowser: () => true,
    fetchImpl: tokenFetch(),
    startPoller,
    stdout,
    env: {},
  })
  assert.deepEqual(chunks, [], 'the standalone transcript is still the print seam alone')
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

test('the plain lane says it is waiting even when the browser was not opened', async () => {
  const { startPoller } = scriptedPoller()
  /** @type {string[]} */
  const printed = []
  await loginWithBrowser({
    identityBase: 'https://hyp.internal/v1/identity',
    noBrowser: true,
    openBrowser: () => true,
    fetchImpl: tokenFetch(),
    startPoller,
    print: (line) => printed.push(line),
  })
  // Without it this branch prints the URL and then goes silent for the whole
  // five-minute poll budget, ending in a bare timeout.
  const waitAt = printed.findIndex((line) => /Waiting for the sign-in to complete/.test(line))
  assert.ok(waitAt >= 0, 'the no-browser branch announces the wait')
  const urlAt = printed.findIndex((line) => line.includes('/login/start'))
  assert.ok(waitAt > urlAt, 'and announces it after the URL, so it is the last thing on screen')
})

/**
 * A /token endpoint held open until the test releases it, so the output
 * written *during* the code exchange can be observed.
 */
function gatedTokenFetch() {
  let release = /** @type {() => void} */ (() => {})
  const gate = /** @type {Promise<void>} */ (new Promise((resolve) => { release = () => resolve() }))
  const fetchImpl = /** @type {any} */ (async () => {
    await gate
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ refresh_token: 'rt', access_jwt: 'jwt', expires_at: '2026-06-29T12:00:00Z', org: 'acme' }),
    }
  })
  return { fetchImpl, release }
}

/** Let the flow settle out of the poll phase and into the exchange. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

test('compact covers the token exchange with a second, differently worded phase', async () => {
  const { startPoller, release } = gatedPoller()
  const { fetchImpl, release: releaseToken } = gatedTokenFetch()
  const { chunks, stdout } = recordingTty()

  const flow = loginWithBrowser({
    identityBase: 'https://hyp.internal/v1/identity',
    openBrowser: () => true,
    fetchImpl,
    startPoller,
    compact: true,
    stdout,
    env: {},
  })
  release()
  await settle()

  // The sign-in has completed, so the poll's label would be a lie here; the
  // exchange is bounded at 30s, so the lane cannot go silent either.
  const frame = String(chunks.at(-1))
  assert.match(frame, /Finishing the sign-in/)
  assert.doesNotMatch(frame, /Waiting for the sign-in to complete/)

  releaseToken()
  await flow
  assert.equal(chunks.at(-1), '\r\x1b[2K', 'and the line is cleared once the session is in hand')
})

test('the plain lane names the exchange phase too', async () => {
  const { startPoller } = scriptedPoller()
  /** @type {string[]} */
  const printed = []
  await loginWithBrowser({
    identityBase: 'https://hyp.internal/v1/identity',
    openBrowser: () => true,
    fetchImpl: tokenFetch(),
    startPoller,
    print: (line) => printed.push(line),
  })
  assert.equal(printed.at(-1), 'Finishing the sign-in...')
})
