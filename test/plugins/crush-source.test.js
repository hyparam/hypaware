// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  createCrushPollRunner,
  crushSourceStatus,
  runCrushPollTick,
  startCrushSource,
} from '../../hypaware-core/plugins-workspace/crush/src/source.js'
import { MAX_DATABASES } from '../../hypaware-core/plugins-workspace/crush/src/discovery.js'
import { readCrushWatermark } from '../../hypaware-core/plugins-workspace/crush/src/watermark.js'
import { TracerProvider } from '../../src/core/observability/runtime.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import { sessionIgnoresDir } from '../../src/core/runtime/paths.js'
import { createCrushDb, insertMessage, insertSession, openWriter } from '../helpers/crush_db_fixture.js'
import { createCrushHarness, crushPollLogs } from '../helpers/crush_source_fixture.js'

/**
 * @ref LLP 0573#reconciliation [tests]: the stat gate on `crush.db` and its
 *   `-wal`, the rowid cursor and the floor, the per-session digest, the
 *   same-second settle rule, deferred claims and the one-batch commit, through
 *   the real materializer and a scoped snapshot writer.
 * @ref LLP 0573#privacy [tests]: a usage-policy ignore removes the project's
 *   rows and opens nothing, a session exclusion is never projected, and an
 *   exclusions store that cannot load fails the tick closed.
 * @ref LLP 0573#status [tests]: one case per state, and no log record or span
 *   carries message text, a title, a project path or a database path.
 * @ref LLP 0573#source [tests]: start runs one tick, `enabled = false` opens
 *   nothing, and a restart over a recorded watermark re-imports nothing.
 */

/** @param {ReturnType<typeof createCrushPollRunner>} runner */
function statusOf(runner) {
  return crushSourceStatus(/** @type {NonNullable<typeof runner.lastResult>} */ (runner.lastResult), {
    indexPath: runner.indexPath,
    pollIntervalMs: runner.pollIntervalMs,
    rowsWritten: runner.rowsWritten,
    errorCounts: runner.errorCounts,
    schemaDetail: runner.schemaDetail,
    lastError: runner.lastError,
    lastErrorKind: runner.lastErrorKind,
    sessionsTracked: runner.sessionsTracked,
    sessionsPending: runner.sessionsPending,
    lastPollAt: runner.lastPollAt,
  })
}

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

/** @param {string} text */
function textParts(text) {
  return [{ type: 'text', data: { text } }]
}

/**
 * A harness whose databases have had their first (baseline) tick, with a
 * writer open on the first one.
 *
 * @param {{ projects?: string[], ignoredSessions?: Set<string>,
 *   hooks?: Parameters<typeof createCrushHarness>[0]['hooks'] }} [opts]
 */
async function baselined(opts = {}) {
  const harness = await createCrushHarness({ projects: opts.projects ?? ['p1'], hooks: opts.hooks })
  const runner = createCrushPollRunner(harness.ctx, { ignoredSessions: opts.ignoredSessions })
  await runCrushPollTick(runner, harness.ctx)
  const w = openWriter(harness.dbPaths[0])
  return { ...harness, runner, w }
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

// ---------------------------------------------------------------------------
// The stat gate
// ---------------------------------------------------------------------------

test('first start baselines without importing history', async () => {
  const harness = await createCrushHarness({ projects: ['p1'] })
  const w = openWriter(harness.dbPaths[0])
  insertSession(w, { id: 's1', title: 'Fixture title' })
  addTurn(w, 's1', 'history')
  w.close()
  const runner = createCrushPollRunner(harness.ctx)
  await runCrushPollTick(runner, harness.ctx)
  assert.equal(harness.committed.length, 0, 'history is the backfill\'s, not the poll\'s')
  assert.equal(crushPollLogs(harness.logs, 'baseline').length, 1)
  const db = runner.watermark?.dbs[harness.dbPaths[0]]
  assert.equal(db?.max_rowid, 2, 'the cursor starts past the existing rows')
  assert.ok(typeof db?.floor === 'number' && db.floor > 1793738790, 'the floor is the baseline second')
})

test('a database with no -wal opens once, and the read never changes crush.db', async () => {
  const harness = await createCrushHarness({ projects: ['p1'] })
  const before = await fs.readFile(harness.dbPaths[0])
  const runner = createCrushPollRunner(harness.ctx)
  await runCrushPollTick(runner, harness.ctx)
  await runCrushPollTick(runner, harness.ctx)
  await runCrushPollTick(runner, harness.ctx)
  const polls = crushPollLogs(harness.logs)
  assert.deepEqual(polls.map(p => p.fields?.dbs_opened), [1, 0, 0], 'the reader\'s own -wal does not reopen it')
  assert.deepEqual(polls.map(p => p.fields?.poll_status), ['baseline', 'unchanged', 'unchanged'])
  assert.ok((await fs.readFile(harness.dbPaths[0])).equals(before), 'crush.db is byte-identical after the reads')
})

test('an idle tick opens nothing', async () => {
  const { runner, ctx, logs, w } = await baselined()
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'first')
  await runCrushPollTick(runner, ctx)
  await runCrushPollTick(runner, ctx)
  w.close()
  const last = crushPollLogs(logs).at(-1)
  assert.equal(last?.fields?.poll_status, 'unchanged')
  assert.equal(last?.fields?.dbs_opened, 0)
})

