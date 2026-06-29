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
  centralSeedPath,
  createConfigControl,
  readConfigControlStatus,
  resolveCentralLayerPath,
} from '../../src/core/config/apply.js'
import { parseConfigShape } from '../../src/core/config/schema.js'

/**
 * @import { PluginConfigInstance } from '../../collectivus-plugin-kernel-types.js'
 * @import { ConfigApplyDeps, PinnedInstallResult } from '../../src/core/config/types.js'
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
  // `join` writes the seed (the initial central layer) under
  // config-control/, never to the user-owned hypaware-config.json.
  const seedPath = centralSeedPath(stateRoot)
  await fsp.mkdir(path.dirname(seedPath), { recursive: true })
  await fsp.writeFile(seedPath, JSON.stringify(SEED_CONFIG, null, 2) + '\n')
  return { tmp, stateRoot, seedPath }
}

/** Read whatever the central-layer pointer currently resolves to. */
function readCentralLayer(stateRoot) {
  const p = resolveCentralLayerPath({ stateRoot })
  if (!p) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
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
 * @param {{ stateRoot: string, now?: () => number }} args
 */
function makeControl({ stateRoot, now }) {
  /** @type {string[]} */
  const restarts = []
  /** @type {string[]} */
  const confirmedEdges = []
  const control = createConfigControl({
    stateRoot,
    requestRestart: (reason) => { restarts.push(reason) },
    onConfirmed: (etag) => { confirmedEdges.push(etag) },
    ...(now ? { now } : {}),
  })
  return { control, restarts, confirmedEdges }
}

test('stage applies a document: slot persisted, pointer flipped, etag staged, probation armed, restart requested', async () => {
  const { stateRoot } = await makeFixture()
  const { control, restarts } = makeControl({ stateRoot })
  control.attachApplyDeps(makeDeps())

  const result = await control.stage(REMOTE_CONFIG, 'etag-1')
  assert.deepEqual(result, { ok: true, action: 'applied' })
  assert.deepEqual(restarts, ['config_applied'])

  // The active-slot pointer (inside config-control/, not the user config)
  // is now a symlink resolving to the new doc.
  const pointer = path.join(stateRoot, 'config-control', 'active')
  const stat = await fsp.lstat(pointer)
  assert.ok(stat.isSymbolicLink())
  assert.deepEqual(readCentralLayer(stateRoot).plugins, REMOTE_CONFIG.plugins)

  // The seed was preserved as the rollback target, and retired from its
  // own file once the apply succeeded.
  const slotA = JSON.parse(
    await fsp.readFile(path.join(stateRoot, 'config-control', 'config.a.json'), 'utf8')
  )
  assert.deepEqual(slotA, SEED_CONFIG)
  assert.equal(fs.existsSync(centralSeedPath(stateRoot)), false)

  assert.equal(control.runningEtag(), 'etag-1')
  const status = await control.status()
  assert.equal(status.probation?.etag, 'etag-1')
  assert.equal(status.probation?.slot, 'b')
  assert.equal(status.probation?.previous_slot, 'a')
})

test('probation window is max(3 × poll interval, floor) from the staged document', async () => {
  const { stateRoot } = await makeFixture()
  const t0 = Date.parse('2026-06-12T00:00:00.000Z')
  const { control } = makeControl({ stateRoot, now: () => t0 })
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
  const relaunch = makeControl({ stateRoot, now: () => t0 })
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
  const { stateRoot } = await makeFixture()
  const { control, restarts } = makeControl({ stateRoot })
  const result = await control.stage(REMOTE_CONFIG, 'etag-1')
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.errorKind, 'apply_engine_not_ready')
  assert.deepEqual(restarts, [])
})

