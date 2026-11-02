// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_POLL_INTERVAL_MS,
  GOOSE_CONFIG_SECTION,
  resolveGooseEnabled,
  resolvePollIntervalMs,
  resolveSessionsDbPath,
  validateGooseConfig,
} from '../../hypaware-core/plugins-workspace/goose/src/config.js'
import { startGooseSource } from '../../hypaware-core/plugins-workspace/goose/src/source.js'
import { createConfigRegistry } from '../../src/core/config/schema.js'

/**
 * Tests for the `@hypaware/goose` `[goose]` config section and path order.
 *
 * @ref LLP 0570#config [tests]: the `[hermes]` keys with `sessions_db`, and
 *   one default path on Linux and macOS.
 *
 * @import { PluginActivationContext } from '../../hypaware-plugin-kernel-types.js'
 */

const HOME = '/home/fixture'
const DEFAULT_PATH = path.join(HOME, '.local', 'share', 'goose', 'sessions', 'sessions.db')

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
 * @param {string} platform
 * @param {() => void} fn
 */
function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    fn()
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

test('validateGooseConfig accepts an absent, empty or full config', () => {
  assert.deepEqual(validateGooseConfig(undefined), { ok: true })
  assert.deepEqual(validateGooseConfig(null), { ok: true })
  assert.deepEqual(validateGooseConfig({}), { ok: true })
  assert.deepEqual(
    validateGooseConfig({ enabled: false, sessions_db: '~/goose/sessions.db', poll_interval: '30s' }),
    { ok: true }
  )
  for (const value of [5000, '500ms', '10s', '5m', '1h']) {
    assert.deepEqual(validateGooseConfig({ poll_interval: value }), { ok: true }, String(value))
  }
})

test('validateGooseConfig refuses a bad value or an unknown key', () => {
  /** @type {Array<[unknown, string]>} */
  const cases = [
    [42, ''],
    [[], ''],
    [{ enabled: 'yes' }, '/enabled'],
    [{ sessions_db: '' }, '/sessions_db'],
    [{ sessions_db: '   ' }, '/sessions_db'],
    [{ sessions_db: 7 }, '/sessions_db'],
    [{ poll_interval: 0 }, '/poll_interval'],
    [{ poll_interval: -5 }, '/poll_interval'],
    [{ poll_interval: '30' }, '/poll_interval'],
    [{ poll_interval: '30x' }, '/poll_interval'],
    [{ poll_interval: true }, '/poll_interval'],
    [{ state_db: '/tmp/x.db' }, '/state_db'],
  ]
  for (const [value, pointer] of cases) {
    const result = validateGooseConfig(value)
    assert.equal(result.ok, false, JSON.stringify(value))
    if (result.ok) continue
    assert.equal(result.errors[0].pointer, pointer, JSON.stringify(value))
  }
})

test('the registered goose section drives validatePluginConfig', () => {
  const registry = createConfigRegistry()
  registry.registerSection({ plugin: '@hypaware/goose', section: GOOSE_CONFIG_SECTION, validate: validateGooseConfig })
  assert.deepEqual(registry.validatePluginConfig('@hypaware/goose', { poll_interval: '45s' }), { ok: true })
  assert.equal(registry.validatePluginConfig('@hypaware/goose', { poll_interval: 'soon' }).ok, false)
})

test('resolveGooseEnabled is true unless enabled is explicitly false', () => {
  assert.equal(resolveGooseEnabled(undefined), true)
  assert.equal(resolveGooseEnabled({}), true)
  assert.equal(resolveGooseEnabled({ enabled: true }), true)
  assert.equal(resolveGooseEnabled({ enabled: false }), false)
})

test('resolvePollIntervalMs defaults to 60s and honors numbers and durations', () => {
  assert.equal(resolvePollIntervalMs(makeCtx(undefined)), DEFAULT_POLL_INTERVAL_MS)
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 60_000)
  assert.equal(resolvePollIntervalMs(makeCtx({ poll_interval: 5000 })), 5000)
  assert.equal(resolvePollIntervalMs(makeCtx({ poll_interval: '30s' })), 30_000)
  assert.equal(resolvePollIntervalMs(makeCtx({ poll_interval: '2m' })), 120_000)
})

test('the default sessions.db path is the same on linux and darwin', () => {
  for (const platform of ['linux', 'darwin']) {
    withPlatform(platform, () => {
      assert.equal(process.platform, platform)
      assert.equal(resolveSessionsDbPath(makeCtx(undefined), HOME), DEFAULT_PATH, platform)
    })
  }
})

test('path order: sessions_db, then an absolute GOOSE_PATH_ROOT, then the default', () => {
  const root = '/opt/goose-root'
  const fromRoot = path.join(root, 'data', 'sessions', 'sessions.db')
  assert.equal(resolveSessionsDbPath(makeCtx(undefined, { GOOSE_PATH_ROOT: root }), HOME), fromRoot)
  assert.equal(
    resolveSessionsDbPath(makeCtx({ sessions_db: '/srv/custom.db' }, { GOOSE_PATH_ROOT: root }), HOME),
    '/srv/custom.db'
  )
})

test('a relative GOOSE_PATH_ROOT is ignored', () => {
  assert.equal(resolveSessionsDbPath(makeCtx(undefined, { GOOSE_PATH_ROOT: 'relative/root' }), HOME), DEFAULT_PATH)
})

test('sessions_db expands a leading ~ at resolve time', () => {
  assert.equal(resolveSessionsDbPath(makeCtx({ sessions_db: '~/g/sessions.db' }), HOME), path.join(HOME, 'g', 'sessions.db'))
  assert.equal(resolveSessionsDbPath(makeCtx({ sessions_db: '~' }), HOME), HOME)
})

test('a sessions_db that does not exist resolves without error and the source reports it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goose-config-'))
  try {
    const missing = path.join(dir, 'nope', 'sessions.db')
    assert.equal(resolveSessionsDbPath(makeCtx({ sessions_db: missing }), HOME), missing)
    const source = await startGooseSource(makeCtx({ sessions_db: missing }))
    assert.ok(source.status)
    const status = await source.status()
    assert.equal(status.state, 'ready')
    assert.equal(status.message, 'no goose installation detected')
    assert.equal(status.rowsWritten, 0)
    assert.deepEqual(status.details, { sessions_db: missing })
    await source.stop()
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('an existing sessions.db is reported as ready with no sessions yet', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goose-config-'))
  try {
    const db = path.join(dir, 'sessions.db')
    await fs.writeFile(db, '')
    const source = await startGooseSource(makeCtx({ sessions_db: db, poll_interval: '30s' }))
    assert.ok(source.status)
    const status = await source.status()
    assert.equal(status.state, 'ready')
    assert.equal(status.message, `polling ${db} every 30000ms, no sessions yet`)
    assert.equal(status.rowsWritten, 0)
    await source.stop()
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('enabled = false starts a disabled source that reports the kill switch', async () => {
  const ctx = makeCtx({ enabled: false })
  const source = await startGooseSource(ctx)
  assert.ok(source.status)
  const status = await source.status()
  assert.equal(status.state, 'ready')
  assert.equal(status.message, 'goose ongoing capture disabled (goose.enabled = false)')
  assert.deepEqual(status.details, { sessions_db: DEFAULT_PATH, enabled: false })
  const logged = /** @type {Array<[string, unknown]>} */ (/** @type {any} */ (ctx).logged)
  assert.equal(logged[0][0], 'goose.source_disabled')
  await source.stop()
})
