// @ts-check

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import nodeFs from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  createMastracodePollRunner,
  errorKind,
  mastraStatSig,
  mastracodeSourceStatus,
  runMastracodePollTick,
  startMastracodeSource,
  statusInputs,
} from '../../hypaware-core/plugins-workspace/mastracode/src/source.js'
import { MastraDbError } from '../../hypaware-core/plugins-workspace/mastracode/src/errors.js'
import { openMastraDb, SQLITE_VERSION_SQL } from '../../hypaware-core/plugins-workspace/mastracode/src/mastra_db.js'
import { readMastraWatermark } from '../../hypaware-core/plugins-workspace/mastracode/src/watermark.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import { sessionIgnoresDir } from '../../src/core/runtime/paths.js'
import { assistantContent, insertMessage, openWriter, rewriteMessage, textPart, updateThread } from '../helpers/mastracode_db_fixture.js'
import { addThread, addTurn, createMastracodeHarness, mastracodePollLogs, nextUpdatedAt, texts } from '../helpers/mastracode_source_fixture.js'

const require = createRequire(import.meta.url)

/**
 * @ref LLP 0586#reconciliation [tests]: the stat gate on `mastra.db` and its
 *   `-wal`, the rowid cursor and the floor, the per-thread digest and its
 *   `open` flag, deferred claims and the one-batch commit, through the real
 *   materializer and a scoped snapshot writer.
 * @ref LLP 0586#privacy [tests]: a usage-policy ignore reconciles the thread
 *   to an empty snapshot, an excluded thread is never projected and is
 *   recovered by unignore, and a store that cannot load fails closed.
 * @ref LLP 0586#source [tests]: start runs one tick, a restart over a
 *   recorded watermark re-imports nothing, and no connection outlives stop.
 *
 * Synthetic rows only, written through the fixture's own connection between
 * ticks, as Mastra Code writes.
 */

/**
 * A harness whose database has had its first (baseline) tick, with a writer
 * open on it.
 *
 * @param {{ ignoredSessions?: Set<string>,
 *   hooks?: NonNullable<Parameters<typeof createMastracodeHarness>[0]>['hooks'] }} [opts]
 */
async function baselined(opts = {}) {
  const harness = await createMastracodeHarness({ hooks: opts.hooks })
  const runner = createMastracodePollRunner(harness.ctx, { ignoredSessions: opts.ignoredSessions })
  await runMastracodePollTick(runner, harness.ctx)
  const w = openWriter(harness.dbPath)
  return { ...harness, runner, w }
}

/** @param {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} logs */
function lastPoll(logs) {
  return /** @type {Record<string, unknown>} */ (mastracodePollLogs(logs).at(-1)?.fields)
}

// ---------------------------------------------------------------------------
// The stat gate
// ---------------------------------------------------------------------------

test('first start baselines without walking history', async () => {
  const harness = await createMastracodeHarness()
  const w = openWriter(harness.dbPath)
  addThread(w, 't1', harness.projectDir, { title: 'Fixture title' })
  addTurn(w, 't1', 'history')
  w.close()
  const runner = createMastracodePollRunner(harness.ctx)
  await runMastracodePollTick(runner, harness.ctx)
  assert.equal(harness.committed.length, 0, 'history is the backfill\'s, not the poll\'s')
  assert.equal(mastracodePollLogs(harness.logs, 'baseline').length, 1)
  const db = runner.watermark?.db
  assert.equal(db?.max_rowid, 2, 'the cursor starts past the existing rows')
  assert.equal(typeof db?.floor, 'string', 'the floor is the newest updatedAt')
  assert.deepEqual(runner.watermark?.threads, {})
})

test('an idle tick opens nothing', async () => {
  const { runner, ctx, logs, w, projectDir } = await baselined()
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'first')
  await runMastracodePollTick(runner, ctx)
  assert.equal(lastPoll(logs).changed, true)
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.equal(lastPoll(logs).poll_status, 'unchanged')
  assert.equal(lastPoll(logs).changed, false)
})

