// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  FIRST_SYNC_MIN_LEAD_MS,
  computeFirstSyncDeadline,
  firstSyncHoldMarkerPath,
  readFirstSyncDeadline,
  writeFirstSyncHoldMarker,
} from '../../src/core/usage-policy/first_sync_hold.js'
import { createSinkDriver } from '../../src/core/sinks/driver.js'

async function tmpStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-first-sync-hold-'))
}

/* --------------------------------------------------------------------------
 * Deadline computation (LLP 0101 #deadline): the next local 11:59pm, rolled a
 * day forward when it is under the 4-hour floor.
 * ------------------------------------------------------------------------ */

/** The local 11:59:00.000pm on the same calendar day as `now`. */
function elevenFiftyNineToday(now) {
  const d = new Date(now)
  d.setHours(23, 59, 0, 0)
  return d.getTime()
}

test('deadline is the next local 11:59pm when that is comfortably away', () => {
  // 8:00am local: 23:59 today is ~16h away, well over the floor.
  const now = new Date(2026, 6, 13, 8, 0, 0, 0).getTime()
  const deadline = computeFirstSyncDeadline(now)
  assert.equal(deadline, elevenFiftyNineToday(now))
  const d = new Date(deadline)
  assert.equal(d.getHours(), 23)
  assert.equal(d.getMinutes(), 59)
  assert.equal(d.getDate(), 13, 'same calendar day')
})

test('deadline rolls to the following day when same-day 11:59pm is under the 4-hour floor', () => {
  // 10:00pm local: 23:59 today is only ~1h59m away, under the 4h floor.
  const now = new Date(2026, 6, 13, 22, 0, 0, 0).getTime()
  const deadline = computeFirstSyncDeadline(now)
  const d = new Date(deadline)
  assert.equal(d.getDate(), 14, 'rolled to the following day')
  assert.equal(d.getHours(), 23)
  assert.equal(d.getMinutes(), 59)
  assert.ok(deadline - now >= FIRST_SYNC_MIN_LEAD_MS, 'the rolled deadline clears the floor')
})

test('deadline exactly at the 4-hour boundary does not roll (floor is strict "less than")', () => {
  // now = 23:59 today minus exactly 4h => the same-day deadline is exactly the
  // floor away, which is NOT "less than" the floor, so it stands.
  const target = elevenFiftyNineToday(new Date(2026, 6, 13, 12, 0, 0, 0).getTime())
  const now = target - FIRST_SYNC_MIN_LEAD_MS
  const deadline = computeFirstSyncDeadline(now)
  assert.equal(deadline, target, 'exactly 4h away is kept, not rolled')
})

test('an enrollment after 11:59pm rolls to the next day (past same-day deadline is under the floor)', () => {
  const now = new Date(2026, 6, 13, 23, 59, 30, 0).getTime() // 30s past 23:59
  const deadline = computeFirstSyncDeadline(now)
  const d = new Date(deadline)
  assert.equal(d.getDate(), 14)
  assert.ok(deadline > now)
})

test('the deadline always lands on a local 23:59 and is strictly in the future (DST-agnostic invariant)', () => {
  // Sweep an hour-of-day spread; whatever the local offset or a DST edge, the
  // computed deadline is always a future local 23:59 (Date setters do the
  // local-time arithmetic, so DST transitions fall out correctly).
  for (const hour of [0, 6, 12, 19, 20, 21, 22, 23]) {
    const now = new Date(2026, 2, 8, hour, 30, 0, 0).getTime() // US DST spring-forward weekend
    const deadline = computeFirstSyncDeadline(now)
    const d = new Date(deadline)
    assert.equal(d.getHours(), 23, `hour ${hour}: deadline is at 23:xx local`)
    assert.equal(d.getMinutes(), 59, `hour ${hour}: deadline is at xx:59 local`)
    assert.ok(deadline > now, `hour ${hour}: deadline is in the future`)
    assert.ok(deadline - now >= FIRST_SYNC_MIN_LEAD_MS, `hour ${hour}: deadline clears the 4h floor`)
  }
})

/* --------------------------------------------------------------------------
 * The marker module (LLP 0101): the deadline lives INSIDE the marker, so it
 * survives incidental touches; corrupt or past reads as absent (fail-open).
 * ------------------------------------------------------------------------ */

test('a written marker reads back its future deadline; the deadline is stored, not derived from mtime', async () => {
  const stateDir = await tmpStateDir()
  assert.equal(await readFirstSyncDeadline({ stateDir }), null, 'absent before any write')
  const now = new Date(2026, 6, 13, 8, 0, 0, 0).getTime()
  const written = await writeFirstSyncHoldMarker({ stateDir, now })
  assert.equal(written, computeFirstSyncDeadline(now))
  // Read well after the write's wall clock but still before the deadline: the
  // hold is live because the deadline is in the body, not the file mtime.
  const read = await readFirstSyncDeadline({ stateDir, now: now + 3 * 60 * 60_000 })
  assert.equal(read, written)
})