test('a commit that lands during the read leaves the database to reopen next tick', async () => {
  const { runner, ctx, committed, logs, w } = await baselined()
  insertSession(w, { id: 's1' })
  insertMessage(w, { id: 'm1', session_id: 's1', role: 'user', parts: textParts('first prompt') })
  const materializers = ctx.backfillMaterializers
  let armed = true
  ctx.backfillMaterializers = {
    get(/** @type {string} */ kind) {
      if (armed) {
        armed = false
        insertMessage(w, { id: 'm2', session_id: 's1', role: 'user', parts: textParts('mid-read prompt') })
      }
      return materializers.get(kind)
    },
  }
  await runCrushPollTick(runner, ctx)
  assert.deepEqual(texts(committed, 's1'), ['first prompt'])
  await runCrushPollTick(runner, ctx)
  w.close()
  assert.equal(crushPollLogs(logs).at(-1)?.fields?.dbs_opened, 1, 'the moved signature is not recorded as seen')
  assert.deepEqual(texts(committed, 's1'), ['first prompt', 'mid-read prompt'])
})

test('a checkpoint-and-reset moves the signature, reopens once and re-imports nothing', async () => {
  const { runner, ctx, committed, batches, logs, w } = await baselined()
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'first')
  await runCrushPollTick(runner, ctx)
  const rows = committed.length
  const batchCount = batches.length
  w.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  await runCrushPollTick(runner, ctx)
  assert.equal(crushPollLogs(logs).at(-1)?.fields?.dbs_opened, 1)
  assert.equal(batches.length, batchCount, 'no session is rewritten')
  assert.equal(committed.length, rows)
  await runCrushPollTick(runner, ctx)
  assert.equal(crushPollLogs(logs).at(-1)?.fields?.poll_status, 'unchanged', 'the reset WAL settles')

  addTurn(w, 's1', 'after-reset')
  await runCrushPollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 's1'), ['first prompt', 'first reply', 'after-reset prompt', 'after-reset reply'])
})

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

test('an appended turn is captured as one session snapshot', async () => {
  const { runner, ctx, committed, batches, w } = await baselined()
  insertSession(w, { id: 's1', title: 'Fixture title' })
  addTurn(w, 's1', 'first')
  await runCrushPollTick(runner, ctx)
  assert.deepEqual(texts(committed, 's1'), ['first prompt', 'first reply'])
  addTurn(w, 's1', 'second')
  await runCrushPollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 's1'), ['first prompt', 'first reply', 'second prompt', 'second reply'])
  assert.deepEqual(batches.at(-1), ['crush-s1'])
  assert.equal(runner.watermark?.sessions.s1.message_count, 4)
  assert.equal(committed.filter(row => row.part_type === 'session_metadata').length, 1, 'the title row is replaced, not appended')
})

test('a streamed assistant message settles to one message with the final text', async () => {
  const { runner, ctx, committed, w } = await baselined()
  insertSession(w, { id: 's1' })
  insertMessage(w, { id: 'm1', session_id: 's1', role: 'user', parts: textParts('stream prompt') })
  insertMessage(w, { id: 'm2', session_id: 's1', role: 'assistant', parts: textParts('partial reply'), finished_at: null })
  await runCrushPollTick(runner, ctx)
  assert.equal(runner.watermark?.sessions.s1.open, true)
  assert.equal(runner.sessionsPending, 0, 'an open session is not pending work')
  w.prepare('UPDATE messages SET parts = ?, finished_at = ? WHERE id = ?')
    .run(JSON.stringify(textParts('final reply')), 1793738795, 'm2')
  await runCrushPollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 's1'), ['stream prompt', 'final reply'])
  assert.equal(committed.filter(row => row.provider_uuid === 'm2').length, 1)
  assert.equal(runner.watermark?.sessions.s1.open, false)
})

