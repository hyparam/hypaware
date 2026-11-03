// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import { createGoosePollRunner, runGoosePollTick } from '../../hypaware-core/plugins-workspace/goose/src/source.js'
import { MAX_ID_SQL, NEW_MESSAGES_SQL, UPDATED_SQL } from '../../hypaware-core/plugins-workspace/goose/src/sessions_db.js'
import { MAX_WATERMARK_SESSIONS, readGooseWatermark } from '../../hypaware-core/plugins-workspace/goose/src/watermark.js'
import { SessionIgnoreSet } from '../../src/core/control/session_ignore_store.js'
import {
  createFakeStorage,
  createFixtureDb,
  insertMessage,
  insertSession,
  makeCtx,
  nextTimestamp,
  tmpDir,
} from '../helpers/goose_source_fixture.js'

/**
 * @ref LLP 0570#cost [tests]: every poll read is a SEARCH on the indexes Goose
 *   v1.57.0 creates, an unchanged candidate is skipped without a snapshot read,
 *   and the watermark stays bounded by its cap.
 * @ref LLP 0570#reconciliation [tests]: whole-session reconcile replaces rows
 *   after a `replace_conversation` rewrite, an in-place edit, a truncation and
 *   an unignore, and a failed commit leaves the persisted watermark untouched.
 *
 * Synthetic rows only, written through the fixture's own connection between
 * ticks, as Goose writes.
 */

/**
 * A fixture with session s1 holding one exchange, baselined.
 *
 * @param {{ hooks?: Parameters<typeof createFakeStorage>[0], dir?: string, ignoredSessions?: Set<string> }} [opts]
 */
