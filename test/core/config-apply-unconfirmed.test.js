// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  UNCONFIRMED_RETRY_BACKOFF_MS,
  centralSeedPath,
  createConfigControl,
  readConfigControlStatus,
} from '../../src/core/config/apply.js'

/**
 * @import { TestContext } from 'node:test'
 * @import { ConfigApplyDeps } from '../../src/core/config/types.js'
 */

// A probation that expires while a sink could not materialize is recorded as
// "could not confirm", and the same revision is retried without operator
// action (issue #2547). A genuinely bad revision still waits for a new etag.

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

const T0 = Date.parse('2026-10-16T00:00:00.000Z')
const HOUR = 60 * 60 * 1000

/** @param {TestContext} t */
async function makeFixture(t) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hyp-config-unconfirmed-'))
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }))
  const stateRoot = path.join(tmp, 'hypaware')
  const seedPath = centralSeedPath(stateRoot)
  await fsp.mkdir(path.dirname(seedPath), { recursive: true })
  await fsp.writeFile(seedPath, JSON.stringify(SEED_CONFIG, null, 2) + '\n')
  return stateRoot
}

/**
 * @param {{ validateOk?: boolean }} [opts]
 * @returns {ConfigApplyDeps}
 */
function makeDeps(opts = {}) {
  return {
    async validateDocument() {
      return opts.validateOk === false
        ? { ok: false, errors: [{ pointer: '/plugins/0', message: 'nope' }] }
        : { ok: true, errors: [] }
    },
    async installPinnedPlugins() { return { ok: true } },
  }
}

/**
 * One daemon boot: a fresh engine over the same state root, with its own
 * clock and client version.
 * @param {{ stateRoot: string, clock: { at: number }, clientVersion: string, deps?: ConfigApplyDeps }} args
 */
function boot({ stateRoot, clock, clientVersion, deps }) {
  /** @type {string[]} */
  const restarts = []
  /** @type {string[]} */
  const confirmed = []
  const control = createConfigControl({
    stateRoot,
    requestRestart: (reason) => { restarts.push(reason) },
    onConfirmed: (etag) => { confirmed.push(etag) },
    clientVersion,
    now: () => clock.at,
  })
  control.attachApplyDeps(deps ?? makeDeps())
  return { control, restarts, confirmed }
}

/** @param {string} stateRoot */
function state(stateRoot) {
  return readConfigControlStatus({ stateRoot })
}

// @ref LLP 0517#retry [tests]: the same etag is retried once the backoff elapses
test('a probation that expires while a sink failed is retried after the backoff and confirms', async (t) => {
  const stateRoot = await makeFixture(t)
  const clock = { at: T0 }
  const version = '1.40.0'

  // The seed boot pulls etag-1 and applies it.
  const seed = boot({ stateRoot, clock, clientVersion: version })
  assert.equal((await seed.control.stage(REMOTE_CONFIG, 'etag-1')).ok, true)

  // The staged restart boots etag-1, its sink fails to materialize, so no
  // poll confirms, and the in-process watchdog expires the window.
  const probation = boot({ stateRoot, clock, clientVersion: version })
  assert.equal((await probation.control.evaluateAtBoot()).action, 'none')
  probation.control.noteSinkMaterializeFailed()
  clock.at = T0 + HOUR
  probation.control.armProbationWatchdog()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(probation.restarts, ['probation_expired'])

  const rolledBack = await state(stateRoot)
  assert.equal(rolledBack.runningEtag, null)
  assert.equal(rolledBack.lastRollback?.reason, 'probation_unconfirmed')
  assert.deepEqual(rolledBack.badEtag, {
    etag: 'etag-1',
    reason: 'probation_unconfirmed',
    recorded_at: new Date(T0 + HOUR).toISOString(),
    client_version: version,
  })

  // Back on the seed: inside the backoff the same etag is held back.
  const back = boot({ stateRoot, clock, clientVersion: version })
  assert.equal((await back.control.evaluateAtBoot()).action, 'none')
  clock.at = T0 + HOUR + UNCONFIRMED_RETRY_BACKOFF_MS - 1
  assert.deepEqual(await back.control.stage(REMOTE_CONFIG, 'etag-1'), { ok: true, action: 'skipped_bad_etag' })

  // Once the backoff elapses the same etag applies again, unprompted.
  clock.at = T0 + HOUR + UNCONFIRMED_RETRY_BACKOFF_MS
  assert.deepEqual(await back.control.stage(REMOTE_CONFIG, 'etag-1'), { ok: true, action: 'applied' })
  const retried = await state(stateRoot)
  assert.equal(retried.badEtag, null)
  assert.equal(retried.probation?.etag, 'etag-1')

  // The retry boots with a healthy sink and the first poll confirms it.
  const healthy = boot({ stateRoot, clock, clientVersion: version })
  assert.equal((await healthy.control.evaluateAtBoot()).action, 'none')
  healthy.control.confirmPoll()
  assert.deepEqual(healthy.confirmed, ['etag-1'])
  const confirmed = await state(stateRoot)
  assert.equal(confirmed.runningEtag, 'etag-1')
  assert.equal(confirmed.probation, null)
  assert.equal(confirmed.lastRollback, null)
  assert.equal(confirmed.badEtag, null)
})