test('a message that never finishes is re-read on each changed tick without a catch-up', async () => {
  const { runner, ctx, logs, w } = await baselined()
  insertSession(w, { id: 's1' })
  insertMessage(w, { id: 'm1', session_id: 's1', role: 'assistant', parts: textParts('stuck reply'), finished_at: null })
  insertSession(w, { id: 's2' })
  await runCrushPollTick(runner, ctx)
  addTurn(w, 's2', 'other')
  await runCrushPollTick(runner, ctx)
  w.close()
  const last = crushPollLogs(logs).at(-1)
  assert.equal(last?.fields?.sessions_changed, 2, 'the open session is read again alongside the changed one')
  assert.equal(last?.fields?.sessions_pending, 0)
  assert.equal(runner.dbsPending, 0)
})

test('a deleted message reconciles away', async () => {
  const { runner, ctx, committed, w } = await baselined()
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'kept')
  insertMessage(w, { id: 'doomed', session_id: 's1', role: 'user', parts: textParts('doomed prompt') })
  await runCrushPollTick(runner, ctx)
  assert.ok(texts(committed, 's1').includes('doomed prompt'))
  w.prepare('DELETE FROM messages WHERE id = ?').run('doomed')
  await runCrushPollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 's1'), ['kept prompt', 'kept reply'])
})

test('a same-second rewrite that reuses the rowid is still read', async () => {
  // Pin the clock and drop Crush's updated_at trigger, so the rewrite carries
  // the same updated_at, message_count and max rowid the entry recorded: only
  // the same-second settle rule can find it.
  const { runner, ctx, committed, w } = await baselined()
  w.exec('DROP TRIGGER update_sessions_updated_at')
  const second = Math.floor(Date.now() / 1000) + 10
  const realNow = Date.now
  Date.now = () => second * 1000 + 500
  try {
    insertSession(w, { id: 's1', updated_at: second })
    insertMessage(w, { id: 'm1', session_id: 's1', role: 'user', parts: textParts('first prompt') })
    await runCrushPollTick(runner, ctx)
    assert.deepEqual(texts(committed, 's1'), ['first prompt'])
    assert.ok(runner.unsettled?.has('s1'), 'an entry recorded in its own second stays unsettled')
    w.prepare('DELETE FROM messages WHERE id = ?').run('m1')
    insertMessage(w, { id: 'm1b', session_id: 's1', role: 'user', parts: textParts('rewritten prompt') })
    assert.equal(w.prepare('SELECT MAX(rowid) AS r FROM messages').get()?.r, 1, 'the rowid is reused')
    await runCrushPollTick(runner, ctx)
    assert.deepEqual(texts(committed, 's1'), ['rewritten prompt'])
  } finally {
    Date.now = realNow
    w.close()
  }
})

test('a session outside the window with no new rows is not read', async () => {
  const { runner, ctx, committed, w } = await baselined()
  // Written before the baseline second, with its rows below the cursor: the
  // backfill's history, not the poll's.
  w.exec('DROP TRIGGER update_sessions_updated_at')
  insertSession(w, { id: 'old', updated_at: 1793738790 })
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'fresh')
  await runCrushPollTick(runner, ctx)
  w.close()
  assert.equal(texts(committed, 'old').length, 0)
  assert.equal(runner.watermark?.sessions.old, undefined, 'the old session gets no entry')
  assert.deepEqual(texts(committed, 's1'), ['fresh prompt', 'fresh reply'])
})

test('a restart over a recorded watermark re-imports nothing', async () => {
  const { runner, ctx, committed, batches, logs, w } = await baselined()
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'first')
  await runCrushPollTick(runner, ctx)
  const rows = committed.length
  const restarted = createCrushPollRunner(ctx)
  await runCrushPollTick(restarted, ctx)
  assert.equal(crushPollLogs(logs).at(-1)?.fields?.poll_status, 'unchanged')
  assert.equal(committed.length, rows)

  insertSession(w, { id: 's2' })
  addTurn(w, 's2', 'second')
  await runCrushPollTick(restarted, ctx)
  w.close()
  assert.ok(!batches.at(-1)?.includes('crush-s1'), 'the recorded session is not rewritten')
  assert.deepEqual(texts(committed, 's2'), ['second prompt', 'second reply'])
  assert.deepEqual(readCrushWatermark(ctx.paths.stateDir).sessions.s1?.message_count, 2)
})

