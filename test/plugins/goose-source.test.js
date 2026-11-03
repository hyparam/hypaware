// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  createGoosePollRunner,
  gooseSourceStatus,
  runGoosePollTick,
  startGooseSource,
  GOOSE_SESSIONS_PER_TICK,
} from '../../hypaware-core/plugins-workspace/goose/src/source.js'
import { readGooseWatermark } from '../../hypaware-core/plugins-workspace/goose/src/watermark.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import { sessionIgnoresDir } from '../../src/core/runtime/paths.js'
import {
  createFakeStorage,
  createFixtureDb,
  insertMessage,
  insertSession,
  makeCtx,
  pollLogs,
  renameSession,
  tmpDir,
} from '../helpers/goose_source_fixture.js'

/**
 * @ref LLP 0570#reconciliation [tests]: baseline, the `data_version`
 *   shortcut, the two cursors, the per-tick budget, deferred claims and the
 *   batch commit, through the real materializer and a scoped snapshot writer.
 * @ref LLP 0570#privacy [tests]: a usage-policy ignore reconciles to an empty
 *   snapshot, a session exclusion is never projected, and an exclusions store
 *   that cannot load fails the tick closed.
 * @ref LLP 0570#status [tests]: one case per state (missing, ready with no
 *   traffic, recording, `permission_denied`, `sqlite_busy`,
 *   `schema_unsupported`, disabled), and no log record carries message text,
 *   a title, a `working_dir` or the database path.
 *
 * The fixture is a reduced copy of the Goose v1.57.0 schema v17, synthetic
 * rows only, written through its own connection between ticks so
 * `PRAGMA data_version` moves the way it does when Goose writes.
 */

/**
 * A fixture with one session holding one exchange, a runner over it, and a
 * first tick already run, so the poll has its baseline.
 *
 * @param {{ hooks?: Parameters<typeof createFakeStorage>[0], ignoredSessions?: Set<string> }} [opts]
 */
async function baselined(opts = {}) {
  const dir = await tmpDir()
  const workingDir = path.join(dir, 'work')
  await fs.mkdir(workingDir)
  const sessionsDb = path.join(dir, 'sessions.db')
  const db = createFixtureDb(sessionsDb)
  insertSession(db, { id: 's1', workingDir })
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'fixture prompt' })
  insertMessage(db, { sessionId: 's1', role: 'assistant', text: 'fixture reply' })
  const harness = makeCtx({ dir, sessionsDb, hooks: opts.hooks })
  const runner = createGoosePollRunner(harness.ctx, opts.ignoredSessions ? { ignoredSessions: opts.ignoredSessions } : {})
  await runGoosePollTick(runner, harness.ctx)
  return { dir, workingDir, sessionsDb, db, runner, ...harness }
}

// ---------------------------------------------------------------------------
// Idle and disabled
// ---------------------------------------------------------------------------

test('a missing sessions.db idles as ready: nothing opened, idle logged once, no error', async () => {
  const dir = await tmpDir()
  const sessionsDb = path.join(dir, 'sessions.db')
  const { ctx, logs } = makeCtx({ dir, sessionsDb })
  const runner = createGoosePollRunner(ctx)
  await runGoosePollTick(runner, ctx)
  await runGoosePollTick(runner, ctx)
  await runGoosePollTick(runner, ctx)

  assert.equal(runner.db, null)
  assert.equal(runner.lastError, undefined)
  assert.equal(logs.filter(entry => entry.message === 'goose.source_idle').length, 1)
  assert.deepEqual(logs.filter(entry => entry.level === 'error'), [])
  const status = gooseSourceStatus(runner)
  assert.equal(status.state, 'ready')
  assert.equal(status.message, 'no goose installation detected')
  assert.equal(status.rowsWritten, 0)
})

test('enabled = false opens nothing and reports the kill switch', async () => {
  const dir = await tmpDir()
  const sessionsDb = path.join(dir, 'sessions.db')
  createFixtureDb(sessionsDb).close()
  const { ctx, logs } = makeCtx({ dir, sessionsDb, config: { enabled: false } })
  const source = await startGooseSource(ctx)
  try {
    const status = await source.status?.()
    assert.ok(status)
    assert.equal(status.state, 'ready')
    assert.equal(status.message, 'goose ongoing capture disabled (goose.enabled = false)')
    assert.equal(status.details?.enabled, false)
    assert.ok(logs.some(entry => entry.message === 'goose.source_disabled'))
    assert.ok(!logs.some(entry => entry.message === 'goose.poll'), 'no tick ran')
  } finally {
    await source.stop()
  }
})

