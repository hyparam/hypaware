// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveClientActionSeam } from '../../src/core/daemon/runtime.js'

/**
 * #179 round-3 hardening (LLP 0045 §Part 1): the daemon's client-action seam
 * resolves the auto-attach `endpoint` from a *proven-bound* gateway only. When
 * `localEndpoint()` throws (the gateway never bound) the daemon must NOT fall
 * back to the configured-`listen` URL — recording a base URL for a port nothing
 * bound would point clients at a dead endpoint. The manual `hyp attach`/`init`
 * paths keep that fallback (`core_commands.js`); this is the daemon path only.
 */

/** A quiet file log that records its `warn` calls. */
function makeFileLog() {
  /** @type {Array<{ event: string, attrs: any }>} */
  const warnings = []
  return {
    warnings,
    warn(/** @type {string} */ event, /** @type {any} */ attrs) { warnings.push({ event, attrs }) },
    info() {},
    error() {},
    debug() {},
  }
}

/**
 * A minimal `BootKernelResult` double exposing just what the seam reads: the
 * ai-gateway capability (with a stubbed `localEndpoint`) and a config whose
 * configured `listen` *would* resolve — so the unbound case proves the daemon no
 * longer falls back to it.
 * @param {{ localEndpoint: () => string }} opts
 * @returns {any}
 */
function makeBoot({ localEndpoint }) {
  const capability = {
    localEndpoint,
    getClient() { return undefined },
    listClients() { return [] },
    registerClient() {},
    registerUpstreamPreset() {},
    registerExchangeProjector() {},
    registerSettlementEnricher() {},
  }
  return {
    clientDescriptors: new Map(),
    // Configured listen resolves to http://127.0.0.1:8787 — the *old* fallback
    // target. The daemon path must ignore it when localEndpoint() throws.
    config: { version: 2, plugins: [{ name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:8787' } }] },
    runtime: {
      capabilities: {
        has: (/** @type {string} */ name) => name === 'hypaware.ai-gateway',
        require: () => capability,
      },
    },
  }
}

test('seam records the proven-bound localEndpoint as the daemon attach endpoint', () => {
  const fileLog = makeFileLog()
  const seam = resolveClientActionSeam({
    boot: makeBoot({ localEndpoint: () => 'http://127.0.0.1:54321' }),
    fileLog: /** @type {any} */ (fileLog),
  })
  assert.equal(seam.endpoint, 'http://127.0.0.1:54321')
  assert.notEqual(seam.clients, undefined)
  assert.equal(fileLog.warnings.length, 0, 'no unresolved-endpoint warning when bound')
})

test('seam does NOT fall back to the configured listen when localEndpoint() throws (no URL for an unbound port)', () => {
  const fileLog = makeFileLog()
  const seam = resolveClientActionSeam({
    boot: makeBoot({
      localEndpoint: () => {
        throw new Error('ai-gateway: localEndpoint() called before the gateway started')
      },
    }),
    fileLog: /** @type {any} */ (fileLog),
  })
  // The configured listen (127.0.0.1:8787) WOULD have resolved — the daemon path
  // must still leave endpoint undefined so auto-attach stays inert this pass.
  assert.equal(seam.endpoint, undefined)
  // The gateway capability itself is still present (clients can be invoked once
  // a later boot observes a bound gateway).
  assert.notEqual(seam.clients, undefined)
  // It surfaces the unresolved-endpoint warning for operators.
  assert.equal(
    fileLog.warnings.some((w) => w.event === 'daemon.attach_endpoint_unresolved'),
    true,
    'expected a daemon.attach_endpoint_unresolved warning'
  )
})

test('seam is inert (no clients/endpoint) when the ai-gateway capability is absent', () => {
  const fileLog = makeFileLog()
  /** @type {any} */
  const boot = {
    clientDescriptors: new Map(),
    config: { version: 2, plugins: [] },
    runtime: {
      capabilities: {
        has: () => false,
        require() { throw new Error('require() must not be called without the capability') },
      },
    },
  }
  const seam = resolveClientActionSeam({ boot, fileLog: /** @type {any} */ (fileLog) })
  assert.equal(seam.clients, undefined)
  assert.equal(seam.endpoint, undefined)
  assert.equal(fileLog.warnings.length, 0)
})