test('one session id in two databases is counted, and only the first owner is captured', async () => {
  const { runner, ctx, committed, w, dbPaths } = await baselined({ projects: ['p1', 'p2'] })
  const w2 = openWriter(dbPaths[1])
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'p1')
  insertSession(w2, { id: 's1' })
  addTurn(w2, 's1', 'p2')
  await runCrushPollTick(runner, ctx)
  w.close()
  w2.close()
  assert.deepEqual(texts(committed, 's1'), ['p1 prompt', 'p1 reply'])
  const status = statusOf(runner)
  assert.equal(status.state, 'degraded')
  assert.equal(status.details?.error_kind, 'session_collision')
  assert.equal(status.message, '1 sessions appear in more than one crush database')
})

// ---------------------------------------------------------------------------
// Claims and the batch commit
// ---------------------------------------------------------------------------

test('a held scope defers its session and lands once released', async () => {
  const { runner, ctx, committed, held, logs, w } = await baselined()
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'first')
  held.add('crush-s1')
  await runCrushPollTick(runner, ctx)
  assert.equal(committed.length, 0)
  assert.equal(runner.sessionsPending, 1)
  assert.equal(logs.find(entry => entry.message === 'crush.session_deferred')?.fields?.error_kind, 'cache_partition_mutation_busy')
  held.delete('crush-s1')
  await runCrushPollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 's1'), ['first prompt', 'first reply'])
  assert.equal(runner.sessionsPending, 0)
})

test('a tick commits every database\'s sessions in one batch', async () => {
  const { runner, ctx, batches, w, dbPaths } = await baselined({ projects: ['p1', 'p2'] })
  const w2 = openWriter(dbPaths[1])
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'one')
  insertSession(w, { id: 's2' })
  addTurn(w, 's2', 'two')
  insertSession(w2, { id: 's3' })
  addTurn(w2, 's3', 'three')
  await runCrushPollTick(runner, ctx)
  w.close()
  w2.close()
  assert.equal(batches.length, 1)
  assert.deepEqual([...batches[0]].sort(), ['crush-s1', 'crush-s2', 'crush-s3'])
})

test('a failed batch falls back to one commit per session', async () => {
  let failBatch = true
  const { runner, ctx, committed, logs, w } = await baselined({ hooks: { failBatch: () => failBatch } })
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'first')
  await runCrushPollTick(runner, ctx)
  failBatch = false
  w.close()
  assert.equal(logs.find(entry => entry.message === 'crush.batch_reconcile_failed')?.fields?.status, 'retrying')
  assert.deepEqual(texts(committed, 's1'), ['first prompt', 'first reply'])
  assert.equal(runner.lastError, undefined)
})

test('a commit that fails leaves the recorded watermark unchanged', async () => {
  let fail = false
  const { runner, ctx, committed, w } = await baselined({ hooks: { failBatch: () => fail, failReconcile: () => fail } })
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'first')
  await runCrushPollTick(runner, ctx)
  const before = JSON.stringify(readCrushWatermark(ctx.paths.stateDir))
  fail = true
  addTurn(w, 's1', 'second')
  await runCrushPollTick(runner, ctx)
  assert.equal(JSON.stringify(readCrushWatermark(ctx.paths.stateDir)), before)
  assert.ok(runner.lastError)
  assert.equal(statusOf(runner).state, 'degraded')
  fail = false
  await runCrushPollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 's1'), ['first prompt', 'first reply', 'second prompt', 'second reply'])
})

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