async function baselined(opts = {}) {
  const dir = opts.dir ?? await tmpDir()
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

/**
 * Count the snapshot reads the runner makes from here on.
 *
 * @param {any} runner
 * @returns {string[]} the session ids read, in order
 */
function spySnapshots(runner) {
  /** @type {string[]} */
  const reads = []
  const real = runner.db.readSessionSnapshot.bind(runner.db)
  runner.db.readSessionSnapshot = (/** @type {string} */ sessionId) => {
    reads.push(sessionId)
    return real(sessionId)
  }
  return reads
}

/**
 * @param {Record<string, unknown>[]} committed
 * @param {string} sessionId
 */
function rowsOf(committed, sessionId) {
  return committed.filter(row => row.session_id === `goose-${sessionId}`)
}

/** @param {Record<string, unknown>[]} rows */
function partIds(rows) {
  return rows.map(row => String(row.part_id)).sort()
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string} text
 */
function anyRowHas(rows, text) {
  return rows.some(row => JSON.stringify(row).includes(text))
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 */
function touch(db, sessionId) {
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(nextTimestamp(), sessionId)
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

test('every poll read is a SEARCH on the Goose v17 indexes, with and without ANALYZE', () => {
  const db = createFixtureDb(':memory:', { indexes: true })
  const addSession = db.prepare(`INSERT INTO sessions (id, session_type, working_dir, created_at, updated_at)
    VALUES (?, ?, '/w', '2026-11-01 00:00:00', ?)`)
  const addMessage = db.prepare(`INSERT INTO messages (session_id, role, content_json, created_timestamp)
    VALUES (?, 'user', '[]', ?)`)
  db.exec('BEGIN')
  for (let s = 0; s < 2000; s++) {
    const at = new Date(Date.UTC(2026, 10, 1) + s * 1000).toISOString().slice(0, 19).replace('T', ' ')
    addSession.run(`s${s}`, s % 10 ? 'user' : 'hidden', at)
    for (let m = 0; m < 20; m++) addMessage.run(`s${s}`, m)
  }
  db.exec('COMMIT')

  /** @param {string} sql @param {unknown} arg */
  const plan = (sql, arg) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(/** @type {any} */ (arg)).map(row => String(row.detail))
  for (const pass of ['no-analyze', 'analyze']) {
    if (pass === 'analyze') db.exec('ANALYZE')
    const reads = {
      new_messages: plan(NEW_MESSAGES_SQL, 39_000),
      updated: plan(UPDATED_SQL, '2026-11-01 00:30:00'),
      max_id: plan(MAX_ID_SQL, 's7'),
    }
    for (const [name, details] of Object.entries(reads)) {
      for (const detail of details) {
        assert.doesNotMatch(detail, /^SCAN (messages|sessions|m|s)\b/, `${pass} ${name}: ${detail}`)
      }
    }
    assert.ok(reads.new_messages.some(detail => /^SEARCH m USING INTEGER PRIMARY KEY \(rowid>\?\)/.test(detail)), `${pass}: ${reads.new_messages}`)
    assert.ok(reads.updated.some(detail => /^SEARCH sessions USING INDEX idx_sessions_updated/.test(detail)), `${pass}: ${reads.updated}`)
    assert.ok(reads.max_id.some(detail => /^SEARCH messages USING (COVERING )?INDEX idx_messages_session/.test(detail)), `${pass}: ${reads.max_id}`)
  }
  db.close()
})

test('one changed session among many is the only snapshot read; the boundary relist is not hashed', async () => {
  const dir = await tmpDir()
  const workingDir = path.join(dir, 'work')
  await fs.mkdir(workingDir)
  const sessionsDb = path.join(dir, 'sessions.db')
  const db = createFixtureDb(sessionsDb, { indexes: true })
  for (let s = 0; s < 200; s++) {
    insertSession(db, { id: `s${s}`, workingDir })
    insertMessage(db, { sessionId: `s${s}`, role: 'user', text: `prompt ${s}` })
  }
  const { ctx, committed } = makeCtx({ dir, sessionsDb })
  const runner = createGoosePollRunner(ctx)
  await runGoosePollTick(runner, ctx)
  assert.equal(committed.length, 0)
  const reads = spySnapshots(runner)

  insertMessage(db, { sessionId: 's17', role: 'user', text: 'a second prompt' })
  await runGoosePollTick(runner, ctx)
  assert.deepEqual(reads, ['s17'])
  assert.ok(rowsOf(committed, 's17').length > 0)
  assert.equal(committed.length, rowsOf(committed, 's17').length)

  // Settled: a write that touches no Goose row moves data_version, the
  // inclusive time cursor relists s17, and its mark matches.
  db.exec('CREATE TABLE unrelated (x)')
  await runGoosePollTick(runner, ctx)
  assert.deepEqual(reads, ['s17'])
  db.close()
})

test('the watermark cap evicts the oldest entries and an evicted session reconciles idempotently', async () => {
  const { dir, workingDir, runner, ctx, committed, db } = await baselined()
  insertSession(db, { id: 'e1', workingDir })
  insertMessage(db, { sessionId: 'e1', role: 'user', text: 'evicted prompt' })
  await runGoosePollTick(runner, ctx)
  const e1Before = rowsOf(committed, 'e1')
  assert.ok(e1Before.length > 0)

  // Fill the watermark with entries newer than everything, so s1 and e1 are
  // the oldest when the next write caps it.
  const sessions = /** @type {any} */ (runner.watermark).sessions
  const filler = MAX_WATERMARK_SESSIONS - 1
  for (let i = 0; i < filler; i++) sessions[`f${i}`] = { updated_at: '2099-01-01 00:00:00', max_id: 0 }
  insertSession(db, { id: 's2', workingDir })
  insertMessage(db, { sessionId: 's2', role: 'user', text: 'other prompt' })
  await runGoosePollTick(runner, ctx)

  const persisted = readGooseWatermark(dir)
  assert.equal(Object.keys(persisted.sessions).length, MAX_WATERMARK_SESSIONS)
  assert.equal(persisted.sessions.s1, undefined)
  assert.equal(persisted.sessions.e1, undefined)
  assert.ok(persisted.sessions.s2)
  assert.equal(Object.keys(sessions).length, MAX_WATERMARK_SESSIONS, 'the cap applies in memory too')

  insertMessage(db, { sessionId: 'e1', role: 'user', text: 'after eviction' })
  await runGoosePollTick(runner, ctx)
  const e1After = rowsOf(committed, 'e1')
  assert.equal(new Set(partIds(e1After)).size, e1After.length, 'no duplicate part rows')
  assert.ok(e1After.length > e1Before.length)
  assert.ok(partIds(e1Before).every(id => partIds(e1After).includes(id)), 'earlier parts keep their ids')
  assert.match(readGooseWatermark(dir).sessions.e1?.digest ?? '', /^[a-f0-9]{64}$/)
  db.close()
})

test('a failed commit leaves the persisted watermark unchanged, session entries included', async () => {
  let failing = false
  const { dir, runner, ctx, committed, db } = await baselined({
    hooks: { failBatch: () => failing, failReconcile: () => failing },
  })
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'second prompt' })
  await runGoosePollTick(runner, ctx)
  const settled = readGooseWatermark(dir)
  assert.match(settled.sessions.s1?.digest ?? '', /^[a-f0-9]{64}$/)
  const rowsBefore = committed.length

  failing = true
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'third prompt' })
  await runGoosePollTick(runner, ctx)
  assert.deepEqual(readGooseWatermark(dir), settled)
  assert.equal(committed.length, rowsBefore)

  failing = false
  await runGoosePollTick(runner, ctx)
  assert.ok(anyRowHas(rowsOf(committed, 's1'), 'third prompt'))
  assert.ok(Number(readGooseWatermark(dir).sessions.s1?.max_id) > Number(settled.sessions.s1?.max_id))
  db.close()
})

