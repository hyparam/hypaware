// @ts-check
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { composePickerConfig } from '../../src/core/cli/walkthrough.js'
import { INIT_SOURCE_CHOICES, INIT_CLIENT_CHOICES } from '../../src/core/commands/init.js'
import { validateCursorConfig } from '../../hypaware-core/plugins-workspace/cursor/src/config.js'

test('Cursor is bundled, selectable, and composes without a provider gateway', async () => {
  const bundled = await discoverBundledPlugins()
  assert.ok(bundled.loaded.some((p) => p.manifest.name === '@hypaware/cursor'))
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  assert.ok(INIT_SOURCE_CHOICES.includes('cursor'))
  assert.ok(INIT_CLIENT_CHOICES.includes('cursor'))
  const config = composePickerConfig({ sources: ['cursor'], descriptors: catalog.pickerDescriptors, exportChoice: 'keep-local', retentionDays: 30, hypHome: '/tmp/test-hyp' })
  assert.deepEqual(config.plugins, [{ name: '@hypaware/cursor' }])
  assert.match(catalog.pickerDescriptors.get('cursor')?.summary ?? '', /editor and CLI/)
})

test('Cursor accepts existing attach/port controls and accepts bounded history configuration', () => {
  assert.equal(validateCursorConfig({ listen_port: 4321 }).ok, true)
  assert.equal(validateCursorConfig({ backfill: { on_join: false, window_days: 7, sweep_cron: '*/5 * * * *' } }).ok, true)
  for (const value of [{ listen_port: 0 }, { listen_port: 65536 }, { backfill: { window_days: -1 } }, { usage: true }]) assert.equal(validateCursorConfig(value).ok, false)
})
