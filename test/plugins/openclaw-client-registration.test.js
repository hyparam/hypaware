// @ts-check

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { activate } from '../../hypaware-core/plugins-workspace/openclaw/src/index.js'
// Fixture setup only for the real-attach detach case below: the write this
// stages is the exact real-world undo record detachClientFromDisk reverses,
// mirroring client-detach-json-path.test.js's own use of the real effect.
import { createOpenclawAttach } from '../../hypaware-core/plugins-workspace/openclaw/src/attach.js'
import { buildAttachPluginCatalog, buildClientDescriptorMap, runAttach, runDetach } from '../../src/core/commands/clients.js'
import { createAttachHandler } from '../../src/core/config/action_attach.js'

/**
 * `gateway.registerClient({ name: 'openclaw', ... })` is what makes the
 * manual `hyp attach openclaw` / `hyp detach openclaw` / `hyp clients
 * openclaw` commands resolve the client instead of erroring `unknown client
 * 'openclaw'`; those commands resolve `getClient()` directly and do not gate
 * on `attachProbe`. These tests cover the registration itself and the wiring
 * from `activate()` to the real effect in `attach.js` (LLP 0169 restored the
 * settings write LLP 0161 had retired); `openclaw-attach.test.js` covers the
 * effect's own contract.
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

/**
 * Stage a HOME with an OpenClaw config in it, and the activation context
 * pointed at that HOME so `activate()`'s attach writes into the temp tree
 * rather than the developer's own `~/.openclaw`.
 *
 * @param {Record<string, unknown>} config
 * @param {Record<string, unknown>} [pluginConfig]  the plugin's own validated
 *   `config` slice, i.e. `ctx.config`
 * @returns {{ homeDir: string, settingsPath: string, ctx: any, client(): any }}
 */
function stageActivation(config, pluginConfig) {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'hyp-openclaw-activate-'))
  const settingsPath = path.join(homeDir, '.openclaw', 'openclaw.json')
  mkdirSync(path.dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(config, null, 2))

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
    env: { HOME: homeDir },
    plugin: { version: '0.0.0-test' },
    // `ctx.config` is the kernel's already-validated slice of this plugin's own
    // `config` block (LLP 0037), the same shape `config.js` checks.
    config: pluginConfig ?? {},
    configRegistry: { registerSection() {} },
    backfills: { register() {} },
    requireCapability: () => gateway,
  })
  return { homeDir, settingsPath, ctx, client: () => registeredClient }
}

test('activate() registers the openclaw client and wires attach() to the real write', async () => {
  /** @type {any} */
  let registeredBackfill
  const staged = stageActivation({ models: { providers: {} } })
  staged.ctx.backfills = { register(/** @type {any} */ contribution) { registeredBackfill = contribution } }
  try {
    await activate(staged.ctx)

    const registeredClient = staged.client()
    assert.ok(registeredClient, 'activate() registered a client')
    assert.equal(registeredClient.name, 'openclaw')
    assert.equal(registeredClient.defaultUpstream, 'anthropic')

    // The session-transcript backfill provider rides the same activation, the
    // imperative `ctx.backfills.register(...)` house pattern @hypaware/codex
    // already follows. @ref LLP 0161#backfill-provider [tests]
    assert.ok(registeredBackfill, 'activate() registered a backfill provider')
    assert.equal(registeredBackfill.name, 'openclaw')
    assert.equal(registeredBackfill.plugin, '@hypaware/openclaw')
    assert.deepEqual(registeredBackfill.datasets, ['ai_gateway_messages'])

    const stdout = makeBuf()
    const stderr = makeBuf()
    await registeredClient.attach({ endpoint: 'http://127.0.0.1:4317', stdout, stderr, dryRun: false, json: false })

    // Registration is wired to `attach.js`'s effect, not to the retired no-op:
    // the two provider entries land on disk and the user is told to restart.
    // The entries' exact shape is `openclaw-attach.test.js`'s business.
    // @ref LLP 0169#decision [tests]
    const written = JSON.parse(readFileSync(staged.settingsPath, 'utf8'))
    assert.deepEqual(Object.keys(written.models.providers).sort(), ['anthropic', 'openai'])
    assert.match(stdout.text(), /openclaw gateway restart/)
  } finally {
    rmSync(staged.homeDir, { recursive: true, force: true })
  }
})