// ---------------------------------------------------------------------------
// Whole-session reconcile
// ---------------------------------------------------------------------------

test('a replace_conversation rewrite with new row ids replaces the rows under the same part ids', async () => {
  const { workingDir, runner, ctx, committed, db } = await baselined()
  insertSession(db, { id: 'r1', workingDir })
  const add = db.prepare(`INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json)
    VALUES (?, 'r1', ?, ?, ?, '{"userVisible":true,"agentVisible":true}')`)
  const conversation = /** @type {const} */ ([
    ['msg_r1-1', 'user', 'rewrite prompt'],
    ['msg_r1-2', 'assistant', 'rewrite reply'],
  ])
  const write = () => {
    for (const [i, [messageId, role, text]] of conversation.entries()) {
      add.run(messageId, role, JSON.stringify([{ type: 'text', text }]), 1793744391 + i)
    }
    touch(db, 'r1')
  }
  write()
  await runGoosePollTick(runner, ctx)
  const before = partIds(rowsOf(committed, 'r1'))
  assert.ok(before.length > 0)

  db.prepare("DELETE FROM messages WHERE session_id = 'r1'").run()
  write()
  await runGoosePollTick(runner, ctx)
  assert.deepEqual(partIds(rowsOf(committed, 'r1')), before)
  db.close()
})

test('an in-place edit that keeps max_id reconciles on the digest', async () => {
  const { runner, ctx, committed, db } = await baselined()
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'second prompt' })
  insertMessage(db, { sessionId: 's1', role: 'assistant', text: 'original reply' })
  await runGoosePollTick(runner, ctx)
  const mark = runner.watermark?.sessions.s1
  assert.ok(anyRowHas(rowsOf(committed, 's1'), 'original reply'))

  db.prepare('UPDATE messages SET content_json = ? WHERE id = ?')
    .run(JSON.stringify([{ type: 'text', text: 'edited reply' }]), mark?.max_id ?? 0)
  touch(db, 's1')
  await runGoosePollTick(runner, ctx)
  const rows = rowsOf(committed, 's1')
  assert.equal(runner.watermark?.sessions.s1.max_id, mark?.max_id)
  assert.notEqual(runner.watermark?.sessions.s1.digest, mark?.digest)
  assert.ok(anyRowHas(rows, 'edited reply'))
  assert.ok(!anyRowHas(rows, 'original reply'))
  db.close()
})

test('a truncation drops the removed rows, and a later append lands on the truncated state', async () => {
  const { runner, ctx, committed, db } = await baselined()
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'doomed prompt' })
  insertMessage(db, { sessionId: 's1', role: 'assistant', text: 'doomed reply' })
  await runGoosePollTick(runner, ctx)
  assert.ok(anyRowHas(rowsOf(committed, 's1'), 'doomed reply'))

  db.prepare("DELETE FROM messages WHERE session_id = 's1' AND id > 2").run()
  touch(db, 's1')
  await runGoosePollTick(runner, ctx)
  assert.equal(runner.watermark?.sessions.s1.max_id, 2)
  assert.ok(!anyRowHas(rowsOf(committed, 's1'), 'doomed'))
  assert.ok(anyRowHas(rowsOf(committed, 's1'), 'fixture reply'))

  insertMessage(db, { sessionId: 's1', role: 'user', text: 'resubmitted prompt' })
  await runGoosePollTick(runner, ctx)
  const rows = rowsOf(committed, 's1')
  assert.ok(anyRowHas(rows, 'resubmitted prompt'))
  assert.ok(!anyRowHas(rows, 'doomed'))
  assert.equal(new Set(partIds(rows)).size, rows.length)
  db.close()
})

test('removing a session exclusion resumes capture on its next change', async () => {
  const dir = await tmpDir()
  const ignoredSessions = new SessionIgnoreSet(dir)
  const { runner, ctx, committed, db } = await baselined({ dir, ignoredSessions })
  new SessionIgnoreSet(dir).add('s1')
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'excluded prompt' })
  await runGoosePollTick(runner, ctx)
  assert.equal(committed.length, 0)

  new SessionIgnoreSet(dir).delete('s1')
  insertMessage(db, { sessionId: 's1', role: 'user', text: 'resumed prompt' })
  await runGoosePollTick(runner, ctx)
  assert.ok(anyRowHas(rowsOf(committed, 's1'), 'resumed prompt'))
  assert.equal(runner.watermark?.sessions.s1.max_id, 4)
  assert.equal(runner.lastError, undefined)
  db.close()
})