test('validation failure remembers the bad etag and leaves the central layer untouched', async () => {
  const { stateRoot, seedPath } = await makeFixture()
  const { control, restarts } = makeControl({ stateRoot })
  control.attachApplyDeps(makeDeps({ validateOk: false }))

  const result = await control.stage(REMOTE_CONFIG, 'etag-bad')
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.errorKind, 'config_invalid')
  assert.deepEqual(restarts, [])

  // Still the seed, no pointer flipped, no slot written.
  assert.equal(fs.existsSync(path.join(stateRoot, 'config-control', 'active')), false)
  assert.equal(resolveCentralLayerPath({ stateRoot }), seedPath)
  assert.deepEqual(readCentralLayer(stateRoot), SEED_CONFIG)
  const status = await control.status()
  assert.equal(status.badEtag?.etag, 'etag-bad')
  assert.equal(status.badEtag?.reason, 'validation_failed')
  assert.equal(status.runningEtag, null)
})

test('pinned plugins install before full validation, so a config can name a not-yet-installed plugin', async () => {
  // Catalog-backed validation only knows a plugin once it is installed;
  // install-on-config breaks if validation runs first (LLP 0025
  // install-on-config). The shape gate runs before install instead.
  const { stateRoot } = await makeFixture()
  const { control } = makeControl({ stateRoot })
  const deps = makeDeps()
  control.attachApplyDeps(deps)

  const result = await control.stage(REMOTE_CONFIG, 'etag-order')
  assert.equal(result.ok, true)
  assert.deepEqual(deps.calls, ['install', 'validate'])
})

test('a shape-invalid document is rejected before any install runs', async () => {
  const { stateRoot } = await makeFixture()
  const { control } = makeControl({ stateRoot })
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
  const { stateRoot } = await makeFixture()
  const { control } = makeControl({ stateRoot })
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
  const { stateRoot } = await makeFixture()
  const { control, restarts } = makeControl({ stateRoot })
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
  const { stateRoot } = await makeFixture()
  const { control } = makeControl({ stateRoot })
  const deps = makeDeps()
  control.attachApplyDeps(deps)

  const huge = { ...REMOTE_CONFIG, padding: 'x'.repeat(MAX_CONFIG_DOCUMENT_BYTES) }
  const result = await control.stage(huge, 'etag-huge')
  assert.equal(!result.ok && result.errorKind, 'document_too_large')
  assert.equal(deps.validateCalls, 0)
})

test('staging the running etag is a no-op', async () => {
  const { stateRoot } = await makeFixture()
  const first = makeControl({ stateRoot })
  first.control.attachApplyDeps(makeDeps())
  await first.control.stage(REMOTE_CONFIG, 'etag-1')

  // Relaunch: a fresh engine over the same state.
  const second = makeControl({ stateRoot })
  second.control.attachApplyDeps(makeDeps())
  const result = await second.control.stage(REMOTE_CONFIG, 'etag-1')
  assert.deepEqual(result, { ok: true, action: 'noop_same_etag' })
})

test('a second stage in the same process is refused while a restart is pending', async () => {
  const { stateRoot } = await makeFixture()
  const { control } = makeControl({ stateRoot })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')
  const result = await control.stage(REMOTE_CONFIG, 'etag-2')
  assert.equal(!result.ok && result.errorKind, 'restart_pending')
})

test('confirmPoll clears probation', async () => {
  const { stateRoot } = await makeFixture()
  const { control } = makeControl({ stateRoot })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')

  control.confirmPoll()
  const status = await control.status()
  assert.equal(status.probation, null)
  assert.equal(status.runningEtag, 'etag-1')
  // Idempotent.
  control.confirmPoll()
})

test('onConfirmed fires exactly on the probation active→cleared edge, not on a no-probation poll', async () => {
  const { stateRoot } = await makeFixture()

  // A poll before anything is under probation is not an edge.
  const idle = makeControl({ stateRoot })
  idle.control.attachApplyDeps(makeDeps())
  idle.control.confirmPoll()
  assert.deepEqual(idle.confirmedEdges, [])

  // Apply puts a revision under probation; the first confirming poll is the
  // active→cleared edge and fires the hook once with the cleared etag.
  await idle.control.stage(REMOTE_CONFIG, 'etag-1')
  idle.control.confirmPoll()
  assert.deepEqual(idle.confirmedEdges, ['etag-1'])

  // Further polls with no active probation do not re-fire the edge.
  idle.control.confirmPoll()
  assert.deepEqual(idle.confirmedEdges, ['etag-1'])
})

