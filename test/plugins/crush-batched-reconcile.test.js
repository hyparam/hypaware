// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  CRUSH_CATCH_UP_DELAY_MS,
  CRUSH_OPENS_PER_TICK,
  CRUSH_ROWS_PER_TICK,
  CRUSH_SESSIONS_PER_TICK,
  createCrushPollRunner,
  runCrushPollTick,
  startCrushSource,
} from '../../hypaware-core/plugins-workspace/crush/src/source.js'
import { capCrushWatermarkSessions } from '../../hypaware-core/plugins-workspace/crush/src/watermark.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import { insertMessage, insertSession, openWriter } from '../helpers/crush_db_fixture.js'
import { createCrushHarness, crushPollLogs } from '../helpers/crush_source_fixture.js'

/**
 * @ref LLP 0527#tick-budget [tests]: a tick admits at most 64 sessions or
 *   4096 rows, and a catch-up tick takes the leftovers with no further write.
 * @ref LLP 0573#source [tests]: at most 16 changed databases open per tick,
 *   the cycle runs by real path from the database after the one opened last,
 *   a database that always has leftovers does not starve the others, and an
 *   open session is never pending.
 * @ref LLP 0573#cost [tests]: settled unchanged sessions are not hashed, the
 *   watermark cap evicts the oldest entry, and the many-database fixture's CPU
 *   and memory are measured. The `EXPLAIN QUERY PLAN` gate on the rowid range
 *   read and the `MAX(rowid)` seek lives in test/plugins/crush-db.test.js.
 * @ref LLP 0573#privacy [tests]: an excluded session is recovered by unignore.
 *
 * Synthetic rows only, written through the fixture's own connections between
 * ticks, as Crush writes.
 */

/**
 * The `content_text` of one session's committed message rows, in commit
 * order. The title row (`session_metadata`) carries no `content_text`.
 *
 * @param {Record<string, unknown>[]} committed
 * @param {string} sessionId
 */
function texts(committed, sessionId) {
  return committed
    .filter(row => row.session_id === `crush-${sessionId}` && row.part_type !== 'session_metadata')
    .map(row => row.content_text)
}

/**
 * Distinct sessions with committed message rows.
 *
 * @param {Record<string, unknown>[]} committed
 */
function committedSessions(committed) {
  return new Set(committed.filter(row => row.part_type !== 'session_metadata').map(row => row.session_id))
}

/** @param {string} text */
function textParts(text) {
  return [{ type: 'text', data: { text } }]
}

/**
 * One finished user-and-assistant turn.
 *
 * @param {ReturnType<typeof openWriter>} w
 * @param {string} sessionId
 * @param {string} tag
 */
function addTurn(w, sessionId, tag) {
  insertMessage(w, { id: `${sessionId}-${tag}-u`, session_id: sessionId, role: 'user', parts: textParts(`${tag} prompt`) })
  insertMessage(w, {
    id: `${sessionId}-${tag}-a`, session_id: sessionId, role: 'assistant',
    parts: textParts(`${tag} reply`), model: 'fixture-model', provider: 'fixture-provider',
  })
}

/**
 * One turn in one session of the database at `dbPath`, through a writer
 * opened and closed around it.
 *
 * @param {string} dbPath
 * @param {string} sessionId
 * @param {string} tag
 */
function writeTurn(dbPath, sessionId, tag) {
  const w = openWriter(dbPath)
  addTurn(w, sessionId, tag)
  w.close()
}

/**
 * `count` new sessions `<prefix><nnn>`, each with `turns` turns, in one
 * write transaction.
 *
 * @param {ReturnType<typeof openWriter>} w
 * @param {string} prefix
 * @param {number} count
 * @param {number} [turns]
 */
function addSessions(w, prefix, count, turns = 1) {
  w.exec('BEGIN')
  for (let i = 0; i < count; i++) {
    const id = `${prefix}${String(i).padStart(3, '0')}`
    insertSession(w, { id })
    for (let j = 0; j < turns; j++) addTurn(w, id, `t${j}`)
  }
  w.exec('COMMIT')
}

/** @param {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} logs */
function lastPoll(logs) {
  const polls = crushPollLogs(logs)
  return polls[polls.length - 1]?.fields ?? {}
}

/**
 * A harness whose databases have had their first (baseline) tick, with a
 * writer open on the first one.
 *
 * @param {{ projects?: string[], ignoredSessions?: Set<string> }} [opts]
 */
