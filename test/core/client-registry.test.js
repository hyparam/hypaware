// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { createAiGatewayApi, createGatewayState } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { createAttachHandler } from '../../src/core/config/action_attach.js'
import { createClientRegistry } from '../../src/core/registry/clients.js'

test('intrinsic client registry defaults to gateway-required and preserves endpoint-free registrations', () => {
  const registry = createClientRegistry()
  registry.registerClient({ name: 'claude', async attach() {} })
  registry.registerClient({ name: 'opencode', requiresEndpoint: false, async attach() {} })

  assert.equal(registry.getClient('claude')?.requiresEndpoint, true)
  assert.equal(registry.getClient('opencode')?.requiresEndpoint, false)
  assert.deepEqual(registry.listClients().map((client) => client.name), ['claude', 'opencode'])
})

test('gateway client API delegates registrations but does not expose endpoint-free clients as gateway routes', () => {
  const registry = createClientRegistry()
  registry.registerClient({ name: 'opencode', requiresEndpoint: false, async attach() {} })
  const gateway = createAiGatewayApi(createGatewayState(), { clients: registry })
  gateway.registerClient({ name: 'claude', defaultUpstream: 'anthropic', async attach() {} })

  assert.equal(registry.getClient('claude')?.name, 'claude')
  assert.equal(gateway.getClient('opencode'), undefined)
  assert.deepEqual(gateway.listClients().map((client) => client.name), ['claude'])
})

test('reconciled attach invokes endpoint-free clients without a gateway endpoint', async () => {
  const registry = createClientRegistry()
  /** @type {any} */
  let received
  registry.registerClient({
    name: 'opencode',
    requiresEndpoint: false,
    async attach(ctx) {
      received = ctx
      ctx.stdout.write(JSON.stringify({
        status: 'ok',
        action: 'attach',
        client: 'opencode',
        dry_run: false,
        changed: true,
        settings_path: '/tmp/opencode/hypaware.js',
      }))
    },
  })
  const handler = createAttachHandler()
  const outcome = await handler.perform(
    { requestKey: 'opencode', params: { client: 'opencode', plugin: '@hypaware/opencode' } },
    /** @type {any} */ ({
      config: { version: 2, plugins: [] },
      env: {},
      clients: registry,
      endpoint: undefined,
      now: () => Date.parse('2026-08-24T00:00:00.000Z'),
      log: { debug() {}, info() {}, warn() {}, error() {} },
    })
  )

  assert.deepEqual(outcome, {
    status: 'done',
    detail: { settings_path: '/tmp/opencode/hypaware.js' },
  })
  assert.equal(received.endpoint, undefined)
  assert.equal(received.json, true)
})
