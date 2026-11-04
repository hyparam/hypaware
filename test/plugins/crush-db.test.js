// @ts-check

/**
 * @import { TestContext } from 'node:test'
 * @import { CrushDb } from '../../hypaware-core/plugins-workspace/crush/src/crush_db.js'
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import * as crushDb from '../../hypaware-core/plugins-workspace/crush/src/crush_db.js'
import { CrushDbError } from '../../hypaware-core/plugins-workspace/crush/src/errors.js'
import { createCrushDb, insertMessage, insertSession, openWriter, tmpDir } from '../helpers/crush_db_fixture.js'

const {
  DEFAULT_BUSY_RETRY_ATTEMPTS,
  NEW_ROWS_SQL,
  SESSION_MAX_ROWID_SQL,
  SESSION_MESSAGES_SQL,
  openCrushDb,
  withBusyRetry,
} = crushDb

/**
 * @ref LLP 0573#sqlite [tests]: read-only open that leaves crush.db and its
 *   WAL as they were, bounded busy retry, the required-column check, title
 *   sessions skipped, and the D6 query-text guard.
 *
 * The fixture is the Crush v0.99.0 schema the probe dumped, synthetic rows
 * only.
 */

const ROOT = 'aaaaaaaa-0000-4000-8000-000000000001'
const TITLE = `title-${ROOT}`

/** @param {string} dbPath */
function seed(dbPath) {
  const db = openWriter(dbPath)
  insertSession(db, { id: ROOT, title: 'Fixture session', cost: 0.01 })
  insertSession(db, { id: TITLE, title: 'Title generation' })
  insertMessage(db, { id: 'm1', session_id: ROOT, role: 'user', parts: [{ type: 'text', data: { text: 'fixture prompt' } }] })
  insertMessage(db, { id: 'm2', session_id: ROOT, role: 'assistant', model: 'fixture-model', provider: 'fixture', parts: [{ type: 'text', data: { text: 'fixture reply' } }], finished_at: null })
  insertMessage(db, { id: 't1', session_id: TITLE, role: 'user', parts: [{ type: 'text', data: { text: 'title prompt' } }] })
  db.close()
}

/**
 * @param {TestContext} t
 * @returns {Promise<{ dir: string, dbPath: string }>}
 */
async function fixture(t) {
  const dir = await tmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const dbPath = await createCrushDb(path.join(dir, 'project'))
  seed(dbPath)
  return { dir, dbPath }
}

/**
 * Every read the reader offers, once.
 *
 * @param {CrushDb} reader
 */
async function readEverything(reader) {
  await reader.maxRowid()
  await reader.changes(0)
  await reader.sessionMaxRowid(ROOT)
  await reader.listSessions()
  await reader.readSessionSnapshot(ROOT)
}

/** @param {number} errcode */
function sqliteError(errcode) {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode })
}

test('the reader opens read-only: a write through its handle throws', async (t) => {
  const { dbPath } = await fixture(t)
  const reader = openCrushDb(dbPath)
  t.after(() => reader.close())
  assert.throws(() => reader.db.exec("UPDATE sessions SET title = 'x'"), /readonly/i)
})

test('with no -wal at the start, a read leaves crush.db byte-identical and creates only the -wal and -shm', async (t) => {
  const { dbPath } = await fixture(t)
  const dataDir = path.dirname(dbPath)
  assert.deepEqual((await fs.readdir(dataDir)).sort(), ['crush.db'])
  const before = await fs.readFile(dbPath)
  const reader = openCrushDb(dbPath)
  await readEverything(reader)
  reader.close()
  assert.ok(before.equals(await fs.readFile(dbPath)), 'crush.db bytes changed')
  // SQLite creates a missing -wal and -shm for a read-only WAL reader when
  // the directory is writable (LLP 0573#sqlite). The -wal stays empty, so
  // no content was written; nothing else appears.
  const after = (await fs.readdir(dataDir)).sort()
  assert.ok(after.every(name => ['crush.db', 'crush.db-shm', 'crush.db-wal'].includes(name)), `unexpected files: ${after}`)
  assert.ok(after.includes('crush.db-shm'), 'expected the -shm SQLite creates')
  if (after.includes('crush.db-wal')) assert.equal((await fs.stat(`${dbPath}-wal`)).size, 0)
})