async function baselined(opts = {}) {
  const harness = await createCrushHarness({ projects: opts.projects ?? ['p1'] })
  const runner = createCrushPollRunner(harness.ctx, { ignoredSessions: opts.ignoredSessions })
  await runCrushPollTick(runner, harness.ctx)
  const w = openWriter(harness.dbPaths[0])
  return { ...harness, runner, w }
}

/**
 * Forty projects, `p00` to `p39`, each with one session `<name>-s`, the
 * index written in reverse so index order is not real-path order, and every
 * database baselined.
 */
async function fortyBaselined() {
  const names = Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, '0')}`)
  const harness = await createCrushHarness({ projects: names })
  for (let i = 0; i < names.length; i++) {
    const w = openWriter(harness.dbPaths[i])
    insertSession(w, { id: `${names[i]}-s` })
    w.close()
  }
  await harness.writeIndex([...harness.projectDirs].reverse().map(p => path.join(p, '.crush')))
  const real = await Promise.all(harness.dbPaths.map(p => fs.realpath(p)))
  const sorted = [...real].sort()
  /** @type {Map<string, string>} */
  const sessionOf = new Map(real.map((p, i) => [p, `${names[i]}-s`]))
  /** @type {Map<string, string>} */
  const projectOf = new Map(real.map((p, i) => [p, harness.projectDirs[i]]))
  const runner = createCrushPollRunner(harness.ctx)
  /** @type {unknown[]} */
  const baselineOpens = []
  for (let i = 0; i < 3; i++) {
    await runCrushPollTick(runner, harness.ctx)
    baselineOpens.push(lastPoll(harness.logs).dbs_opened)
  }
  return { ...harness, names, real, sorted, sessionOf, projectOf, runner, baselineOpens }
}

/**
 * @param {Map<string, string>} sessionOf
 * @param {string[]} paths
 */
function scopeIds(sessionOf, paths) {
  return paths.map(p => `crush-${sessionOf.get(p)}`)
}

// ---------------------------------------------------------------------------
// The open budget and the round-robin cycle
// ---------------------------------------------------------------------------

test('40 changed databases open 16 a tick in real-path order and all open within three ticks', async () => {
  const h = await fortyBaselined()
  assert.deepEqual(h.baselineOpens, [16, 16, 8], 'baselines spend the same open budget')
  assert.equal(h.runner.dbsPending, 0)

  for (const p of h.real) writeTurn(p, /** @type {string} */ (h.sessionOf.get(p)), 'one')
  await runCrushPollTick(h.runner, h.ctx)
  let poll = lastPoll(h.logs)
  assert.equal(poll.dbs_changed, 40)
  assert.equal(poll.dbs_opened, CRUSH_OPENS_PER_TICK)
  assert.equal(poll.dbs_pending, 24)
  assert.equal(h.runner.lastOpened, h.sorted[15])
  assert.deepEqual(h.batches.at(-1), scopeIds(h.sessionOf, h.sorted.slice(0, 16)), 'the cycle runs by real path, not index order')

  // Reordering projects.json between ticks does not move the cycle.
  await h.writeIndex(h.projectDirs.map(p => path.join(p, '.crush')))
  await runCrushPollTick(h.runner, h.ctx)
  poll = lastPoll(h.logs)
  assert.equal(poll.dbs_changed, 24, 'an unopened database is read on the next tick')
  assert.equal(poll.dbs_opened, 16)
  assert.equal(poll.dbs_pending, 8)
  assert.deepEqual(h.batches.at(-1), scopeIds(h.sessionOf, h.sorted.slice(16, 32)))

  await runCrushPollTick(h.runner, h.ctx)
  poll = lastPoll(h.logs)
  assert.equal(poll.dbs_opened, 8)
  assert.equal(poll.dbs_pending, 0)
  assert.equal(h.runner.lastOpened, h.sorted[39])
  for (const p of h.real) assert.deepEqual(texts(h.committed, /** @type {string} */ (h.sessionOf.get(p))), ['one prompt', 'one reply'])

  // No path sorts after the last one opened: the cycle wraps to the first.
  for (const p of h.real) writeTurn(p, /** @type {string} */ (h.sessionOf.get(p)), 'two')
  await runCrushPollTick(h.runner, h.ctx)
  assert.deepEqual(h.batches.at(-1), scopeIds(h.sessionOf, h.sorted.slice(0, 16)))
  assert.equal(h.runner.lastOpened, h.sorted[15])

  // The database opened last leaves the set: the next tick starts at the
  // next real path, ahead of an earlier changed one.
  const gone = h.sorted[15]
  await h.writeIndex(h.projectDirs.filter(p => p !== h.projectOf.get(gone)).map(p => path.join(p, '.crush')))
  writeTurn(h.sorted[0], /** @type {string} */ (h.sessionOf.get(h.sorted[0])), 'three')
  await runCrushPollTick(h.runner, h.ctx)
  poll = lastPoll(h.logs)
  assert.equal(poll.dbs_total, 39)
  assert.equal(poll.dbs_changed, 25)
  assert.deepEqual(h.batches.at(-1), scopeIds(h.sessionOf, h.sorted.slice(16, 32)))

  // A restart keeps the watermark but not the cycle: it starts at the first
  // real path.
  const restarted = createCrushPollRunner(h.ctx)
  await runCrushPollTick(restarted, h.ctx)
  poll = lastPoll(h.logs)
  assert.equal(poll.dbs_changed, 9)
  assert.deepEqual(h.batches.at(-1), scopeIds(h.sessionOf, [h.sorted[0], ...h.sorted.slice(32)]))
  assert.equal(restarted.dbsPending, 0)
  assert.deepEqual(texts(h.committed, /** @type {string} */ (h.sessionOf.get(h.sorted[0]))),
    ['one prompt', 'one reply', 'two prompt', 'two reply', 'three prompt', 'three reply'])
  assert.deepEqual(texts(h.committed, /** @type {string} */ (h.sessionOf.get(gone))),
    ['one prompt', 'one reply', 'two prompt', 'two reply'])
})

test('a database that always has leftovers does not keep the other changed databases from opening', async () => {
  const h = await baselined({ projects: ['pa', 'pb'] })
  addSessions(h.w, 'a', 200)
  const wb = openWriter(h.dbPaths[1])
  insertSession(wb, { id: 'b1' })
  addTurn(wb, 'b1', 'b')
  wb.close()

  await runCrushPollTick(h.runner, h.ctx)
  let poll = lastPoll(h.logs)
  assert.equal(poll.dbs_opened, 1)
  assert.equal(poll.dbs_pending, 1)
  assert.equal(poll.sessions_changed, CRUSH_SESSIONS_PER_TICK)
  assert.equal(texts(h.committed, 'b1').length, 0)

  await runCrushPollTick(h.runner, h.ctx)
  poll = lastPoll(h.logs)
  assert.equal(h.batches.at(-1)?.[0], 'crush-b1', 'the next tick starts after the database opened last')
  assert.deepEqual(texts(h.committed, 'b1'), ['b prompt', 'b reply'])
  h.w.close()
})

// ---------------------------------------------------------------------------
// The session and row budget, and catch-up
// ---------------------------------------------------------------------------

test('one database with more than 64 candidates commits its leftovers on the next tick with no further write', async () => {
  const h = await baselined()
  addSessions(h.w, 'm', 100)
  await runCrushPollTick(h.runner, h.ctx)
  const poll = lastPoll(h.logs)
  assert.equal(poll.sessions_changed, CRUSH_SESSIONS_PER_TICK)
  assert.equal(poll.sessions_pending, 36)
  assert.equal(committedSessions(h.committed).size, 64)

  await runCrushPollTick(h.runner, h.ctx)
  assert.equal(committedSessions(h.committed).size, 100, 'leftovers come before re-reads of unsettled entries')
  h.w.close()
})

test('start schedules a catch-up tick for leftovers ahead of the poll interval', async () => {
  const harness = await createCrushHarness({ projects: ['p1'], config: { poll_interval: '1h' } })
  await runCrushPollTick(createCrushPollRunner(harness.ctx), harness.ctx)
  const w = openWriter(harness.dbPaths[0])
  addSessions(w, 'm', 100)
  w.close()

  const source = await startCrushSource(harness.ctx)
  try {
    assert.equal(committedSessions(harness.committed).size, 64, 'start awaits one budgeted tick')
    const deadline = Date.now() + CRUSH_CATCH_UP_DELAY_MS + 3000
    while (committedSessions(harness.committed).size < 100 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(committedSessions(harness.committed).size, 100)
  } finally {
    await source.stop()
  }
})

test('the row budget closes a tick at 4096 rows and leaves the rest pending', async () => {
  const h = await baselined()
  addSessions(h.w, 'r', 10, 250)
  await runCrushPollTick(h.runner, h.ctx)
  const poll = lastPoll(h.logs)
  const admitted = Number(poll.sessions_changed)
  assert.ok(admitted < 10, `admitted ${admitted}`)
  assert.equal(poll.sessions_pending, 10 - admitted)
  const rows = Number(poll.rows)
  assert.ok(rows >= CRUSH_ROWS_PER_TICK, `rows ${rows}`)
  const lastId = h.batches.at(-1)?.at(-1)
  const lastRows = h.committed.filter(row => row.session_id === lastId).length
  assert.ok(rows - lastRows < CRUSH_ROWS_PER_TICK, 'the budget closes only after the session that crossed it')
  h.w.close()
})

test('an open session left unadmitted on its final write is read on the next tick and is never pending', async () => {
  const h = await baselined()
  insertSession(h.w, { id: 'a1' })
  insertMessage(h.w, { id: 'a1-u', session_id: 'a1', role: 'user', parts: textParts('open prompt') })
  insertMessage(h.w, { id: 'a1-a', session_id: 'a1', role: 'assistant', parts: textParts('open reply'), finished_at: null })
  await runCrushPollTick(h.runner, h.ctx)
  assert.equal(h.runner.watermark?.sessions.a1?.open, true)

  h.w.exec('BEGIN')
  for (let i = 0; i < CRUSH_SESSIONS_PER_TICK; i++) {
    const id = `f${String(i).padStart(3, '0')}`
    insertSession(h.w, { id })
    addTurn(h.w, id, 'fill')
  }
  h.w.prepare('UPDATE messages SET finished_at = ? WHERE id = ?').run(1793738795, 'a1-a')
  h.w.exec('COMMIT')
  await runCrushPollTick(h.runner, h.ctx)
  let poll = lastPoll(h.logs)
  assert.equal(poll.sessions_changed, CRUSH_SESSIONS_PER_TICK, 'sessions that moved come first')
  assert.equal(poll.sessions_pending, 0, 'an open session is never pending')
  assert.equal(h.runner.watermark?.sessions.a1?.open, true)

  await runCrushPollTick(h.runner, h.ctx)
  poll = lastPoll(h.logs)
  assert.equal(h.runner.watermark?.sessions.a1?.open, false, 'read with no further write')
  h.w.close()
})

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('settled unchanged sessions are not hashed', async () => {
  const h = await baselined()
  addSessions(h.w, 'k', 50, 10)
  const realNow = Date.now
  // Every entry is recorded in a second before the one the tick observes, so
  // none is unsettled.
  Date.now = () => realNow() + 5000
  try {
    await runCrushPollTick(h.runner, h.ctx)
    assert.equal(lastPoll(h.logs).sessions_changed, 50)
    addTurn(h.w, 'k000', 'later')
    await runCrushPollTick(h.runner, h.ctx)
    assert.equal(lastPoll(h.logs).sessions_changed, 1)
  } finally {
    Date.now = realNow
  }
  assert.deepEqual(texts(h.committed, 'k000').slice(-2), ['later prompt', 'later reply'])
  h.w.close()
})

test('the cap evicts the oldest entry, which is not hashed until it changes and then reconciles idempotently', async () => {
  const h = await baselined()
  // Pin `updated_at` to the values written, so the eviction order is fixed.
  h.w.exec('DROP TRIGGER update_sessions_updated_at')
  insertSession(h.w, { id: 'e1', updated_at: 1793738700 })
  addTurn(h.w, 'e1', 'first')
  insertSession(h.w, { id: 's2', updated_at: 1793738800 })
  addTurn(h.w, 's2', 'first')
  await runCrushPollTick(h.runner, h.ctx)
  const watermark = h.runner.watermark
  assert.ok(watermark)
  assert.ok(watermark.sessions.e1 && watermark.sessions.s2)

  assert.equal(capCrushWatermarkSessions(watermark, 1), 1)
  assert.equal(watermark.sessions.e1, undefined, 'the oldest entry is evicted')
  assert.ok(watermark.sessions.s2)
  assert.ok(Object.values(watermark.dbs)[0].floor >= 1793738700, 'eviction raises the floor')

  addTurn(h.w, 's2', 'second')
  h.w.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(1793738900, 's2')
  await runCrushPollTick(h.runner, h.ctx)
  assert.equal(lastPoll(h.logs).sessions_changed, 1, 'the evicted session is not hashed')
  assert.deepEqual(texts(h.committed, 'e1'), ['first prompt', 'first reply'])

  addTurn(h.w, 'e1', 'second')
  h.w.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(1793738950, 'e1')
  await runCrushPollTick(h.runner, h.ctx)
  const rows = h.committed.filter(row => row.session_id === 'crush-e1')
  const partIds = rows.map(row => String(row.part_id))
  assert.equal(new Set(partIds).size, partIds.length, 'no duplicate part ids')
  assert.deepEqual(texts(h.committed, 'e1'), ['first prompt', 'first reply', 'second prompt', 'second reply'])
  assert.match(h.runner.watermark?.sessions.e1?.digest ?? '', /^[a-f0-9]{64}$/)
  h.w.close()
})

test('cost on the many-database fixture: 40 databases, 100 candidates in one', async (t) => {
  const h = await fortyBaselined()
  const first = /** @type {string} */ (h.sorted[0])
  const wf = openWriter(first)
  addSessions(wf, 'm', 100)
  wf.close()
  for (const p of h.real) writeTurn(p, /** @type {string} */ (h.sessionOf.get(p)), 'one')

  const heapBefore = process.memoryUsage().heapUsed
  const cpuBefore = process.cpuUsage()
  const started = process.hrtime.bigint()
  let ticks = 0
  let maxRss = 0
  let maxOpened = 0
  let maxRows = 0
  while (committedSessions(h.committed).size < 140 && ticks < 10) {
    await runCrushPollTick(h.runner, h.ctx)
    ticks++
    const poll = lastPoll(h.logs)
    maxOpened = Math.max(maxOpened, Number(poll.dbs_opened))
    maxRows = Math.max(maxRows, Number(poll.rows))
    maxRss = Math.max(maxRss, process.memoryUsage().rss)
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  const cpu = process.cpuUsage(cpuBefore)
  const heapAfter = process.memoryUsage().heapUsed

  assert.equal(committedSessions(h.committed).size, 140)
  assert.ok(ticks <= 5, `drained in ${ticks} ticks`)
  assert.ok(maxOpened <= CRUSH_OPENS_PER_TICK)
  assert.ok(Object.keys(h.runner.watermark?.sessions ?? {}).length === 140)

  // Idle: no database moved, so the tick opens nothing.
  const idleCpu = process.cpuUsage()
  const idleStart = process.hrtime.bigint()
  await runCrushPollTick(h.runner, h.ctx)
  const idleMs = Number(process.hrtime.bigint() - idleStart) / 1e6
  const idleCpuUs = process.cpuUsage(idleCpu)
  const idle = lastPoll(h.logs)
  // Leftover re-reads of entries recorded in their own second may reopen one
  // database; nothing else moves.
  assert.ok(Number(idle.dbs_opened) <= 1)

  t.diagnostic(`ticks=${ticks} wall_ms=${elapsedMs.toFixed(1)} cpu_user_ms=${(cpu.user / 1000).toFixed(1)}`
    + ` cpu_system_ms=${(cpu.system / 1000).toFixed(1)} max_dbs_opened=${maxOpened} max_rows=${maxRows}`
    + ` heap_delta_kib=${Math.round((heapAfter - heapBefore) / 1024)} max_rss_mib=${(maxRss / 1048576).toFixed(1)}`)
  t.diagnostic(`idle_tick wall_ms=${idleMs.toFixed(2)} cpu_user_ms=${(idleCpuUs.user / 1000).toFixed(2)}`
    + ` cpu_system_ms=${(idleCpuUs.system / 1000).toFixed(2)} dbs_opened=${idle.dbs_opened}`)
})

// ---------------------------------------------------------------------------
// Session exclusions
// ---------------------------------------------------------------------------

test('an unignored session is recovered on its next change', async () => {
  const harness = await createCrushHarness({ projects: ['p1'] })
  const ignoredSessions = new SessionIgnoreSet(harness.dir)
  const runner = createCrushPollRunner(harness.ctx, { ignoredSessions })
  await runCrushPollTick(runner, harness.ctx)
  new SessionIgnoreSet(harness.dir).add('crush-s1')
  const w = openWriter(harness.dbPaths[0])
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'hidden')
  await runCrushPollTick(runner, harness.ctx)
  assert.equal(texts(harness.committed, 's1').length, 0)
  assert.equal(runner.watermark?.sessions.s1, undefined, 'an excluded session records no entry')

  new SessionIgnoreSet(harness.dir).delete('crush-s1')
  addTurn(w, 's1', 'resumed')
  await runCrushPollTick(runner, harness.ctx)
  w.close()
  assert.deepEqual(texts(harness.committed, 's1'), ['hidden prompt', 'hidden reply', 'resumed prompt', 'resumed reply'])
  assert.equal(runner.lastError, undefined)
})
