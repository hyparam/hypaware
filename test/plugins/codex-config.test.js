// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CODEX_CONFIG_SECTION,
  validateAttachSection,
  validateBackfillSection,
  validateCodexConfig,
} from '../../hypaware-core/plugins-workspace/codex/src/config.js'
import { createConfigRegistry } from '../../src/core/config/schema.js'

test('validateCodexConfig accepts an empty / absent config', () => {
  assert.deepEqual(validateCodexConfig(undefined), { ok: true })
  assert.deepEqual(validateCodexConfig(null), { ok: true })
  assert.deepEqual(validateCodexConfig({}), { ok: true })
})

test('validateCodexConfig accepts a full backfill block', () => {
  assert.deepEqual(
    validateCodexConfig({ backfill: { on_join: true, window_days: 30 } }),
    { ok: true }
  )
  assert.deepEqual(validateCodexConfig({ backfill: { on_join: false } }), { ok: true })
  assert.deepEqual(validateCodexConfig({ backfill: {} }), { ok: true })
})

test('validateCodexConfig rejects a non-object config', () => {
  const result = validateCodexConfig(42)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '')
})

test('validateCodexConfig rejects a malformed backfill block', () => {
  /** @type {Array<[unknown, string]>} */
  const cases = [
    [{ backfill: [] }, '/backfill'],
    [{ backfill: { on_join: 'yes' } }, '/backfill/on_join'],
    [{ backfill: { window_days: 0 } }, '/backfill/window_days'],
    [{ backfill: { window_days: -3 } }, '/backfill/window_days'],
    [{ backfill: { window_days: 2.5 } }, '/backfill/window_days'],
    [{ backfill: { bogus: true } }, '/backfill/bogus'],
  ]
  for (const [config, pointer] of cases) {
    const result = validateCodexConfig(config)
    assert.equal(result.ok, false, `${JSON.stringify(config)} must fail`)
    if (result.ok) continue
    assert.equal(result.errors[0].pointer, pointer, `${JSON.stringify(config)} pointer`)
  }
})

test('validateBackfillSection mounts pointers under the supplied prefix', () => {
  assert.deepEqual(validateBackfillSection(undefined, '/backfill'), [])
  const errors = validateBackfillSection({ window_days: -1 }, '/plugins/0/config/backfill')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].pointer, '/plugins/0/config/backfill/window_days')
})

test('validateCodexConfig accepts an attach block', () => {
  assert.deepEqual(validateCodexConfig({ attach: { on_join: true } }), { ok: true })
  assert.deepEqual(validateCodexConfig({ attach: { on_join: false } }), { ok: true })
  assert.deepEqual(validateCodexConfig({ attach: {} }), { ok: true })
  assert.deepEqual(
    validateCodexConfig({ backfill: { on_join: true }, attach: { on_join: false } }),
    { ok: true }
  )
})

test('validateCodexConfig rejects a malformed attach block', () => {
  /** @type {Array<[unknown, string]>} */
  const cases = [
    [{ attach: [] }, '/attach'],
    [{ attach: 42 }, '/attach'],
    [{ attach: null }, '/attach'],
    [{ attach: { on_join: 'yes' } }, '/attach/on_join'],
    [{ attach: { on_join: 0 } }, '/attach/on_join'],
    [{ attach: { window_days: 7 } }, '/attach/window_days'],
    [{ attach: { on_joins: true } }, '/attach/on_joins'],
  ]
  for (const [config, pointer] of cases) {
    const result = validateCodexConfig(config)
    assert.equal(result.ok, false, `${JSON.stringify(config)} must fail`)
    if (result.ok) continue
    assert.equal(result.errors[0].pointer, pointer, `${JSON.stringify(config)} pointer`)
  }
})

test('validateAttachSection mounts pointers under the supplied prefix', () => {
  assert.deepEqual(validateAttachSection(undefined, '/attach'), [])
  const errors = validateAttachSection({ on_join: 'no' }, '/plugins/0/config/attach')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].pointer, '/plugins/0/config/attach/on_join')
})

test('the registered codex section drives validatePluginConfig', () => {
  const registry = createConfigRegistry()
  registry.registerSection({
    plugin: '@hypaware/codex',
    section: CODEX_CONFIG_SECTION,
    validate: validateCodexConfig,
  })
  assert.deepEqual(
    registry.validatePluginConfig('@hypaware/codex', { backfill: { window_days: 7 } }),
    { ok: true }
  )
  const bad = registry.validatePluginConfig('@hypaware/codex', { backfill: { window_days: 0 } })
  assert.equal(bad.ok, false)
})