test('chained applies alternate slots and roll back one revision', async () => {
  const { stateRoot } = await makeFixture()

  const first = makeControl({ stateRoot })
  first.control.attachApplyDeps(makeDeps())
  await first.control.stage(REMOTE_CONFIG, 'etag-1')

  // Relaunch, probation clears, a newer revision arrives.
  const second = makeControl({ stateRoot })
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
  const third = makeControl({ stateRoot, now: () => future })
  const evaluated = await third.control.evaluateAtBoot()
  assert.equal(evaluated.action, 'rolled_back')
  assert.equal(third.control.runningEtag(), 'etag-1')
  const rolled = await third.control.status()
  assert.equal(rolled.lastRollback?.etag, 'etag-2')
  assert.equal(rolled.lastRollback?.reason, 'probation_expired')
  assert.equal(rolled.badEtag?.etag, 'etag-2')
})

test('evaluateAtBoot rolls an expired first apply back onto the seed', async () => {
  const { stateRoot } = await makeFixture()
  const { control } = makeControl({ stateRoot })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')

  const future = Date.now() + 10 * 24 * 60 * 60 * 1000
  const relaunch = makeControl({ stateRoot, now: () => future })
  const evaluated = await relaunch.control.evaluateAtBoot()
  assert.equal(evaluated.action, 'rolled_back')

  // Rolled back onto the seed bytes preserved in slot 'a'.
  assert.deepEqual(readCentralLayer(stateRoot), SEED_CONFIG)
  assert.equal(relaunch.control.runningEtag(), undefined)
})

test('evaluateAtBoot keeps an unexpired probation marker', async () => {
  const { stateRoot } = await makeFixture()
  const { control } = makeControl({ stateRoot })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')

  const relaunch = makeControl({ stateRoot })
  const evaluated = await relaunch.control.evaluateAtBoot()
  assert.equal(evaluated.action, 'none')
  const status = await relaunch.control.status()
  assert.equal(status.probation?.etag, 'etag-1')
})

test('evaluateAtBoot discards a probation marker whose flip never committed', async () => {
  const { stateRoot } = await makeFixture()
  const { control } = makeControl({ stateRoot })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')

  // Simulate a crash between the marker write and the pointer flip by
  // pointing the marker at the slot that is NOT active.
  const statePath = path.join(stateRoot, 'config-control', 'state.json')
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.probation.slot = 'a'
  fs.writeFileSync(statePath, JSON.stringify(state))

  const relaunch = makeControl({ stateRoot })
  const evaluated = await relaunch.control.evaluateAtBoot()
  assert.equal(evaluated.action, 'cleared_orphan')
  const status = await relaunch.control.status()
  assert.equal(status.probation, null)
  // The operative central config is untouched by orphan cleanup.
  assert.equal(relaunch.control.runningEtag(), 'etag-1')
})

test('the probation watchdog rolls back and requests a restart on expiry', async () => {
  const { stateRoot } = await makeFixture()
  const { control, restarts } = makeControl({ stateRoot })
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
  assert.deepEqual(readCentralLayer(stateRoot), SEED_CONFIG)
})

test('a confirmed poll disarms the watchdog before it fires', async () => {
  const { stateRoot } = await makeFixture()
  const { control, restarts } = makeControl({ stateRoot })
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
  const { stateRoot } = await makeFixture()
  const empty = readConfigControlStatus({ stateRoot })
  assert.deepEqual(empty, { probation: null, lastRollback: null, badEtag: null, runningEtag: null })

  const { control } = makeControl({ stateRoot })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')

  const status = readConfigControlStatus({ stateRoot })
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
