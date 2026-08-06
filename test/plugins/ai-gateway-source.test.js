// @ts-check

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createStartSource } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'
import { composePickerConfig } from '../../src/core/cli/walkthrough.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'

// A source with an empty routing table binds no listener at all, so a test
// that needs a live port must give it something to route even when it only
// exercises the control path (and never proxies through it). Hence this
// unreachable-but-well-formed upstream on the R3 tests below.
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

// ---------------------------------------------------------------------------
// An upstream-less gateway is a valid config, not a misconfiguration.
// `@hypaware/hermes` reads Hermes's own state.db and is "never modified,
// configured, or proxied" (LLP 0119), but the shared
// `ai_gateway.projected_exchange` materializer is a hard `requires.plugins`
// dependency (LLP 0120), so its picker row composes the gateway plugin while
// contributing no `gateway_upstream`. Picked alone that wrote a gateway slice
// with `upstreams: []` whose source start threw, i.e. a reachable first-run
// choice that produced a broken install rather than a working one (#649).
// ---------------------------------------------------------------------------

/** @param {string[]} sources */
async function composePicked(sources) {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  return composePickerConfig({
    sources: /** @type {any} */ (sources),
    descriptors: catalog.pickerDescriptors,
    exportChoice: 'local-parquet',
    retentionDays: 30,
    hypHome: '/home/tester/.hyp',
  })
}

// @ref LLP 0120#consequences [tests]: hermes composes the gateway plugin for the materializer alone, so the config a hermes-only picker run writes must yield a source that starts
test('the gateway source a hermes-only picker run composes starts, idle', async () => {
  const config = await composePicked(['hermes'])
  const gateway = config.plugins?.find((p) => p.name === '@hypaware/ai-gateway')
  assert.ok(gateway, 'hermes composes the gateway plugin: its materializer is a hard dependency')
  assert.deepEqual(gateway.config?.upstreams, [], 'and hermes contributes no upstream of its own')

  // Before the fix this rejected with
  // "ai-gateway: at least one upstream must be configured before start".
  const source = await createStartSource(createGatewayState())(fakeCtx(/** @type {any} */ (gateway.config)))
  try {
    assert.ok(source.status, 'source exposes status()')
    const status = await source.status()
    assert.equal(status.state, 'ready', 'an idle gateway is not an error state')
    assert.ok(status.details, 'status carries details')
    assert.equal(status.details.listening, false, 'no listener was bound')
    assert.equal(status.details.port, undefined, 'and no port is advertised for one')
    assert.match(String(status.message ?? ''), /no upstreams/, 'status says why it is idle')
  } finally {
    await source.stop()
  }
})

// Idling must be recoverable, not a dead end: the daemon reloads the source
// in place when config changes, so adding an upstream has to bind a listener
// without a restart.
test('an idle gateway binds once a reload brings an upstream', async () => {
  // Idle source first, echo upstream second: if starting it ever regresses to
  // throwing, this fails without leaking a listening server into the run.
  const source = await createStartSource(createGatewayState())(fakeCtx({ listen: '127.0.0.1:0', upstreams: [] }))
  const upstream = await startEchoUpstream('reloaded-ok')
  try {
    assert.ok(source.reload && source.status, 'source exposes reload() and status()')
    await source.reload(fakeCtx({
      listen: '127.0.0.1:0',
      upstreams: [{ name: 'echo', base_url: upstream.url, path_prefix: '/' }],
    }))
    const status = await source.status()
    assert.ok(status.details, 'status carries details')
    assert.equal(status.details.listening, undefined, 'the reloaded source is no longer idle')
    const body = await fetchText(`http://${status.details.host}:${status.details.port}/anything`)
    assert.equal(body.status, 200)
    assert.equal(body.text, 'reloaded-ok')
  } finally {
    await source.stop()
    await upstream.close()
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
