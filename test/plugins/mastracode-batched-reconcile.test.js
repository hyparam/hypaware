// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MASTRACODE_CATCH_UP_DELAY_MS,
  MASTRACODE_ROWS_PER_TICK,
  MASTRACODE_THREADS_PER_TICK,
  createMastracodePollRunner,
  runMastracodePollTick,
  startMastracodeSource,
} from '../../hypaware-core/plugins-workspace/mastracode/src/source.js'
import { capMastraWatermarkThreads } from '../../hypaware-core/plugins-workspace/mastracode/src/watermark.js'
import { assistantContent, insertMessage, openWriter, textPart, updateThread, userContent } from '../helpers/mastracode_db_fixture.js'
import { addThread, addTurn, createMastracodeHarness, mastracodePollLogs, nextUpdatedAt, texts } from '../helpers/mastracode_source_fixture.js'

/** @import { DatabaseSync as SqliteDatabase } from 'node:sqlite' */

/**
 * @ref LLP 0527#tick-budget [tests]: a tick admits at most 64 threads or
 *   4096 rows, and a catch-up tick takes the leftovers with no further write.
 * @ref LLP 0586#cost [tests]: settled unchanged threads are not hashed, and
 *   the watermark cap evicts the oldest entry, which is not hashed again
 *   until it changes.
 *
 * Synthetic rows only, written through the fixture's own connection between
 * ticks, as Mastra Code writes.
 */

/** Distinct threads with committed message rows. @param {Record<string, unknown>[]} committed */
function committedThreads(committed) {
  return new Set(committed.filter(row => row.part_type !== 'session_metadata').map(row => row.session_id))
}

/** @param {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} logs */
function lastPoll(logs) {
  return /** @type {Record<string, unknown>} */ (mastracodePollLogs(logs).at(-1)?.fields)
}

/**
 * `count` threads in one transaction, each with `turns` finished turns.
 *
 * @param {SqliteDatabase} w
 * @param {string} projectDir
 * @param {string} prefix
 * @param {number} count
 * @param {number} [turns]
 */
function addThreads(w, projectDir, prefix, count, turns = 1) {
  w.exec('BEGIN')
  for (let i = 0; i < count; i++) {
    const id = `${prefix}${String(i).padStart(3, '0')}`
    addThread(w, id, projectDir)
    for (let t = 0; t < turns; t++) addTurn(w, id, `turn${t}`)
  }
  w.exec('COMMIT')
}

async function baselined() {
  const harness = await createMastracodeHarness()
  const runner = createMastracodePollRunner(harness.ctx)
  await runMastracodePollTick(runner, harness.ctx)
  const w = openWriter(harness.dbPath)
  return { ...harness, runner, w }
}

test('more than 64 changed threads commit their leftovers on the next tick with no further write', async () => {
  const h = await baselined()
  addThreads(h.w, h.projectDir, 'm', 100)
  await runMastracodePollTick(h.runner, h.ctx)
  const poll = lastPoll(h.logs)
  assert.equal(poll.threads_changed, MASTRACODE_THREADS_PER_TICK)
  assert.equal(poll.threads_pending, 36)
  assert.equal(committedThreads(h.committed).size, 64)
  assert.equal(h.batches.length, 1, 'one batch commit per tick')

  await runMastracodePollTick(h.runner, h.ctx)
  assert.equal(committedThreads(h.committed).size, 100, 'leftovers come before re-reads of open entries')
  assert.equal(lastPoll(h.logs).threads_pending, 0)
  h.w.close()
})

test('the row budget closes a tick at 4096 rows and leaves the rest pending', async () => {
  const h = await baselined()
  addThreads(h.w, h.projectDir, 'r', 10, 250)
  await runMastracodePollTick(h.runner, h.ctx)
  const poll = lastPoll(h.logs)
  const admitted = Number(poll.threads_changed)
  assert.ok(admitted < 10, `admitted ${admitted}`)
  assert.equal(poll.threads_pending, 10 - admitted)
  const rows = Number(poll.rows)
  assert.ok(rows >= MASTRACODE_ROWS_PER_TICK, `rows ${rows}`)
  const lastId = h.batches.at(-1)?.at(-1)
  const lastRows = h.committed.filter(row => row.session_id === lastId).length
  assert.ok(rows - lastRows < MASTRACODE_ROWS_PER_TICK, 'the budget closes only after the thread that crossed it')
  h.w.close()
})

