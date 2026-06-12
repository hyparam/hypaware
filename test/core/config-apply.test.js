// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  MAX_CONFIG_DOCUMENT_BYTES,
  PROBATION_FLOOR_SECONDS,
  createConfigControl,
  readConfigControlStatus,
} from '../../src/core/config/apply.js'
import { parseConfigShape } from '../../src/core/config/schema.js'

/**
 * @import { PluginConfigInstance } from '../../collectivus-plugin-kernel-types.d.ts'
 * @import { ConfigApplyDeps, PinnedInstallResult } from '../../src/core/config/types.d.ts'
 */

const SEED_CONFIG = {
  version: 2,
  plugins: [{ name: '@hypaware/central' }],
  sinks: {
    central: {
      plugin: '@hypaware/central',
      config: { url: 'https://central.example', identity: { bootstrap_token: 'tok' } },
    },
  },
}

const REMOTE_CONFIG = {
  version: 2,
  plugins: [{ name: '@hypaware/central' }, { name: '@hypaware/otel' }],
  sinks: {
    central: {
      plugin: '@hypaware/central',
      config: { url: 'https://central.example', identity: {} },
    },
  },
}

async function makeFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-config-apply-'))
  const stateRoot = path.join(tmp, 'hypaware')
  await fsp.mkdir(stateRoot, { recursive: true })
  const configPath = path.join(tmp, 'hypaware-config.json')
  await fsp.writeFile(configPath, JSON.stringify(SEED_CONFIG, null, 2) + '\n')
  return { tmp, stateRoot, configPath }
}

/**
 * @param {{ validateOk?: boolean, installResult?: PinnedInstallResult }} [opts]
 * @returns {ConfigApplyDeps & { validateCalls: number, installCalls: number, calls: string[] }}
 */
function makeDeps(opts = {}) {
  const deps = {
    validateCalls: 0,
    installCalls: 0,
    /** @type {string[]} */
    calls: [],
    /** @param {unknown} _document */
    async validateDocument(_document) {
      deps.validateCalls += 1
      deps.calls.push('validate')
      return opts.validateOk === false
        ? { ok: false, errors: [{ pointer: '/plugins/0', message: 'nope' }] }
        : { ok: true, errors: [] }
    },
    /** @param {PluginConfigInstance[]} _entries */
    async installPinnedPlugins(_entries) {
      deps.installCalls += 1
      deps.calls.push('install')
      return opts.installResult ?? { ok: true }
    },
  }
  return deps
}

/**
 * @param {{ stateRoot: string, configPath: string, now?: () => number }} args
 */
function makeControl({ stateRoot, configPath, now }) {
  /** @type {string[]} */
  const restarts = []
  const control = createConfigControl({
    stateRoot,
    configPath,
    requestRestart: (reason) => { restarts.push(reason) },
    ...(now ? { now } : {}),
  })
  return { control, restarts }
}

test('stage applies a document: slot persisted, pointer flipped, etag staged, probation armed, restart requested', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control, restarts } = makeControl({ stateRoot, configPath })
  control.attachApplyDeps(makeDeps())

  const result = await control.stage(REMOTE_CONFIG, 'etag-1')
  assert.deepEqual(result, { ok: true, action: 'applied' })
  assert.deepEqual(restarts, ['config_applied'])

  // Operative config is now a symlink whose content is the new doc.
  const stat = await fsp.lstat(configPath)
  assert.ok(stat.isSymbolicLink())
  const operative = JSON.parse(await fsp.readFile(configPath, 'utf8'))
  assert.deepEqual(operative.plugins, REMOTE_CONFIG.plugins)

  // The seed was preserved as the rollback target.
  const slotA = JSON.parse(
    await fsp.readFile(path.join(stateRoot, 'config-control', 'config.a.json'), 'utf8')
  )
  assert.deepEqual(slotA, SEED_CONFIG)

  assert.equal(control.runningEtag(), 'etag-1')
  const status = await control.status()
  assert.equal(status.probation?.etag, 'etag-1')
  assert.equal(status.probation?.slot, 'b')
  assert.equal(status.probation?.previous_slot, 'a')
})

