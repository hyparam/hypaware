// @ts-check

import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { captureSession } from '../../hypaware-core/bridges/devin/capture.js'
import { devinDetail, devinMessages, devinPage } from '../../hypaware-core/smoke/fixtures/devin.js'
import { flattenOtlpLogs } from '../../hypaware-core/plugins-workspace/otel/src/otlp/logs.js'

/** @import { TestContext } from 'node:test' */

/** @param {unknown} value @param {number} [status] @param {Record<string, string>} [headers] */
function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers })
}

/** @param {TestContext} t */
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devin-bridge-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const options = { orgId: 'org-fixture', sessionId: 'devin-abc123', token: 'cog_synthetic',
    statePath: path.join(dir, 'state.json'), endpoint: 'http://127.0.0.1:4318/v1/logs' }
  /** @type {Record<string, unknown>[]} */
  const rows = []
  /** @type {{ url: URL, init: RequestInit }[]} */
  const calls = []
  const sleeps = []
  const runtime = {
    now: () => 1792531000000,
    sleep: async (/** @type {number} */ ms) => { sleeps.push(ms) },
    fetch: /** @type {typeof fetch} */ (async (input, init = {}) => {
      const url = new URL(String(input))
      calls.push({ url, init })
      if (init.method === 'POST') {
        rows.push(...flattenOtlpLogs(JSON.parse(String(init.body))))
        return json({})
      }
      if (url.pathname.endsWith('/messages')) return json(devinPage(url.searchParams.get('after')))
      return json(devinDetail)
    }),
  }
  return { options, runtime, rows, calls, sleeps, json }
}

test('selected-session bridge preserves native bodies, identities, timestamps, ACUs and outcome links', async t => {
  const f = await setup(t)
  const result = await captureSession(f.options, f.runtime)
  assert.equal(result.distinctMessages, 2)
  assert.equal(result.delivered, 3)
  assert.equal(result.duplicates, 1)
  assert.deepEqual(f.rows.map(r => r.body), [devinDetail, ...devinMessages])
  assert.equal(f.rows[1].timestamp, new Date(devinMessages[0].created_at * 1000).toISOString())
  assert.equal(f.rows[1].observedTimestamp, new Date(f.runtime.now()).toISOString())
  assert.deepEqual(f.rows[1].attributes, { org_id: 'org-fixture', session_id: 'devin-abc123', event_kind: 'message', event_id: 'event-user', source: 'user' })
  assert.ok(f.calls.filter(c => c.init.method === 'GET').every(c => c.url.pathname.includes('/organizations/org-fixture/sessions/devin-abc123')))
  assert.ok(f.calls.filter(c => c.init.method === 'POST').every(c => !('authorization' in (c.init.headers ?? {}))))
  assert.ok(f.calls.every(c => c.init.redirect === 'error'))
  const raw = await fs.readFile(f.options.statePath, 'utf8')
  assert.ok(!raw.includes('cog_') && !raw.includes(devinMessages[0].message))
  assert.equal((await fs.stat(f.options.statePath)).mode & 0o777, 0o600)
  assert.deepEqual(f.sleeps, [])
})

test('restart resumes final-page cursor and suppresses acknowledged messages and unchanged detail', async t => {
  const f = await setup(t)
  await captureSession(f.options, f.runtime)
  f.calls.length = 0
  const result = await captureSession(f.options, f.runtime)
  assert.equal(result.delivered, 0)
  assert.equal(f.rows.length, 3)
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('/messages')).length, 1)
  assert.equal(f.calls.find(c => c.url.pathname.endsWith('/messages'))?.url.searchParams.get('after'), 'page-two')
})

test('collector failure leaves the failed page recoverable after restart', async t => {
  const f = await setup(t)
  const original = f.runtime.fetch
  f.runtime.fetch = async (input, init) => {
    if (init?.method === 'POST' && String(init.body).includes('event-devin')) return json({}, 503)
    return original(input, init)
  }
  await assert.rejects(captureSession(f.options, f.runtime), /otlp_retry_exhausted/)
  assert.equal(JSON.parse(await fs.readFile(f.options.statePath, 'utf8')).seen.length, 1)
  f.runtime.fetch = original
  const result = await captureSession(f.options, f.runtime)
  assert.equal(result.delivered, 1)
  assert.equal(f.rows.length, 3)
  assert.deepEqual(f.sleeps, [1000, 2000])
})

