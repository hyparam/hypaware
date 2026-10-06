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

// @ref LLP 0399#seams [tests]: discoverable for explicit config, never a default client/source/picker
test('Ollama is bundled for explicit activation with only a gateway capability requirement', async () => {
  const catalog = await discoverBundledPlugins()
  assert.equal(catalog.failed.length, 0)
  assert.ok(!catalog.loaded.some(entry => entry.manifest.name === '@hypaware/ollama'))
  const entry = catalog.excluded.find(entry => entry.manifest.name === '@hypaware/ollama')
  assert.ok(entry, 'explicit Ollama plugin missing from bundled discovery')
  assert.deepEqual(entry.manifest.requires, { capabilities: { 'hypaware.ai-gateway': '^2.0.0' } })
  assert.deepEqual(entry.manifest.contributes ?? {}, {})
})

test('explicit config activates Ollama after gateway; omitting the capability fails clearly', async () => {
  const hypHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ollama-activation-'))
  const configPath = path.join(hypHome, 'hypaware-config.json')
  await fs.writeFile(configPath, JSON.stringify({ version: 2, auto_update: false, plugins: [{ name: '@hypaware/ai-gateway' }, { name: '@hypaware/ollama' }] }))
  const boot = await bootKernel({ hypHome, configPath, env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath } })
  assert.deepEqual(boot.activations.map(result => [result.plugin.name, result.ok]), [['@hypaware/ai-gateway', true], ['@hypaware/ollama', true]])
  assert.deepEqual(boot.unsatisfiedRequirements, [])
  assert.equal(boot.runtime.clients.listClients().length, 0)
  assert.deepEqual(boot.runtime.sources.list().map(source => source.name), ['ai-gateway'])
  await fs.writeFile(configPath, JSON.stringify({ version: 2, plugins: [{ name: '@hypaware/ollama' }] }))
  const missing = await bootKernel({ hypHome, configPath, env: { ...process.env, HYP_HOME: hypHome, HYP_CONFIG: configPath } })
  assert.ok(missing.unsatisfiedRequirements.some(requirement => requirement.plugin === '@hypaware/ollama' && requirement.detail?.includes('hypaware.ai-gateway')))
})

test('activation contributes only one distinct preset/projector; named upstream override follows existing config ownership', () => {
  const state = createGatewayState()
  const gateway = createAiGatewayApi(state)
  activate(/** @type {any} */ ({ requireCapability: (name, version) => {
    assert.equal(name, 'hypaware.ai-gateway')
    assert.equal(version, '^2.0.0')
    return gateway
  } }))
  assert.deepEqual([...state.presets.keys()], ['ollama'])
  assert.equal(state.projectors.length, 1)
  assert.equal(state.clients.size, 0)
  const presetOnly = mergeUpstreams([], state)
  assert.equal(presetOnly[0].match?.({ method: 'GET', path: '/api/chat', headers: {} }), false)
  const config = compileConfig({ upstreams: [{ name: 'ollama', base_url: 'http://127.0.0.1:21500', path_prefix: '/api/chat' }] })
  const overridden = mergeUpstreams(config.upstreams, state)
  assert.equal(overridden.length, 1)
  assert.equal(overridden[0].base_url, 'http://127.0.0.1:21500')
  assert.equal(overridden[0].provider, 'ollama')
})