// The wiring, not the resolver. `backfill.js` has always read `sweep_cron` and
// `quiesce_ms` off the `config` it is handed, and its own unit tests hand that
// config straight to the factory, so they could not see that `activate()` never
// passed one: both keys were validated by `config.js` on the way in and then
// silently discarded, and every install got the hardcoded defaults no matter
// what the operator configured. `ctx.config` is the seam, so the assertion has
// to start from an activation.
// @ref LLP 0172#lane-b-sweep [tests]: the registered contribution's `sweep` is
// populated from the plugin's own validated config, not from the default
test('activate() threads ctx.config into the backfill provider (sweep_cron and quiesce_ms)', async () => {
  /** @type {any} */
  let registeredBackfill
  const staged = stageActivation(
    { models: { providers: {} } },
    { backfill: { sweep_cron: '*/30 * * * *', quiesce_ms: 777 } }
  )
  staged.ctx.backfills = { register(/** @type {any} */ contribution) { registeredBackfill = contribution } }
  try {
    await activate(staged.ctx)

    assert.ok(registeredBackfill, 'activate() registered a backfill provider')
    // The configured cadence is the one the daemon's sweep driver will match
    // against, not `*/5 * * * *`.
    assert.deepEqual(registeredBackfill.sweep, { cron: '*/30 * * * *' })

    // `quiesce_ms` has no contribution-level surface, so read it off the run's
    // own `scan_started` record (the same field openclaw-backfill.test.js
    // asserts the 180000ms default on). An empty HOME is enough: the record is
    // emitted before any file is read.
    /** @type {Array<{ message: string, fields: any }>} */
    const entries = []
    /** @param {string} message @param {any} fields */
    const record = (message, fields) => { entries.push({ message, fields }) }
    const runCtx = /** @type {any} */ ({
      env: {},
      cacheRoot: path.join(staged.homeDir, 'cache-unused'),
      dryRun: true,
      storage: {},
      log: { debug: record, info: record, warn: record, error: record },
    })
    for await (const _yielded of registeredBackfill.run(runCtx)) { /* drain */ }

    const started = entries.find((entry) => entry.message === 'openclaw.backfill.scan_started')
    assert.ok(started, 'the run logs scan_started')
    assert.equal(started.fields.quiesce_ms, 777)
  } finally {
    rmSync(staged.homeDir, { recursive: true, force: true })
  }
})

test('activate() attach() reports the same write under --json', async () => {
  const staged = stageActivation({ models: { providers: {} } })
  try {
    await activate(staged.ctx)

    const stdout = makeBuf()
    const stderr = makeBuf()
    await staged.client().attach({ endpoint: 'http://127.0.0.1:4317', stdout, stderr, dryRun: false, json: true })

    const payload = JSON.parse(stdout.text().trim())
    assert.equal(payload.status, 'ok')
    assert.equal(payload.action, 'attach')
    assert.equal(payload.client, 'openclaw')
    assert.equal(payload.changed, true)
    assert.equal(payload.settings_path, staged.settingsPath)
    assert.equal(payload.restart_command, 'openclaw gateway restart')
  } finally {
    rmSync(staged.homeDir, { recursive: true, force: true })
  }
})

// @ref LLP 0172#lane-a-attach [tests]: a refusal reaches the reconciler as a
// retryable failure. The kernel types the registered `attach()` as
// `Promise<void>`, so the effect's returned outcome reaches no caller and the
// wrapper has to rethrow it. Returning quietly recorded a `done` marker that
// `isCurrent()` then matched forever, so the join never re-attached after the
// user cleared the conflicting entry, and `hyp attach` exited 0 on a refusal.
test('activate() attach() rethrows a refusal so the join records a retryable failure', async () => {
  const staged = stageActivation({
    models: { providers: { anthropic: { baseUrl: 'https://mine.example', models: [] } } },
  })
  try {
    await activate(staged.ctx)

    const stdout = makeBuf()
    const stderr = makeBuf()
    await assert.rejects(
      () => staged.client().attach({ endpoint: 'http://127.0.0.1:4317', stdout, stderr, json: true }),
      /already exists/
    )

    // The reported line is still written before the throw: the throw is what
    // the void-typed callers can see, the payload is what a `--json` reader
    // parses.
    const payload = JSON.parse(stdout.text().trim())
    assert.equal(payload.status, 'failed')
    assert.match(payload.reason, /already exists/)
  } finally {
    rmSync(staged.homeDir, { recursive: true, force: true })
  }
})

