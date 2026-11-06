// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { bootKernel } from '../../src/core/runtime/boot.js'
import { createGatewayState, createAiGatewayApi } from '../../hypaware-core/plugins-workspace/ai-gateway/src/api.js'
import { mergeUpstreams } from '../../hypaware-core/plugins-workspace/ai-gateway/src/source.js'
import { compileConfig } from '../../hypaware-core/plugins-workspace/ai-gateway/src/config.js'
import { activate } from '../../hypaware-core/plugins-workspace/ollama/src/index.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { materializeClientAssets, clientAssetBaseDirs } from '../../src/core/runtime/client_assets.js'
import { resolveLaunchers } from '../../src/core/cli/wizard/first_ask.js'
import { runReportGenerate } from '../../src/core/cli/report_commands.js'

// @ref LLP 0474#setup [tests]: visible declarative suggestion, explicit activation and no settings marker
test('Ollama is bundled for explicit activation with only a gateway capability requirement', async () => {
  const catalog = await discoverBundledPlugins()
  assert.equal(catalog.failed.length, 0)
  assert.ok(!catalog.loaded.some(entry => entry.manifest.name === '@hypaware/ollama'))
  const entry = catalog.excluded.find(entry => entry.manifest.name === '@hypaware/ollama')
  assert.ok(entry, 'explicit Ollama plugin missing from bundled discovery')
  assert.deepEqual(entry.manifest.requires, { capabilities: { 'hypaware.ai-gateway': '^2.0.0' } })
  assert.equal(entry.manifest.contributes?.client?.name, 'ollama')
  assert.equal(entry.manifest.contributes?.client?.attach_probe, undefined)
  const picker = entry.manifest.contributes?.picker?.[0]
  assert.equal(picker?.name, 'ollama')
  assert.deepEqual(picker?.detect, { settings_file: '.ollama/history' })
  assert.equal(picker?.configure_command, 'ollama setup')
})

test('explicit config activates Ollama after gateway; omitting the capability fails clearly', async (t) => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ollama-activation-'))
  t.after(() => fs.rm(hypHome, { recursive: true, force: true }))
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({ version: 2, auto_update: false, plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/ollama' }] }))
  const boot = await bootKernel({ hypHome, configPath, env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath } })
  assert.deepEqual(boot.activations
    .filter(result => ['@hypaware/ai-gateway', '@hypaware/ollama'].includes(result.plugin.name))
    .map(result => [result.plugin.name, result.ok]), [['@hypaware/ai-gateway', true], ['@hypaware/ollama', true]])
  assert.deepEqual(boot.unsatisfiedRequirements, [])
  assert.deepEqual(boot.runtime.clients.listClients().map(c => c.name), ['ollama'])
  assert.deepEqual(boot.runtime.sources.list().map(source => source.name), ['ai-gateway'])
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/ollama' }] }))
  const missing = await bootKernel({ hypHome, configPath, env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath } })
  assert.ok(missing.unsatisfiedRequirements.some(requirement => requirement.plugin === '@hypaware/ollama' && requirement.detail?.includes('hypaware.ai-gateway')))
})

test('activation contributes one preset/projector/client/alias; named upstream override follows existing config ownership', () => {
  const state = createGatewayState()
  const gateway = createAiGatewayApi(state)
  activate(/** @type {any} */ ({ commands: { register() {}, registerGroup() {} }, requireCapability: (name, version) => {
    assert.equal(name, 'hypaware.ai-gateway')
    assert.equal(version, '^2.0.0')
    return gateway
  } }))
  assert.deepEqual([...state.presets.keys()], ['ollama'])
  assert.equal(state.projectors.length, 1)
  assert.equal(state.clients.size, 1)
  assert.deepEqual([...state.aliases.keys()], ['ollama-native'])
  const presetOnly = mergeUpstreams([], state)
  assert.equal(presetOnly[0].match?.({ method: 'GET', path: '/api/chat', headers: {} }), false)
  const config = compileConfig({ upstreams: [{ name: 'ollama', base_url: 'http://127.0.0.1:21500', path_prefix: '/api/chat' }] })
  const overridden = mergeUpstreams(config.upstreams, state)
  assert.equal(overridden.length, 2)
  assert.equal(overridden[0].base_url, 'http://127.0.0.1:21500')
  assert.equal(overridden[0].provider, 'ollama')
})

// @ref LLP 0474#setup [tests]: an empty existing asset directory declares no writable client home and no launcher
test('real Ollama manifest/catalog is asset-free across all-client materialization and ask/report selection', async t => {
  const bundled = await discoverBundledPlugins()
  const descriptors = buildPluginCatalog([...bundled.loaded, ...bundled.excluded]).clientDescriptors
  const ollama = descriptors.get('ollama')
  assert.ok(ollama)
  assert.equal(ollama.skillDir, '')
  assert.equal(ollama.agentDir, undefined)
  assert.equal(ollama.attachProbe, undefined)
  assert.equal(ollama.launch, undefined)
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ollama-assets-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ollama-skill-'))
  t.after(() => fs.rm(source, { recursive: true, force: true }))
  await fs.writeFile(path.join(source, 'SKILL.md'), 'test-owned fixture')
  const options = /** @type {any} */ ({ homeDir: home, clients: 'all', descriptors,
    skills: { list: () => [{ name: 'test-owned-skill', plugin: '@hypaware/ollama', clients: ['all'], sourceDir: source }] },
    agents: { list: () => [] },
  })
  const result = await materializeClientAssets(options)
  assert.ok(result.installed.some(x => x.client === 'claude'))
  assert.ok(result.installed.every(x => x.client !== 'ollama' && x.dest !== path.join(home, 'test-owned-skill')))
  assert.deepEqual(clientAssetBaseDirs(ollama, home), [])
  assert.equal(await fs.stat(path.join(home, 'test-owned-skill')).then(() => true, () => false), false)
  assert.equal(await fs.stat(path.join(home, '.ollama')).then(() => true, () => false), false)
  const resolutions = []
  const launchers = await resolveLaunchers({ clients: ['ollama', 'claude'], descriptors, env: { HOME: home }, resolve: async bin => { resolutions.push(bin); return `/test-owned/${bin}` } })
  assert.deepEqual(launchers.map(x => x.client), ['claude'])
  assert.deepEqual(resolutions, ['claude'])
  let error = ''
  const ctx = /** @type {any} */ ({ env: { HOME: home, HYP_HOME: home }, cwd: home, stdout: { write() {} }, stderr: { write(s) { error += s } } })
  const code = await runReportGenerate([], ctx, /** @type {any} */ ({
    collectStatus: async () => ({ clients: [{ name: 'ollama', configured: true, recording: true, attachable: false }] }),
  }))
  assert.equal(code, 1)
  assert.match(error, /no recorded client.*skill can be started/)
})
