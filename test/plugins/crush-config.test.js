// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CRUSH_CONFIG_SECTION,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_DATA_DIRS,
  resolveCrushEnabled,
  resolveDataDirs,
  resolveIndexPath,
  resolvePollIntervalMs,
  validateCrushConfig,
} from '../../hypaware-core/plugins-workspace/crush/src/config.js'
import { startCrushSource } from '../../hypaware-core/plugins-workspace/crush/src/index.js'
import { createConfigRegistry } from '../../src/core/config/schema.js'

/**
 * Tests for the `@hypaware/crush` `[crush]` config section and index path.
 *
 * @ref LLP 0573#config [tests]: `enabled`, `data_dirs`, `poll_interval` and
 *   `backfill`; the index path follows Crush's own variables, absolute only.
 *
 * @import { PluginActivationContext } from '../../hypaware-plugin-kernel-types.js'
 */

const HOME = '/home/fixture'
const DEFAULT_INDEX = path.join(HOME, '.local', 'share', 'crush', 'projects.json')

/**
 * @param {unknown} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {PluginActivationContext}
 */
function makeCtx(config, env = {}) {
  /** @type {Array<[string, unknown]>} */
  const logged = []
  return /** @type {PluginActivationContext} */ (/** @type {unknown} */ ({
    config,
    env: { HOME, ...env },
    log: { info: (/** @type {string} */ name, /** @type {unknown} */ attrs) => logged.push([name, attrs]) },
    logged,
  }))
}

test('validateCrushConfig accepts an absent, empty or full config', () => {
  assert.deepEqual(validateCrushConfig(undefined), { ok: true })
  assert.deepEqual(validateCrushConfig(null), { ok: true })
  assert.deepEqual(validateCrushConfig({}), { ok: true })
  assert.deepEqual(
    validateCrushConfig({ enabled: false, data_dirs: ['~/p/.crush', '/srv/q/.crush'], poll_interval: '30s' }),
    { ok: true }
  )
  for (const value of [5000, '500ms', '10s', '5m', '1h']) {
    assert.deepEqual(validateCrushConfig({ poll_interval: value }), { ok: true }, String(value))
  }
  assert.deepEqual(validateCrushConfig({ backfill: { on_join: false, window_days: 30 } }), { ok: true })
  assert.deepEqual(validateCrushConfig({ data_dirs: new Array(MAX_DATA_DIRS).fill('/x/.crush') }), { ok: true })
})

test('validateCrushConfig refuses a bad value, an over-long data_dirs or an unknown key', () => {
  /** @type {Array<[unknown, string]>} */
  const cases = [
    [42, ''],
    [[], ''],
    [{ enabled: 'yes' }, '/enabled'],
    [{ data_dirs: '/x/.crush' }, '/data_dirs'],
    [{ data_dirs: new Array(MAX_DATA_DIRS + 1).fill('/x/.crush') }, '/data_dirs'],
    [{ data_dirs: ['/a/.crush', ''] }, '/data_dirs/1'],
    [{ data_dirs: ['   '] }, '/data_dirs/0'],
    [{ data_dirs: [7] }, '/data_dirs/0'],
    [{ poll_interval: 0 }, '/poll_interval'],
    [{ poll_interval: -5 }, '/poll_interval'],
    [{ poll_interval: '30' }, '/poll_interval'],
    [{ poll_interval: '30x' }, '/poll_interval'],
    [{ poll_interval: true }, '/poll_interval'],
    [{ index: '/tmp/projects.json' }, '/index'],
    [{ backfill: 'x' }, '/backfill'],
    [{ backfill: { window_days: -1 } }, '/backfill/window_days'],
    [{ backfill: { on_join: 'yes' } }, '/backfill/on_join'],
  ]
  for (const [value, pointer] of cases) {
    const result = validateCrushConfig(value)
    assert.equal(result.ok, false, JSON.stringify(value))
    if (result.ok) continue
    assert.equal(result.errors[0].pointer, pointer, JSON.stringify(value))
  }
})

test('the registered crush section drives validatePluginConfig', () => {
  const registry = createConfigRegistry()
  registry.registerSection({ plugin: '@hypaware/crush', section: CRUSH_CONFIG_SECTION, validate: validateCrushConfig })
  assert.deepEqual(registry.validatePluginConfig('@hypaware/crush', { poll_interval: '45s' }), { ok: true })
  assert.equal(registry.validatePluginConfig('@hypaware/crush', { poll_interval: 'soon' }).ok, false)
})