test('a usage-policy ignore removes the project\'s rows, opens nothing and does not churn', async () => {
  const { runner, ctx, committed, logs, w, projectDirs, dbPaths } = await baselined()
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'first')
  await runCrushPollTick(runner, ctx)
  assert.ok(committed.length > 0)

  await fs.writeFile(path.join(projectDirs[0], '.hypignore'), 'ignore\n')
  // A fresh resolver, as a daemon restart or the policy cache expiry gives.
  runner.resolver = createCrushPollRunner(ctx).resolver
  addTurn(w, 's1', 'private')
  await runCrushPollTick(runner, ctx)
  assert.equal(texts(committed, 's1').length, 0, 'rows captured before are removed')
  assert.equal(crushPollLogs(logs).at(-1)?.fields?.dbs_opened, 0, 'an ignored project spends no open')
  assert.equal(runner.watermark?.sessions.s1, undefined)
  assert.equal(runner.watermark?.dbs[dbPaths[0]], undefined, 'leaving the policy re-baselines')

  await runCrushPollTick(runner, ctx)
  assert.equal(crushPollLogs(logs).at(-1)?.fields?.poll_status, 'unchanged', 'an unchanged ignored project is not revisited')
  w.close()
})

test('a first tick beside an ignore-policy project still reports baseline', async () => {
  const harness = await createCrushHarness({ projects: ['p1', 'p2'] })
  await fs.writeFile(path.join(harness.projectDirs[1], '.hypignore'), 'ignore\n')
  const runner = createCrushPollRunner(harness.ctx)
  await runCrushPollTick(runner, harness.ctx)
  assert.equal(crushPollLogs(harness.logs).at(-1)?.fields?.poll_status, 'baseline')
  assert.equal(harness.committed.length, 0)
})

test('an excluded session is never projected and does not count as pending', async () => {
  const harness = await createCrushHarness({ projects: ['p1'] })
  const ignoredSessions = new SessionIgnoreSet(harness.dir)
  const runner = createCrushPollRunner(harness.ctx, { ignoredSessions })
  await runCrushPollTick(runner, harness.ctx)
  new SessionIgnoreSet(harness.dir).add('crush-s1')
  const w = openWriter(harness.dbPaths[0])
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'excluded')
  insertSession(w, { id: 's2' })
  addTurn(w, 's2', 'kept')
  await runCrushPollTick(runner, harness.ctx)
  w.close()
  assert.equal(texts(harness.committed, 's1').length, 0)
  assert.deepEqual(texts(harness.committed, 's2'), ['kept prompt', 'kept reply'])
  assert.equal(runner.sessionsPending, 0)
  assert.equal(runner.lastError, undefined)
})

test('an exclusions store that cannot load fails the tick closed', async () => {
  const harness = await createCrushHarness({ projects: ['p1'] })
  const ignoredSessions = new SessionIgnoreSet(harness.dir)
  const runner = createCrushPollRunner(harness.ctx, { ignoredSessions })
  await runCrushPollTick(runner, harness.ctx)
  await fs.mkdir(sessionIgnoresDir(harness.dir), { recursive: true })
  await fs.writeFile(path.join(sessionIgnoresDir(harness.dir), 'not-a-marker'), 'x')
  const before = JSON.stringify(readCrushWatermark(harness.dir))
  const w = openWriter(harness.dbPaths[0])
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'first')
  await runCrushPollTick(runner, harness.ctx)
  assert.equal(harness.committed.length, 0)
  assert.equal(JSON.stringify(readCrushWatermark(harness.dir)), before, 'nothing advances')
  assert.equal(runner.lastErrorKind, 'session_ignore_load_failed')
  assert.equal(harness.logs.find(entry => entry.message === 'crush.poll' && entry.level === 'error')?.fields?.error_kind,
    'session_ignore_load_failed')

  await fs.rm(path.join(sessionIgnoresDir(harness.dir), 'not-a-marker'))
  await runCrushPollTick(runner, harness.ctx)
  w.close()
  assert.deepEqual(texts(harness.committed, 's1'), ['first prompt', 'first reply'], 'a repaired store resumes capture')
})

// ---------------------------------------------------------------------------
// Start and status
// ---------------------------------------------------------------------------

test('startCrushSource runs one tick before returning and reports polling status', async () => {
  const harness = await createCrushHarness({ projects: ['p1'] })
  const source = await startCrushSource(harness.ctx)
  try {
    const status = await source.status?.()
    assert.equal(status?.state, 'ready')
    assert.match(status?.message ?? '', /^polling 1 crush projects every \d+ms, no sessions yet$/)
    assert.equal(typeof status?.details?.last_poll_at, 'string')
    assert.equal(status?.details?.index_path, harness.indexPath)
  } finally {
    await source.stop()
  }
  assert.equal((await source.status?.())?.state, 'stopped')
})

