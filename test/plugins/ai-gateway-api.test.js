// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAiGatewayApi,
  createGatewayState,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'

test('registerExchangeProjector accepts a complete projector record', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  api.registerExchangeProjector({
    name: 'p',
    priority: 5,
    match: () => true,
    project: () => undefined,
  })
  assert.equal(state.projectors.length, 1)
  const recorded = state.projectors[0]
  assert.equal(recorded.name, 'p')
  assert.equal(recorded.priority, 5)
  assert.equal(typeof recorded.match, 'function')
  assert.equal(typeof recorded.project, 'function')
  assert.equal(recorded._seq, 0, 'first registration is _seq 0')
})

test('registerExchangeProjector assigns _seq in registration order', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  for (const name of ['a', 'b', 'c']) {
    api.registerExchangeProjector({
      name,
      match: () => true,
      project: () => undefined,
    })
  }
  assert.deepEqual(state.projectors.map((p) => [p.name, p._seq]), [
    ['a', 0],
    ['b', 1],
    ['c', 2],
  ])
})

test('registerExchangeProjector rejects missing or non-string name', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  const stub = { match: () => true, project: () => undefined }
  assert.throws(() => api.registerExchangeProjector(/** @type {any} */ (null)), TypeError)
  assert.throws(() => api.registerExchangeProjector(/** @type {any} */ ({ ...stub })), TypeError)
  assert.throws(() => api.registerExchangeProjector(/** @type {any} */ ({ ...stub, name: '' })), TypeError)
  assert.throws(() => api.registerExchangeProjector(/** @type {any} */ ({ ...stub, name: 123 })), TypeError)
  assert.equal(state.projectors.length, 0, 'no projector should be recorded after a failed validation')
})

test('registerExchangeProjector rejects missing match()', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  assert.throws(
    () => api.registerExchangeProjector(/** @type {any} */ ({ name: 'p', project: () => undefined })),
    /match\(\) is required/
  )
  assert.throws(
    () => api.registerExchangeProjector(/** @type {any} */ ({ name: 'p', match: 'not-a-fn', project: () => undefined })),
    /match\(\) is required/
  )
})

test('registerExchangeProjector rejects missing project()', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  assert.throws(
    () => api.registerExchangeProjector(/** @type {any} */ ({ name: 'p', match: () => true })),
    /project\(\) is required/
  )
})

test('registerExchangeProjector preserves a missing priority as undefined', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  api.registerExchangeProjector({ name: 'p', match: () => true, project: () => undefined })
  assert.equal(state.projectors[0].priority, undefined)
})

test('registerUpstreamPreset stores presets by name and rejects invalid records', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  api.registerUpstreamPreset({ name: 'echo', base_url: 'http://127.0.0.1', path_prefix: '/v1/echo' })
  assert.deepEqual(Array.from(state.presets.keys()), ['echo'])

  assert.throws(
    () => api.registerUpstreamPreset(/** @type {any} */ ({ base_url: 'http://x', path_prefix: '/' })),
    /name is required/
  )
  assert.throws(
    () => api.registerUpstreamPreset(/** @type {any} */ ({ name: 'no-url', path_prefix: '/' })),
    /base_url is required/
  )
  assert.throws(
    () => api.registerUpstreamPreset(/** @type {any} */ ({ name: 'no-route', base_url: 'http://x' })),
    /match\(\) or path_prefix is required/
  )
})

test('registerUpstreamPreset replaces an existing entry with the same name', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  api.registerUpstreamPreset({ name: 'echo', base_url: 'http://a', path_prefix: '/v1' })
  api.registerUpstreamPreset({ name: 'echo', base_url: 'http://b', path_prefix: '/v2' })
  assert.equal(state.presets.size, 1)
  assert.equal(state.presets.get('echo')?.base_url, 'http://b')
})

test('registerClient validates name, defaultUpstream, and attach/detach', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  const ok = {
    name: 'codex',
    defaultUpstream: 'openai',
    attach: async () => {},
    detach: async () => {},
  }
  api.registerClient(ok)
  assert.equal(state.clients.get('codex')?.defaultUpstream, 'openai')

  assert.throws(
    () => api.registerClient(/** @type {any} */ ({ defaultUpstream: 'u', attach() {}, detach() {} })),
    /name is required/
  )
  assert.throws(
    () => api.registerClient(/** @type {any} */ ({ name: 'x', attach() {}, detach() {} })),
    /defaultUpstream is required/
  )
  assert.throws(
    () => api.registerClient(/** @type {any} */ ({ name: 'x', defaultUpstream: 'u', attach() {} })),
    /attach\(\)\/detach\(\) are required/
  )
})

test('getClient and listClients expose the registered clients', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  const claude = { name: 'claude', defaultUpstream: 'anthropic', attach: async () => {}, detach: async () => {} }
  const codex = { name: 'codex', defaultUpstream: 'openai', attach: async () => {}, detach: async () => {} }
  api.registerClient(claude)
  api.registerClient(codex)
  assert.equal(api.getClient('claude'), claude)
  assert.equal(api.getClient('missing'), undefined)
  assert.deepEqual(api.listClients().map((c) => c.name).sort(), ['claude', 'codex'])
})

test('localEndpoint throws before the source starts', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  assert.throws(() => api.localEndpoint(), /localEndpoint\(\) called before the gateway started/)
})

test('localEndpoint returns the bound host:port once the source has started', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  state.listen = { host: '127.0.0.1', port: 8123 }
  assert.equal(api.localEndpoint(), 'http://127.0.0.1:8123')
})

test('localEndpoint appends pathPrefix, normalizing a missing leading slash', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  state.listen = { host: '127.0.0.1', port: 4000 }
  assert.equal(api.localEndpoint({ pathPrefix: '/v1' }), 'http://127.0.0.1:4000/v1')
  assert.equal(api.localEndpoint({ pathPrefix: 'v1' }), 'http://127.0.0.1:4000/v1')
})

test('localEndpoint brackets IPv6 hosts so URL parsers do not choke', () => {
  const state = createGatewayState()
  const api = createAiGatewayApi(state)
  state.listen = { host: '::1', port: 9000 }
  assert.equal(api.localEndpoint(), 'http://[::1]:9000')
})