test('an existing sessions.db with no sessions reports polling, no sessions yet', async () => {
  const dir = await tmpDir()
  const sessionsDb = path.join(dir, 'sessions.db')
  createFixtureDb(sessionsDb).close()
  const { ctx, logs } = makeCtx({ dir, sessionsDb, config: { poll_interval: '30s' } })
  const source = await startGooseSource(ctx)
  try {
    const status = await source.status?.()
    assert.ok(status)
    assert.equal(status.state, 'ready')
    assert.equal(status.message, `polling ${sessionsDb} every 30000ms, no sessions yet`)
    assert.equal(status.rowsWritten, 0)
    assert.deepEqual(logs.filter(entry => entry.level === 'error'), [])
  } finally {
    await source.stop()
  }
})

// ---------------------------------------------------------------------------
// Baseline, the data_version shortcut, and the two cursors
// ---------------------------------------------------------------------------

test('first start baselines at the store maxima and projects no history', async () => {
  const { dir, runner, committed, logs, db } = await baselined()
  db.close()
  assert.equal(committed.length, 0, 'history is the backfill\'s job')
  assert.equal(pollLogs(logs, 'baseline').length, 1)
  const persisted = readGooseWatermark(dir)
  assert.equal(persisted.cursor_id, 2)
  assert.equal(typeof persisted.cursor_updated_at, 'string')
  assert.deepEqual(Object.keys(persisted.sessions), ['s1'])
  assert.equal(persisted.sessions.s1.digest, undefined, 'a seed carries no digest')
})

test('an idle tick is the data_version shortcut and reads nothing else', async () => {
  const { runner, ctx, logs, db } = await baselined()
  db.close()
  const before = JSON.stringify(runner.watermark)
  await runGoosePollTick(runner, ctx)
  assert.equal(pollLogs(logs, 'unchanged').length, 1)
  assert.equal(JSON.stringify(runner.watermark), before)
})

test('a new message reconciles the whole session and advances both cursors', async () => {
  const { runner, ctx, committed, logs, db } = await baselined()
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'second prompt' })
  insertMessage(db, { sessionId: 's1', role: 'assistant', text: 'second reply' })
  await runGoosePollTick(runner, ctx)

  const ok = pollLogs(logs, 'ok')
  assert.equal(ok.length, 1)
  assert.equal(ok[0].fields?.sessions_changed, 1)
  assert.ok(committed.length > 0, 'rows landed')
  assert.ok(committed.every(row => row.session_id === 'goose-s1' && row.client_name === 'goose'))
  assert.equal(runner.watermark?.cursor_id, 4)
  assert.equal(runner.watermark?.sessions.s1.max_id, 4)
  assert.match(runner.watermark?.sessions.s1.digest ?? '', /^[a-f0-9]{64}$/)
  assert.equal(runner.rowsWritten, committed.length)

  // Settled: the next tick is the shortcut again.
  await runGoosePollTick(runner, ctx)
  assert.equal(pollLogs(logs, 'unchanged').length, 1)
  db.close()
})

test('a session found only by updated_at reconciles; a repeat read with the same mark is skipped', async () => {
  const { runner, ctx, committed, db } = await baselined()
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'second prompt' })
  await runGoosePollTick(runner, ctx)
  const rowsAfterMessage = committed.length
  const writtenAfterMessage = runner.rowsWritten

  renameSession(db, 's1', 'Renamed session')
  await runGoosePollTick(runner, ctx)
  assert.equal(committed.length, rowsAfterMessage, 'the rename re-projects the same parts')
  const markAfterRename = runner.watermark?.sessions.s1
  assert.equal(markAfterRename?.max_id, 3)

  // Another connection's write that touches no Goose row moves data_version,
  // and the inclusive time cursor re-reads s1: its mark matches, so no work.
  db.exec('CREATE TABLE unrelated (x)')
  await runGoosePollTick(runner, ctx)
  assert.deepEqual(runner.watermark?.sessions.s1, markAfterRename)
  assert.ok(runner.rowsWritten >= writtenAfterMessage)
  db.close()
})

// ---------------------------------------------------------------------------
// Budget, catch-up and deferred claims
// ---------------------------------------------------------------------------