test('changed lifecycle snapshot is captured with unknown vendor fields intact', async t => {
  const f = await setup(t)
  await captureSession(f.options, f.runtime)
  const original = f.runtime.fetch
  f.runtime.fetch = async (input, init) => String(input).endsWith('devin-abc123')
    ? json({ ...devinDetail, status: 'exit', future_vendor_field: { unknown: true } }) : original(input, init)
  assert.equal((await captureSession(f.options, f.runtime)).delivered, 1)
  assert.deepEqual(/** @type {any} */ (f.rows.at(-1)?.body).future_vendor_field, { unknown: true })
})

for (const status of [401, 403, 404, 409, 422]) {
  test(`HTTP ${status} fails once without exposing the vendor error body`, async t => {
    const f = await setup(t)
    let calls = 0
    f.runtime.fetch = async () => {
      calls++
      return json({ error: 'cog_never_print_this' }, status)
    }
    await assert.rejects(captureSession(f.options, f.runtime), new RegExp(`^Error: details_http_${status}$`))
    assert.equal(calls, 1)
  })
}

test('429 honors Retry-After and recovers within the attempt budget', async t => {
  const f = await setup(t)
  const original = f.runtime.fetch
  let first = true
  f.runtime.fetch = async (input, init) => {
    if (first) {
      first = false
      return json({}, 429, { 'retry-after': '5' })
    }
    return original(input, init)
  }
  await captureSession(f.options, f.runtime)
  assert.deepEqual(f.sleeps, [5000])
})

test('long Retry-After refuses instead of retrying earlier than the server permits', async t => {
  const f = await setup(t)
  f.runtime.fetch = async () => json({}, 429, { 'retry-after': '3600' })
  await assert.rejects(captureSession(f.options, f.runtime), /details_retry_after_exceeds_budget/)
  assert.deepEqual(f.sleeps, [])
})

test('network failures have a bounded retry count and secret-safe errors', async t => {
  const f = await setup(t)
  let calls = 0
  f.runtime.fetch = async () => {
    calls++
    throw new Error('network cog_secret private prompt')
  }
  await assert.rejects(captureSession(f.options, f.runtime), /^Error: details_retry_exhausted$/)
  assert.equal(calls, 3)
})

for (const [label, page] of [
  ['cycle', { items: [], has_next_page: true, end_cursor: 'page-two' }],
  ['missing cursor', { items: [], has_next_page: true, end_cursor: null }],
  ['bad event', { items: [{ ...devinMessages[0], event_id: null }], has_next_page: false, end_cursor: null }],
  ['bad time', { items: [{ ...devinMessages[0], event_id: 'bad-time-new-event', created_at: null }], has_next_page: false, end_cursor: null }],
]) {
  test(`invalid message page (${label}) fails without checkpointing its events`, async t => {
    const f = await setup(t)
    const original = f.runtime.fetch
    f.runtime.fetch = async (input, init) => String(input).includes('after=page-two') ? json(page) : original(input, init)
    await assert.rejects(captureSession(f.options, f.runtime), /messages_cursor_cycle|messages_invalid_item|invalid_vendor_timestamp/)
    assert.equal(JSON.parse(await fs.readFile(f.options.statePath, 'utf8')).seen.length, 1)
  })
}

for (const limits of [{ responseBytes: 5 }, { totalBytes: 10 }, { pages: 1 }, { records: 1 }, { durationMs: 0 }]) {
  test(`bounded collection stops explicitly at ${JSON.stringify(limits)}`, async t => {
    const f = await setup(t)
    await assert.rejects(captureSession(f.options, { ...f.runtime, limits }), /limit_exceeded|deadline_exceeded/)
  })
}

test('OTLP partial success remains uncheckpointed and is recoverable', async t => {
  const f = await setup(t)
  f.runtime.fetch = async (_input, init) => init?.method === 'POST'
    ? json({ partialSuccess: { rejectedLogRecords: '1', errorMessage: 'cog_private' } }) : json(devinDetail)
  await assert.rejects(captureSession(f.options, f.runtime), /^Error: otlp_partial_success$/)
  await assert.rejects(fs.stat(f.options.statePath), { code: 'ENOENT' })
})

