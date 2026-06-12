// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_CONFIG_DOCUMENT_BYTES,
  createConfigPullLoop,
} from '../../hypaware-core/plugins-workspace/central/src/config_client.js'

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

/** @param {Array<{ status: number, headers?: Record<string, string>, body?: string }>} responses */
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
    const headers = new Headers(next.headers ?? {})
    return /** @type {Response} */ (/** @type {unknown} */ ({
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      headers,
      async text() { return next.body ?? '' },
    }))
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
  // by the loop itself — that's what makes this test fast.
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
