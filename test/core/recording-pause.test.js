// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  __test,
  createRecordingPauseFilter,
  pauseRecording,
  readPausedSince,
  readPauseWindows,
  recordingPausePath,
  resumeRecording,
} from '../../src/core/usage-policy/recording_pause.js'

async function rig(t) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-pause-'))
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }))
  return stateDir
}

const at = (ms) => ({ session_id: 's', message_created_at: new Date(ms).toISOString() })

test('no pause state keeps every row and returns the same array', async t => {
  const stateDir = await rig(t)
  const rows = [at(1000)]
  assert.equal(createRecordingPauseFilter(stateDir).keep(rows), rows)
  assert.equal(await readPausedSince({ stateDir }), null)
})

test('a live pause drops rows from its start onward', async t => {
  const stateDir = await rig(t)
  await pauseRecording({ stateDir, now: 2000 })
  const kept = createRecordingPauseFilter(stateDir).keep([at(1999), at(2000), at(9000)])
  assert.deepEqual(kept, [at(1999)])
  assert.equal(await readPausedSince({ stateDir }), 2000)
})

// @ref LLP 0579#windows [tests]: importing after a resume can't bring the pause back
test('after a resume the paused time stays out, and later rows are kept', async t => {
  const stateDir = await rig(t)
  await pauseRecording({ stateDir, now: 2000 })
  await resumeRecording({ stateDir, now: 3000 })
  const kept = createRecordingPauseFilter(stateDir).keep([at(1000), at(2500), at(3000), at(4000)])
  assert.deepEqual(kept, [at(1000), at(3000), at(4000)])
  assert.equal(await readPausedSince({ stateDir }), null)
})

test('several pauses each keep their window', async t => {
  const stateDir = await rig(t)
  await pauseRecording({ stateDir, now: 100 })
  await resumeRecording({ stateDir, now: 200 })
  await pauseRecording({ stateDir, now: 300 })
  await resumeRecording({ stateDir, now: 400 })
  assert.equal((await readPauseWindows({ stateDir })).length, 2)
  const kept = createRecordingPauseFilter(stateDir).keep([at(150), at(250), at(350), at(450)])
  assert.deepEqual(kept, [at(250), at(450)])
})

test('pausing twice keeps the first start, and resuming twice is harmless', async t => {
  const stateDir = await rig(t)
  assert.deepEqual(await pauseRecording({ stateDir, now: 100 }), { since: 100, changed: true })
  assert.deepEqual(await pauseRecording({ stateDir, now: 200 }), { since: 100, changed: false })
  assert.deepEqual(await resumeRecording({ stateDir, now: 300 }), { changed: true })
  assert.deepEqual(await resumeRecording({ stateDir, now: 400 }), { changed: false })
  assert.deepEqual(await readPauseWindows({ stateDir }), [{ start: 100, end: 300 }])
})

test('the running filter picks up a pause and a resume from another process', async t => {
  const stateDir = await rig(t)
  const filter = createRecordingPauseFilter(stateDir)
  assert.equal(filter.keep([at(5000)]).length, 1)
  await pauseRecording({ stateDir, now: 1000 })
  assert.equal(filter.keep([at(5000)]).length, 0)
  await resumeRecording({ stateDir, now: 2000 })
  assert.equal(filter.keep([at(5000)]).length, 1)
})

// @ref LLP 0579#fail-closed [tests]: nothing is written when the state can't be read
test('unreadable state counts as paused', async t => {
  const stateDir = await rig(t)
  await fs.mkdir(path.dirname(recordingPausePath(stateDir)), { recursive: true })
  await fs.writeFile(recordingPausePath(stateDir), 'not json')
  assert.deepEqual(createRecordingPauseFilter(stateDir).keep([at(5000)]), [])
  assert.equal(await readPausedSince({ stateDir }), 0)
  await assert.rejects(pauseRecording({ stateDir }))
})

test('a row with no time is dropped only during a live pause, and only from a session', async t => {
  const stateDir = await rig(t)
  const filter = createRecordingPauseFilter(stateDir)
  const session = { session_id: 's' }
  const derived = { node_id: 'n' }
  await pauseRecording({ stateDir, now: 1000 })
  assert.deepEqual(filter.keep([session, derived]), [derived])
  await resumeRecording({ stateDir, now: 2000 })
  assert.deepEqual(filter.keep([session, derived]), [session, derived])
})

test('row times read whichever column and unit a recorder used', () => {
  const ms = Date.parse('2026-11-04T10:00:00.000Z')
  assert.equal(__test.rowTimeMs({ message_created_at: new Date(ms) }), ms)
  assert.equal(__test.rowTimeMs({ event_timestamp: '2026-11-04T10:00:00.000Z' }), ms)
  assert.equal(__test.rowTimeMs({ timestamp: ms }), ms)
  assert.equal(__test.rowTimeMs({ timestamp: ms * 1000 }), ms)
  assert.equal(__test.rowTimeMs({ timestamp: BigInt(ms) * 1000n }), ms)
  assert.equal(__test.rowTimeMs({ timestamp: ms / 1000 }), ms)
  assert.equal(__test.rowTimeMs({ other: 1 }), null)
  assert.equal(__test.rowTimeMs({ timestamp: 'garbage' }), null)
})
