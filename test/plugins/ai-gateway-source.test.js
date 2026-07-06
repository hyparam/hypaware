// @ts-check

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createStartSource } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'

// startProxy requires at least one configured upstream even when a test only
// exercises the control path (never proxies through it), so the R3 tests
// below carry this unreachable-but-well-formed one.
const ARBITRARY_UPSTREAM = { name: 'unused', base_url: 'http://127.0.0.1:1', path_prefix: '/' }

test('source starts with only adapter-registered upstream presets', async () => {
  const upstream = await startEchoUpstream('preset-ok')
  const state = createGatewayState()
  state.presets.set('echo', {
    name: 'echo',
    base_url: upstream.url,
    path_prefix: '/',
  })

  const source = await createStartSource(state)(fakeCtx({
    listen: '127.0.0.1:0',
  }))

  try {
    assert.ok(source.status, 'source exposes status()')
    const status = await source.status()
    assert.ok(status.details, 'status carries details')
    const body = await fetchText(`http://${status.details.host}:${status.details.port}/anything`)
    assert.equal(body.status, 200)
    assert.equal(body.text, 'preset-ok')
  } finally {
    await source.stop()
    await upstream.close()
  }
})

test('operator configured upstream wins over same-name adapter preset', async () => {
  const upstream = await startEchoUpstream('config-ok')
  const state = createGatewayState()
  state.presets.set('openai', {
    name: 'openai',
    base_url: 'http://127.0.0.1:1',
    path_prefix: '/',
  })

  const source = await createStartSource(state)(fakeCtx({
    listen: '127.0.0.1:0',
    upstreams: [{
      name: 'openai',
      base_url: upstream.url,
      path_prefix: '/',
      provider: 'openai',
    }],
  }))

  try {
    assert.ok(source.status, 'source exposes status()')
    const status = await source.status()
    assert.ok(status.details, 'status carries details')
    const body = await fetchText(`http://${status.details.host}:${status.details.port}/v1/responses`)
    assert.equal(body.status, 200)
    assert.equal(body.text, 'config-ok')
  } finally {
    await source.stop()
    await upstream.close()
  }
})

// ---------------------------------------------------------------------------
// @ref LLP 0066#ephemeral [tests]: R3 restart-drops-state / reload-keeps-set.
// `ignoredSessions` lives on `GatewayState`, created once per plugin
// activation (createGatewayState()), not per-listener. A `reload()` tears
// down and relaunches the listener with the SAME state, so an opt-out must
// survive it; a fresh activation (the restart case) gets a brand-new state
// and must start empty.
// ---------------------------------------------------------------------------

test('the ignored-session set survives a reload() of the same GatewayState', async () => {
  const state = createGatewayState()
  const source = await createStartSource(state)(fakeCtx({ listen: '127.0.0.1:0', upstreams: [ARBITRARY_UPSTREAM] }))

  try {
    assert.ok(source.status, 'source exposes status()')
    const before = await source.status()
    assert.ok(before.details, 'status carries details')
    const addRes = await fetch(`http://${before.details.host}:${before.details.port}/_hypaware/ignore/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-reload' }),
    })
    assert.equal(addRes.status, 200)
    assert.ok(state.ignoredSessions.has('sess-reload'), 'the opt-out landed on the shared state')

    // reload() tears down the listener and rebuilds it on a new ephemeral
    // port, but hands launchListener the SAME `state` object (source.js
    // never calls createGatewayState() again).
    assert.ok(source.reload, 'source exposes reload()')
    await source.reload(fakeCtx({ listen: '127.0.0.1:0', upstreams: [ARBITRARY_UPSTREAM] }))
    assert.ok(state.ignoredSessions.has('sess-reload'), 'reload must not clear the ignored-session set')

    // Prove it end-to-end too: the NEW listener re-serves the route over the
    // same set, so re-POSTing the same id is the idempotent no-op it would be
    // pre-reload (still ignored, total unchanged), not a fresh add.
    const after = await source.status()
    assert.ok(after.details, 'status carries details after reload')
    const reAddRes = await fetch(`http://${after.details.host}:${after.details.port}/_hypaware/ignore/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-reload' }),
    })
    const reAddBody = await reAddRes.json()
    assert.deepEqual(reAddBody, { session_id: 'sess-reload', ignored: true, total: 1 })
  } finally {
    await source.stop()
  }
})

test('restart-drops-state: a fresh GatewayState never carries a previous run\'s opt-outs', async () => {
  const priorRunState = createGatewayState()
  priorRunState.ignoredSessions.add('sess-from-before-restart')
  assert.equal(priorRunState.ignoredSessions.size, 1)

  // A daemon restart re-runs plugin activate(), which calls
  // createGatewayState() again: a brand-new Set, unconnected to whatever the
  // prior process held in memory.
  const freshState = createGatewayState()
  assert.equal(freshState.ignoredSessions.size, 0, 'a fresh activation starts with an empty ignored-session set')
  assert.equal(
    freshState.ignoredSessions.has('sess-from-before-restart'),
    false,
    'a restart must not carry over a previously ignored session'
  )

  // Confirmed live too: a source started against the fresh state serves the
  // control route over an empty set, so the previously ignored id is not
  // reported as ignored.
  const source = await createStartSource(freshState)(fakeCtx({ listen: '127.0.0.1:0', upstreams: [ARBITRARY_UPSTREAM] }))
  try {
    assert.ok(source.status, 'source exposes status()')
    const status = await source.status()
    assert.ok(status.details, 'status carries details')
    assert.equal(status.details.ignored_sessions, 0)
  } finally {
    await source.stop()
  }
})

/** @param {Record<string, unknown>} config */
function fakeCtx(config) {
  return /** @type {any} */ ({
    config,
    storage: {
      cacheTablePath(dataset, partitions) {
        return [dataset, ...(partitions ?? [])].join('/')
      },
      async appendRows() {},
    },
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  })
}

/** @param {string} body */
async function startEchoUpstream(body) {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(body)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)))
    }),
  }
}

/** @param {string} url */
async function fetchText(url) {
  const res = await fetch(url)
  return { status: res.status, text: await res.text() }
}