test('a commit that lands during the read leaves the database to reopen next tick', async () => {
  const { runner, ctx, committed, w, projectDir } = await baselined()
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'first')
  const materializers = ctx.backfillMaterializers
  let armed = true
  ctx.backfillMaterializers = {
    get(/** @type {string} */ kind) {
      if (armed) {
        armed = false
        addTurn(w, 't1', 'mid-read')
      }
      return materializers.get(kind)
    },
  }
  await runMastracodePollTick(runner, ctx)
  assert.deepEqual(texts(committed, 't1'), ['first prompt', 'first reply'])
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 't1'), ['first prompt', 'first reply', 'mid-read prompt', 'mid-read reply'])
})

test('the signature moves on every commit through a separate writer, through a checkpoint and a WAL reset', async () => {
  const { runner, ctx, committed, batches, logs, w, dbPath, projectDir } = await baselined()
  /** @type {Set<string | null>} */
  const seen = new Set([mastraStatSig(dbPath)])
  addThread(w, 't1', projectDir)
  assert.ok(!seen.has(mastraStatSig(dbPath)))
  seen.add(mastraStatSig(dbPath))
  addTurn(w, 't1', 'first')
  assert.ok(!seen.has(mastraStatSig(dbPath)))
  seen.add(mastraStatSig(dbPath))
  await runMastracodePollTick(runner, ctx)
  const rows = committed.length
  const batchCount = batches.length

  w.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  assert.ok(!seen.has(mastraStatSig(dbPath)), 'a checkpoint-and-reset moves the signature')
  seen.add(mastraStatSig(dbPath))
  await runMastracodePollTick(runner, ctx)
  assert.equal(lastPoll(logs).changed, true)
  assert.equal(batches.length, batchCount, 'no thread is rewritten')
  assert.equal(committed.length, rows)
  await runMastracodePollTick(runner, ctx)
  assert.equal(lastPoll(logs).poll_status, 'unchanged', 'the reset WAL settles')

  addTurn(w, 't1', 'after-reset')
  assert.ok(!seen.has(mastraStatSig(dbPath)), 'the first write after a reset moves it too')
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 't1'), ['first prompt', 'first reply', 'after-reset prompt', 'after-reset reply'])
})

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

test('an appended turn is captured as one thread snapshot', async () => {
  const { runner, ctx, committed, batches, w, projectDir } = await baselined()
  addThread(w, 't1', projectDir, { title: 'Fixture title' })
  addTurn(w, 't1', 'first')
  await runMastracodePollTick(runner, ctx)
  assert.deepEqual(texts(committed, 't1'), ['first prompt', 'first reply'])
  addTurn(w, 't1', 'second')
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 't1'), ['first prompt', 'first reply', 'second prompt', 'second reply'])
  assert.deepEqual(batches.at(-1), ['mastracode-t1'])
  assert.equal(runner.watermark?.threads.t1.message_count, 4)
})

test('an assistant row rewritten in place, with no updatedAt bump, reconciles to one whole turn', async () => {
  const { runner, ctx, committed, w, projectDir } = await baselined()
  addThread(w, 't1', projectDir)
  insertMessage(w, { id: 'u1', thread_id: 't1', role: 'signal', type: 'user', content: { format: 2, parts: [textPart('stream prompt')] } })
  insertMessage(w, { id: 'a1', thread_id: 't1', role: 'assistant', type: 'v2', content: assistantContent([textPart('partial')]) })
  await runMastracodePollTick(runner, ctx)
  assert.equal(runner.watermark?.threads.t1.open, true, 'a changed digest leaves the entry open')
  assert.equal(runner.threadsPending, 0, 'an open thread is not pending work')

  rewriteMessage(w, 'a1', assistantContent([textPart('partial'), textPart('final reply')]))
  await runMastracodePollTick(runner, ctx)
  assert.deepEqual(texts(committed, 't1'), ['stream prompt', 'partial', 'final reply'])
  assert.equal(runner.watermark?.threads.t1.open, true, 'the rewrite was found by the open re-read')

  w.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  await runMastracodePollTick(runner, ctx)
  assert.equal(runner.watermark?.threads.t1.open, false, 'a hash that finds it unchanged closes it')
  await runMastracodePollTick(runner, ctx)
  w.close()
  const partIds = committed.filter(row => row.session_id === 'mastracode-t1').map(row => String(row.part_id))
  assert.equal(new Set(partIds).size, partIds.length, 'no duplicate part ids')
})

