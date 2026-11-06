// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_POLL_INTERVAL_MS,
  MASTRACODE_CONFIG_SECTION,
  resolveMastraDbLocation,
  resolveMastracodeEnabled,
  resolvePollIntervalMs,
  validateMastracodeConfig,
} from '../../hypaware-core/plugins-workspace/mastracode/src/config.js'
import { activate } from '../../hypaware-core/plugins-workspace/mastracode/src/index.js'
import { createConfigRegistry } from '../../src/core/config/schema.js'

/**
 * Tests for the `@hypaware/mastracode` `[mastracode]` config section and
 * the database path order.
 *
 * @ref LLP 0586#config [tests]: the goose keys with `db_path`, and the
 *   five-step path order with absolute environment values only.
 *
 * @import { PluginActivationContext } from '../../hypaware-plugin-kernel-types.js'
 */

const HOME = '/home/fixture'
const LINUX_DEFAULT = path.posix.join(HOME, '.local', 'share', 'mastracode', 'mastra.db')

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

/**
 * @param {unknown} config
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 */
function resolve(config, env, platform = 'linux') {
  return resolveMastraDbLocation(makeCtx(config, env), HOME, platform)
}

test('validateMastracodeConfig accepts an absent, empty or full config', () => {
  assert.deepEqual(validateMastracodeConfig(undefined), { ok: true })
  assert.deepEqual(validateMastracodeConfig(null), { ok: true })
  assert.deepEqual(validateMastracodeConfig({}), { ok: true })
  assert.deepEqual(
    validateMastracodeConfig({ enabled: false, db_path: '~/m/mastra.db', poll_interval: '30s' }),
    { ok: true }
  )
  for (const value of [5000, '500ms', '10s', '5m', '1h']) {
    assert.deepEqual(validateMastracodeConfig({ poll_interval: value }), { ok: true }, String(value))
  }
  assert.deepEqual(validateMastracodeConfig({ backfill: { on_join: false, window_days: 30 } }), { ok: true })
})

test('validateMastracodeConfig refuses a bad value or an unknown key', () => {
  /** @type {Array<[unknown, string]>} */
  const cases = [
    [42, ''],
    [[], ''],
    [{ enabled: 'yes' }, '/enabled'],
    [{ db_path: '' }, '/db_path'],
    [{ db_path: '   ' }, '/db_path'],
    [{ db_path: 7 }, '/db_path'],
    [{ poll_interval: 0 }, '/poll_interval'],
    [{ poll_interval: -5 }, '/poll_interval'],
    [{ poll_interval: '30' }, '/poll_interval'],
    [{ poll_interval: '30x' }, '/poll_interval'],
    [{ poll_interval: true }, '/poll_interval'],
    [{ sessions_db: '/tmp/x.db' }, '/sessions_db'],
    [{ db_url: 'libsql://x' }, '/db_url'],
    [{ backfill: 'x' }, '/backfill'],
    [{ backfill: { window_days: -1 } }, '/backfill/window_days'],
    [{ backfill: { on_join: 'yes' } }, '/backfill/on_join'],
  ]
  for (const [value, pointer] of cases) {
    const result = validateMastracodeConfig(value)
    assert.equal(result.ok, false, JSON.stringify(value))
    if (result.ok) continue
    assert.equal(result.errors[0].pointer, pointer, JSON.stringify(value))
  }
})

test('the registered mastracode section drives validatePluginConfig', () => {
  const registry = createConfigRegistry()
  registry.registerSection({ plugin: '@hypaware/mastracode', section: MASTRACODE_CONFIG_SECTION, validate: validateMastracodeConfig })
  assert.deepEqual(registry.validatePluginConfig('@hypaware/mastracode', { poll_interval: '45s' }), { ok: true })
  assert.equal(registry.validatePluginConfig('@hypaware/mastracode', { poll_interval: 'soon' }).ok, false)
})

test('resolveMastracodeEnabled is true when absent and false only when false', () => {
  assert.equal(resolveMastracodeEnabled(undefined), true)
  assert.equal(resolveMastracodeEnabled(null), true)
  assert.equal(resolveMastracodeEnabled({}), true)
  assert.equal(resolveMastracodeEnabled({ enabled: true }), true)
  assert.equal(resolveMastracodeEnabled({ enabled: false }), false)
})

test('resolvePollIntervalMs defaults to 60s and honors numbers and durations', () => {
  assert.equal(resolvePollIntervalMs(makeCtx(undefined)), DEFAULT_POLL_INTERVAL_MS)
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 60_000)
  assert.equal(resolvePollIntervalMs(makeCtx({ poll_interval: 5000 })), 5000)
  assert.equal(resolvePollIntervalMs(makeCtx({ poll_interval: '30s' })), 30_000)
  assert.equal(resolvePollIntervalMs(makeCtx({ poll_interval: '2m' })), 120_000)
})

test('the platform default for linux, darwin and win32', () => {
  assert.deepEqual(resolve(undefined), { kind: 'local', path: LINUX_DEFAULT })
  assert.deepEqual(resolve(undefined, {}, 'freebsd'), { kind: 'local', path: LINUX_DEFAULT })
  assert.deepEqual(resolve(undefined, {}, 'darwin'), {
    kind: 'local',
    path: path.posix.join(HOME, 'Library', 'Application Support', 'mastracode', 'mastra.db'),
  })
  const winHome = 'C:\\Users\\fixture'
  const appData = 'C:\\Users\\fixture\\AppData\\Roaming'
  assert.deepEqual(
    resolveMastraDbLocation(makeCtx(undefined, { APPDATA: appData }), winHome, 'win32'),
    { kind: 'local', path: 'C:\\Users\\fixture\\AppData\\Roaming\\mastracode\\mastra.db' }
  )
  // An unset APPDATA falls back to the roaming directory under the home.
  assert.deepEqual(
    resolveMastraDbLocation(makeCtx(undefined), winHome, 'win32'),
    { kind: 'local', path: 'C:\\Users\\fixture\\AppData\\Roaming\\mastracode\\mastra.db' }
  )
})