test('a burst past the per-tick budget is held for catch-up ticks without losing a session', async () => {
  const { runner, ctx, committed, workingDir, db } = await baselined()
  const extra = GOOSE_SESSIONS_PER_TICK + 6
  for (let i = 0; i < extra; i++) {
    insertSession(db, { id: `b${i}`, workingDir })
    insertMessage(db, { sessionId: `b${i}`, role: 'user', text: `burst ${i}` })
  }
  await runGoosePollTick(runner, ctx)
  assert.equal(runner.sessionsPending, 6)
  const firstTickSessions = new Set(committed.map(row => row.session_id))
  assert.equal(firstTickSessions.size, GOOSE_SESSIONS_PER_TICK)
  assert.ok(Number(runner.watermark?.cursor_id) < extra + 2, 'the id cursor holds below the first held session')
  assert.equal(gooseSourceStatus(runner).details?.sessions_pending, 6)

  await runGoosePollTick(runner, ctx)
  assert.equal(runner.sessionsPending, 0)
  assert.equal(new Set(committed.map(row => row.session_id)).size, extra)
  assert.equal(runner.watermark?.cursor_id, extra + 2)
  db.close()
})

test('a scope another writer holds is deferred, holds the cursors, and lands next tick', async () => {
  const { runner, ctx, committed, held, logs, db } = await baselined()
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'second prompt' })
  held.add('goose-s1')
  const cursorBefore = runner.watermark?.cursor_id
  await runGoosePollTick(runner, ctx)
  assert.equal(committed.length, 0)
  assert.equal(runner.sessionsPending, 1)
  assert.equal(runner.watermark?.cursor_id, cursorBefore)
  assert.equal(runner.lastError, undefined, 'a deferral is not an error')
  assert.equal(logs.filter(entry => entry.message === 'goose.session_deferred').length, 1)

  held.delete('goose-s1')
  await runGoosePollTick(runner, ctx)
  assert.ok(committed.length > 0)
  assert.equal(runner.sessionsPending, 0)
  assert.equal(held.size, 0, 'every claim is released')
  db.close()
})

// ---------------------------------------------------------------------------
// The batch commit
// ---------------------------------------------------------------------------

test('a tick commits its sessions in one batch call, in admission order', async () => {
  const { runner, ctx, batches, workingDir, db } = await baselined()
  insertSession(db, { id: 's2', workingDir })
  insertMessage(db, { sessionId: 's2', role: 'user', text: 'other prompt' })
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'second prompt' })
  await runGoosePollTick(runner, ctx)
  // Admission is by first new message id, so s2 (id 3) precedes s1 (id 4).
  assert.deepEqual(batches, [['goose-s2', 'goose-s1']])
  db.close()
})

test('a failed batch falls back to per-session commits', async () => {
  const { runner, ctx, committed, logs, workingDir, db } = await baselined({ hooks: { failBatch: () => true } })
  insertSession(db, { id: 's2', workingDir })
  insertMessage(db, { sessionId: 's2', role: 'user', text: 'other prompt' })
  await runGoosePollTick(runner, ctx)
  const retry = logs.filter(entry => entry.message === 'goose.batch_reconcile_failed')
  assert.equal(retry.length, 1)
  assert.equal(retry[0].fields?.sessions_in_batch, 1)
  assert.ok(committed.some(row => row.session_id === 'goose-s2'))
  assert.equal(runner.lastError, undefined)
  db.close()
})

test('a session that cannot commit keeps the cursors and logs by kind', async () => {
  let failing = true
  const { runner, ctx, committed, logs, sessionsDb, db } = await baselined({
    hooks: { failBatch: () => true, failReconcile: () => failing },
  })
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'second prompt' })
  const before = { cursor_id: runner.watermark?.cursor_id, cursor_updated_at: runner.watermark?.cursor_updated_at }
  await runGoosePollTick(runner, ctx)
  assert.equal(committed.length, 0)
  assert.deepEqual({ cursor_id: runner.watermark?.cursor_id, cursor_updated_at: runner.watermark?.cursor_updated_at }, before)
  assert.equal(gooseSourceStatus(runner).state, 'degraded')
  const failed = logs.filter(entry => entry.message === 'goose.session_reconcile_failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].fields?.session_id, 's1')
  assert.equal(pollLogs(logs, 'failed')[0]?.fields?.error_kind, 'unknown')
  for (const entry of logs) {
    assert.ok(!JSON.stringify(entry.fields ?? {}).includes(sessionsDb), `${entry.message} keeps the database path out`)
  }

  failing = false
  await runGoosePollTick(runner, ctx)
  assert.ok(committed.length > 0, 'the next tick retries the held session')
  assert.equal(runner.lastError, undefined)
  db.close()
})

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