test('an open thread is re-hashed on changed ticks only until a hash finds it unchanged, with no catch-up', async () => {
  const { runner, ctx, logs, w, projectDir } = await baselined()
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'first')
  addThread(w, 't2', projectDir)
  await runMastracodePollTick(runner, ctx)
  assert.equal(runner.watermark?.threads.t1.open, true)
  addTurn(w, 't2', 'other')
  await runMastracodePollTick(runner, ctx)
  assert.equal(lastPoll(logs).threads_changed, 2, 'the open thread is read again alongside the changed one')
  assert.equal(lastPoll(logs).threads_pending, 0)
  assert.equal(runner.watermark?.threads.t1.open, false)
  addTurn(w, 't2', 'third')
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.equal(lastPoll(logs).threads_changed, 1, 'a closed entry is not hashed again')
})

test('a row deleted and re-inserted reconciles to one', async () => {
  const { runner, ctx, committed, w, projectDir } = await baselined()
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'first')
  await runMastracodePollTick(runner, ctx)
  const reply = w.prepare('SELECT content FROM mastra_messages WHERE id = ?').get('t1-first-a')
  w.prepare('DELETE FROM mastra_messages WHERE id = ?').run('t1-first-a')
  w.prepare(`INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('t1-first-a', 't1', String(reply?.content), 'assistant', 'v2', '2026-11-05T22:52:20.831Z', 'fixture-resource')
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 't1'), ['first prompt', 'first reply'])
})

test('a continued thread appends to the same thread', async () => {
  const { runner, ctx, committed, w, projectDir } = await baselined()
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'first')
  await runMastracodePollTick(runner, ctx)
  // `mastracode -c` resumes the newest thread: new rows, the same thread id.
  addTurn(w, 't1', 'continued')
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 't1'), ['first prompt', 'first reply', 'continued prompt', 'continued reply'])
  assert.equal(new Set(committed.map(row => row.session_id)).size, 1)
})

test('a thread outside the window with no new rows is not read on later ticks', async () => {
  const harness = await createMastracodeHarness()
  const { ctx, committed, projectDir } = harness
  const w = openWriter(harness.dbPath)
  // Present at first start, so at or below the floor with its rows below
  // the cursor: the backfill's history, not the poll's.
  addThread(w, 'old', projectDir)
  addTurn(w, 'old', 'history')
  const runner = createMastracodePollRunner(ctx)
  await runMastracodePollTick(runner, ctx)
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'fresh')
  await runMastracodePollTick(runner, ctx)
  addTurn(w, 't1', 'again')
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.equal(lastPoll(harness.logs).threads_changed, 1, 'only the fresh thread is hashed')
  assert.equal(texts(committed, 'old').length, 0)
  assert.equal(runner.watermark?.threads.old, undefined, 'the old thread gets no entry')
  assert.deepEqual(texts(committed, 't1'), ['fresh prompt', 'fresh reply', 'again prompt', 'again reply'])
})

test('a restart over a recorded watermark re-imports nothing', async () => {
  const { runner, ctx, committed, batches, logs, w, projectDir } = await baselined()
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'first')
  await runMastracodePollTick(runner, ctx)
  await runMastracodePollTick(runner, ctx)
  const rows = committed.length
  const restarted = createMastracodePollRunner(ctx)
  await runMastracodePollTick(restarted, ctx)
  assert.equal(lastPoll(logs).poll_status, 'unchanged')
  assert.equal(committed.length, rows)

  addThread(w, 't2', projectDir)
  addTurn(w, 't2', 'second')
  await runMastracodePollTick(restarted, ctx)
  w.close()
  assert.ok(!batches.at(-1)?.includes('mastracode-t1'), 'the recorded thread is not rewritten')
  assert.deepEqual(texts(committed, 't2'), ['second prompt', 'second reply'])
  assert.equal(readMastraWatermark(ctx.paths.stateDir).threads.t1?.message_count, 2)
})

test('messages deleted from a live thread are removed on its next reconcile; a thread deleted upstream keeps its rows', async () => {
  const { runner, ctx, committed, w, projectDir } = await baselined()
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'kept')
  addTurn(w, 't1', 'doomed')
  addThread(w, 't2', projectDir)
  addTurn(w, 't2', 'gone')
  await runMastracodePollTick(runner, ctx)
  w.prepare('DELETE FROM mastra_messages WHERE id IN (?, ?)').run('t1-doomed-u', 't1-doomed-a')
  updateThread(w, 't1', { updatedAt: nextUpdatedAt() })
  w.prepare('DELETE FROM mastra_messages WHERE thread_id = ?').run('t2')
  w.prepare('DELETE FROM mastra_threads WHERE id = ?').run('t2')
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 't1'), ['kept prompt', 'kept reply'])
  assert.deepEqual(texts(committed, 't2'), ['gone prompt', 'gone reply'], 'the poll never deletes a thread the database dropped')
})

// ---------------------------------------------------------------------------
// Claims and the batch commit
// ---------------------------------------------------------------------------

test('a held scope defers its thread and lands once released', async () => {
  const { runner, ctx, committed, held, logs, w, projectDir } = await baselined()
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'first')
  held.add('mastracode-t1')
  await runMastracodePollTick(runner, ctx)
  assert.equal(committed.length, 0)
  assert.equal(runner.threadsPending, 1)
  assert.ok(logs.some(entry => entry.message === 'mastracode.thread_deferred'))
  held.delete('mastracode-t1')
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 't1'), ['first prompt', 'first reply'])
  assert.equal(runner.threadsPending, 0)
})

test('a failed commit leaves the recorded watermark unchanged', async () => {
  let fail = false
  const { runner, ctx, committed, w, projectDir } = await baselined({ hooks: { failBatch: () => fail, failReconcile: () => fail } })
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'first')
  await runMastracodePollTick(runner, ctx)
  await runMastracodePollTick(runner, ctx)
  const before = JSON.stringify(readMastraWatermark(ctx.paths.stateDir))
  fail = true
  addTurn(w, 't1', 'second')
  await runMastracodePollTick(runner, ctx)
  assert.equal(JSON.stringify(readMastraWatermark(ctx.paths.stateDir)), before)
  assert.ok(runner.lastError)
  assert.equal(mastracodeSourceStatus(statusInputs(runner)).state, 'degraded')
  fail = false
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.deepEqual(texts(committed, 't1'), ['first prompt', 'first reply', 'second prompt', 'second reply'])
})

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

test('a usage-policy ignore removes the thread\'s rows by empty snapshot', async () => {
  const { runner, ctx, committed, w, projectDir } = await baselined()
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'first')
  await runMastracodePollTick(runner, ctx)
  assert.equal(texts(committed, 't1').length, 2)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, '.hypignore'), 'ignore\n')
  // A fresh resolver, as a daemon restart or the policy cache expiry gives.
  runner.resolver = createMastracodePollRunner(ctx).resolver
  addTurn(w, 't1', 'second')
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.equal(committed.filter(row => row.session_id === 'mastracode-t1').length, 0)
  assert.equal(runner.lastError, undefined)
})

test('an excluded thread is not projected, an unignore recovers it, and a load error projects nothing', async () => {
  const harness = await createMastracodeHarness()
  const ignoredSessions = new SessionIgnoreSet(harness.dir)
  const runner = createMastracodePollRunner(harness.ctx, { ignoredSessions })
  const { ctx, committed, projectDir } = harness
  await runMastracodePollTick(runner, ctx)
  const store = new SessionIgnoreSet(harness.dir)
  store.add('mastracode-t1')
  const w = openWriter(harness.dbPath)
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'excluded')
  addThread(w, 't2', projectDir)
  addTurn(w, 't2', 'kept')
  await runMastracodePollTick(runner, ctx)
  assert.equal(texts(committed, 't1').length, 0)
  assert.deepEqual(texts(committed, 't2'), ['kept prompt', 'kept reply'])
  assert.equal(runner.threadsPending, 0, 'an excluded thread is not pending')

  store.delete('mastracode-t1')
  addTurn(w, 't1', 'later')
  await runMastracodePollTick(runner, ctx)
  assert.deepEqual(texts(committed, 't1'), ['excluded prompt', 'excluded reply', 'later prompt', 'later reply'])

  await fs.mkdir(sessionIgnoresDir(harness.dir), { recursive: true })
  await fs.writeFile(path.join(sessionIgnoresDir(harness.dir), 'not-a-marker'), 'x')
  const before = JSON.stringify(readMastraWatermark(harness.dir))
  const rows = committed.length
  addTurn(w, 't2', 'blocked')
  await runMastracodePollTick(runner, ctx)
  w.close()
  assert.equal(committed.length, rows, 'a store that cannot load projects nothing')
  assert.equal(JSON.stringify(readMastraWatermark(harness.dir)), before, 'nothing advances')
  assert.equal(runner.lastErrorKind, 'session_ignore_load_failed')
})

// ---------------------------------------------------------------------------
// Status, one case per row of LLP 0586#status
// ---------------------------------------------------------------------------

/**
 * The source's status after the runner's last tick.
 *
 * @ref LLP 0586#status [tests]: each row of the table from a real tick where
 *   one can produce it; the old SQLite row from the error the open raises.
 *
 * @param {ReturnType<typeof createMastracodePollRunner>} runner
 */
function statusOf(runner) {
  return mastracodeSourceStatus(statusInputs(runner))
}

/**
 * Every log line serialized, for the privacy assertion: no fixture text,
 * title, project path or database path may appear in any of them.
 *
 * @param {{ logs: unknown[], dir: string, dbPath: string, projectDir: string }} harness
 * @param {string[]} markers
 */
function assertLogsCarryNoContent(harness, markers) {
  const serialized = JSON.stringify(harness.logs)
  for (const needle of [...markers, harness.dir, harness.dbPath, harness.projectDir]) {
    assert.equal(serialized.includes(needle), false, `no log line carries ${JSON.stringify(needle)}`)
  }
}

test('status: no database is ready with zero rows and names the path it looked at', async () => {
  const harness = await createMastracodeHarness()
  const absent = path.join(harness.dir, 'absent', 'mastra.db')
  harness.ctx.env.MASTRA_DB_PATH = absent
  const runner = createMastracodePollRunner(harness.ctx)
  await runMastracodePollTick(runner, harness.ctx)
  const status = statusOf(runner)
  assert.equal(status.state, 'ready')
  assert.equal(status.rowsWritten, 0)
  assert.equal(status.message, `no mastracode installation detected at ${absent}`)
  assert.equal(status.details?.db_path, absent)
  assert.equal(status.lastError, undefined)
  assert.equal(lastPoll(harness.logs).poll_status, 'missing')
})

test('status: a store with no traffic is ready with no threads yet; a recorded turn makes it recording', async () => {
  const { runner, ctx, w, logs, projectDir, ...harness } = await baselined()
  let status = statusOf(runner)
  assert.equal(status.state, 'ready')
  assert.equal(status.rowsWritten, 0)
  assert.equal(status.message, `polling mastracode every ${runner.pollIntervalMs}ms, no threads yet`)
  addThread(w, 't1', projectDir, { title: 'status-title-marker' })
  addTurn(w, 't1', 'status-text-marker')
  w.close()
  await runMastracodePollTick(runner, ctx)
  status = statusOf(runner)
  assert.equal(status.state, 'ready')
  assert.ok((status.rowsWritten ?? 0) > 0, 'recording')
  assert.equal(status.message, `polling mastracode every ${runner.pollIntervalMs}ms`)
  assert.equal(status.details?.threads_tracked, 1)
  assert.equal(status.details?.threads_pending, 0)
  assert.equal(typeof status.details?.last_poll_at, 'string')
  assertLogsCarryNoContent({ logs, projectDir, ...harness }, ['status-title-marker', 'status-text-marker'])
})

// Mode 000 does not stop root, and win32 has no POSIX mode bits.
const cannotChmod = process.platform === 'win32' || process.getuid?.() === 0

test('status: a database with mode 000 is degraded permission_denied, and no log line names it', { skip: cannotChmod }, async () => {
  const { runner, ctx, w, logs, projectDir, dbPath, ...harness } = await baselined()
  addThread(w, 't1', projectDir, { title: 'unreadable-title-marker' })
  addTurn(w, 't1', 'unreadable-text-marker')
  w.close()
  const before = JSON.stringify(readMastraWatermark(harness.dir))
  await fs.chmod(dbPath, 0o000)
  try {
    await runMastracodePollTick(runner, ctx)
  } finally {
    await fs.chmod(dbPath, 0o644)
  }
  const status = statusOf(runner)
  assert.equal(status.state, 'degraded')
  assert.equal(status.details?.error_kind, 'permission_denied')
  assert.equal(status.message, `cannot read the mastracode database at ${dbPath}`)
  assert.equal(status.lastError, status.message)
  assert.equal(JSON.stringify(readMastraWatermark(harness.dir)), before, 'the watermark is left as it was')
  const failed = logs.filter(entry => entry.message === 'mastracode.poll' && entry.level === 'error')
  assert.equal(failed.at(-1)?.fields?.error_kind, 'permission_denied')
  assertLogsCarryNoContent({ logs, projectDir, dbPath, ...harness }, ['unreadable-title-marker', 'unreadable-text-marker'])
  await runMastracodePollTick(runner, ctx)
  assert.equal(statusOf(runner).state, 'ready', 'a readable database recovers on the next tick')
})

test('status: a writer holding the lock is degraded sqlite_busy, and the next tick captures', async () => {
  const { runner, ctx, w, logs, projectDir, committed, ...harness } = await baselined()
  const before = JSON.stringify(readMastraWatermark(harness.dir))
  // An exclusive-mode writer keeps its lock after the commit, so every
  // reader's first statement is SQLITE_BUSY until it lets go.
  w.exec('PRAGMA locking_mode = EXCLUSIVE')
  addThread(w, 't1', projectDir)
  addTurn(w, 't1', 'busy-text-marker')
  await runMastracodePollTick(runner, ctx)
  const status = statusOf(runner)
  assert.equal(status.state, 'degraded')
  assert.equal(status.details?.error_kind, 'sqlite_busy')
  assert.equal(status.message, 'mastracode database busy, retrying next poll')
  assert.equal(committed.length, 0)
  assert.equal(JSON.stringify(readMastraWatermark(harness.dir)), before, 'the watermark is left as it was')
  w.exec('PRAGMA locking_mode = NORMAL')
  // The lock is released on the next access after the mode change.
  w.prepare('SELECT 1 FROM mastra_threads LIMIT 1').get()
  w.close()
  await runMastracodePollTick(runner, ctx)
  assert.equal(statusOf(runner).state, 'ready')
  assert.deepEqual(texts(committed, 't1'), ['busy-text-marker prompt', 'busy-text-marker reply'])
  assertLogsCarryNoContent({ logs, projectDir, ...harness }, ['busy-text-marker'])
})

test('status: a missing table or column is degraded schema_unsupported and names it', async () => {
  const { runner, ctx, w } = await baselined()
  w.exec('ALTER TABLE mastra_threads DROP COLUMN metadata')
  await runMastracodePollTick(runner, ctx)
  let status = statusOf(runner)
  assert.equal(status.state, 'degraded')
  assert.equal(status.details?.error_kind, 'schema_unsupported')
  assert.equal(status.message, 'mastra.db has no mastra_threads.metadata column')
  w.exec('ALTER TABLE mastra_threads ADD COLUMN metadata TEXT')
  w.exec('DROP TABLE mastra_messages')
  w.close()
  await runMastracodePollTick(runner, ctx)
  status = statusOf(runner)
  assert.equal(status.details?.error_kind, 'schema_unsupported')
  assert.equal(status.message, 'mastra.db has no mastra_messages table')
})

test('status: a SQLite older than 3.45 is degraded sqlite_unsupported', async () => {
  const harness = await createMastracodeHarness()
  const real = require('node:sqlite')
  class OldSqlite extends real.DatabaseSync {
    /** @param {string} sql */
    prepare(sql) {
      if (sql === SQLITE_VERSION_SQL) return /** @type {any} */ ({ get: () => ({ version: '3.44.2' }) })
      return super.prepare(sql)
    }
  }
  // The runner opens the real module; the status is fed the error the open
  // raises under an older one.
  /** @type {unknown} */
  let raised
  try {
    openMastraDb(harness.dbPath, { requireFn: () => ({ DatabaseSync: OldSqlite }) })
  } catch (err) {
    raised = err
  }
  assert.ok(raised instanceof MastraDbError)
  const runner = createMastracodePollRunner(harness.ctx)
  const status = mastracodeSourceStatus({
    ...statusInputs(runner),
    dbPresent: true,
    lastErrorKind: errorKind(raised),
    lastError: raised.message,
  })
  assert.equal(status.state, 'degraded')
  assert.equal(status.details?.error_kind, 'sqlite_unsupported')
  assert.equal(status.message, "SQLite 3.44.2 cannot read Mastra Code's JSONB metadata (needs 3.45 or newer)")
})

test('status: MASTRA_DB_URL is degraded remote_store_unsupported and opens no file', async () => {
  const harness = await createMastracodeHarness({ env: { MASTRA_DB_URL: 'libsql://example.invalid' } })
  const appdata = path.dirname(harness.dbPath)
  const listed = (await fs.readdir(appdata)).sort()
  const runner = createMastracodePollRunner(harness.ctx)
  await runMastracodePollTick(runner, harness.ctx)
  const status = statusOf(runner)
  assert.equal(status.state, 'degraded')
  assert.equal(status.details?.error_kind, 'remote_store_unsupported')
  assert.equal(status.details?.remote_store, true)
  assert.equal(status.details?.db_path, undefined)
  assert.equal(status.message, 'MASTRA_DB_URL is set; remote stores are not supported')
  assert.equal(runner.dbPresent, false, 'the local file was not even stat-ed')
  assert.deepEqual((await fs.readdir(appdata)).sort(), listed, 'no -wal or -shm appeared, so nothing opened it')
  assert.deepEqual(openDescriptors(harness.dbPath), [])
  assertLogsCarryNoContent(harness, ['libsql://example.invalid'])
})

test('status: enabled = false reports capture disabled and starts no poll', async () => {
  const harness = await createMastracodeHarness({ config: { enabled: false } })
  const source = await startMastracodeSource(harness.ctx)
  try {
    const status = await source.status?.()
    assert.equal(status?.state, 'ready')
    assert.equal(status?.message, 'mastracode ongoing capture disabled (mastracode.enabled = false)')
    assert.deepEqual(status?.details, { enabled: false })
  } finally {
    await source.stop()
  }
  assert.equal(mastracodePollLogs(harness.logs).length, 0, 'no tick ran')
})

// ---------------------------------------------------------------------------
// Start and stop
// ---------------------------------------------------------------------------

test('startMastracodeSource runs one tick, and no connection is open after stop', async () => {
  const harness = await createMastracodeHarness()
  const w = openWriter(harness.dbPath)
  addThread(w, 't1', harness.projectDir)
  const probed = nodeFs.existsSync('/proc/self/fd')
  if (probed) assert.ok(openDescriptors(harness.dbPath).length > 0, 'the probe sees an open connection')
  w.close()
  const source = await startMastracodeSource(harness.ctx)
  try {
    const status = await source.status?.()
    assert.equal(status?.state, 'ready')
    assert.match(status?.message ?? '', /^polling mastracode every \d+ms, no threads yet$/)
    assert.equal(typeof status?.details?.last_poll_at, 'string')
  } finally {
    await source.stop()
  }
  assert.equal((await source.status?.())?.state, 'stopped')
  assert.deepEqual(openDescriptors(harness.dbPath), [], 'the tick closed its connection')
})

/**
 * This process's open descriptors on the database or its sidecars, read from
 * `/proc/self/fd`; empty where there is no `/proc`.
 *
 * @param {string} dbPath
 * @returns {string[]}
 */
function openDescriptors(dbPath) {
  let fds
  try {
    fds = nodeFs.readdirSync('/proc/self/fd')
  } catch {
    return []
  }
  /** @type {string[]} */
  const open = []
  for (const fd of fds) {
    try {
      const target = nodeFs.readlinkSync(path.join('/proc/self/fd', fd))
      if (target.startsWith(dbPath)) open.push(target)
    } catch {
      // closed between the listing and the read
    }
  }
  return open
}
