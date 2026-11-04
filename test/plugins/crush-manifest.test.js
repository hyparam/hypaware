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
 * Manifest and bundling tests for `@hypaware/crush`.
 *
 * @ref LLP 0573#manifest [tests]: the goose manifest field for field, with no
 *   `client`, `skills` or picker contribution until T2.
 */

const WORKSPACE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../hypaware-core/plugins-workspace'
)

async function loadCrush() {
  const { loaded, failed } = await loadManifests([path.join(WORKSPACE, 'crush')])
  assert.equal(failed.length, 0, failed.map((f) => f.message).join('; '))
  assert.equal(loaded.length, 1)
  return loaded[0].manifest
}

test('crush manifest loads and validates', async () => {
  const manifest = await loadCrush()
  assert.equal(manifest.name, '@hypaware/crush')
  assert.equal(manifest.schema_version, 1)
  assert.equal(manifest.hypaware_api, '^1.0.0')
  assert.equal(manifest.runtime, 'node')
  assert.equal(manifest.node_engine, '>=22.12')
  assert.equal(manifest.entrypoint, './src/index.js')
  assert.deepEqual(manifest.permissions, ['read_home', 'read_state', 'write_state'])
  assert.equal(manifest.requires?.plugins?.['@hypaware/ai-gateway'], '^2.0.0')
})

test('crush contributes a config section and a source, and no client, skills or picker', async () => {
  const manifest = await loadCrush()
  const sections = (manifest.contributes?.config_sections ?? []).map((s) => /** @type {{ section: string }} */ (s).section)
  assert.deepEqual(sections, ['crush'])
  const sources = (manifest.contributes?.sources ?? []).map((s) => /** @type {{ name: string }} */ (s).name)
  assert.deepEqual(sources, ['crush'])
  const contributes = /** @type {Record<string, unknown>} */ (manifest.contributes ?? {})
  assert.equal(contributes.datasets, undefined)
  assert.equal(contributes.client, undefined)
  assert.equal(contributes.skills, undefined)
  assert.equal(contributes.picker, undefined)
})

test('crush is bundled and default-activated beside goose', () => {
  assert.ok(V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/crush'))
  assert.ok(V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/goose'))
  assert.ok(!V1_EXCLUDED_FROM_DEFAULT.has('@hypaware/crush'))
})