// The other half of the same clause: the throw must reach the reconciler as a
// recorded `failed` outcome and must NOT abort the join's other actions.
// `perform()`'s catch is the seam that converts it, so drive the real handler
// rather than asserting on the wrapper alone.
// @ref LLP 0172#lane-a-attach [tests]: refusal is recorded and retried, and the
// sibling client attached in the same pass still lands
test('a refused openclaw attach is a failed reconciler outcome, not a done marker, and the join continues', async () => {
  const staged = stageActivation({
    models: { providers: { openai: { baseUrl: 'https://mine.example', models: [] } } },
  })
  try {
    await activate(staged.ctx)
    const openclaw = staged.client()

    /** @type {string[]} */
    const attached = []
    const handler = createAttachHandler()
    const ctx = /** @type {any} */ ({
      env: { HOME: staged.homeDir },
      endpoint: 'http://127.0.0.1:4317',
      log: { info() {}, warn() {}, error() {} },
      clients: {
        getClient(name) {
          if (name === 'openclaw') return openclaw
          if (name === 'sibling') return { name, async attach() { attached.push(name) } }
          return undefined
        },
      },
    })

    const refused = await handler.perform({ requestKey: 'openclaw', params: { client: 'openclaw' } }, ctx)
    assert.equal(refused.status, 'failed')
    assert.match(String(refused.reason), /already exists/)

    // A `failed` outcome carries no marker detail to go `done` on, so the next
    // pass re-performs rather than short-circuiting on `isCurrent`.
    assert.equal(refused.detail, undefined)

    const sibling = await handler.perform({ requestKey: 'sibling', params: { client: 'sibling' } }, ctx)
    assert.equal(sibling.status, 'done')
    assert.deepEqual(attached, ['sibling'])
  } finally {
    rmSync(staged.homeDir, { recursive: true, force: true })
  }
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
    backfills: { register() { calls.push('backfill') } },
  })

  await activate(ctx)

  // Assert the ADJACENCY this test is about, not the preset count: how many
  // upstream presets activate() registers is Section 3.4's business (one per
  // wire shape) and grows independently of this placement. The backfill
  // provider registers between the enricher and the client
  // (LLP 0161#backfill-provider); this test only pins the
  // projector/enricher adjacency, not the trailing registrations.
  assert.deepEqual(calls.slice(calls.indexOf('projector')), ['projector', 'enricher', 'backfill', 'client'])
  assert.ok(calls.every((call, i) => i >= calls.indexOf('projector') || call === 'preset'))
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

// The user-facing half of the same clause: a refusal must be distinguishable
// from a success by a script, which under exit 0 it was not.
// @ref LLP 0172#lane-a-attach [tests]: `hyp attach --client openclaw` exits
// nonzero when attach refuses
test('hyp attach openclaw exits nonzero when the attach refuses', async () => {
  const staged = stageActivation({
    models: { providers: { anthropic: { baseUrl: 'https://mine.example', models: [] } } },
  })
  try {
    await activate(staged.ctx)
    const openclaw = staged.client()

    const stdout = makeBuf()
    const stderr = makeBuf()
    const gateway = /** @type {any} */ ({
      localEndpoint: () => 'http://127.0.0.1:4388',
      getClient: (name) => (name === 'openclaw' ? openclaw : null),
      listClients: () => [{ name: 'openclaw' }],
    })
    const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
      stdout,
      stderr,
      env: { HOME: staged.homeDir, HYP_HOME: path.join(staged.homeDir, '.hyp') },
      config: { version: 2 },
      capabilities: { has: () => true, require: () => gateway },
    }))

    const code = await runAttach(['openclaw'], ctx)

    assert.equal(code, 1, stdout.text())
    assert.match(stderr.text(), /already exists/)
  } finally {
    rmSync(staged.homeDir, { recursive: true, force: true })
  }
})