test('watch polls at 30 seconds and stops after draining finished/waiting/suspended/error sessions', async t => {
  for (const detail of [{ status: 'running', status_detail: 'finished' }, { status: 'running', status_detail: 'waiting_for_user' },
    { status: 'running', status_detail: 'waiting_for_approval' }, { status: 'suspended', status_detail: 'out_of_credits' },
    { status: 'error', status_detail: null }, { status: 'exit', status_detail: null }]) {
    const f = await setup(t)
    const original = f.runtime.fetch
    let poll = 0
    f.runtime.fetch = async (input, init) => String(input).endsWith('devin-abc123')
      ? json({ ...devinDetail, ...(poll++ ? detail : { status: 'running', status_detail: 'working' }) }) : original(input, init)
    const result = await captureSession({ ...f.options, watch: true }, f.runtime)
    assert.equal(result.status, detail.status)
    assert.deepEqual(f.sleeps, [30000])
  }
})

test('state cannot be reused for another organization, session or receiver; corrupt state fails closed', async t => {
  const f = await setup(t)
  await captureSession(f.options, f.runtime)
  for (const options of [{ sessionId: 'devin-other' }, { orgId: 'org-other' }, { endpoint: 'http://127.0.0.1:4319/v1/logs' }]) {
    await assert.rejects(captureSession({ ...f.options, ...options }, f.runtime), /state_invalid_or_mismatched/)
  }
  await fs.writeFile(f.options.statePath, 'private malformed content')
  await assert.rejects(captureSession(f.options, f.runtime), /^Error: state_invalid_json$/)
})

test('concurrent writers fail immediately and leave the existing lock intact', async t => {
  const f = await setup(t)
  await fs.writeFile(`${f.options.statePath}.lock`, '')
  await assert.rejects(captureSession(f.options, f.runtime), /state_locked/)
  assert.equal(f.calls.length, 0)
  await fs.stat(`${f.options.statePath}.lock`)
})

test('explicit selection, credential and loopback receiver validation happens before any request', async t => {
  const f = await setup(t)
  for (const options of [{ orgId: '../escape' }, { sessionId: 'bad' }, { token: '' },
    { endpoint: 'http://example.com/v1/logs' }, { endpoint: 'http://127.0.0.1/v1/logs?token=x' }]) {
    await assert.rejects(captureSession({ ...f.options, ...options }, f.runtime))
  }
  assert.equal(f.calls.length, 0)
})

test('request timeout aborts each attempt and leaves recovery state untouched', async t => {
  const f = await setup(t)
  let calls = 0
  f.runtime.fetch = async (_input, init) => {
    calls++
    return new Promise((_resolve, reject) => {
      // Keep the test alive while the real unref-ed AbortSignal timer runs.
      const keepAlive = setTimeout(() => reject(new Error('test deadline')), 1000)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(keepAlive)
        reject(new Error('aborted private transport message'))
      }, { once: true })
    })
  }
  await assert.rejects(captureSession(f.options, { ...f.runtime, limits: { timeoutMs: 5 } }), /^Error: details_retry_exhausted$/)
  assert.equal(calls, 3)
  await assert.rejects(fs.stat(f.options.statePath), { code: 'ENOENT' })
})

test('watch deadline prevents another poll and leaves acknowledged progress recoverable', async t => {
  const f = await setup(t)
  const original = f.runtime.fetch
  f.runtime.fetch = async (input, init) => String(input).endsWith('devin-abc123')
    ? json({ ...devinDetail, status_detail: 'working' }) : original(input, init)
  await assert.rejects(captureSession({ ...f.options, watch: true }, { ...f.runtime, limits: { durationMs: 30000 } }), /deadline_exceeded/)
  assert.deepEqual(f.sleeps, [])
  assert.equal(JSON.parse(await fs.readFile(f.options.statePath, 'utf8')).seen.length, 2)
})

test('lost OTLP acknowledgement can replay raw rows while distinct native event counts remain stable', async t => {
  const f = await setup(t)
  const original = f.runtime.fetch
  let lost = false
  f.runtime.fetch = async (input, init) => {
    const result = await original(input, init)
    if (!lost && init?.method === 'POST' && String(init.body).includes('event-devin')) {
      lost = true
      throw new Error('connection lost after acceptance')
    }
    return result
  }
  const result = await captureSession(f.options, f.runtime)
  assert.equal(result.distinctMessages, 2)
  const events = f.rows.map(r => /** @type {any} */ (r.attributes)?.event_id).filter(Boolean)
  assert.equal(events.length, 3)
  assert.equal(new Set(events).size, 2)
  assert.equal((await captureSession(f.options, f.runtime)).delivered, 0)
})