test('enabled = false opens nothing and says so', async () => {
  const harness = await createCrushHarness({ projects: ['p1'], config: { enabled: false } })
  const source = await startCrushSource(harness.ctx)
  const status = await source.status?.()
  await source.stop()
  assert.equal(status?.state, 'ready')
  assert.equal(status?.message, 'crush ongoing capture disabled (crush.enabled = false)')
  assert.equal(crushPollLogs(harness.logs).length, 0)
  assert.equal(harness.logs[0]?.message, 'crush.source_disabled')
})

test('status names a missing install, an empty index, stale entries and recording', async () => {
  const harness = await createCrushHarness({ projects: ['p1'] })
  const runner = createCrushPollRunner(harness.ctx)

  await fs.rm(harness.indexPath)
  await runCrushPollTick(runner, harness.ctx)
  assert.equal(statusOf(runner).message, `no crush installation detected at ${harness.indexPath}`)

  await harness.writeIndex([])
  await runCrushPollTick(runner, harness.ctx)
  assert.equal(statusOf(runner).message, `crush index at ${harness.indexPath} lists no projects yet`)

  await harness.writeIndex([path.join(harness.projectDirs[0], '.crush'), path.join(harness.dir, 'gone', '.crush')])
  await runCrushPollTick(runner, harness.ctx)
  assert.equal(statusOf(runner).message,
    `polling 1 crush projects every ${runner.pollIntervalMs}ms, no sessions yet; 1 listed projects have no crush.db`)

  const w = openWriter(harness.dbPaths[0])
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'first')
  await runCrushPollTick(runner, harness.ctx)
  w.close()
  const status = statusOf(runner)
  assert.equal(status.state, 'ready')
  assert.equal(status.message, `polling 1 crush projects every ${runner.pollIntervalMs}ms; 1 listed projects have no crush.db`)
  assert.equal(status.details?.sessions_tracked, 1)
})

test('an unreadable crush.db degrades with permission_denied and keeps the path out of logs and spans', async () => {
  const harness = await createCrushHarness({ projects: ['p1'] })
  const dbPath = harness.dbPaths[0]
  await fs.chmod(dbPath, 0o000)
  try {
    const runner = createCrushPollRunner(harness.ctx)
    /** @type {any[]} */
    const spans = []
    const provider = new TracerProvider({
      resource: { attributes: {} },
      exporters: [{
        exportBatch: (/** @type {any[]} */ batch) => {
          for (const s of batch) spans.push({ name: s.name, status: { ...s.status }, attributes: { ...s.attributes }, events: s.events })
        },
      }],
    })
    provider.register()
    try {
      await runCrushPollTick(runner, harness.ctx)
    } finally {
      await provider.shutdown()
    }
    const status = statusOf(runner)
    assert.equal(status.state, 'degraded')
    assert.equal(status.details?.error_kind, 'permission_denied')
    assert.equal(status.message, 'cannot read 1 crush databases')
    assert.equal(status.lastError, status.message, 'plain status prints the same text')
    assert.equal(crushPollLogs(harness.logs).at(-1)?.fields?.error_kind, 'permission_denied')
    assert.ok(spans.some(s => s.name === 'crush.poll'), 'the tick span was exported')
    for (const marker of [dbPath, harness.projectDirs[0]]) {
      assert.ok(!JSON.stringify(harness.logs).includes(marker), 'the path stays out of the log')
      assert.ok(!JSON.stringify(spans).includes(marker), 'the path stays out of the span')
    }
  } finally {
    await fs.chmod(dbPath, 0o600)
  }
})

test('a database locked past the bounded retry degrades with sqlite_busy and recovers next poll', async () => {
  // A rollback-journal writer holding EXCLUSIVE blocks every reader, which a
  // WAL writer never does.
  const { runner, ctx, committed, w } = await baselined()
  w.exec('PRAGMA journal_mode = DELETE')
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'first')
  w.exec('BEGIN EXCLUSIVE')
  await runCrushPollTick(runner, ctx)
  const status = statusOf(runner)
  assert.equal(status.state, 'degraded')
  assert.equal(status.details?.error_kind, 'sqlite_busy')
  assert.equal(status.message, '1 crush databases busy, retrying next poll')
  assert.equal(committed.length, 0)

  w.exec('COMMIT')
  await runCrushPollTick(runner, ctx)
  w.close()
  assert.equal(statusOf(runner).state, 'ready')
  assert.deepEqual(texts(committed, 's1'), ['first prompt', 'first reply'], 'the held change lands once the lock clears')
})