test('resolveCrushEnabled is true unless enabled is explicitly false', () => {
  assert.equal(resolveCrushEnabled(undefined), true)
  assert.equal(resolveCrushEnabled({}), true)
  assert.equal(resolveCrushEnabled({ enabled: true }), true)
  assert.equal(resolveCrushEnabled({ enabled: false }), false)
})

test('resolvePollIntervalMs defaults to 60s and honors numbers and durations', () => {
  assert.equal(resolvePollIntervalMs(makeCtx(undefined)), DEFAULT_POLL_INTERVAL_MS)
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 60_000)
  assert.equal(resolvePollIntervalMs(makeCtx({ poll_interval: 5000 })), 5000)
  assert.equal(resolvePollIntervalMs(makeCtx({ poll_interval: '30s' })), 30_000)
  assert.equal(resolvePollIntervalMs(makeCtx({ poll_interval: '2m' })), 120_000)
})

test('index order: CRUSH_GLOBAL_DATA, then XDG_DATA_HOME, then the default', () => {
  const globalData = '/opt/crush-global'
  const xdg = '/opt/xdg'
  const both = { CRUSH_GLOBAL_DATA: globalData, XDG_DATA_HOME: xdg }
  assert.equal(resolveIndexPath(makeCtx(undefined), HOME), DEFAULT_INDEX)
  assert.equal(resolveIndexPath(makeCtx(undefined, both), HOME), path.join(globalData, 'projects.json'))
  assert.equal(resolveIndexPath(makeCtx(undefined, { CRUSH_GLOBAL_DATA: globalData }), HOME), path.join(globalData, 'projects.json'))
  assert.equal(resolveIndexPath(makeCtx(undefined, { XDG_DATA_HOME: xdg }), HOME), path.join(xdg, 'crush', 'projects.json'))
})

test('a relative CRUSH_GLOBAL_DATA or XDG_DATA_HOME is ignored', () => {
  assert.equal(resolveIndexPath(makeCtx(undefined, { CRUSH_GLOBAL_DATA: 'rel/global' }), HOME), DEFAULT_INDEX)
  assert.equal(resolveIndexPath(makeCtx(undefined, { XDG_DATA_HOME: 'rel/xdg' }), HOME), DEFAULT_INDEX)
  assert.equal(
    resolveIndexPath(makeCtx(undefined, { CRUSH_GLOBAL_DATA: 'rel/global', XDG_DATA_HOME: '/opt/xdg' }), HOME),
    path.join('/opt/xdg', 'crush', 'projects.json')
  )
})

test('data_dirs expands a leading ~ and trims entries', () => {
  assert.deepEqual(
    resolveDataDirs(makeCtx({ data_dirs: ['~/p/.crush', '~', ' /srv/q/.crush '] }), HOME),
    [path.join(HOME, 'p', '.crush'), HOME, '/srv/q/.crush']
  )
  assert.deepEqual(resolveDataDirs(makeCtx(undefined), HOME), [])
})

test('a missing index resolves without error and the source reports it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crush-config-'))
  try {
    const ctx = makeCtx(undefined, { CRUSH_GLOBAL_DATA: dir, HYP_HOME: dir })
    Object.assign(ctx, { paths: { stateDir: path.join(dir, 'state') } })
    const source = await startCrushSource(ctx)
    assert.ok(source.status)
    const status = await source.status()
    const index = path.join(dir, 'projects.json')
    assert.equal(status.state, 'ready')
    assert.equal(status.message, `no crush installation detected at ${index}`)
    assert.equal(status.rowsWritten, 0)
    assert.equal(status.details?.index_path, index)
    await source.stop()
    assert.equal((await source.status()).state, 'stopped')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('enabled = false starts a disabled source that reports the kill switch', async () => {
  const ctx = makeCtx({ enabled: false })
  const source = await startCrushSource(ctx)
  assert.ok(source.status)
  const status = await source.status()
  assert.equal(status.state, 'ready')
  assert.equal(status.message, 'crush ongoing capture disabled (crush.enabled = false)')
  assert.deepEqual(status.details, { index_path: DEFAULT_INDEX, enabled: false })
  const logged = /** @type {Array<[string, unknown]>} */ (/** @type {any} */ (ctx).logged)
  assert.equal(logged[0][0], 'crush.source_disabled')
  await source.stop()
})
