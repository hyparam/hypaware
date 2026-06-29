// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CONFIG_DOCUMENT_BYTES,
  createConfigPullLoop,
} from '../../hypaware-core/plugins-workspace/central/src/config_client.js'
import { parseRetryAfter } from '../../hypaware-core/plugins-workspace/central/src/backoff.js'

function makeLog() {
  /** @type {Array<{ level: string, message: string, fields: Record<string, unknown> }>} */
  const rows = []
  /** @param {string} level */
  const emit = (level) =>
    /** @param {string} message @param {Record<string, unknown>} [fields] */
    (message, fields) => { rows.push({ level, message, fields: fields ?? {} }) }
  return {
    rows,
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  }
}

/** @param {{ runningEtag?: string }} [opts] */
function makeControl(opts = {}) {
  /** @type {Array<{ document: unknown, etag: string }>} */
  const staged = []
  let confirms = 0
  return {
    staged,
    get confirms() { return confirms },
    /** @param {unknown} document @param {string} etag */
    async stage(document, etag) {
      staged.push({ document, etag })
      return /** @type {const} */ ({ ok: true, action: 'applied' })
    },
    confirmPoll() { confirms += 1 },
    runningEtag() { return opts.runningEtag },
  }
}

/**
 * Real `Response` objects so the transport path under test (streamed
 * body reads, abort signals) matches what `fetch` actually returns.
 *
 * @param {Array<{ status: number, headers?: Record<string, string>, body?: string }>} responses
 */
function makeFetch(responses) {
  /** @type {Array<{ url: string, headers: Record<string, string> }>} */
  const requests = []
  /** @type {typeof fetch} */
  const fetchFn = async (url, init) => {
    requests.push({
      url: String(url),
      headers: /** @type {Record<string, string>} */ (init?.headers ?? {}),
    })
    const next = responses.shift() ?? { status: 500 }
    // Response forbids a body on null-body statuses (204/304).
    const body = next.status === 204 || next.status === 304 ? null : next.body ?? null
    return new Response(body, { status: next.status, headers: next.headers ?? {} })
  }
  return { fetchFn, requests }
}

function makeIdentity() {
  let refreshes = 0
  return {
    get refreshes() { return refreshes },
    async getCurrentJwt() { return 'jwt-1' },
    async refresh() { refreshes += 1 },
  }
}

/**
 * @param {object} overrides
 */
function makeLoop(overrides) {
  const log = makeLog()
  const args = /** @type {any} */ ({
    centralUrl: 'https://central.example',
    identityClient: makeIdentity(),
    pollIntervalSeconds: 3600,
    log,
    ...overrides,
  })
  return { loop: createConfigPullLoop(args), log }
}

test('start pulls immediately; a 200 confirms the poll and stages the document with its etag', async () => {
  const control = makeControl()
  const { fetchFn, requests } = makeFetch([
    { status: 200, headers: { etag: 'rev-1' }, body: JSON.stringify({ version: 2 }) },
  ])
  const { loop } = makeLoop({ configControl: control, fetchFn })

  loop.start()
  await loop.stop()

  assert.equal(requests.length, 1)
  assert.ok(requests[0].url.endsWith('/v1/config'))
  assert.equal(requests[0].headers.authorization, 'Bearer jwt-1')
  // No running config etag → no If-None-Match (first 200 must happen).
  assert.equal('if-none-match' in requests[0].headers, false)
  assert.equal(control.confirms, 1)
  assert.deepEqual(control.staged, [{ document: { version: 2 }, etag: 'rev-1' }])
})

test('If-None-Match always presents the running config etag', async () => {
  const control = makeControl({ runningEtag: 'rev-current' })
  const { fetchFn, requests } = makeFetch([{ status: 304 }])
  const { loop } = makeLoop({ configControl: control, fetchFn })

  loop.start()
  await loop.stop()

  assert.equal(requests[0].headers['if-none-match'], 'rev-current')
  assert.equal(control.confirms, 1)
  assert.deepEqual(control.staged, [])
})

test('401 refreshes the JWT and retries once; a second 401 escalates without staging', async () => {
  const control = makeControl()
  const identityClient = makeIdentity()
  const ok = makeFetch([
    { status: 401 },
    { status: 304 },
  ])
  const { loop } = makeLoop({ configControl: control, identityClient, fetchFn: ok.fetchFn })
  loop.start()
  await loop.stop()
  assert.equal(identityClient.refreshes, 1)
  assert.equal(ok.requests.length, 2)
  assert.equal(control.confirms, 1)

  const identity2 = makeIdentity()
  const bad = makeFetch([{ status: 401 }, { status: 401 }])
  const second = makeLoop({ configControl: control, identityClient: identity2, fetchFn: bad.fetchFn })
  second.loop.start()
  await second.loop.stop()
  assert.equal(identity2.refreshes, 1)
  assert.equal(control.confirms, 1)
  assert.deepEqual(control.staged, [])
})