test('with a live -wal, a read leaves crush.db and the -wal byte-identical and sees the WAL rows', async (t) => {
  const { dbPath } = await fixture(t)
  const writer = openWriter(dbPath)
  t.after(() => writer.close())
  writer.exec('PRAGMA wal_autocheckpoint = 0')
  insertMessage(writer, { id: 'm3', session_id: ROOT, role: 'user', parts: [{ type: 'text', data: { text: 'later prompt' } }] })
  const dbBefore = await fs.readFile(dbPath)
  const walBefore = await fs.readFile(`${dbPath}-wal`)
  assert.ok(walBefore.length > 0)
  const reader = openCrushDb(dbPath)
  await readEverything(reader)
  const snapshot = await reader.readSessionSnapshot(ROOT)
  reader.close()
  assert.deepEqual(snapshot?.messages.map(m => m.id), ['m1', 'm2', 'm3'])
  assert.ok(dbBefore.equals(await fs.readFile(dbPath)), 'crush.db bytes changed')
  assert.ok(walBefore.equals(await fs.readFile(`${dbPath}-wal`)), 'crush.db-wal bytes changed')
})

test('title sessions are skipped by every read', async (t) => {
  const { dbPath } = await fixture(t)
  const reader = openCrushDb(dbPath)
  t.after(() => reader.close())
  assert.deepEqual((await reader.listSessions()).map(s => s.id), [ROOT])
  const changes = await reader.changes(0)
  assert.deepEqual(changes.newRows.map(r => r.session_id), [ROOT])
  assert.deepEqual(changes.sessions.map(s => s.id), [ROOT])
  assert.equal(changes.maxRowid, 3)
  assert.equal(await reader.readSessionSnapshot(TITLE), null)
  assert.equal(await reader.readSessionSnapshot('no-such-session'), null)
})

test('readSessionSnapshot returns ordered messages and the watermark mark', async (t) => {
  const { dbPath } = await fixture(t)
  const reader = openCrushDb(dbPath)
  t.after(() => reader.close())
  const snapshot = await reader.readSessionSnapshot(ROOT)
  assert.ok(snapshot)
  assert.equal(snapshot.session.title, 'Fixture session')
  assert.equal(snapshot.session.cost, 0.01)
  assert.deepEqual(snapshot.messages.map(m => [m.id, m.role, m.rowid]), [['m1', 'user', 1], ['m2', 'assistant', 2]])
  assert.equal(snapshot.mark.max_rowid, 2)
  assert.equal(snapshot.mark.message_count, 2)
  assert.equal(snapshot.mark.open, true, 'the latest message is an unfinished assistant message')
  assert.match(snapshot.mark.digest, /^[0-9a-f]{64}$/)
  assert.equal((await reader.readSessionSnapshot(ROOT))?.mark.digest, snapshot.mark.digest)
})

test('changes(cursor) returns only sessions with rows above the cursor', async (t) => {
  const { dbPath } = await fixture(t)
  const reader = openCrushDb(dbPath)
  t.after(() => reader.close())
  assert.deepEqual((await reader.changes(2)).newRows, [])
  assert.deepEqual((await reader.changes(1)).newRows, [{ session_id: ROOT, max_rowid: 2 }])
  assert.equal(await reader.sessionMaxRowid(ROOT), 2)
  assert.equal(await reader.maxRowid(), 3)
})