test('a usage-policy ignore reconciles the session to an empty snapshot', async () => {
  const { runner, ctx, committed, workingDir, db } = await baselined()
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'second prompt' })
  await runGoosePollTick(runner, ctx)
  assert.ok(committed.length > 0)

  await fs.writeFile(path.join(workingDir, '.hypignore'), 'ignore\n')
  // A fresh resolver, as a daemon restart or the policy cache expiry gives.
  runner.resolver = createGoosePollRunner(ctx).resolver
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'private prompt' })
  await runGoosePollTick(runner, ctx)
  assert.equal(committed.filter(row => row.session_id === 'goose-s1').length, 0, 'rows captured before are removed')
  assert.equal(runner.watermark?.sessions.s1.max_id, 4, 'the ignored session still settles')
  db.close()
})

test('an excluded session is never projected and the cursors move past it', async () => {
  const dir = await tmpDir()
  const ignoredSessions = new SessionIgnoreSet(dir)
  const { runner, ctx, committed, db } = await baselinedIn(dir, ignoredSessions)
  new SessionIgnoreSet(dir).add('s1')
  const markBefore = runner.watermark?.sessions.s1
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'excluded prompt' })
  await runGoosePollTick(runner, ctx)
  assert.equal(committed.length, 0)
  assert.deepEqual(runner.watermark?.sessions.s1, markBefore, 'its entry does not advance')
  assert.equal(runner.watermark?.cursor_id, 2)
  assert.equal(runner.sessionsPending, 0, 'an exclusion is settled, not pending')
  assert.equal(runner.lastError, undefined)
  db.close()
})

test('an exclusions store that cannot load fails the tick closed', async () => {
  const dir = await tmpDir()
  const ignoredSessions = new SessionIgnoreSet(dir)
  const { runner, ctx, committed, logs, db } = await baselinedIn(dir, ignoredSessions)
  await fs.mkdir(sessionIgnoresDir(dir), { recursive: true })
  await fs.writeFile(path.join(sessionIgnoresDir(dir), 'not-a-marker'), 'x')
  const before = JSON.stringify(runner.watermark)
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'second prompt' })
  await runGoosePollTick(runner, ctx)
  assert.equal(committed.length, 0)
  assert.equal(JSON.stringify(runner.watermark), before, 'nothing advances')
  assert.equal(runner.lastErrorKind, 'session_ignore_load_failed')
  assert.equal(pollLogs(logs, 'failed')[0]?.fields?.error_kind, 'session_ignore_load_failed')

  await fs.rm(path.join(sessionIgnoresDir(dir), 'not-a-marker'))
  await runGoosePollTick(runner, ctx)
  assert.ok(committed.length > 0, 'a repaired store resumes capture')
  db.close()
})

/**
 * {@link baselined} with the exclusions store rooted where the test can reach it.
 *
 * @param {string} dir
 * @param {Set<string>} ignoredSessions
 */
async function baselinedIn(dir, ignoredSessions) {
  const workingDir = path.join(dir, 'work')
  await fs.mkdir(workingDir)
  const sessionsDb = path.join(dir, 'sessions.db')
  const db = createFixtureDb(sessionsDb)
  insertSession(db, { id: 's1', workingDir })
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'fixture prompt' })
  const harness = makeCtx({ dir, sessionsDb })
  const runner = createGoosePollRunner(harness.ctx, { ignoredSessions })
  await runGoosePollTick(runner, harness.ctx)
  return { runner, db, ...harness }
}

// ---------------------------------------------------------------------------
// Start and status
// ---------------------------------------------------------------------------

test('startGooseSource runs one tick before returning and reports polling status', async () => {
  const { dir, sessionsDb, db } = await baselined()
  db.close()
  const { ctx } = makeCtx({ dir, sessionsDb })
  const source = await startGooseSource(ctx)
  try {
    const status = await source.status?.()
    assert.ok(status)
    assert.equal(status.state, 'ready')
    assert.match(status.message ?? '', /^polling .* every \d+ms$/)
    assert.equal(status.details?.sessions_tracked, 1)
    assert.equal(typeof status.details?.last_poll_at, 'string')
  } finally {
    await source.stop()
  }
  assert.equal((await source.status?.())?.state, 'stopped')
})

// ---------------------------------------------------------------------------
// Status per state, and what a log line may carry
// ---------------------------------------------------------------------------

test('a recording source reports ready, polling, and the rows it wrote', async () => {
  const { runner, ctx, sessionsDb, db } = await baselined()
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'second prompt' })
  await runGoosePollTick(runner, ctx)
  db.close()
  const status = gooseSourceStatus(runner)
  assert.equal(status.state, 'ready')
  assert.equal(status.message, `polling ${sessionsDb} every ${runner.pollIntervalMs}ms`)
  assert.ok((status.rowsWritten ?? 0) > 0)
  assert.equal(status.details?.error_kind, undefined)
})