test('a touched marker (mtime bumped) keeps its original deadline - incidental writes cannot shorten or extend the hold', async () => {
  const stateDir = await tmpStateDir()
  const now = new Date(2026, 6, 13, 8, 0, 0, 0).getTime()
  const written = await writeFirstSyncHoldMarker({ stateDir, now })
  const markerPath = firstSyncHoldMarkerPath(stateDir)
  // Bump mtime far into the future: were freshness mtime-based this would move
  // the hold; the deadline is in the body, so it does not.
  const future = new Date(Date.now() + 100 * 60_000)
  await fs.utimes(markerPath, future, future)
  assert.equal(await readFirstSyncDeadline({ stateDir, now: written - 1 }), written)
})

test('a past deadline reads as absent and is opportunistically unlinked (bounded hold, LLP 0101)', async () => {
  const stateDir = await tmpStateDir()
  const now = new Date(2026, 6, 13, 8, 0, 0, 0).getTime()
  const written = await writeFirstSyncHoldMarker({ stateDir, now })
  const markerPath = firstSyncHoldMarkerPath(stateDir)
  assert.equal(await readFirstSyncDeadline({ stateDir, now: written + 1000 }), null, 'past its deadline reads as absent')
  await assert.rejects(fs.stat(markerPath), /ENOENT/, 'the expired marker is opportunistically unlinked')
})

test('an unreadable marker reads as absent, never a wedge (fail-open by design)', async () => {
  const stateDir = await tmpStateDir()
  const brokenFs = /** @type {any} */ ({ readFile: async () => { throw new Error('EACCES: denied') } })
  assert.equal(await readFirstSyncDeadline({ stateDir, fs: brokenFs }), null)
})

test('a malformed marker (bad JSON or missing deadline) reads as absent (fail-open)', async () => {
  const stateDir = await tmpStateDir()
  const markerPath = firstSyncHoldMarkerPath(stateDir)
  await fs.mkdir(path.dirname(markerPath), { recursive: true })
  await fs.writeFile(markerPath, '{ not json')
  assert.equal(await readFirstSyncDeadline({ stateDir }), null, 'torn write reads as absent')
  await fs.writeFile(markerPath, JSON.stringify({ version: 1, created_at: 'x' })) // no deadline_ms
  assert.equal(await readFirstSyncDeadline({ stateDir }), null, 'a marker without a numeric deadline reads as absent')
})

/* --------------------------------------------------------------------------
 * Driver enforcement (LLP 0101 #hold): a live deadline holds the whole tick;
 * an expired or absent one lets exports proceed.
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

test('a live first-sync hold holds the whole sink tick (no sink exports); the tick after the deadline exports', async () => {
  const stateRoot = await tmpStateDir()
  const { driver, exports } = makeDriver(stateRoot)
  const enrolledAt = new Date(2026, 6, 13, 8, 0, 0, 0).getTime()
  const deadline = await writeFirstSyncHoldMarker({ stateDir: stateRoot, now: enrolledAt })

  // A tick before the deadline: the whole tick is held.
  const held = await driver.tick({ force: true, now: new Date(deadline - 60_000) })
  assert.equal(held.held, 'first_sync_hold')
  assert.deepEqual(held.sinks, [])
  assert.equal(exports.length, 0, 'no sink may export while the review window is open')

  // The first tick at/after the deadline exports normally (and unlinks the marker).
  const after = await driver.tick({ force: true, now: new Date(deadline + 1000) })
  assert.equal(after.held, undefined)
  assert.equal(after.sinks.length, 1)
  assert.equal(exports.length, 1)
})

test('an expired marker does not hold the tick (a bounded hold can never stall exports past its deadline)', async () => {
  const stateRoot = await tmpStateDir()
  const { driver, exports } = makeDriver(stateRoot)
  const enrolledAt = new Date(2026, 6, 13, 8, 0, 0, 0).getTime()
  const deadline = await writeFirstSyncHoldMarker({ stateDir: stateRoot, now: enrolledAt })

  const report = await driver.tick({ force: true, now: new Date(deadline + 60_000) })
  assert.equal(report.held, undefined)
  assert.equal(exports.length, 1, 'exports proceed past an expired hold')
})

test('no marker means no hold: exports proceed on the first tick', async () => {
  const stateRoot = await tmpStateDir()
  const { driver, exports } = makeDriver(stateRoot)
  const report = await driver.tick({ force: true })
  assert.equal(report.held, undefined)
  assert.equal(exports.length, 1)
})