test('a database missing a required column degrades with schema_unsupported naming it', async () => {
  const harness = await createCrushHarness({ projects: ['p1'] })
  await fs.rm(path.join(harness.projectDirs[0], '.crush'), { recursive: true })
  await createCrushDb(harness.projectDirs[0], { dropColumn: ['sessions', 'parent_session_id'] })
  const runner = createCrushPollRunner(harness.ctx)
  await runCrushPollTick(runner, harness.ctx)
  const status = statusOf(runner)
  assert.equal(status.state, 'degraded')
  assert.equal(status.details?.error_kind, 'schema_unsupported')
  assert.match(status.message ?? '', /sessions\.parent_session_id.*\(1 crush databases\)$/)
  assert.ok(!(status.message ?? '').includes(harness.dbPaths[0]), 'the schema detail names no path')
})

test('an index that stops parsing degrades with index_unreadable and keeps polling the last good list', async () => {
  const { runner, ctx, logs, w, indexPath } = await baselined()
  await fs.writeFile(indexPath, '{ not json')
  insertSession(w, { id: 's1' })
  addTurn(w, 's1', 'first')
  await runCrushPollTick(runner, ctx)
  w.close()
  const status = statusOf(runner)
  assert.equal(status.state, 'degraded')
  assert.equal(status.details?.error_kind, 'index_unreadable')
  assert.equal(status.message, `cannot read the crush index at ${indexPath}`)
  const last = crushPollLogs(logs).at(-1)
  assert.equal(last?.fields?.error_kind, 'index_unreadable')
  assert.equal(last?.fields?.dbs_total, 1)
  assert.ok(Number(last?.fields?.rows) > 0, 'the last good list is still polled')
})

test('past the database cap the tick logs too_many_projects ahead of any per-database kind', async () => {
  const harness = await createCrushHarness({ projects: [] })
  /** @type {string[]} */
  const dataDirs = []
  for (let i = 0; i < MAX_DATABASES + 3; i++) {
    const dataDir = path.join(harness.dir, `p${String(i).padStart(4, '0')}`, '.crush')
    await fs.mkdir(dataDir, { recursive: true })
    // An empty file is a database with no tables: each one opened fails as
    // schema_unsupported, which the cap outranks.
    await fs.writeFile(path.join(dataDir, 'crush.db'), '')
    dataDirs.push(dataDir)
  }
  await harness.writeIndex(dataDirs)
  const runner = createCrushPollRunner(harness.ctx)
  await runCrushPollTick(runner, harness.ctx)
  const status = statusOf(runner)
  assert.equal(status.state, 'degraded')
  assert.equal(status.details?.error_kind, 'too_many_projects')
  assert.equal(status.message, '3 crush projects skipped over the 1,024 limit')
  const last = crushPollLogs(harness.logs).at(-1)
  assert.equal(last?.fields?.error_kind, 'too_many_projects')
  assert.equal(last?.fields?.dbs_total, MAX_DATABASES)
})

test('no log line carries message text, a title, the project dir or the database path', async () => {
  const { runner, ctx, logs, w, projectDirs, dbPaths } = await baselined()
  insertSession(w, { id: 's1', title: 'Fixture title' })
  addTurn(w, 's1', 'first')
  await runCrushPollTick(runner, ctx)
  w.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Renamed fixture title', 's1')
  addTurn(w, 's1', 'second')
  await runCrushPollTick(runner, ctx)
  await runCrushPollTick(runner, ctx)
  w.close()
  const ok = crushPollLogs(logs, 'ok')
  assert.ok(ok.length > 0, 'a recording tick ran')
  for (const entry of ok) {
    for (const key of ['component', 'operation', 'status', 'dbs_total', 'dbs_changed', 'dbs_opened', 'dbs_pending', 'sessions_changed', 'sessions_pending', 'rows']) {
      assert.ok(entry.fields && key in entry.fields, `crush.poll carries ${key}`)
    }
  }
  const serialized = JSON.stringify(logs)
  for (const marker of ['first prompt', 'first reply', 'second prompt', 'Fixture title', 'Renamed fixture title', projectDirs[0], dbPaths[0]]) {
    assert.ok(!serialized.includes(marker), `no log line carries ${marker}`)
  }
})