test('a 200 without an etag header is dropped, not staged', async () => {
  const control = makeControl()
  const { fetchFn } = makeFetch([
    { status: 200, body: JSON.stringify({ version: 2 }) },
  ])
  const { loop, log } = makeLoop({ configControl: control, fetchFn })
  loop.start()
  await loop.stop()
  assert.deepEqual(control.staged, [])
  assert.equal(control.confirms, 0)
  assert.ok(log.rows.some((r) => r.fields.error_kind === 'config_missing_etag'))
})

test('an oversized 200 body is dropped before parsing', async () => {
  const control = makeControl()
  const { fetchFn } = makeFetch([
    { status: 200, headers: { etag: 'rev-big' }, body: 'x'.repeat(MAX_CONFIG_DOCUMENT_BYTES + 1) },
  ])
  const { loop, log } = makeLoop({ configControl: control, fetchFn })
  loop.start()
  await loop.stop()
  assert.deepEqual(control.staged, [])
  assert.ok(log.rows.some((r) => r.fields.error_kind === 'config_document_too_large'))
})

test('invalid JSON in a 200 body is dropped', async () => {
  const control = makeControl()
  const { fetchFn } = makeFetch([
    { status: 200, headers: { etag: 'rev-1' }, body: '{nope' },
  ])
  const { loop, log } = makeLoop({ configControl: control, fetchFn })
  loop.start()
  await loop.stop()
  assert.deepEqual(control.staged, [])
  assert.ok(log.rows.some((r) => r.fields.error_kind === 'config_invalid_json'))
})

test('404 takes the legacy backoff branch without confirming probation', async () => {
  const control = makeControl()
  const { fetchFn } = makeFetch([{ status: 404 }])
  const { loop, log } = makeLoop({ configControl: control, fetchFn })
  loop.start()
  await loop.stop()
  assert.equal(control.confirms, 0)
  assert.ok(log.rows.some((r) => r.fields.hyp_reason === 'no_config_registered_legacy'))
})

test('the steady timer keeps polling on the configured cadence', async () => {
  const control = makeControl()
  const { fetchFn, requests } = makeFetch([
    { status: 304 }, { status: 304 }, { status: 304 }, { status: 304 },
  ])
  // Sub-second cadence is rejected by config validation but accepted
  // by the loop itself. That's what makes this test fast.
  const { loop } = makeLoop({ configControl: control, fetchFn, pollIntervalSeconds: 0.02 })
  loop.start()
  await new Promise((resolve) => setTimeout(resolve, 120))
  await loop.stop()
  assert.ok(requests.length >= 2, `expected repeat polls, saw ${requests.length}`)
  assert.ok(control.confirms >= 2, `expected repeat confirms, saw ${control.confirms}`)
})

test('stop prevents any further polls', async () => {
  const control = makeControl()
  const { fetchFn, requests } = makeFetch([{ status: 304 }, { status: 304 }])
  const { loop } = makeLoop({ configControl: control, fetchFn, pollIntervalSeconds: 0.01 })
  loop.start()
  await loop.stop()
  const seen = requests.length
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(requests.length, seen)
})

test('transport errors back off and keep the loop alive', async () => {
  const control = makeControl()
  let calls = 0
  /** @type {typeof fetch} */
  const fetchFn = async () => {
    calls += 1
    throw new Error('connection refused')
  }
  const { loop, log } = makeLoop({ configControl: control, fetchFn })
  loop.start()
  await loop.stop()
  assert.equal(calls, 1)
  assert.ok(log.rows.some((r) => r.message === 'central.config.poll_failed'))
})

test('an oversized Content-Length is rejected without reading the body', async () => {
  const control = makeControl()
  /** @type {typeof fetch} */
  const fetchFn = async () => {
    // A stream that never produces and never closes: only the
    // Content-Length pre-reject can finish this poll promptly. The
    // streaming counter would wait on it until the deadline.
    const stream = new ReadableStream({ pull() {} })
    const response = new Response(stream, { status: 200, headers: { etag: 'rev-huge' } })
    response.headers.set('content-length', String(MAX_CONFIG_DOCUMENT_BYTES + 1))
    return response
  }
  const { loop, log } = makeLoop({ configControl: control, fetchFn, requestTimeoutSeconds: 600 })
  loop.start()
  await loop.stop()
  assert.deepEqual(control.staged, [])
  const row = log.rows.find((r) => r.fields.error_kind === 'config_document_too_large')
  assert.ok(row, 'expected the Content-Length pre-reject to fire')
  // body_bytes reports the declared length. The streaming path could
  // never have observed this number from an empty stream.
  assert.equal(row?.fields.body_bytes, MAX_CONFIG_DOCUMENT_BYTES + 1)
})