test('path order: db_path, MASTRA_DB_PATH, MASTRA_APP_DATA_DIR, XDG_DATA_HOME, then the default', () => {
  const all = {
    MASTRA_DB_PATH: '/srv/env/mastra.db',
    MASTRA_APP_DATA_DIR: '/srv/appdata',
    XDG_DATA_HOME: '/srv/xdg',
  }
  assert.deepEqual(resolve({ db_path: '/srv/config.db' }, all), { kind: 'local', path: '/srv/config.db' })
  assert.deepEqual(resolve(undefined, all), { kind: 'local', path: '/srv/env/mastra.db' })
  const { MASTRA_DB_PATH, ...noDbPath } = all
  assert.equal(MASTRA_DB_PATH, '/srv/env/mastra.db')
  assert.deepEqual(resolve(undefined, noDbPath), { kind: 'local', path: '/srv/appdata/mastra.db' })
  assert.deepEqual(resolve(undefined, { XDG_DATA_HOME: '/srv/xdg' }), { kind: 'local', path: '/srv/xdg/mastracode/mastra.db' })
  assert.deepEqual(resolve(undefined, {}), { kind: 'local', path: LINUX_DEFAULT })
  // Each step on its own, with every other variable unset.
  assert.deepEqual(resolve(undefined, { MASTRA_APP_DATA_DIR: '/srv/appdata' }), { kind: 'local', path: '/srv/appdata/mastra.db' })
  assert.deepEqual(resolve(undefined, { MASTRA_DB_PATH: '/srv/env/mastra.db' }), { kind: 'local', path: '/srv/env/mastra.db' })
  // An environment step outranks the platform default on every platform.
  assert.deepEqual(resolve(undefined, { XDG_DATA_HOME: '/srv/xdg' }, 'darwin'), { kind: 'local', path: '/srv/xdg/mastracode/mastra.db' })
})

test('a relative environment value is ignored', () => {
  for (const key of ['MASTRA_DB_PATH', 'MASTRA_APP_DATA_DIR', 'XDG_DATA_HOME']) {
    assert.deepEqual(resolve(undefined, { [key]: 'relative/dir' }), { kind: 'local', path: LINUX_DEFAULT }, key)
  }
  assert.deepEqual(
    resolve(undefined, { MASTRA_DB_PATH: 'rel.db', XDG_DATA_HOME: '/srv/xdg' }),
    { kind: 'local', path: '/srv/xdg/mastracode/mastra.db' }
  )
})

test('db_path expands a leading ~ at resolve time', () => {
  assert.deepEqual(resolve({ db_path: '~/m/mastra.db' }), { kind: 'local', path: path.posix.join(HOME, 'm', 'mastra.db') })
  assert.deepEqual(resolve({ db_path: '~' }), { kind: 'local', path: HOME })
  assert.deepEqual(resolve({ db_path: '/abs/~/mastra.db' }), { kind: 'local', path: '/abs/~/mastra.db' })
})

test('MASTRA_DB_URL gives a remote store, even with a local path configured', () => {
  assert.deepEqual(resolve(undefined, { MASTRA_DB_URL: 'libsql://example.invalid' }), { kind: 'remote' })
  assert.deepEqual(
    resolve({ db_path: '/srv/config.db' }, { MASTRA_DB_URL: 'libsql://example.invalid', MASTRA_DB_PATH: '/srv/env.db' }),
    { kind: 'remote' }
  )
  assert.deepEqual(resolve(undefined, { MASTRA_DB_URL: '' }), { kind: 'local', path: LINUX_DEFAULT })
})

/**
 * @param {unknown} config
 */
async function startViaActivate(config) {
  /** @type {any[]} */
  const sources = []
  /** @type {any[]} */
  const sections = []
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mastracode-config-'))
  const ctx = /** @type {any} */ (makeCtx(config, { HYP_HOME: dir, MASTRA_DB_PATH: path.join(dir, 'absent', 'mastra.db') }))
  ctx.paths = { rootDir: dir, stateDir: dir, cacheDir: dir, tempDir: dir }
  ctx.log = { ...ctx.log, debug() {}, warn() {}, error() {} }
  ctx.configRegistry = { registerSection: (/** @type {any} */ s) => sections.push(s) }
  ctx.sources = { register: (/** @type {any} */ s) => sources.push(s) }
  await activate(ctx)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].section, 'mastracode')
  assert.equal(sources.length, 1)
  assert.equal(sources[0].name, 'mastracode')
  assert.equal(sources[0].configSection, 'mastracode')
  const source = await sources[0].start(ctx)
  return { source, ctx }
}

test('the source starts and reports ready with zero rows', async () => {
  const { source, ctx } = await startViaActivate(undefined)
  const status = await source.status()
  assert.equal(status.state, 'ready')
  assert.equal(status.rowsWritten, 0)
  assert.equal(status.message, `no mastracode installation detected at ${ctx.env.MASTRA_DB_PATH}`)
  await source.stop()
})

test('enabled = false starts a disabled source that reports the kill switch', async () => {
  const { source, ctx } = await startViaActivate({ enabled: false })
  const status = await source.status()
  assert.equal(status.state, 'ready')
  assert.equal(status.message, 'mastracode ongoing capture disabled (mastracode.enabled = false)')
  assert.equal(status.rowsWritten, 0)
  assert.equal(status.details?.enabled, false)
  assert.equal(ctx.logged[0][0], 'mastracode.source_disabled')
  await source.stop()
})