// @ref LLP 0517#retry [tests]: a client version change retries at once
test('a client version change retries an unconfirmed revision at once', async (t) => {
  const stateRoot = await makeFixture(t)
  const clock = { at: T0 }

  const seed = boot({ stateRoot, clock, clientVersion: '1.40.0' })
  await seed.control.stage(REMOTE_CONFIG, 'etag-1')

  const probation = boot({ stateRoot, clock, clientVersion: '1.40.0' })
  await probation.control.evaluateAtBoot()
  probation.control.noteSinkMaterializeFailed()

  // The window passes while the daemon is down; the next boot expires it.
  clock.at = T0 + HOUR
  const expired = boot({ stateRoot, clock, clientVersion: '1.40.0' })
  assert.equal((await expired.control.evaluateAtBoot()).action, 'rolled_back')
  assert.equal((await state(stateRoot)).badEtag?.reason, 'probation_unconfirmed')
  assert.deepEqual(await expired.control.stage(REMOTE_CONFIG, 'etag-1'), { ok: true, action: 'skipped_bad_etag' })

  // The client upgrades a minute later: well inside the backoff, the same
  // etag applies on the first poll.
  clock.at = T0 + HOUR + 60 * 1000
  const upgraded = boot({ stateRoot, clock, clientVersion: '1.41.0' })
  assert.equal((await upgraded.control.evaluateAtBoot()).action, 'none')
  assert.deepEqual(await upgraded.control.stage(REMOTE_CONFIG, 'etag-1'), { ok: true, action: 'applied' })

  const healthy = boot({ stateRoot, clock, clientVersion: '1.41.0' })
  assert.equal((await healthy.control.evaluateAtBoot()).action, 'none')
  healthy.control.confirmPoll()
  const confirmed = await state(stateRoot)
  assert.equal(confirmed.runningEtag, 'etag-1')
  assert.equal(confirmed.lastRollback, null)
  assert.equal(confirmed.badEtag, null)
})

// @ref LLP 0517#bad-unchanged [tests]: a bad revision still waits for a new etag
test('a genuinely bad revision is still skipped as bad_etag', async (t) => {
  const stateRoot = await makeFixture(t)
  const clock = { at: T0 }

  // Sinks healthy, but no poll confirmed: a plain expiry.
  const seed = boot({ stateRoot, clock, clientVersion: '1.40.0' })
  await seed.control.stage(REMOTE_CONFIG, 'etag-1')
  clock.at = T0 + HOUR
  const expired = boot({ stateRoot, clock, clientVersion: '1.40.0' })
  assert.equal((await expired.control.evaluateAtBoot()).action, 'rolled_back')
  const plain = await state(stateRoot)
  assert.equal(plain.lastRollback?.reason, 'probation_expired')
  assert.deepEqual(plain.badEtag, {
    etag: 'etag-1',
    reason: 'probation_expired',
    recorded_at: new Date(T0 + HOUR).toISOString(),
  })

  // A sink failure with no probation open changes nothing.
  expired.control.noteSinkMaterializeFailed()
  assert.deepEqual((await state(stateRoot)).badEtag, plain.badEtag)

  // Neither the backoff nor an upgrade lets the same etag back in.
  clock.at = T0 + HOUR + 2 * UNCONFIRMED_RETRY_BACKOFF_MS
  const later = boot({ stateRoot, clock, clientVersion: '1.41.0' })
  assert.deepEqual(await later.control.stage(REMOTE_CONFIG, 'etag-1'), { ok: true, action: 'skipped_bad_etag' })

  // A revision that fails validation stays skipped the same way.
  const invalid = boot({ stateRoot, clock, clientVersion: '1.41.0', deps: makeDeps({ validateOk: false }) })
  assert.equal((await invalid.control.stage(REMOTE_CONFIG, 'etag-2')).ok, false)
  assert.equal((await state(stateRoot)).badEtag?.reason, 'validation_failed')
  clock.at += 2 * UNCONFIRMED_RETRY_BACKOFF_MS
  const upgradedAgain = boot({ stateRoot, clock, clientVersion: '1.42.0' })
  assert.deepEqual(await upgradedAgain.control.stage(REMOTE_CONFIG, 'etag-2'), { ok: true, action: 'skipped_bad_etag' })
})