test('a chunked oversized body is cancelled at the cap, not buffered whole', async () => {
  const control = makeControl()
  const chunk = new TextEncoder().encode('x'.repeat(64 * 1024))
  let chunksServed = 0
  /** @type {typeof fetch} */
  const fetchFn = async () => {
    // Endless chunked stream with no Content-Length: only the byte
    // counter can stop this one.
    const stream = new ReadableStream({
      pull(controller) {
        chunksServed += 1
        controller.enqueue(chunk)
      },
    })
    return new Response(stream, { status: 200, headers: { etag: 'rev-endless' } })
  }
  const { loop, log } = makeLoop({ configControl: control, fetchFn })
  loop.start()
  await loop.stop()
  assert.deepEqual(control.staged, [])
  assert.ok(log.rows.some((r) => r.fields.error_kind === 'config_document_too_large'))
  // Reads stop within one chunk of the cap instead of draining forever.
  assert.ok(
    chunksServed <= MAX_CONFIG_DOCUMENT_BYTES / chunk.byteLength + 2,
    `expected the read to stop at the cap, served ${chunksServed} chunks`
  )
})

test('stop() aborts a poll stuck on a never-resolving fetch after the drain grace', async () => {
  const control = makeControl()
  /** @type {typeof fetch} */
  const fetchFn = () => new Promise(() => {})
  // Long request timeout: the stop-grace abort, not the deadline, is
  // what must unblock shutdown here.
  const { loop } = makeLoop({
    configControl: control,
    fetchFn,
    requestTimeoutSeconds: 600,
    stopGraceSeconds: 0.02,
  })
  loop.start()
  const before = Date.now()
  await loop.stop()
  assert.ok(Date.now() - before < 5000, 'stop() must not wait out the request timeout')
  assert.deepEqual(control.staged, [])
})

test('the request deadline aborts a stalled poll and the loop stays alive', async () => {
  const control = makeControl()
  let aborted = false
  /** @type {typeof fetch} */
  const fetchFn = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(init.signal?.reason ?? new Error('aborted'))
      })
    })
  const { loop, log } = makeLoop({
    configControl: control,
    fetchFn,
    requestTimeoutSeconds: 0.02,
  })
  loop.start()
  await new Promise((resolve) => setTimeout(resolve, 100))
  await loop.stop()
  assert.equal(aborted, true)
  const row = log.rows.find((r) => r.fields.error_kind === 'config_poll_error')
  assert.ok(row, 'expected the timed-out poll to log a failure')
  assert.match(String(row?.fields.message), /exceeded/)
})

test('429 with Retry-After schedules from the header without confirming the poll', async () => {
  const control = makeControl()
  const { fetchFn } = makeFetch([{ status: 429, headers: { 'retry-after': '7' } }])
  const { loop, log } = makeLoop({ configControl: control, fetchFn })
  loop.start()
  await loop.stop()
  assert.equal(control.confirms, 0)
  assert.deepEqual(control.staged, [])
  const row = log.rows.find((r) => r.fields.error_kind === 'config_poll_throttled')
  assert.ok(row)
  assert.equal(row?.fields.http_status, 429)
  assert.equal(row?.fields.retry_after_seconds, 7)
})

test('503 with a garbage Retry-After falls back to the backoff ladder', async () => {
  const control = makeControl()
  const { fetchFn } = makeFetch([{ status: 503, headers: { 'retry-after': 'soonish' } }])
  const { loop, log } = makeLoop({ configControl: control, fetchFn })
  loop.start()
  await loop.stop()
  assert.equal(control.confirms, 0)
  const row = log.rows.find((r) => r.fields.error_kind === 'config_poll_throttled')
  assert.ok(row)
  assert.equal(row?.fields.http_status, 503)
  assert.equal('retry_after_seconds' in (row?.fields ?? {}), false)
})

test('429 with Retry-After: 0 reschedules via the ladder, not an immediate re-poll', async () => {
  const control = makeControl()
  // A legal `Retry-After: 0` (or a past date) parses to 0. Rescheduling at
  // 0s would re-poll immediately and spin; the loop must back off on the
  // ladder (30s) instead. Persistent throttle so a spin would be obvious.
  const { fetchFn, requests } = makeFetch([
    { status: 429, headers: { 'retry-after': '0' } },
    { status: 429, headers: { 'retry-after': '0' } },
    { status: 429, headers: { 'retry-after': '0' } },
  ])
  const { loop } = makeLoop({ configControl: control, fetchFn })
  loop.start()
  // Comfortably longer than a 0ms re-poll, far shorter than the 30s ladder:
  // a spinning loop would issue many polls in this window; the fix issues one.
  await new Promise((resolve) => setTimeout(resolve, 50))
  await loop.stop()
  assert.equal(requests.length, 1)
})

test('parseRetryAfter: delta-seconds, HTTP-date, and garbage', () => {
  assert.equal(parseRetryAfter('7'), 7)
  assert.equal(parseRetryAfter('0'), 0)
  // An HTTP-date resolves to a non-negative whole-second delay.
  const future = parseRetryAfter(new Date(Date.now() + 30_000).toUTCString())
  assert.ok(typeof future === 'number' && future >= 28 && future <= 31, `got ${future}`)
  // A past date clamps to zero rather than going negative.
  assert.equal(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0)
  assert.equal(parseRetryAfter('soonish'), undefined)
  assert.equal(parseRetryAfter(''), undefined)
  assert.equal(parseRetryAfter(null), undefined)
})