test('probation window is max(3 × poll interval, floor) from the staged document', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const t0 = Date.parse('2026-06-12T00:00:00.000Z')
  const { control } = makeControl({ stateRoot, configPath, now: () => t0 })
  control.attachApplyDeps(makeDeps())

  // No poll_interval_seconds in the doc → default cadence.
  await control.stage(REMOTE_CONFIG, 'etag-1')
  let status = await control.status()
  assert.equal(
    Date.parse(/** @type {string} */ (status.probation?.until)) - t0,
    3 * DEFAULT_POLL_INTERVAL_SECONDS * 1000
  )

  // A fast cadence is floored. Fresh engine: the first stage left a
  // restart pending in the old one.
  const relaunch = makeControl({ stateRoot, configPath, now: () => t0 })
  relaunch.control.attachApplyDeps(makeDeps())
  relaunch.control.confirmPoll()
  const fastDoc = {
    ...REMOTE_CONFIG,
    sinks: {
      central: {
        plugin: '@hypaware/central',
        config: { url: 'https://central.example', identity: {}, poll_interval_seconds: 5 },
      },
    },
  }
  await relaunch.control.stage(fastDoc, 'etag-2')
  status = await relaunch.control.status()
  assert.equal(
    Date.parse(/** @type {string} */ (status.probation?.until)) - t0,
    PROBATION_FLOOR_SECONDS * 1000
  )
})

test('stage before attachApplyDeps fails closed', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control, restarts } = makeControl({ stateRoot, configPath })
  const result = await control.stage(REMOTE_CONFIG, 'etag-1')
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.errorKind, 'apply_engine_not_ready')
  assert.deepEqual(restarts, [])
})

test('validation failure remembers the bad etag and leaves the config untouched', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control, restarts } = makeControl({ stateRoot, configPath })
  control.attachApplyDeps(makeDeps({ validateOk: false }))

  const result = await control.stage(REMOTE_CONFIG, 'etag-bad')
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.errorKind, 'config_invalid')
  assert.deepEqual(restarts, [])

  // Still the seed, still a regular file.
  const stat = await fsp.lstat(configPath)
  assert.ok(!stat.isSymbolicLink())
  const status = await control.status()
  assert.equal(status.badEtag?.etag, 'etag-bad')
  assert.equal(status.badEtag?.reason, 'validation_failed')
  assert.equal(status.runningEtag, null)
})

test('pinned plugins install before full validation, so a config can name a not-yet-installed plugin', async () => {
  // Catalog-backed validation only knows a plugin once it is installed;
  // install-on-config breaks if validation runs first (LLP 0023
  // install-on-config). The shape gate runs before install instead.
  const { stateRoot, configPath } = await makeFixture()
  const { control } = makeControl({ stateRoot, configPath })
  const deps = makeDeps()
  control.attachApplyDeps(deps)

  const result = await control.stage(REMOTE_CONFIG, 'etag-order')
  assert.equal(result.ok, true)
  assert.deepEqual(deps.calls, ['install', 'validate'])
})

test('a shape-invalid document is rejected before any install runs', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control } = makeControl({ stateRoot, configPath })
  const deps = makeDeps()
  control.attachApplyDeps(deps)

  const result = await control.stage({ version: 1 }, 'etag-shape')
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.errorKind, 'config_invalid')
  assert.equal(deps.installCalls, 0)
  const status = await control.status()
  assert.equal(status.badEtag?.reason, 'validation_failed')
})

test('a remembered bad etag backs off re-apply until the etag changes', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control } = makeControl({ stateRoot, configPath })
  const deps = makeDeps({ validateOk: false })
  control.attachApplyDeps(deps)

  await control.stage(REMOTE_CONFIG, 'etag-bad')
  assert.equal(deps.validateCalls, 1)

  // Same etag again: skipped without re-validating.
  const skipped = await control.stage(REMOTE_CONFIG, 'etag-bad')
  assert.deepEqual(skipped, { ok: true, action: 'skipped_bad_etag' })
  assert.equal(deps.validateCalls, 1)

  // A different etag proceeds (and fails validation again here).
  const retried = await control.stage(REMOTE_CONFIG, 'etag-fixed')
  assert.equal(retried.ok, false)
  assert.equal(deps.validateCalls, 2)
})

