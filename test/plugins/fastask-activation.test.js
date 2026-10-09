// @ts-check

// @hypaware/graph-cache after enablement (LLP 0481 T14, LLP 0480#enablement):
// bundled in the default set and enabled for connected clients by migration
// (LLP 0490), preserving explicit entries during setup; its entry
// registers the source and the commands, the deferred planner stays
// unregistered (LLP 0488), and the query evidence verb stays off the MCP
// surface.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { V1_EXCLUDED_FROM_DEFAULT, discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { bootKernel } from '../../src/core/runtime/boot.js'
import { composePickerConfig } from '../../src/core/cli/walkthrough.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'

// @ref LLP 0480#enablement [tests]: the enabling task ships the plugin in default activation with its source and commands
test('fastask is bundled, in default activation, and declares its source and commands', async () => {
  const catalog = await discoverBundledPlugins()
  assert.equal(catalog.failed.length, 0)
  assert.ok(!V1_EXCLUDED_FROM_DEFAULT.has('@hypaware/graph-cache'))
  assert.ok(!catalog.excluded.some((e) => e.manifest.name === '@hypaware/graph-cache'))
  const entry = catalog.loaded.find((e) => e.manifest.name === '@hypaware/graph-cache')
  assert.ok(entry)
  assert.deepEqual(entry.manifest.contributes?.sources, [{ name: 'team-graph-replica' }])
  assert.deepEqual(entry.manifest.contributes?.commands?.map((c) => c.name), ['graph replica status', 'graph replica refresh', 'query evidence', 'query team-graph discover', 'query team-graph neighbors', 'query team-graph search'])
})

test('local-only setup does not compose graph-cache or override a prior disable', async () => {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  /** @param {any[]} sources */
  const compose = (sources) => (composePickerConfig({
    sources, descriptors: catalog.pickerDescriptors, exportChoice: 'local-parquet', retentionDays: 30, hypHome: '/home/tester/.hyp', composeWith: catalog.composeWith ?? new Map(),
  }).plugins ?? []).map((p) => p.name)
  assert.ok(!compose(['claude']).includes('@hypaware/graph-cache'))
  assert.ok(!compose(['codex']).includes('@hypaware/graph-cache'))
  assert.equal(catalog.composeWith?.has('@hypaware/graph-cache'), false)
  const disabled = composePickerConfig({
    sources: ['claude'], descriptors: catalog.pickerDescriptors, exportChoice: 'local-parquet', retentionDays: 30, hypHome: '/home/tester/.hyp', composeWith: catalog.composeWith,
    existing: { version: 2, plugins: [{ name: '@hypaware/graph-cache', enabled: false }] },
  })
  assert.deepEqual(disabled.plugins?.find(p => p.name === '@hypaware/graph-cache'), { name: '@hypaware/graph-cache', enabled: false })
  assert.ok(!compose(['otel']).includes('@hypaware/graph-cache'), 'not without the gateway')
})

test('its config entry registers the source and the commands, without the planner', async (t) => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-fastask-activation-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const configPath = path.join(hypHome, 'hypaware-config.json')
  const env = { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath }

  await fs.writeFile(configPath, JSON.stringify({ version: 2, auto_update: false, plugins: [{ name: '@hypaware/graph-cache' }] }))
  const explicit = await bootKernel({ hypHome, configPath, env })
  const activation = explicit.activations.find((a) => a.plugin.name === '@hypaware/graph-cache')
  assert.equal(activation?.ok, true)
  assert.deepEqual(explicit.runtime.sources.list().map((s) => s.name), ['team-graph-replica'])
  const commands = explicit.runtime.commands.list().filter((c) => c.plugin === '@hypaware/graph-cache').map((c) => c.name).sort()
  // The planner is deferred (LLP 0488#planner-deferred): not registered.
  assert.deepEqual(commands, ['graph replica refresh', 'graph replica status', 'query evidence', 'query team-graph discover', 'query team-graph neighbors', 'query team-graph search'])
  const verb = explicit.runtime.verbs.list().find((v) => v.name === 'query evidence')
  assert.equal(verb?.tool, 'session_evidence')
  assert.equal(verb?.exposure, 'cli-only', 'never an MCP tool of this client')
})
