// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadManifests } from '../../src/core/manifest.js'
import {
  V1_BUNDLED_PLUGIN_ALLOWLIST,
  V1_EXCLUDED_FROM_DEFAULT,
} from '../../src/core/runtime/bundled.js'

/**
 * Manifest and bundling tests for `@hypaware/mastracode`.
 *
 * @ref LLP 0586#manifest [tests]: the goose manifest field for field, with a
 *   picker row and no `client` or `skills` contribution.
 */

const WORKSPACE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../hypaware-core/plugins-workspace'
)

async function loadMastracode() {
  const { loaded, failed } = await loadManifests([path.join(WORKSPACE, 'mastracode')])
  assert.equal(failed.length, 0, failed.map((f) => f.message).join('; '))
  assert.equal(loaded.length, 1)
  return loaded[0].manifest
}

test('mastracode manifest loads and validates', async () => {
  const manifest = await loadMastracode()
  assert.equal(manifest.name, '@hypaware/mastracode')
  assert.equal(manifest.schema_version, 1)
  assert.equal(manifest.hypaware_api, '^1.0.0')
  assert.equal(manifest.runtime, 'node')
  assert.equal(manifest.node_engine, '>=22.12')
  assert.equal(manifest.entrypoint, './src/index.js')
  assert.deepEqual(manifest.permissions, ['read_home', 'read_state', 'write_state'])
  assert.equal(manifest.requires?.plugins?.['@hypaware/ai-gateway'], '^2.0.0')
})

test('mastracode contributes a picker row, a config section and a source, and no client or skills', async () => {
  const manifest = await loadMastracode()
  const sections = (manifest.contributes?.config_sections ?? []).map((s) => /** @type {{ section: string }} */ (s).section)
  assert.deepEqual(sections, ['mastracode'])
  const sources = (manifest.contributes?.sources ?? []).map((s) => /** @type {{ name: string }} */ (s).name)
  assert.deepEqual(sources, ['mastracode'])
  const contributes = /** @type {Record<string, unknown>} */ (manifest.contributes ?? {})
  assert.equal(contributes.datasets, undefined)
  assert.equal(contributes.client, undefined)
  assert.equal(contributes.skills, undefined)
  // No `platforms` gate: Windows is still offered (LLP 0586#detect-platforms).
  assert.deepEqual(manifest.contributes?.picker, [{
    name: 'mastracode',
    label: 'Mastra Code',
    summary: 'Records your Mastra Code conversations and imports recent history. Makes no changes to Mastra Code.',
    detect: { settings_file: '.local/share/mastracode/mastra.db' },
    compose: { plugin: { name: '@hypaware/mastracode' }, requires_gateway: true },
  }])
})

test('mastracode is bundled and default-activated beside goose and crush', () => {
  assert.ok(V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/mastracode'))
  assert.ok(V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/goose'))
  assert.ok(V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/crush'))
  assert.ok(!V1_EXCLUDED_FROM_DEFAULT.has('@hypaware/mastracode'))
})
