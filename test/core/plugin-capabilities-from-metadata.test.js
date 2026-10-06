// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { validateManifest } from '../../src/core/manifest.js'
import { buildPluginCatalog } from '../../src/core/plugin_catalog.js'
import { capabilitiesFromMetadata } from '../../src/core/commands/plugin.js'

/**
 * @import { LoadedManifest } from '../../src/core/types.js'
 */

/**
 * A loaded manifest declaring exactly `capabilities` under `provides`,
 * routed through the real validator so a fixture cannot declare a shape
 * the kernel would have rejected on the way in.
 *
 * @param {string} name
 * @param {Record<string, string>} capabilities
 * @returns {LoadedManifest}
 */
function loaded(name, capabilities) {
  const check = validateManifest({
    schema_version: 1,
    name,
    version: '1.0.0',
    hypaware_api: '^1.0.0',
    runtime: 'node',
    entrypoint: './src/index.js',
    provides: { capabilities },
  })
  if (!check.ok) throw new Error(`fixture manifest ${name} did not validate: ${check.message}`)
  return { ok: true, manifest: check.manifest, manifestPath: `/${name}/hypaware.plugin.json`, rootDir: `/${name}` }
}

test('a manifest declaring an empty capability name or version loads', () => {
  // Not a request to change that: `isStringMap` checks values and never keys,
  // so both shapes reach the catalog verbatim. This is why the seeding filter
  // has to hold, and it pins the premise the rest of this file rests on.
  for (const capabilities of [{ '': '1.0.0' }, { 'cap.real': '' }]) {
    const check = validateManifest({
      schema_version: 1,
      name: '@test/neighbour',
      version: '1.0.0',
      hypaware_api: '^1.0.0',
      runtime: 'node',
      entrypoint: './src/index.js',
      provides: { capabilities },
    })
    assert.equal(check.ok, true, JSON.stringify(capabilities))
  }
})

test('capabilitiesFromMetadata drops empty capability names and empty versions', () => {
  const catalog = buildPluginCatalog([
    loaded('@test/healthy', { 'cap.good': '1.2.3' }),
    loaded('@test/empty-name', { '': '1.0.0' }),
    loaded('@test/empty-version', { 'cap.real': '' }),
  ])

  const caps = capabilitiesFromMetadata(catalog.pluginMetadata)

  assert.deepEqual([...caps.keys()], ['cap.good'])
  assert.deepEqual(caps.get('cap.good'), ['1.2.3'])
  assert.equal(caps.has(''), false)
  assert.equal(caps.has('cap.real'), false)
})

test('a neighbour keeps its well-formed capabilities when one entry is malformed', () => {
  const catalog = buildPluginCatalog([
    loaded('@test/mixed', { 'cap.kept': '2.0.0', '': '9.9.9', 'cap.dropped': '', 'cap.also-kept': '3.1.0' }),
    loaded('@test/second-provider', { 'cap.kept': '2.5.0' }),
  ])

  const caps = capabilitiesFromMetadata(catalog.pluginMetadata)

  // Every survivor, not just the first: a filter that stopped at one entry
  // leaves 'cap.also-kept' unresolvable and hides the second provider's version.
  assert.deepEqual([...caps.keys()], ['cap.kept', 'cap.also-kept'])
  assert.deepEqual(caps.get('cap.kept'), ['2.0.0', '2.5.0'])
  assert.deepEqual(caps.get('cap.also-kept'), ['3.1.0'])
})
