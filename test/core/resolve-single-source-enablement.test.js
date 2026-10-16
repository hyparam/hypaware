// @ts-check

/**
 * @import { PickerDescriptor } from '../../src/core/types.js'
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveSingleSourceEnablement } from '../../src/core/cli/walkthrough.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'

// Reads the real bundled manifests via buildPluginCatalog (not a hand-rolled
// fixture) so a manifest edit that changes a client adapter's dependency set
// fails this test instead of drifting silently (LLP 0178 T6).

/** @returns {Promise<Map<string, PickerDescriptor>>} */
async function realPickerDescriptors() {
  const bundled = await discoverBundledPlugins()
  const catalog = buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
  return catalog.pickerDescriptors
}

test('resolveSingleSourceEnablement resolves the claude descriptor to ai-gateway + claude', async () => {
  const descriptors = await realPickerDescriptors()
  const descriptor = descriptors.get('claude')
  assert.ok(descriptor, 'claude picker descriptor exists')
  assert.deepEqual(resolveSingleSourceEnablement(/** @type {PickerDescriptor} */ (descriptor)), {
    requiresGateway: true,
    pluginNames: ['@hypaware/ai-gateway', '@hypaware/claude'],
    entries: [
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/claude' },
    ],
  })
})

test('resolveSingleSourceEnablement resolves the openclaw descriptor to ai-gateway + openclaw', async () => {
  const descriptors = await realPickerDescriptors()
  const descriptor = descriptors.get('openclaw')
  assert.ok(descriptor, 'openclaw picker descriptor exists')
  assert.deepEqual(resolveSingleSourceEnablement(/** @type {PickerDescriptor} */ (descriptor)), {
    requiresGateway: true,
    pluginNames: ['@hypaware/ai-gateway', '@hypaware/openclaw'],
    entries: [
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/openclaw' },
    ],
  })
})

// otel has no compose.requires_gateway and no compose.plugins array, only a
// bare `plugin`, so this pins the shape when a descriptor's own adapter is
// gateway-independent (a case the claude/openclaw fixtures above do not
// cover).
test('resolveSingleSourceEnablement resolves a gateway-independent descriptor with just its own plugin', async () => {
  const descriptors = await realPickerDescriptors()
  const descriptor = descriptors.get('otel')
  assert.ok(descriptor, 'otel picker descriptor exists')
  const result = resolveSingleSourceEnablement(/** @type {PickerDescriptor} */ (descriptor))
  assert.equal(result.requiresGateway, false)
  assert.deepEqual(result.pluginNames, ['@hypaware/otel'])
})

test('resolveSingleSourceEnablement returns empty entries for a descriptor with no compose block', () => {
  /** @type {PickerDescriptor} */
  const descriptor = { plugin: '@hypaware/example', id: 'example', label: 'example' }
  assert.deepEqual(resolveSingleSourceEnablement(descriptor), {
    requiresGateway: false,
    pluginNames: [],
    entries: [],
  })
})
