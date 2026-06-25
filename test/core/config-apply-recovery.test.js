// @ts-check

// Regression tests for #141: an active config slot must never be marked
// `bad_etag` while it stays active. That contradiction (the "bad" config
// stays operative, the bad-etag backoff then refuses to re-apply the very
// revision that is running, probation bookkeeping never clears) wedged
// central with no boot recovery on a real machine, surviving restarts until
// the slot was deleted by hand. Two guards close it: (1) a rollback with no
// distinct `previous_slot` surfaces a clear error instead of recording the
// active etag as bad; (2) a boot-time consistency check recovers if the
// active slot's etag is already marked bad.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  centralSeedPath,
  createConfigControl,
  resolveCentralLayerPath,
} from '../../src/core/config/apply.js'

/**
 * @import { PluginConfigInstance } from '../../collectivus-plugin-kernel-types.d.ts'
 * @import { ConfigApplyDeps } from '../../src/core/config/types.d.ts'
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

/** A state root with **no** join seed — so a first apply has nowhere to
 * roll back to (`previous_slot` is null), exactly the single-usable-slot
 * case behind #141. */
async function makeSeedlessFixture() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-config-recover-'))
  const stateRoot = path.join(tmp, 'hypaware')
  await fsp.mkdir(path.join(stateRoot, 'config-control'), { recursive: true })
  return { tmp, stateRoot }
}

function readCentralLayer(stateRoot) {
  const p = resolveCentralLayerPath({ stateRoot })
  if (!p) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/** @returns {ConfigApplyDeps} */
function makeDeps() {
  return {
    async validateDocument() { return { ok: true, errors: [] } },
    async installPinnedPlugins() { return { ok: true } },
  }
}

/** @param {{ stateRoot: string, now?: () => number }} args */
function makeControl({ stateRoot, now }) {
  /** @type {string[]} */
  const restarts = []
  const control = createConfigControl({
    stateRoot,
    requestRestart: (reason) => { restarts.push(reason) },
    ...(now ? { now } : {}),
  })
  return { control, restarts }
}

function readState(stateRoot) {
  const p = path.join(stateRoot, 'config-control', 'state.json')
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function writeState(stateRoot, state) {
  const p = path.join(stateRoot, 'config-control', 'state.json')
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + '\n')
}

test('an expired first apply with no distinct previous slot does not mark the active etag bad', async () => {
  // Seedless first apply: commit() lands on slot 'b' with previous_slot=null
  // (the single usable slot). When probation expires there is nowhere to
  // roll back to — the engine must NOT record the still-active etag as
  // bad_etag (that is the #141 wedge).
  const { stateRoot } = await makeSeedlessFixture()
  const { control } = makeControl({ stateRoot })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')
  assert.equal(control.runningEtag(), 'etag-1')

  const future = Date.now() + 10 * 24 * 60 * 60 * 1000
  const relaunch = makeControl({ stateRoot, now: () => future })
  const evaluated = await relaunch.control.evaluateAtBoot()

  // A clear, non-silent outcome (not a fake "rolled_back").
  assert.equal(evaluated.action, 'rollback_no_target')

  const status = await relaunch.control.status()
  // The contradiction must not exist: with no bad_etag recorded, the active
  // etag can never equal it.
  assert.equal(status.badEtag, null)
  // The config keeps running (it is all the gateway has) and probation is
  // cleared so there is no rollback loop.
  assert.equal(relaunch.control.runningEtag(), 'etag-1')
  assert.equal(status.probation, null)
})

test('the watchdog does not loop-restart when a no-op rollback has no target', async () => {
  const { stateRoot } = await makeSeedlessFixture()
  const { control, restarts } = makeControl({ stateRoot })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')
  assert.deepEqual(restarts, ['config_applied'])

  // Shrink the live window so the real timer fires fast.
  const state = readState(stateRoot)
  state.probation.until = new Date(Date.now() + 20).toISOString()
  writeState(stateRoot, state)

  control.armProbationWatchdog()
  await new Promise((resolve) => setTimeout(resolve, 100))

  // No second restart: a rollback that cannot flip must not request a
  // staged restart onto the same config (that is an infinite restart loop).
  assert.deepEqual(restarts, ['config_applied'])
  const status = await control.status()
  assert.equal(status.badEtag, null)
  assert.equal(status.probation, null)
  assert.equal(control.runningEtag(), 'etag-1')
})

test('boot recovers an already-wedged active slot by clearing the contradictory bad_etag (re-pull)', async () => {
  // Simulate a machine wedged by the old code: active slot etag == bad_etag,
  // probation already cleared. A boot must un-wedge instead of persisting
  // the contradiction forever.
  const { stateRoot } = await makeSeedlessFixture()
  const { control } = makeControl({ stateRoot })
  control.attachApplyDeps(makeDeps())
  await control.stage(REMOTE_CONFIG, 'etag-1')
  assert.equal(control.runningEtag(), 'etag-1')

  // Hand-author the contradiction the old rollback produced.
  writeState(stateRoot, {
    bad_etag: { etag: 'etag-1', reason: 'probation_expired', recorded_at: new Date().toISOString() },
  })

  const relaunch = makeControl({ stateRoot })
  const evaluated = await relaunch.control.evaluateAtBoot()
  assert.equal(evaluated.action, 'recovered_bad_active')
  assert.equal(evaluated.recovery, 'repull')

  const status = await relaunch.control.status()
  // bad_etag cleared so the next poll can re-validate / converge.
  assert.equal(status.badEtag, null)
  // Config still operative (nowhere else to go) and not contradicted.
  assert.equal(relaunch.control.runningEtag(), 'etag-1')
})

test('boot recovers a wedged active slot by falling back to the seed when one survives', async () => {
  // Wedged state where a seed still exists on disk: recovery should drop the
  // active pointer so boot resolves the central layer back to the seed.
  const { stateRoot } = await makeSeedlessFixture()
  const controlDir = path.join(stateRoot, 'config-control')

  // Author an applied slot 'b' (etag-1) that is the active pointer, plus a
  // surviving seed and a bad_etag matching the active slot.
  fs.writeFileSync(path.join(controlDir, 'config.b.json'), JSON.stringify(REMOTE_CONFIG, null, 2) + '\n')
  fs.writeFileSync(path.join(controlDir, 'config.b.etag'), 'etag-1\n')
  const tmpLink = path.join(controlDir, 'active.tmp')
  fs.symlinkSync('config.b.json', tmpLink)
  fs.renameSync(tmpLink, path.join(controlDir, 'active'))
  fs.writeFileSync(centralSeedPath(stateRoot), JSON.stringify(SEED_CONFIG, null, 2) + '\n')
  writeState(stateRoot, {
    bad_etag: { etag: 'etag-1', reason: 'probation_expired', recorded_at: new Date().toISOString() },
  })

  const { control } = makeControl({ stateRoot })
  assert.equal(control.runningEtag(), 'etag-1')

  const evaluated = await control.evaluateAtBoot()
  assert.equal(evaluated.action, 'recovered_bad_active')
  assert.equal(evaluated.recovery, 'seed')

  // Central layer now resolves to the seed; running etag is unset (seed mode).
  assert.deepEqual(readCentralLayer(stateRoot), SEED_CONFIG)
  assert.equal(control.runningEtag(), undefined)
  const status = await control.status()
  assert.equal(status.badEtag, null)
})