test('a missing required column fails with schema_unsupported naming it', async (t) => {
  const dir = await tmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const dbPath = await createCrushDb(path.join(dir, 'project'), { dropColumn: ['messages', 'is_summary_message'] })
  const reader = openCrushDb(dbPath)
  t.after(() => reader.close())
  await assert.rejects(reader.listSessions(), (err) => {
    assert.ok(err instanceof CrushDbError)
    assert.equal(err.code, 'schema_unsupported')
    assert.match(err.message, /messages\.is_summary_message/)
    assert.doesNotMatch(err.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    return true
  })
})

test('the reader never names files or read_files and never selects *', async (t) => {
  const { dbPath } = await fixture(t)
  const reader = openCrushDb(dbPath)
  t.after(() => reader.close())
  /** @type {string[]} */
  const prepared = []
  const prepare = reader.db.prepare.bind(reader.db)
  const exec = reader.db.exec.bind(reader.db)
  reader.db.prepare = (sql) => { prepared.push(sql); return prepare(sql) }
  reader.db.exec = (sql) => { prepared.push(sql); return exec(sql) }
  await readEverything(reader)
  const exported = Object.entries(crushDb).filter(([name, value]) => name.endsWith('_SQL') && typeof value === 'string').map(([, value]) => /** @type {string} */ (value))
  assert.ok(exported.length >= 7)
  for (const sql of [...prepared, ...exported]) {
    assert.doesNotMatch(sql, /\bfiles\b/i, sql)
    assert.doesNotMatch(sql, /\bread_files\b/i, sql)
    assert.doesNotMatch(sql, /\*/, sql)
  }
  // The source text too, so a query built outside the constants is caught.
  const source = readFileSync(new URL('../../hypaware-core/plugins-workspace/crush/src/crush_db.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\b(?:FROM|JOIN)\s+(?:read_)?files\b/i)
})

test('the per-session reads and the new-row read plan as a SEARCH', async (t) => {
  const { dbPath } = await fixture(t)
  const reader = openCrushDb(dbPath)
  t.after(() => reader.close())
  for (const [sql, args] of /** @type {Array<[string, Array<string | number>]>} */ ([[NEW_ROWS_SQL, [0]], [SESSION_MESSAGES_SQL, [ROOT]], [SESSION_MAX_ROWID_SQL, [ROOT]]])) {
    const plan = reader.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => String(row.detail))
    assert.ok(plan.some(detail => detail.startsWith('SEARCH messages')), `${sql}\n${plan.join('\n')}`)
    assert.ok(!plan.some(detail => detail.startsWith('SCAN messages')), `${sql}\n${plan.join('\n')}`)
  }
})

test('withBusyRetry retries SQLITE_BUSY with the injected sleep and then succeeds', async () => {
  let calls = 0
  /** @type {number[]} */
  const slept = []
  const value = await withBusyRetry(() => {
    calls++
    if (calls < 3) throw sqliteError(5)
    return 'ok'
  }, { sleep: async (ms) => { slept.push(ms) } })
  assert.equal(value, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(slept, [20, 20])
})

test('withBusyRetry gives up after the bound with sqlite_busy, and a non-busy error propagates at once', async () => {
  let calls = 0
  await assert.rejects(withBusyRetry(() => { calls++; throw sqliteError(6) }, { sleep: async () => {} }), (err) => {
    assert.ok(err instanceof CrushDbError)
    assert.equal(err.code, 'sqlite_busy')
    return true
  })
  assert.equal(calls, DEFAULT_BUSY_RETRY_ATTEMPTS)
  calls = 0
  const boom = Object.assign(new Error('malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 11 })
  await assert.rejects(withBusyRetry(() => { calls++; throw boom }, { sleep: async () => {} }), (err) => err === boom)
  assert.equal(calls, 1)
})

test('open refuses a missing file, an unreadable file and a missing node:sqlite', async (t) => {
  const dir = await tmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  assert.throws(() => openCrushDb(path.join(dir, 'absent.db')), (err) => err instanceof CrushDbError && err.code === 'missing')
  assert.throws(() => openCrushDb(path.join(dir, 'absent.db'), { requireFn: () => { throw new Error('no such module') } }), (err) => err instanceof CrushDbError && err.code === 'sqlite_unavailable')
  if (process.getuid?.() === 0) return t.diagnostic('running as root; the permission case is skipped')
  const dbPath = await createCrushDb(path.join(dir, 'project'))
  await fs.chmod(dbPath, 0o000)
  assert.throws(() => openCrushDb(dbPath), (err) => err instanceof CrushDbError && err.code === 'permission_denied')
})
