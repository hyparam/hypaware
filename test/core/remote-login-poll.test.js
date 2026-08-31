// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { startLoginPoller } from '../../src/core/remote/login_poll.js'

/**
 * A scripted fetch that serves each queued response in turn (the last one
 * repeats), recording every request URL. Responses are given as
 * `{ status, body, headers? }`.
 *
 * @param {Array<{ status: number, body: any, headers?: Record<string, string> }>} script
 */
function scriptedFetch(script) {
  /** @type {string[]} */
  const urls = []
  let i = 0
  const fetchImpl = /** @type {any} */ (async (/** @type {string} */ url) => {
    urls.push(url)
    const step = script[Math.min(i, script.length - 1)]
    i += 1
    return {
      status: step.status,
      headers: { get: (/** @type {string} */ name) => step.headers?.[name.toLowerCase()] ?? null },
      text: async () => JSON.stringify(step.body),
    }
  })
  return { fetchImpl, urls }
}

/** An immediate sleep that records the requested delays. */
function recordingSleep() {
  /** @type {number[]} */
  const delays = []
  return { delays, sleep: async (/** @type {number} */ ms) => { delays.push(ms) } }
}

test('resolves the code once the flight settles, polling through pending', async () => {
  const { fetchImpl, urls } = scriptedFetch([
    { status: 200, body: { status: 'pending' } },
    { status: 200, body: { status: 'pending' } },
    { status: 200, body: { status: 'complete', code: 'cd_abc' } },
  ])
  const { sleep } = recordingSleep()
  const poller = startLoginPoller({ identityBase: 'https://h/v1/identity', state: 'st1', fetchImpl, sleep })
  assert.deepEqual(await poller.waitForCode(), { code: 'cd_abc' })
  const first = new URL(urls[0])
  assert.equal(first.pathname, '/v1/identity/login/poll')
  assert.equal(first.searchParams.get('state'), 'st1')
})

test('unknown_state is not terminal: the flight parks only when the browser opens the URL', async () => {
  // The client's first polls land before the human clicks, so the server has
  // no flight yet; the poller must ride through to the eventual outcome.
  const { fetchImpl } = scriptedFetch([
    { status: 404, body: { error: 'unknown_state' } },
    { status: 404, body: { error: 'unknown_state' } },
    { status: 200, body: { status: 'complete', code: 'cd_late' } },
  ])
  const { sleep } = recordingSleep()
  const poller = startLoginPoller({ identityBase: 'https://h/v1/identity', state: 's', fetchImpl, sleep })
  assert.deepEqual(await poller.waitForCode(), { code: 'cd_late' })
})

test('a failed outcome rejects with the D7 code as callbackError', async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 200, body: { status: 'failed', error: 'no_membership' } },
  ])
  const poller = startLoginPoller({ identityBase: 'https://h/v1/identity', state: 's', fetchImpl })
  await assert.rejects(poller.waitForCode(), (/** @type {any} */ err) => {
    assert.match(err.message, /login failed: no_membership/)
    assert.equal(err.callbackError, 'no_membership')
    return true
  })
})

test('a hostile failed-error string is bounded before it reaches the message', async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 200, body: { status: 'failed', error: 'bad\nerror"' + 'x'.repeat(200) } },
  ])
  const poller = startLoginPoller({ identityBase: 'https://h/v1/identity', state: 's', fetchImpl })
  await assert.rejects(poller.waitForCode(), (/** @type {any} */ err) => {
    assert.ok(!err.message.includes('\n'), 'no newline injection')
    assert.ok(!err.message.includes('"'), 'quotes stripped')
    assert.ok(err.callbackError.length <= 80, 'length capped')
    return true
  })
})

test('a generic unknown_path 404 (stale server) fails loudly with the upgrade message', async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 404, body: { error: 'unknown_path' } },
  ])
  const poller = startLoginPoller({ identityBase: 'https://h/v1/identity', state: 's', fetchImpl })
  await assert.rejects(poller.waitForCode(), /does not support poll login yet - upgrade hypaware-server/)
})