test('hyp detach openclaw resolves the client from the real manifest as an honest no-op', async () => {
  // The manifest declares an attach_probe again (LLP 0173 T5 reversed R7), so
  // the no-op observed here on a fresh temp HOME is detachClientFromDisk's
  // absent-settings-file guard ({ changed: false }, no .openclaw/openclaw.json
  // to reverse), not a no-probe guard. The point here is resolution, not
  // restoration - the command must not error `unknown client 'openclaw'`.
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

test('hyp detach openclaw reverses a real attach: the ownership-based json_path undo fires end to end', async () => {
  // Companion to the honest-no-op case above: stage a real openclaw.json
  // written by the actual attach() effect, then drive the same CLI entry
  // point (buildClientDescriptorMap's real manifest descriptor ->
  // detachClientFromDisk's json_path branch) and prove it is not a no-op
  // once there is something on disk to reverse.
  // @ref LLP 0172#lane-a-detach [tests]: the ownership-based json_path undo,
  // exercised through the real manifest descriptor rather than a hand-built
  // one, so the wiring this file is about (not just the core undo, which
  // client-detach-json-path.test.js already covers directly) is proven too.
  const home = mkdtempSync(path.join(tmpdir(), 'hyp-openclaw-detach-real-'))
  try {
    const settingsPath = path.join(home, '.openclaw', 'openclaw.json')
    mkdirSync(path.dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', models: { providers: {} } }, null, 2))

    const endpoint = 'http://127.0.0.1:18521'
    const attachOutcome = await createOpenclawAttach({ homeDir: home, env: {} }).attach(
      /** @type {any} */ ({ endpoint, stdout: makeBuf(), stderr: makeBuf(), dryRun: false, json: true })
    )
    assert.equal(attachOutcome.status, 'done')

    const stdout = makeBuf()
    const stderr = makeBuf()
    const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
      stdout,
      stderr,
      env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
      config: { version: 2, plugins: [{ name: '@hypaware/ai-gateway', config: { listen: '127.0.0.1:18521' } }] },
    }))

    const code = await runDetach(['openclaw', '--json'], ctx)

    assert.equal(code, 0, stderr.text())
    assert.doesNotMatch(stderr.text(), /unknown client/)
    const payload = JSON.parse(stdout.text().trim())
    assert.equal(payload.status, 'ok')
    assert.equal(payload.changed, true)
    assert.equal(payload.settings_path, settingsPath)
    assert.equal(payload.removed, endpoint)

    // The two entries attach wrote are gone; everything else in the file
    // (the theme, the container itself) is untouched.
    const written = JSON.parse(readFileSync(settingsPath, 'utf8'))
    assert.deepEqual(written.models.providers, {})
    assert.equal(written.theme, 'dark')
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
    // LLP 0173 T5: R7 is reversed (LLP 0167#deletion-inventory), and the
    // manifest again declares a json_path attach_probe (design 1.4).
    assert.deepEqual(descriptor?.attachProbe, {
      format: 'json_path',
      settings_file: '.openclaw/openclaw.json',
      container_path: 'models.providers',
      provider_keys: ['anthropic', 'openai'],
      marker_header: 'x-hypaware-upstream',
      cache_glob: 'agents/*/agent/models.json',
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// @ref LLP 0174#detection [tests]: buildAttachPluginCatalog generalizes
// buildClientDescriptorMap to return the full catalog build instead of
// discarding pickerDescriptors/pluginMetadata/knownDatasets; this fixture
// workspace's real bundled manifests include both claude and ai-gateway
// (openclaw's own dependency closure), so the non-clientDescriptors slices
// this task adds must resolve non-empty here too.
test('buildAttachPluginCatalog returns the full catalog, not just clientDescriptors', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hyp-openclaw-catalog-'))
  try {
    const ctx = /** @type {CommandRunContext} */ (/** @type {any} */ ({
      env: { HOME: home, HYP_HOME: path.join(home, '.hyp') },
      config: { version: 2 },
    }))

    const catalog = await buildAttachPluginCatalog(ctx)

    assert.ok(catalog.clientDescriptors.has('openclaw'), 'clientDescriptors still resolves openclaw')
    assert.ok(catalog.pickerDescriptors.size > 0, 'pickerDescriptors is non-empty')
    assert.ok(catalog.pickerDescriptors.has('claude'), 'pickerDescriptors includes the claude picker row')
    assert.ok(catalog.pluginMetadata.size > 0, 'pluginMetadata is non-empty')
    assert.ok(catalog.pluginMetadata.has('@hypaware/claude'), 'pluginMetadata includes @hypaware/claude')
    assert.ok(catalog.pluginMetadata.has('@hypaware/ai-gateway'), 'pluginMetadata includes @hypaware/ai-gateway')

    // buildClientDescriptorMap is now a thin projection of the same catalog
    // build: same keys, same descriptor identity for the shared client.
    const descriptorMap = await buildClientDescriptorMap(ctx)
    assert.deepEqual([...descriptorMap.keys()].sort(), [...catalog.clientDescriptors.keys()].sort())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
