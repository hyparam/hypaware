// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { detectPickerSources } from '../../src/core/cli/detect.js'
import { composePickerConfig } from '../../src/core/cli/walkthrough.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'

async function realCatalog() {
  const bundled = await discoverBundledPlugins()
  return buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
}

async function stageHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-opencode-picker-'))
}

test('real OpenCode picker row has the shared config-home probe and endpoint-free adapter composition', async () => {
  const catalog = await realCatalog()
  const row = catalog.pickerDescriptors.get('opencode')
  assert.equal(row?.label, 'OpenCode')
  assert.equal(row?.summary, 'Records OpenCode conversations from CLI and Desktop using a local plugin, with bounded history recovery.')
  assert.deepEqual(row?.detect, { settings_file: '.config/opencode/opencode.json' })
  assert.deepEqual(row?.compose, { plugin: { name: '@hypaware/opencode' } })

  const config = composePickerConfig({
    sources: ['opencode'],
    descriptors: catalog.pickerDescriptors,
    exportChoice: 'keep-local',
    retentionDays: 30,
    hypHome: '/home/tester/.hyp',
  })
  assert.deepEqual(config.plugins, [{ name: '@hypaware/opencode' }])
  assert.equal(config.plugins.some((plugin) => plugin.name === '@hypaware/ai-gateway'), false)
})

for (const scenario of [
  'CLI-used config home',
  'Desktop-used shared config home',
  'CLI and Desktop shared config home',
]) {
  test(`OpenCode picker detects ${scenario}`, async () => {
    const home = await stageHome()
    try {
      await fs.mkdir(path.join(home, '.config', 'opencode'), { recursive: true })
      const detected = await detectPickerSources(await realCatalog(), { HOME: home })
      assert.equal(detected.has('opencode'), true)
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
}

test('fresh never-run OpenCode remains visible but is not pre-checked', async () => {
  const home = await stageHome()
  try {
    const catalog = await realCatalog()
    const detected = await detectPickerSources(catalog, { HOME: home })
    assert.equal(detected.has('opencode'), false)
    assert.ok(catalog.pickerDescriptors.get('opencode'))
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test('OpenCode picker honors XDG_CONFIG_HOME and does not invent OPENCODE_HOME', async () => {
  const home = await stageHome()
  const xdg = path.join(home, 'xdg')
  const invented = path.join(home, 'invented-opencode-home')
  try {
    await fs.mkdir(path.join(xdg, 'opencode'), { recursive: true })
    let detected = await detectPickerSources(await realCatalog(), {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
    })
    assert.equal(detected.has('opencode'), true)

    await fs.rm(xdg, { recursive: true, force: true })
    await fs.mkdir(invented, { recursive: true })
    detected = await detectPickerSources(await realCatalog(), {
      HOME: home,
      OPENCODE_HOME: invented,
    })
    assert.equal(detected.has('opencode'), false)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})
