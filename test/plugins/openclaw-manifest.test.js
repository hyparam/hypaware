// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadManifests } from '../../src/core/manifest.js'

/**
 * Manifest-shape tests for `@hypaware/openclaw` (LLP 0173 T5): the
 * restored `json_path` `attach_probe` block (design 1.4) parses to the
 * exact fields Lane A's detach/read sides (T2, T3) and `attach()` (T4)
 * already agree on, and the steering-plugin package this change set
 * retires (LLP 0167#deletion-inventory) is named nowhere in the
 * onboarding copy any more.
 *
 * @ref LLP 0172#lane-a-attach [tests]: attach_probe's exact field shape, the one this format needs closed by construction (#212)
 */

const WORKSPACE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../hypaware-core/plugins-workspace'
)

const STEERING_PLUGIN_RE = /openclaw-steering-plugin/

test('openclaw manifest loads and validates', async () => {
  const { loaded, failed } = await loadManifests([path.join(WORKSPACE, 'openclaw')])
  assert.equal(failed.length, 0, failed.map((f) => f.message).join('; '))
  assert.equal(loaded.length, 1)

  const manifest = loaded[0].manifest
  assert.equal(manifest.name, '@hypaware/openclaw')
})

test('openclaw contributes.client.attach_probe parses to the exact json_path shape', async () => {
  const { loaded } = await loadManifests([path.join(WORKSPACE, 'openclaw')])
  const manifest = /** @type {any} */ (loaded[0].manifest)
  const probe = manifest.contributes?.client?.attach_probe

  assert.deepEqual(probe, {
    format: 'json_path',
    settings_file: '.openclaw/openclaw.json',
    container_path: 'models.providers',
    provider_keys: ['anthropic', 'openai'],
    marker_header: 'x-hypaware-upstream',
    cache_glob: 'agents/*/agent/models.json',
  })
})

test('openclaw description and picker summary no longer reference the steering plugin', async () => {
  const { loaded } = await loadManifests([path.join(WORKSPACE, 'openclaw')])
  const manifest = /** @type {any} */ (loaded[0].manifest)

  assert.doesNotMatch(manifest.description, STEERING_PLUGIN_RE)

  const picker = manifest.contributes?.picker ?? []
  assert.ok(picker.length > 0)
  for (const row of picker) {
    assert.doesNotMatch(row.summary ?? '', STEERING_PLUGIN_RE)
  }
})

test('openclaw description and picker summary state the two capture tiers directly', async () => {
  const { loaded } = await loadManifests([path.join(WORKSPACE, 'openclaw')])
  const manifest = /** @type {any} */ (loaded[0].manifest)

  assert.match(manifest.description, /live/i)
  assert.match(manifest.description, /sweep|transcript/i)

  const summary = manifest.contributes?.picker?.[0]?.summary ?? ''
  assert.match(summary, /live/i)
  assert.match(summary, /session history/i)
})

test('claude manifest onboarding copy names the claude-cli OpenClaw case', async () => {
  const { loaded } = await loadManifests([path.join(WORKSPACE, 'claude')])
  const manifest = /** @type {any} */ (loaded[0].manifest)

  const summary = manifest.contributes?.picker?.[0]?.summary ?? ''
  assert.match(summary, /claude-cli/)
  assert.match(summary, /OpenClaw/)
})
