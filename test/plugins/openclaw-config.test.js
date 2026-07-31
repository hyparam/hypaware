// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OPENCLAW_CONFIG_SECTION,
  validateAttachSection,
  validateBackfillSection,
  validateOpenclawConfig,
} from '../../hypaware-core/plugins-workspace/openclaw/src/config.js'

test('validateOpenclawConfig accepts an empty / absent config', () => {
  assert.deepEqual(validateOpenclawConfig(undefined), { ok: true })
  assert.deepEqual(validateOpenclawConfig(null), { ok: true })
  assert.deepEqual(validateOpenclawConfig({}), { ok: true })
})

test('validateOpenclawConfig leaves non-attach keys (e.g. proxy) untouched', () => {
  assert.deepEqual(validateOpenclawConfig({ proxy: '@hypaware/ai-gateway' }), { ok: true })
})

test('validateOpenclawConfig accepts the attach policy block', () => {
  assert.deepEqual(validateOpenclawConfig({ attach: { on_join: true } }), { ok: true })
  assert.deepEqual(validateOpenclawConfig({ attach: { on_join: false } }), { ok: true })
  assert.deepEqual(validateOpenclawConfig({ attach: {} }), { ok: true })
})

test('validateOpenclawConfig rejects a non-object config', () => {
  const result = validateOpenclawConfig('nope')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '')
})

test('validateOpenclawConfig rejects a malformed attach block', () => {
  /** @type {Array<[unknown, string]>} */
  const cases = [
    [{ attach: [] }, '/attach'],
    [{ attach: 7 }, '/attach'],
    [{ attach: { on_join: 'yes' } }, '/attach/on_join'],
    [{ attach: { on_joins: true } }, '/attach/on_joins'],
  ]
  for (const [value, pointer] of cases) {
    const result = validateOpenclawConfig(value)
    assert.equal(result.ok, false, `expected failure for ${JSON.stringify(value)}`)
    if (result.ok) continue
    assert.equal(result.errors[0].pointer, pointer)
  }
})

test('validateAttachSection mounts errors at the caller-supplied pointer', () => {
  const errors = validateAttachSection({ on_join: 1 }, '/x')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].pointer, '/x/on_join')
})

test('the section name matches the manifest config_sections entry', () => {
  assert.equal(OPENCLAW_CONFIG_SECTION, 'openclaw')
})

// The `backfill` block is a deliberately independent copy of `@hypaware/codex`'s
// validator (LLP 0037: each plugin owns its own config validation), so it needs
// its own coverage rather than inheriting codex's - an edit to one copy is
// exactly what these assertions exist to catch.
//
// @ref LLP 0157#backfill [tests]: the plugin-owned `backfill` policy
// (`on_join`, `window_days`) is declared and validated in this plugin's section.
test('validateOpenclawConfig accepts a full backfill block', () => {
  assert.deepEqual(validateOpenclawConfig({ backfill: { on_join: true, window_days: 30 } }), { ok: true })
  assert.deepEqual(validateOpenclawConfig({ backfill: { on_join: false } }), { ok: true })
  assert.deepEqual(validateOpenclawConfig({ backfill: {} }), { ok: true })
  assert.deepEqual(validateOpenclawConfig({ attach: { on_join: true }, backfill: { window_days: 7 } }), { ok: true })
})

test('validateOpenclawConfig rejects a malformed backfill block', () => {
  /** @type {Array<[unknown, string]>} */
  const cases = [
    [{ backfill: [] }, '/backfill'],
    [{ backfill: null }, '/backfill'],
    [{ backfill: { on_join: 'yes' } }, '/backfill/on_join'],
    [{ backfill: { window_days: 0 } }, '/backfill/window_days'],
    [{ backfill: { window_days: -3 } }, '/backfill/window_days'],
    [{ backfill: { window_days: 2.5 } }, '/backfill/window_days'],
    [{ backfill: { window_days: '30' } }, '/backfill/window_days'],
    [{ backfill: { bogus: true } }, '/backfill/bogus'],
  ]
  for (const [value, pointer] of cases) {
    const result = validateOpenclawConfig(value)
    assert.equal(result.ok, false, `expected failure for ${JSON.stringify(value)}`)
    if (result.ok) continue
    assert.equal(result.errors[0].pointer, pointer, `${JSON.stringify(value)} pointer`)
  }
})

test('validateBackfillSection mounts errors at the caller-supplied pointer', () => {
  assert.deepEqual(validateBackfillSection(undefined, '/backfill'), [])
  const errors = validateBackfillSection({ window_days: -1 }, '/plugins/0/config/backfill')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].pointer, '/plugins/0/config/backfill/window_days')
})