test('an unreadable sessions.db degrades with permission_denied and names the path in status only', async () => {
  const dir = await tmpDir()
  const sessionsDb = path.join(dir, 'sessions.db')
  createFixtureDb(sessionsDb).close()
  await fs.chmod(sessionsDb, 0o000)
  try {
    const { ctx, logs } = makeCtx({ dir, sessionsDb })
    const runner = createGoosePollRunner(ctx)
    await runGoosePollTick(runner, ctx)
    const status = gooseSourceStatus(runner)
    assert.equal(status.state, 'degraded')
    assert.equal(status.details?.error_kind, 'permission_denied')
    assert.equal(status.message, `cannot read the database at ${sessionsDb}`)
    assert.equal(pollLogs(logs, 'failed')[0]?.fields?.error_kind, 'permission_denied')
    assert.ok(!JSON.stringify(logs).includes(sessionsDb), 'the path stays out of the log')
  } finally {
    await fs.chmod(sessionsDb, 0o600)
  }
})

test('a store locked past the bounded retry degrades with sqlite_busy and recovers next poll', async () => {
  // A rollback-journal writer holding EXCLUSIVE blocks every reader, which a
  // WAL store never does; the retry is shortened so the test stays quick.
  const dir = await tmpDir()
  const sessionsDb = path.join(dir, 'sessions.db')
  const db = createFixtureDb(sessionsDb)
  db.exec('PRAGMA journal_mode = DELETE')
  insertSession(db, { id: 's1', workingDir: path.join(dir, 'work') })
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'fixture prompt' })
  const { ctx, committed } = makeCtx({ dir, sessionsDb })
  const runner = createGoosePollRunner(ctx)
  await runGoosePollTick(runner, ctx)
  const reader = /** @type {NonNullable<typeof runner.db>} */ (runner.db)
  reader.retryOpts = { attempts: 2, delayMs: 1 }
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'second prompt' })
  db.exec('BEGIN EXCLUSIVE')
  await runGoosePollTick(runner, ctx)
  const status = gooseSourceStatus(runner)
  assert.equal(status.state, 'degraded')
  assert.equal(status.details?.error_kind, 'sqlite_busy')
  assert.equal(status.message, 'database busy, retrying next poll')

  db.exec('COMMIT')
  await runGoosePollTick(runner, ctx)
  assert.equal(gooseSourceStatus(runner).state, 'ready')
  assert.ok(committed.length > 0, 'the held change lands once the lock clears')
  db.close()
})

test('a store missing a required column degrades with schema_unsupported naming it', async () => {
  const dir = await tmpDir()
  const sessionsDb = path.join(dir, 'sessions.db')
  const db = createFixtureDb(sessionsDb)
  db.exec('ALTER TABLE sessions DROP COLUMN parent_session_id')
  db.close()
  const { ctx, logs } = makeCtx({ dir, sessionsDb })
  const runner = createGoosePollRunner(ctx)
  await runGoosePollTick(runner, ctx)
  const status = gooseSourceStatus(runner)
  assert.equal(status.state, 'degraded')
  assert.equal(status.details?.error_kind, 'schema_unsupported')
  assert.match(status.message ?? '', /sessions\.parent_session_id/)
  assert.equal(pollLogs(logs, 'failed')[0]?.fields?.error_kind, 'schema_unsupported')
})

test('no log line carries message text, a title, the working_dir or the database path', async () => {
  const { runner, ctx, logs, sessionsDb, workingDir, db } = await baselined()
  renameSession(db, 's1', 'Renamed fixture title')
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'second prompt' })
  await runGoosePollTick(runner, ctx)
  await runGoosePollTick(runner, ctx)
  db.close()
  assert.ok(pollLogs(logs, 'ok').length > 0, 'a recording tick ran')
  for (const entry of pollLogs(logs, 'ok')) {
    for (const key of ['component', 'operation', 'status', 'sessions_changed', 'sessions_pending', 'rows']) {
      assert.ok(entry.fields && key in entry.fields, `goose.poll carries ${key}`)
    }
  }
  const serialized = JSON.stringify(logs)
  for (const marker of ['fixture prompt', 'fixture reply', 'second prompt', 'Fixture session', 'Renamed fixture title', workingDir, sessionsDb]) {
    assert.ok(!serialized.includes(marker), `no log line carries ${marker}`)
  }
})