test('times out when the flight never settles', async () => {
  const { fetchImpl } = scriptedFetch([{ status: 200, body: { status: 'pending' } }])
  const { sleep } = recordingSleep()
  const poller = startLoginPoller({ identityBase: 'https://h/v1/identity', state: 's', fetchImpl, timeoutMs: 0, sleep })
  await assert.rejects(poller.waitForCode(), /timed out waiting for the browser login/)
})

test('a 429 sleeps for the retry-after hint instead of the poll interval', async () => {
  const { fetchImpl } = scriptedFetch([
    { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '7' } },
    { status: 200, body: { status: 'complete', code: 'cd_ok' } },
  ])
  const { delays, sleep } = recordingSleep()
  const poller = startLoginPoller({ identityBase: 'https://h/v1/identity', state: 's', fetchImpl, intervalMs: 2000, sleep })
  assert.deepEqual(await poller.waitForCode(), { code: 'cd_ok' })
  assert.equal(delays[0], 7000)
})

test('a network error is transient: keeps polling to the outcome', async () => {
  let calls = 0
  const fetchImpl = /** @type {any} */ (async () => {
    calls += 1
    if (calls === 1) throw new Error('ECONNREFUSED')
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: 'complete', code: 'cd_net' }) }
  })
  const { sleep } = recordingSleep()
  const poller = startLoginPoller({ identityBase: 'https://h/v1/identity', state: 's', fetchImpl, sleep })
  assert.deepEqual(await poller.waitForCode(), { code: 'cd_net' })
})

test('close() before a code arrives rejects the wait', async () => {
  const { fetchImpl } = scriptedFetch([{ status: 200, body: { status: 'pending' } }])
  const { sleep } = recordingSleep()
  const poller = startLoginPoller({ identityBase: 'https://h/v1/identity', state: 's', fetchImpl, sleep })
  poller.close()
  await assert.rejects(poller.waitForCode(), /closed before a code arrived/)
})

test('close() rejects a wait that is already in flight', { timeout: 5000 }, async () => {
  // A sleep that never resolves stands in for the parked interval: if `close()`
  // could only be noticed at the top of the next iteration, this wait would
  // hang forever rather than reject.
  const { fetchImpl } = scriptedFetch([{ status: 200, body: { status: 'pending' } }])
  const poller = startLoginPoller({
    identityBase: 'https://h/v1/identity', state: 's', fetchImpl,
    sleep: () => new Promise(() => {}),
  })
  const wait = poller.waitForCode()
  await new Promise((resolve) => setTimeout(resolve, 10))
  poller.close()
  await assert.rejects(wait, /closed before a code arrived/)
})

test('a hung request is aborted and retried instead of eating the whole budget', { timeout: 5000 }, async () => {
  let calls = 0
  const fetchImpl = /** @type {any} */ ((/** @type {string} */ _url, /** @type {any} */ init) => {
    calls += 1
    if (calls === 1) {
      // Never answers, and only reacts to a signal the poller supplies: an
      // unbounded request would sit here for the whole login budget.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: 'complete', code: 'cd_hung' }) })
  })
  const { sleep } = recordingSleep()
  const poller = startLoginPoller({ identityBase: 'https://h/v1/identity', state: 's', fetchImpl, sleep, timeoutMs: 5000, requestTimeoutMs: 20 })
  assert.deepEqual(await poller.waitForCode(), { code: 'cd_hung' })
  assert.equal(calls, 2)
})

test('an unparseable 404 (a proxy error page) is transient, not a stale server', async () => {
  // An ingress between the client and the identity server can answer 404 with
  // HTML for a few seconds during a deploy; ending the login there would be
  // wrong, and the upgrade message would be a lie.
  let calls = 0
  const fetchImpl = /** @type {any} */ (async () => {
    calls += 1
    if (calls === 1) return { status: 404, headers: { get: () => null }, text: async () => '<html>404 Not Found</html>' }
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ status: 'complete', code: 'cd_proxy' }) }
  })
  const { sleep } = recordingSleep()
  const poller = startLoginPoller({ identityBase: 'https://h/v1/identity', state: 's', fetchImpl, sleep })
  assert.deepEqual(await poller.waitForCode(), { code: 'cd_proxy' })
})
