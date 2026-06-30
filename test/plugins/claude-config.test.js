// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLAUDE_CONFIG_SECTION,
  validateAttachSection,
  validateBackfillSection,
  validateClaudeConfig,
} from '../../hypaware-core/plugins-workspace/claude/src/config.js'
import { createConfigRegistry } from '../../src/core/config/schema.js'
import { mergeConfigLayers } from '../../src/core/config/merge.js'

test('validateClaudeConfig accepts an empty / absent config', () => {
  assert.deepEqual(validateClaudeConfig(undefined), { ok: true })
  assert.deepEqual(validateClaudeConfig(null), { ok: true })
  assert.deepEqual(validateClaudeConfig({}), { ok: true })
})

test('validateClaudeConfig leaves non-backfill keys (e.g. proxy) untouched', () => {
  assert.deepEqual(validateClaudeConfig({ proxy: '@hypaware/ai-gateway' }), { ok: true })
})

test('validateClaudeConfig accepts a full backfill block', () => {
  assert.deepEqual(
    validateClaudeConfig({ proxy: '@hypaware/ai-gateway', backfill: { on_join: true, window_days: 30 } }),
    { ok: true }
  )
  assert.deepEqual(validateClaudeConfig({ backfill: { on_join: false } }), { ok: true })
  assert.deepEqual(validateClaudeConfig({ backfill: {} }), { ok: true })
})

test('validateClaudeConfig rejects a non-object config', () => {
  const result = validateClaudeConfig('nope')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '')
})

test('validateClaudeConfig rejects a malformed backfill block', () => {
  /** @type {Array<[unknown, string]>} */
  const cases = [
    [{ backfill: [] }, '/backfill'],
    [{ backfill: 7 }, '/backfill'],
    [{ backfill: { on_join: 'yes' } }, '/backfill/on_join'],
    [{ backfill: { window_days: 0 } }, '/backfill/window_days'],
    [{ backfill: { window_days: -1 } }, '/backfill/window_days'],
    [{ backfill: { window_days: 1.5 } }, '/backfill/window_days'],
    [{ backfill: { window_days: '30' } }, '/backfill/window_days'],
    [{ backfill: { bogus: true } }, '/backfill/bogus'],
  ]
  for (const [config, pointer] of cases) {
    const result = validateClaudeConfig(config)
    assert.equal(result.ok, false, `${JSON.stringify(config)} must fail`)
    if (result.ok) continue
    assert.equal(result.errors[0].pointer, pointer, `${JSON.stringify(config)} pointer`)
  }
})

test('validateBackfillSection mounts pointers under the supplied prefix', () => {
  assert.deepEqual(validateBackfillSection(undefined, '/backfill'), [])
  const errors = validateBackfillSection({ on_join: 1 }, '/plugins/0/config/backfill')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].pointer, '/plugins/0/config/backfill/on_join')
})

test('validateClaudeConfig accepts an attach block', () => {
  assert.deepEqual(validateClaudeConfig({ attach: { on_join: true } }), { ok: true })
  assert.deepEqual(validateClaudeConfig({ attach: { on_join: false } }), { ok: true })
  assert.deepEqual(validateClaudeConfig({ attach: {} }), { ok: true })
  assert.deepEqual(
    validateClaudeConfig({ proxy: '@hypaware/ai-gateway', backfill: { on_join: true }, attach: { on_join: false } }),
    { ok: true }
  )
})

test('validateClaudeConfig rejects a malformed attach block', () => {
  /** @type {Array<[unknown, string]>} */
  const cases = [
    [{ attach: [] }, '/attach'],
    [{ attach: 7 }, '/attach'],
    [{ attach: null }, '/attach'],
    [{ attach: { on_join: 'yes' } }, '/attach/on_join'],
    [{ attach: { on_join: 1 } }, '/attach/on_join'],
    [{ attach: { window_days: 30 } }, '/attach/window_days'],
    [{ attach: { on_joins: true } }, '/attach/on_joins'],
  ]
  for (const [config, pointer] of cases) {
    const result = validateClaudeConfig(config)
    assert.equal(result.ok, false, `${JSON.stringify(config)} must fail`)
    if (result.ok) continue
    assert.equal(result.errors[0].pointer, pointer, `${JSON.stringify(config)} pointer`)
  }
})

test('validateAttachSection mounts pointers under the supplied prefix', () => {
  assert.deepEqual(validateAttachSection(undefined, '/attach'), [])
  const errors = validateAttachSection({ on_join: 1 }, '/plugins/0/config/attach')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].pointer, '/plugins/0/config/attach/on_join')
})

test('the registered claude section drives validatePluginConfig', () => {
  const registry = createConfigRegistry()
  registry.registerSection({
    plugin: '@hypaware/claude',
    section: CLAUDE_CONFIG_SECTION,
    validate: validateClaudeConfig,
  })
  assert.deepEqual(
    registry.validatePluginConfig('@hypaware/claude', { backfill: { on_join: true } }),
    { ok: true }
  )
  const bad = registry.validatePluginConfig('@hypaware/claude', { backfill: { on_join: 'nope' } })
  assert.equal(bad.ok, false)
})

test('a central-locked backfill.on_join cannot be flipped by a colliding local entry', () => {
  // LLP 0031 merge model: plugins[] merges by name; a local entry that
  // collides with a central-named plugin is dropped, so the operator's
  // `on_join: false` survives and the user cannot re-enable it locally.
  const central = {
    version: 2,
    plugins: [{ name: '@hypaware/claude', config: { backfill: { on_join: false } } }],
  }
  const local = {
    version: 2,
    plugins: [{ name: '@hypaware/claude', config: { backfill: { on_join: true } } }],
  }
  const merged = mergeConfigLayers(/** @type {any} */ (central), /** @type {any} */ (local))

  assert.equal(merged.effective.plugins?.length, 1)
  assert.deepEqual(
    /** @type {any} */ (merged.effective.plugins?.[0].config).backfill,
    { on_join: false }
  )
  assert.deepEqual(merged.drops, [
    { section: 'plugins', key: '@hypaware/claude', reason: 'collides_with_central' },
  ])
})

test('a central-locked attach.on_join cannot be flipped by a colliding local entry', () => {
  // LLP 0031 merge model + LLP 0044 opt-out (operator-only, no local
  // override): a local entry that collides with a central-named plugin is
  // dropped, so the operator's `attach.on_join: false` survives and the
  // user cannot re-enable auto-attach locally.
  const central = {
    version: 2,
    plugins: [{ name: '@hypaware/claude', config: { attach: { on_join: false } } }],
  }
  const local = {
    version: 2,
    plugins: [{ name: '@hypaware/claude', config: { attach: { on_join: true } } }],
  }
  const merged = mergeConfigLayers(/** @type {any} */ (central), /** @type {any} */ (local))

  assert.equal(merged.effective.plugins?.length, 1)
  assert.deepEqual(
    /** @type {any} */ (merged.effective.plugins?.[0].config).attach,
    { on_join: false }
  )
  assert.deepEqual(merged.drops, [
    { section: 'plugins', key: '@hypaware/claude', reason: 'collides_with_central' },
  ])
})