test('pinned install hash mismatch is an apply failure with a structured reason', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control, restarts } = makeControl({ stateRoot, configPath })
  control.attachApplyDeps(makeDeps({
    installResult: { ok: false, errorKind: 'artifact_hash_mismatch', message: 'hash differs' },
  }))

  const result = await control.stage(REMOTE_CONFIG, 'etag-hash')
  assert.equal(!result.ok && result.errorKind, 'artifact_hash_mismatch')
  assert.deepEqual(restarts, [])
  const status = await control.status()
  assert.equal(status.badEtag?.reason, 'artifact_hash_mismatch')
})

test('oversized documents are rejected before validation', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control } = makeControl({ stateRoot, configPath })
  const deps = makeDeps()
  control.attachApplyDeps(deps)

  const huge = { ...REMOTE_CONFIG, padding: 'x'.repeat(MAX_CONFIG_DOCUMENT_BYTES) }
  const result = await control.stage(huge, 'etag-huge')
  assert.equal(!result.ok && result.errorKind, 'document_too_large')
  assert.equal(deps.validateCalls, 0)
})

test('staging the running etag is a no-op', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const first = makeControl({ stateRoot, configPath })
  first.control.attachApplyDeps(makeDeps())
  await first.control.stage(REMOTE_CONFIG, 'etag-1')

  // Relaunch: a fresh engine over the same state.
  const second = makeControl({ stateRoot, configPath })
  second.control.attachApplyDeps(makeDeps())
  const result = await second.control.stage(REMOTE_CONFIG, 'etag-1')
  assert.deepEqual(result, { ok: true, action: 'noop_same_etag' })
})

test('a second stage in the same process is refused while a restart is pending', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control } = makeControl({ stateRoot, configPath })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')
  const result = await control.stage(REMOTE_CONFIG, 'etag-2')
  assert.equal(!result.ok && result.errorKind, 'restart_pending')
})

test('confirmPoll clears probation', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control } = makeControl({ stateRoot, configPath })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')

  control.confirmPoll()
  const status = await control.status()
  assert.equal(status.probation, null)
  assert.equal(status.runningEtag, 'etag-1')
  // Idempotent.
  control.confirmPoll()
})

test('chained applies alternate slots and roll back one revision', async () => {
  const { stateRoot, configPath } = await makeFixture()

  const first = makeControl({ stateRoot, configPath })
  first.control.attachApplyDeps(makeDeps())
  await first.control.stage(REMOTE_CONFIG, 'etag-1')

  // Relaunch, probation clears, a newer revision arrives.
  const second = makeControl({ stateRoot, configPath })
  second.control.attachApplyDeps(makeDeps())
  second.control.confirmPoll()
  const doc2 = { ...REMOTE_CONFIG, plugins: [{ name: '@hypaware/central' }] }
  await second.control.stage(doc2, 'etag-2')
  assert.equal(second.control.runningEtag(), 'etag-2')
  const status = await second.control.status()
  assert.equal(status.probation?.slot, 'a')
  assert.equal(status.probation?.previous_slot, 'b')

  // Expired probation at the next boot rolls back to etag-1, not the seed.
  const future = Date.now() + 10 * 24 * 60 * 60 * 1000
  const third = makeControl({ stateRoot, configPath, now: () => future })
  const evaluated = await third.control.evaluateAtBoot()
  assert.equal(evaluated.action, 'rolled_back')
  assert.equal(third.control.runningEtag(), 'etag-1')
  const rolled = await third.control.status()
  assert.equal(rolled.lastRollback?.etag, 'etag-2')
  assert.equal(rolled.lastRollback?.reason, 'probation_expired')
  assert.equal(rolled.badEtag?.etag, 'etag-2')
})

test('evaluateAtBoot rolls an expired first apply back onto the seed', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control } = makeControl({ stateRoot, configPath })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')

  const future = Date.now() + 10 * 24 * 60 * 60 * 1000
  const relaunch = makeControl({ stateRoot, configPath, now: () => future })
  const evaluated = await relaunch.control.evaluateAtBoot()
  assert.equal(evaluated.action, 'rolled_back')

  const operative = JSON.parse(await fsp.readFile(configPath, 'utf8'))
  assert.deepEqual(operative, SEED_CONFIG)
  assert.equal(relaunch.control.runningEtag(), undefined)
})

