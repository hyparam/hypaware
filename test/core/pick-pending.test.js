// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  PICK_PENDING_TTL_MS,
  clearPickPendingMarker,
  isPickPending,
  pickPendingMarkerPath,
  writePickPendingMarker,
} from '../../src/core/usage-policy/pick_pending.js'
import { createSinkDriver } from '../../src/core/sinks/driver.js'

async function tmpStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-pick-pending-'))
}

/* --------------------------------------------------------------------------
 * The marker module (LLP 0093): freshness by mtime, bounded by TTL, never a
 * kill switch.
 * ------------------------------------------------------------------------ */

test('a written marker reads as pending; clearing it reads as absent', async () => {
  const stateDir = await tmpStateDir()
  assert.equal(await isPickPending({ stateDir }), false)
  await writePickPendingMarker({ stateDir })
  assert.equal(await isPickPending({ stateDir }), true)
  await clearPickPendingMarker({ stateDir })
  assert.equal(await isPickPending({ stateDir }), false)
})

test('clearing a missing marker is idempotent, not an error', async () => {
  const stateDir = await tmpStateDir()
  await clearPickPendingMarker({ stateDir })
  await clearPickPendingMarker({ stateDir })
})

test('a marker older than the TTL reads as absent and is unlinked (bounded hold, LLP 0093 #bounded)', async () => {
  const stateDir = await tmpStateDir()
  await writePickPendingMarker({ stateDir })
  const markerPath = pickPendingMarkerPath(stateDir)
  // Backdate the mtime past the TTL: an abandoned login's marker.
  const stale = new Date(Date.now() - PICK_PENDING_TTL_MS - 1000)
  await fs.utimes(markerPath, stale, stale)
  assert.equal(await isPickPending({ stateDir }), false)
  await assert.rejects(fs.stat(markerPath), /ENOENT/, 'the stale marker is opportunistically unlinked')
})

test('freshness honors an injected now (the driver passes its tick time)', async () => {
  const stateDir = await tmpStateDir()
  await writePickPendingMarker({ stateDir })
  assert.equal(await isPickPending({ stateDir, now: Date.now() }), true)
  assert.equal(await isPickPending({ stateDir, now: Date.now() + PICK_PENDING_TTL_MS + 1000 }), false)
})

test('an unreadable marker reads as absent, never a wedge (fail-open by design)', async () => {
  const stateDir = await tmpStateDir()
  const brokenFs = /** @type {any} */ ({ stat: async () => { throw new Error('EACCES: denied') } })
  assert.equal(await isPickPending({ stateDir, fs: brokenFs }), false)
})

/* --------------------------------------------------------------------------
 * Driver enforcement (LLP 0093): a fresh marker holds the whole tick; a
 * stale or absent one lets exports proceed.
 * ------------------------------------------------------------------------ */

/** A minimal driver whose one sink records exportBatch calls. */
function makeDriver(stateRoot) {
  /** @type {any[]} */
  const exports = []
  const handle = {
    instanceName: 'fwd',
    plugin: '@hypaware/test',
    kind: 'request',
    config: { schedule: '* * * * *' },
    sink: {
      exportBatch: async (/** @type {any} */ batch) => {
        exports.push(batch)
        return { status: 'exported', partitionsExported: 0, bytesWritten: 0 }
      },
    },
  }
  const driver = createSinkDriver({
    sinkRegistry: /** @type {any} */ ({ listHandles: () => [handle] }),
    queryRegistry: /** @type {any} */ ({ listDatasets: () => [] }),
    storage: /** @type {any} */ ({ cacheRoot: stateRoot, tableExists: () => false }),
    stateRoot,
  })
  return { driver, exports }
}

test('a fresh pick-pending marker holds the whole sink tick (no sink exports)', async () => {
  const stateRoot = await tmpStateDir()
  const { driver, exports } = makeDriver(stateRoot)
  await writePickPendingMarker({ stateDir: stateRoot })

  const held = await driver.tick({ force: true })
  assert.equal(held.held, 'pick_pending')
  assert.deepEqual(held.sinks, [])
  assert.equal(exports.length, 0, 'no sink may export while the pick is pending')

  // The pick lands (marker cleared): the next tick exports normally.
  await clearPickPendingMarker({ stateDir: stateRoot })
  const after = await driver.tick({ force: true })
  assert.equal(after.held, undefined)
  assert.equal(after.sinks.length, 1)
  assert.equal(exports.length, 1)
})

test('a stale marker does not hold the tick (abandoned login cannot stall exports)', async () => {
  const stateRoot = await tmpStateDir()
  const { driver, exports } = makeDriver(stateRoot)
  await writePickPendingMarker({ stateDir: stateRoot })
  const stale = new Date(Date.now() - PICK_PENDING_TTL_MS - 1000)
  await fs.utimes(pickPendingMarkerPath(stateRoot), stale, stale)

  const report = await driver.tick({ force: true })
  assert.equal(report.held, undefined)
  assert.equal(exports.length, 1, 'exports proceed past an expired hold')
})
