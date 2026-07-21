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
 * Manifest and bundling tests for `@hypaware/hermes` (T5).
 *
 * @ref LLP 0121 [tests]: bundled beside claude/codex, `requires.plugins`
 *   names `@hypaware/ai-gateway` as a hard dependency, no `datasets`
 *   contribution (rows land in `ai_gateway_messages` via the shared
 *   materializer).
 */

const WORKSPACE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../hypaware-core/plugins-workspace'
)

test('hermes manifest loads and validates', async () => {
  const { loaded, failed } = await loadManifests([path.join(WORKSPACE, 'hermes')])
  assert.equal(failed.length, 0, failed.map((f) => f.message).join('; '))
  assert.equal(loaded.length, 1)

  const manifest = loaded[0].manifest
  assert.equal(manifest.name, '@hypaware/hermes')
  assert.equal(manifest.runtime, 'node')
  assert.equal(manifest.entrypoint, './src/index.js')
})

test('hermes requires @hypaware/ai-gateway as a hard plugin dependency', async () => {
  const { loaded } = await loadManifests([path.join(WORKSPACE, 'hermes')])
  const manifest = loaded[0].manifest
  assert.ok(manifest.requires?.plugins)
  assert.ok(Object.keys(manifest.requires?.plugins ?? {}).includes('@hypaware/ai-gateway'))
})

test('hermes contributes a config section and a source, no dataset of its own', async () => {
  const { loaded } = await loadManifests([path.join(WORKSPACE, 'hermes')])
  const manifest = loaded[0].manifest
  const sections = (manifest.contributes?.config_sections ?? []).map((s) => /** @type {{ section: string }} */ (s).section)
  assert.deepEqual(sections, ['hermes'])

  const sources = (manifest.contributes?.sources ?? []).map((s) => /** @type {{ name: string }} */ (s).name)
  assert.deepEqual(sources, ['hermes'])

  assert.equal(manifest.contributes?.datasets, undefined)
})

test('hermes node_engine requires the node:sqlite floor (LLP 0125)', async () => {
  const { loaded } = await loadManifests([path.join(WORKSPACE, 'hermes')])
  assert.equal(loaded[0].manifest.node_engine, '>=22.12')
})

test('hermes is bundled and default-activated beside claude and codex', () => {
  assert.ok(V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/hermes'))
  assert.ok(V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/claude'))
  assert.ok(V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/codex'))
  assert.ok(!V1_EXCLUDED_FROM_DEFAULT.has('@hypaware/hermes'))
})