test('evaluateAtBoot keeps an unexpired probation marker', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control } = makeControl({ stateRoot, configPath })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')

  const relaunch = makeControl({ stateRoot, configPath })
  const evaluated = await relaunch.control.evaluateAtBoot()
  assert.equal(evaluated.action, 'none')
  const status = await relaunch.control.status()
  assert.equal(status.probation?.etag, 'etag-1')
})

test('evaluateAtBoot discards a probation marker whose flip never committed', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control } = makeControl({ stateRoot, configPath })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')

  // Simulate a crash between the marker write and the pointer flip by
  // pointing the marker at the slot that is NOT active.
  const statePath = path.join(stateRoot, 'config-control', 'state.json')
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.probation.slot = 'a'
  fs.writeFileSync(statePath, JSON.stringify(state))

  const relaunch = makeControl({ stateRoot, configPath })
  const evaluated = await relaunch.control.evaluateAtBoot()
  assert.equal(evaluated.action, 'cleared_orphan')
  const status = await relaunch.control.status()
  assert.equal(status.probation, null)
  // The operative config is untouched by orphan cleanup.
  assert.equal(relaunch.control.runningEtag(), 'etag-1')
})

test('the probation watchdog rolls back and requests a restart on expiry', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control, restarts } = makeControl({ stateRoot, configPath })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')
  assert.deepEqual(restarts, ['config_applied'])

  // Shrink the live marker's window so the real timer fires fast.
  const statePath = path.join(stateRoot, 'config-control', 'state.json')
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.probation.until = new Date(Date.now() + 20).toISOString()
  fs.writeFileSync(statePath, JSON.stringify(state))

  control.armProbationWatchdog()
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.deepEqual(restarts, ['config_applied', 'probation_expired'])
  const status = await control.status()
  assert.equal(status.lastRollback?.reason, 'probation_expired')
  assert.equal(status.runningEtag, null)
  const operative = JSON.parse(await fsp.readFile(configPath, 'utf8'))
  assert.deepEqual(operative, SEED_CONFIG)
})

test('a confirmed poll disarms the watchdog before it fires', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const { control, restarts } = makeControl({ stateRoot, configPath })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')

  const statePath = path.join(stateRoot, 'config-control', 'state.json')
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.probation.until = new Date(Date.now() + 30).toISOString()
  fs.writeFileSync(statePath, JSON.stringify(state))

  control.armProbationWatchdog()
  control.confirmPoll()
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.deepEqual(restarts, ['config_applied'])
  assert.equal(control.runningEtag(), 'etag-1')
})

test('readConfigControlStatus reads without an engine and tolerates a fresh install', async () => {
  const { stateRoot, configPath } = await makeFixture()
  const empty = readConfigControlStatus({ stateRoot, configPath })
  assert.deepEqual(empty, { probation: null, lastRollback: null, badEtag: null, runningEtag: null })

  const { control } = makeControl({ stateRoot, configPath })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')

  const status = readConfigControlStatus({ stateRoot, configPath })
  assert.equal(status.runningEtag, 'etag-1')
  assert.equal(status.probation?.etag, 'etag-1')
})

test('parseConfigShape accepts and validates plugin pin fields', () => {
  const ok = parseConfigShape({
    version: 2,
    plugins: [{ name: '@x/y', version: '1.2.3', artifact_hash: 'abc123', source: 'github:x/y' }],
  })
  assert.ok(ok.ok)
  assert.equal(ok.ok && ok.config.plugins?.[0].version, '1.2.3')
  assert.equal(ok.ok && ok.config.plugins?.[0].artifact_hash, 'abc123')
  assert.equal(ok.ok && ok.config.plugins?.[0].source, 'github:x/y')

  const bad = parseConfigShape({
    version: 2,
    plugins: [{ name: '@x/y', version: 7 }],
  })
  assert.ok(!bad.ok)
  assert.ok(!bad.ok && bad.errors.some((e) => e.pointer === '/plugins/0/version'))
})
