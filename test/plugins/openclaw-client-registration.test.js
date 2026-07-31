// @ts-check

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { activate } from '../../hypaware-core/plugins-workspace/openclaw/src/index.js'
import { buildClientDescriptorMap, runAttach, runDetach } from '../../src/core/commands/clients.js'

/**
 * LLP 0161 3.3: retiring `src/settings.js`'s settings-file write means
 * `attach()` becomes an honest no-op, but `gateway.registerClient({ name:
 * 'openclaw', ... })` stays registered so the manual `hyp attach openclaw`
 * / `hyp detach openclaw` / `hyp clients openclaw` commands keep resolving
 * the client instead of erroring `unknown client 'openclaw'` (a real
 * discoverability regression the manifest's `attach_probe` removal alone
 * would not cause, since `hyp clients`/`hyp attach` resolve `getClient()`
 * directly and do not gate on `attachProbe`).
 *
 * @import { CommandRunContext } from '../../hypaware-plugin-kernel-types.js'
 */

/** @returns {{ write(chunk: unknown): boolean, text(): string }} */
function makeBuf() {
  let value = ''
  return {
    write(chunk) {
      value += String(chunk)
      return true
    },
    text() {
      return value
    },
  }
}

test('activate() registers the openclaw client with an honest no-op attach()', async () => {
  /** @type {any} */
  let registeredClient
  const gateway = /** @type {any} */ ({
    registerUpstreamPreset() {},
    registerExchangeProjector() {},
    registerSettlementEnricher() {},
    registerClient(client) {
      registeredClient = client
    },
  })
  const ctx = /** @type {any} */ ({
    env: {},
    plugin: { version: '0.0.0-test' },
    configRegistry: { registerSection() {} },
    requireCapability: () => gateway,
  })

  await activate(ctx)

  assert.ok(registeredClient, 'activate() registered a client')
  assert.equal(registeredClient.name, 'openclaw')
  assert.equal(registeredClient.defaultUpstream, 'anthropic')

  const stdout = makeBuf()
  const stderr = makeBuf()
  await registeredClient.attach({ endpoint: 'http://127.0.0.1:4317', stdout, stderr, dryRun: false, json: false })

  // Writes nothing to the "settings file" (there is none any more); it only
  // reports that routing is owned by the steering plugin.
  assert.match(stdout.text(), /openclaw-steering-plugin/)
  assert.match(stdout.text(), /openclaw plugins install/)
})

test('activate() attach() emits the same report under --json, still writing nothing', async () => {
  /** @type {any} */
  let registeredClient
  const gateway = /** @type {any} */ ({
    registerUpstreamPreset() {},
    registerExchangeProjector() {},
    registerSettlementEnricher() {},
    registerClient(client) {
      registeredClient = client
    },
  })
  const ctx = /** @type {any} */ ({
    env: {},
    plugin: { version: '0.0.0-test' },
    configRegistry: { registerSection() {} },
    requireCapability: () => gateway,
  })
  await activate(ctx)

  const stdout = makeBuf()
  const stderr = makeBuf()
  await registeredClient.attach({ endpoint: 'http://127.0.0.1:4317', stdout, stderr, dryRun: false, json: true })

  const payload = JSON.parse(stdout.text().trim())
  assert.equal(payload.status, 'ok')
  assert.equal(payload.action, 'attach')
  assert.equal(payload.client, 'openclaw')
  assert.equal(payload.changed, false)
  assert.match(payload.routing_owned_by, /openclaw-steering-plugin/)
})

// @ref LLP 0161#settlement-enricher [tests]: the settlement enricher is
// registered in activate(), right after registerExchangeProjector (the
// Claude adapter's placement). Order matters to a reader, not to the
// kernel: the projector stamps the match key the enricher spends, so the
// two registrations belong together and are read together.
test('activate() registers the settlement enricher right after the exchange projector', async () => {
  /** @type {string[]} */
  const calls = []
  /** @type {any} */
  let enricher
  const gateway = /** @type {any} */ ({
    registerUpstreamPreset() { calls.push('preset') },
    registerExchangeProjector() { calls.push('projector') },
    registerSettlementEnricher(value) {
      calls.push('enricher')
      enricher = value
    },
    registerClient() { calls.push('client') },
  })
  const ctx = /** @type {any} */ ({
    env: { HOME: '/tmp/no-home', HYP_HOME: '/tmp/no-home/.hyp' },
    plugin: { version: '0.0.0-test' },
    configRegistry: { registerSection() {} },
    requireCapability: () => gateway,
  })

  await activate(ctx)

  assert.deepEqual(calls, ['preset', 'projector', 'enricher', 'client'])
  assert.equal(enricher.name, 'openclaw-settlement')
  assert.equal(enricher.clientName, 'openclaw')
})

test('hyp attach openclaw resolves the client and does not error unknown client', async () => {
  /** @type {string[]} */
  const attachCalls = []
  const gateway = /** @type {any} */ ({
    localEndpoint() {
      return 'http://127.0.0.1:4388'
    },
    getClient(name) {
      if (name !== 'openclaw') return null
      return {
        name,
        async attach() {
          attachCalls.push(name)
        },
      }
    },
    listClients() {
      return [{ name: 'openclaw' }]
    },
  })
  const stdout = makeBuf()
  const stderr = makeBuf()
  const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
    stdout,
    stderr,
    env: { HOME: '/tmp/no-home', HYP_HOME: '/tmp/no-home/.hyp' },
    config: { version: 2 },
    capabilities: {
      has: () => true,
      require: () => gateway,
    },
  }))

  const code = await runAttach(['openclaw'], ctx)

  assert.equal(code, 0, stderr.text())
  assert.deepEqual(attachCalls, ['openclaw'])
  assert.doesNotMatch(stderr.text(), /unknown client/)
})

test('hyp detach openclaw resolves the client from the real manifest as an honest no-op', async () => {
  // No attach_probe (R7) means detachClientFromDisk's no-probe guard fires:
  // { changed: false }. The point here is resolution, not restoration - the
  // command must not error `unknown client 'openclaw'`.
  const home = mkdtempSync(path.join(tmpdir(), 'hyp-openclaw-detach-'))
  try {
    const stdout = makeBuf()
    const stderr = makeBuf()
    const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
      stdout,
      stderr,
      env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
      config: { version: 2 },
    }))

    const code = await runDetach(['openclaw'], ctx)

    assert.equal(code, 0, stderr.text())
    assert.doesNotMatch(stderr.text(), /unknown client/)
    assert.match(stdout.text(), /nothing to do/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('hyp clients: the descriptor map behind client listing/status resolves openclaw', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hyp-openclaw-clients-'))
  try {
    const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
      env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
      config: { version: 2 },
    }))

    const descriptors = await buildClientDescriptorMap(ctx)

    assert.ok(descriptors.has('openclaw'), 'openclaw client descriptor resolves')
    const descriptor = descriptors.get('openclaw')
    assert.equal(descriptor?.plugin, '@hypaware/openclaw')
    // R7: the manifest declares no attach_probe any more.
    assert.equal(descriptor?.attachProbe, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
