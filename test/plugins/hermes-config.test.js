// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HERMES_CONFIG_SECTION,
  resolveHermesEnabled,
  validateHermesConfig,
} from '../../hypaware-core/plugins-workspace/hermes/src/config.js'
import { createConfigRegistry } from '../../src/core/config/schema.js'

/**
 * Tests for the `@hypaware/hermes` `[hermes]` config section (T5).
 *
 * @ref LLP 0122#config [tests]: `enabled` / `state_db` / `poll_interval`
 *   are all optional; a missing section means defaults.
 */

test('validateHermesConfig accepts an empty / absent config', () => {
  assert.deepEqual(validateHermesConfig(undefined), { ok: true })
  assert.deepEqual(validateHermesConfig(null), { ok: true })
  assert.deepEqual(validateHermesConfig({}), { ok: true })
})

test('validateHermesConfig accepts a full valid config', () => {
  assert.deepEqual(
    validateHermesConfig({ enabled: true, state_db: '/tmp/state.db', poll_interval: '30s' }),
    { ok: true }
  )
  assert.deepEqual(validateHermesConfig({ enabled: false }), { ok: true })
  assert.deepEqual(validateHermesConfig({ poll_interval: 5000 }), { ok: true })
  assert.deepEqual(validateHermesConfig({ state_db: '~/.hermes/state.db' }), { ok: true })
})

test('validateHermesConfig accepts every documented poll_interval duration suffix', () => {
  for (const value of ['500ms', '10s', '5m', '1h']) {
    assert.deepEqual(validateHermesConfig({ poll_interval: value }), { ok: true }, value)
  }
})

test('validateHermesConfig rejects a non-object config', () => {
  const result = validateHermesConfig(42)
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errors[0].pointer, '')
})

test('validateHermesConfig rejects malformed keys', () => {
  /** @type {Array<[unknown, string]>} */
  const cases = [
    [{ enabled: 'yes' }, '/enabled'],
    [{ state_db: '' }, '/state_db'],
    [{ state_db: '   ' }, '/state_db'],
    [{ state_db: 42 }, '/state_db'],
    [{ poll_interval: 0 }, '/poll_interval'],
    [{ poll_interval: -5 }, '/poll_interval'],
    [{ poll_interval: '30' }, '/poll_interval'],
    [{ poll_interval: '30x' }, '/poll_interval'],
    [{ poll_interval: true }, '/poll_interval'],
    [{ bogus: true }, '/bogus'],
  ]
  for (const [config, pointer] of cases) {
    const result = validateHermesConfig(config)
    assert.equal(result.ok, false, `${JSON.stringify(config)} must fail`)
    if (result.ok) continue
    assert.equal(result.errors[0].pointer, pointer, `${JSON.stringify(config)} pointer`)
  }
})

test('resolveHermesEnabled defaults to true (missing/absent/non-object config)', () => {
  assert.equal(resolveHermesEnabled(undefined), true)
  assert.equal(resolveHermesEnabled(null), true)
  assert.equal(resolveHermesEnabled({}), true)
  assert.equal(resolveHermesEnabled({ state_db: '/x' }), true)
})

test('resolveHermesEnabled honors an explicit override', () => {
  assert.equal(resolveHermesEnabled({ enabled: true }), true)
  assert.equal(resolveHermesEnabled({ enabled: false }), false)
})

test('the registered hermes section drives validatePluginConfig', () => {
  const registry = createConfigRegistry()
  registry.registerSection({
    plugin: '@hypaware/hermes',
    section: HERMES_CONFIG_SECTION,
    validate: validateHermesConfig,
  })
  assert.deepEqual(
    registry.validatePluginConfig('@hypaware/hermes', { poll_interval: '45s' }),
    { ok: true }
  )
  const bad = registry.validatePluginConfig('@hypaware/hermes', { poll_interval: 'not-a-duration' })
  assert.equal(bad.ok, false)
})
