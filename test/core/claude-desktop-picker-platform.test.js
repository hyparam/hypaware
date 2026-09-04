// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { visiblePickerDescriptors } from '../../src/core/cli/walkthrough.js'
import { validateManifest } from '../../src/core/manifest.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { discoverBundledPlugins } from '../../src/core/runtime/bundled.js'

async function realCatalog() {
  const bundled = await discoverBundledPlugins()
  return buildPluginCatalog([...bundled.loaded, ...bundled.excluded])
}

/**
 * @param {unknown} platforms
 * @returns {object}
 */
function manifestWithPickerPlatforms(platforms) {
  return {
    schema_version: 1,
    name: '@acme/gated',
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './src/index.js',
    contributes: {
      picker: [{ name: 'gated', label: 'Gated', ...(platforms === undefined ? {} : { platforms }) }],
    },
  }
}

test('the Claude Desktop picker row declares the macOS-only platform gate its session roots require', async () => {
  const catalog = await realCatalog()
  const row = catalog.pickerDescriptors.get('claude-desktop')
  assert.equal(row?.label, 'Claude Desktop')
  assert.deepEqual(row?.platforms, ['darwin'])
})

// Desktop's transcripts are imported by the `@hypaware/claude` provider, so
// its own client block says it registers no provider, and only the explicit
// opt-out reaches the descriptor: every other client leaves the field absent.
// @ref LLP 0379#manifest-declares-no-provider [tests]: the opt-out rides the client block into the descriptor; absent stays absent
test('the Claude Desktop client block declares it registers no backfill provider', async () => {
  const catalog = await realCatalog()
  assert.equal(catalog.clientDescriptors.get('claude-desktop')?.backfillProvider, false)
  for (const name of ['claude', 'codex', 'opencode', 'openclaw']) {
    assert.equal(catalog.clientDescriptors.get(name)?.backfillProvider, undefined, name)
  }
})

// @ref LLP 0368#display-only [tests]: the gate filters the menu only, so every
// ungated row still renders where a gated one does not.
test('the picker offers Claude Desktop on macOS and withholds it on Linux', async () => {
  const catalog = await realCatalog()
  const descriptors = [...catalog.pickerDescriptors.values()]

  const onDarwin = visiblePickerDescriptors(descriptors, 'darwin').map((d) => d.id)
  assert.equal(onDarwin.includes('claude-desktop'), true)

  const onLinux = visiblePickerDescriptors(descriptors, 'linux').map((d) => d.id)
  assert.equal(onLinux.includes('claude-desktop'), false)

  // The gate is display-only: every ungated row still renders on Linux.
  const ungated = descriptors.filter((d) => d.hidden !== true && d.platforms === undefined).map((d) => d.id)
  assert.deepEqual(onLinux, ungated)
  assert.equal(onLinux.includes('claude'), true)
})

test('a picker row with no platforms gate renders on every platform', () => {
  const rows = [{ plugin: '@acme/gated', id: 'gated', label: 'Gated' }]
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.deepEqual(visiblePickerDescriptors(rows, platform).map((d) => d.id), ['gated'])
  }
})

test('manifest validation accepts a platforms gate and rejects a malformed one', () => {
  assert.equal(validateManifest(manifestWithPickerPlatforms(['darwin', 'linux'])).ok, true)
  assert.equal(validateManifest(manifestWithPickerPlatforms(undefined)).ok, true)

  for (const bad of ['darwin', [], [''], [1]]) {
    const result = validateManifest(manifestWithPickerPlatforms(bad))
    assert.equal(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`)
  }
})
