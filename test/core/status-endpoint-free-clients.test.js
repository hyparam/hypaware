// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { listClientNames } from '../../src/core/commands/status.js'

// The gateway capability's listClients() filters to registrations that carry a
// gateway upstream, so an endpoint-free adapter (LLP 0306) is present only in
// the intrinsic registry. `hyp status` must read the registry, or such a client
// is silently missing from the clients line.
// @ref LLP 0306#endpoint-free-clients [tests]: the clients line is derived from the intrinsic registry

/** @param {string[]} names */
function registry(names) {
  return /** @type {any} */ ({
    registerClient() {},
    getClient: (/** @type {string} */ name) => names.includes(name) ? { name, attach: async () => {} } : undefined,
    listClients: () => names.map((name) => ({ name, attach: async () => {} })),
  })
}

/** @param {string[]} names */
function gatewayCapabilities(names) {
  return /** @type {any} */ ({
    has: (/** @type {string} */ id) => id === 'hypaware.ai-gateway',
    require: () => ({ listClients: () => names.map((name) => ({ name, defaultUpstream: 'anthropic' })) }),
  })
}

test('status lists endpoint-free clients the gateway capability filters out', () => {
  const ctx = /** @type {any} */ ({
    clients: registry(['opencode', 'claude']),
    capabilities: gatewayCapabilities(['claude']),
  })
  assert.deepEqual(listClientNames(ctx), ['claude', 'opencode'])
})

test('status falls back to the gateway capability on a host with no client registry', () => {
  const ctx = /** @type {any} */ ({
    capabilities: gatewayCapabilities(['claude', 'codex']),
  })
  assert.deepEqual(listClientNames(ctx), ['claude', 'codex'])
})

test('status lists nothing when neither registry nor gateway capability is present', () => {
  const ctx = /** @type {any} */ ({ capabilities: { has: () => false, require: () => { throw new Error('absent') } } })
  assert.deepEqual(listClientNames(ctx), [])
})