test('start schedules a catch-up tick for leftovers ahead of the poll interval', async () => {
  const harness = await createMastracodeHarness({ config: { poll_interval: '1h' } })
  await runMastracodePollTick(createMastracodePollRunner(harness.ctx), harness.ctx)
  const w = openWriter(harness.dbPath)
  addThreads(w, harness.projectDir, 'm', 100)
  w.close()

  const source = await startMastracodeSource(harness.ctx)
  try {
    assert.equal(committedThreads(harness.committed).size, 64, 'start awaits one budgeted tick')
    const deadline = Date.now() + MASTRACODE_CATCH_UP_DELAY_MS + 3000
    while (committedThreads(harness.committed).size < 100 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(committedThreads(harness.committed).size, 100)
  } finally {
    await source.stop()
  }
})

test('an open thread left unadmitted is read on the next changed tick and is never pending', async () => {
  const h = await baselined()
  addThread(h.w, 'a1', h.projectDir)
  insertMessage(h.w, { id: 'a1-u', thread_id: 'a1', role: 'signal', type: 'user', content: userContent('a1-sig', 'open prompt') })
  insertMessage(h.w, { id: 'a1-a', thread_id: 'a1', role: 'assistant', type: 'v2', content: assistantContent([textPart('open reply')]) })
  await runMastracodePollTick(h.runner, h.ctx)
  assert.equal(h.runner.watermark?.threads.a1?.open, true)

  addThreads(h.w, h.projectDir, 'f', MASTRACODE_THREADS_PER_TICK)
  await runMastracodePollTick(h.runner, h.ctx)
  const poll = lastPoll(h.logs)
  assert.equal(poll.threads_changed, MASTRACODE_THREADS_PER_TICK, 'threads that moved come first')
  assert.equal(poll.threads_pending, 0, 'an open thread is never pending')
  assert.equal(h.runner.watermark?.threads.a1?.open, true)

  updateThread(h.w, 'f000', { updatedAt: nextUpdatedAt() })
  await runMastracodePollTick(h.runner, h.ctx)
  h.w.close()
  assert.equal(h.runner.watermark?.threads.a1?.open, false, 'read on the next changed tick')
})

test('settled unchanged threads are not hashed in a many-thread fixture', async () => {
  const h = await baselined()
  addThreads(h.w, h.projectDir, 'k', 60, 3)
  await runMastracodePollTick(h.runner, h.ctx)
  assert.equal(lastPoll(h.logs).threads_changed, 60)
  // Every entry is open after its first reconcile; one changed tick settles them.
  addThread(h.w, 'other', h.projectDir)
  await runMastracodePollTick(h.runner, h.ctx)
  assert.ok(Object.entries(h.runner.watermark?.threads ?? {}).every(([id, entry]) => id === 'other' || !entry.open))
  // A checkpoint moves the signature with no write, so the new thread settles too.
  h.w.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  await runMastracodePollTick(h.runner, h.ctx)
  assert.ok(Object.values(h.runner.watermark?.threads ?? {}).every(entry => !entry.open))

  addTurn(h.w, 'k001', 'later')
  await runMastracodePollTick(h.runner, h.ctx)
  assert.equal(lastPoll(h.logs).threads_changed, 1, 'only the thread that moved is hashed')
  assert.deepEqual(texts(h.committed, 'k001').slice(-2), ['later prompt', 'later reply'])
  h.w.close()
})

test('the cap evicts the oldest entry, which is not hashed until it changes and then reconciles idempotently', async () => {
  const h = await baselined()
  addThread(h.w, 'e1', h.projectDir)
  addTurn(h.w, 'e1', 'first')
  addThread(h.w, 's2', h.projectDir)
  addTurn(h.w, 's2', 'first')
  await runMastracodePollTick(h.runner, h.ctx)
  const watermark = h.runner.watermark
  assert.ok(watermark)
  assert.ok(watermark.threads.e1 && watermark.threads.s2)
  const e1UpdatedAt = watermark.threads.e1.updated_at

  assert.equal(capMastraWatermarkThreads(watermark, 1), 1)
  assert.equal(watermark.threads.e1, undefined, 'the oldest entry is evicted')
  assert.ok(watermark.threads.s2)
  assert.equal(watermark.db?.floor, e1UpdatedAt, 'eviction raises the floor')

  addTurn(h.w, 's2', 'second')
  await runMastracodePollTick(h.runner, h.ctx)
  assert.equal(lastPoll(h.logs).threads_changed, 1, 'the evicted thread is not hashed')
  assert.deepEqual(texts(h.committed, 'e1'), ['first prompt', 'first reply'])

  addTurn(h.w, 'e1', 'second')
  await runMastracodePollTick(h.runner, h.ctx)
  const rows = h.committed.filter(row => row.session_id === 'mastracode-e1')
  const partIds = rows.map(row => String(row.part_id))
  assert.equal(new Set(partIds).size, partIds.length, 'no duplicate part ids')
  assert.deepEqual(texts(h.committed, 'e1'), ['first prompt', 'first reply', 'second prompt', 'second reply'])
  assert.match(h.runner.watermark?.threads.e1?.digest ?? '', /^[a-f0-9]{64}$/)
  h.w.close()
})
