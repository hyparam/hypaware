// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_BUSY_RETRY_ATTEMPTS,
  isRetryableBusyError,
  loadSqliteModule,
  openGooseSessionsDb,
  withBusyRetry,
} from '../../hypaware-core/plugins-workspace/goose/src/sessions_db.js'
import { GooseSessionsDbError } from '../../hypaware-core/plugins-workspace/goose/src/errors.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

/**
 * @ref LLP 0570#sqlite [tests]: read-only open, bounded busy retry, the
 *   required-column check, and the D1 hidden skip.
 *
 * The fixture is a reduced copy of the Goose v1.57.0 schema v17 the probe
 * recorded (`sessions`, `messages`), with synthetic rows only.
 */

/**
 * @param {string} dir
 * @param {{ dropMessageColumn?: string }} [opts]
 * @returns {string}
 */
function buildFixtureSessionsDb(dir, opts = {}) {
  const dbPath = path.join(dir, 'sessions.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      session_type TEXT NOT NULL DEFAULT 'user',
      working_dir TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      provider_name TEXT,
      model_config_json TEXT,
      parent_session_id TEXT
    )
  `)
  const messageColumns = [
    'id INTEGER PRIMARY KEY AUTOINCREMENT',
    'message_id TEXT',
    'session_id TEXT NOT NULL',
    'role TEXT NOT NULL',
    'content_json TEXT NOT NULL',
    'created_timestamp INTEGER NOT NULL',
    'timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
    'metadata_json TEXT',
  ].filter((column) => column.split(' ')[0] !== opts.dropMessageColumn)
  db.exec(`CREATE TABLE messages (${messageColumns.join(', ')})`)
  const insertSession = db.prepare(`INSERT INTO sessions
    (id, name, session_type, working_dir, created_at, updated_at, provider_name, model_config_json, parent_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  insertSession.run('20261102_1', 'Fixture session', 'user', '/work/fixture', '2026-11-02 22:19:51', '2026-11-02 22:20:10', 'openai', '{"model_name":"fixture-model"}', null)
  insertSession.run('20261102_2', '', 'hidden', '/work/fixture', '2026-11-02 22:21:00', '2026-11-02 22:21:05', 'openai', null, null)
  insertSession.run('20261102_3', 'Child', 'sub_agent', '/work/fixture', '2026-11-02 22:22:00', '2026-11-02 22:22:30', 'openai', null, '20261102_1')
  if (!opts.dropMessageColumn) {
    const insertMessage = db.prepare(`INSERT INTO messages
      (message_id, session_id, role, content_json, created_timestamp, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`)
    insertMessage.run(null, '20261102_1', 'user', '[{"type":"text","text":"fixture prompt"}]', 1793744391, '{"userVisible":true,"agentVisible":true}')
    insertMessage.run('chatcmpl-fixture-2', '20261102_1', 'assistant', '[{"type":"text","text":"fixture reply"}]', 1793744400, '{"userVisible":true,"agentVisible":true}')
    insertMessage.run(null, '20261102_2', 'user', '[{"type":"text","text":"hidden prompt"}]', 1793744460, '{}')
  }
  db.close()
  return dbPath
}

/** @returns {Promise<string>} */
async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'goose-sessions-db-'))
}

/** @param {number} errcode */
function sqliteError(errcode) {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode })
}

test('the reader opens read-only: a write through its handle throws', async (t) => {
  const dir = await tempDir()
    const reader = await openGooseSessionsDb(buildFixtureSessionsDb(dir))
  t.after(() => reader.close())
  // Close before the rm (hooks run in registration order): win32 cannot
  // unlink a database an open handle still maps (EBUSY).
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  assert.throws(() => reader.db.exec("UPDATE sessions SET name = 'x'"), /readonly/i)
})

test('listSessions skips hidden sessions and orders by created_at', async (t) => {
  const dir = await tempDir()
    const reader = await openGooseSessionsDb(buildFixtureSessionsDb(dir))
  t.after(() => reader.close())
  // Close before the rm (hooks run in registration order): win32 cannot
  // unlink a database an open handle still maps (EBUSY).
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const sessions = await reader.listSessions()
  assert.deepEqual(sessions.map((s) => s.id), ['20261102_1', '20261102_3'])
  assert.equal(sessions[1].parent_session_id, '20261102_1')
})

test('readSessionSnapshot returns ordered messages, and null for a hidden or missing session', async (t) => {
  const dir = await tempDir()
    const reader = await openGooseSessionsDb(buildFixtureSessionsDb(dir))
  t.after(() => reader.close())
  // Close before the rm (hooks run in registration order): win32 cannot
  // unlink a database an open handle still maps (EBUSY).
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const snapshot = await reader.readSessionSnapshot('20261102_1')
  assert.ok(snapshot)
  assert.equal(snapshot.session.name, 'Fixture session')
  assert.deepEqual(snapshot.messages.map((m) => [m.id, m.message_id, m.role]), [[1, null, 'user'], [2, 'chatcmpl-fixture-2', 'assistant']])
  assert.equal(await reader.readSessionSnapshot('20261102_2'), null)
  assert.equal(await reader.readSessionSnapshot('no-such-session'), null)
})

test('a missing required column fails with schema_unsupported naming it', async (t) => {
  const dir = await tempDir()
    const reader = await openGooseSessionsDb(buildFixtureSessionsDb(dir, { dropMessageColumn: 'metadata_json' }))
  t.after(() => reader.close())
  // Close before the rm (hooks run in registration order): win32 cannot
  // unlink a database an open handle still maps (EBUSY).
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  await assert.rejects(reader.listSessions(), (err) => {
    assert.ok(err instanceof GooseSessionsDbError)
    assert.equal(err.code, 'schema_unsupported')
    assert.match(err.message, /messages\.metadata_json/)
    return true
  })
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

test('withBusyRetry gives up after the bound with sqlite_busy', async () => {
  let calls = 0
  await assert.rejects(withBusyRetry(() => { calls++; throw sqliteError(6) }, { sleep: async () => {} }), (err) => {
    assert.ok(err instanceof GooseSessionsDbError)
    assert.equal(err.code, 'sqlite_busy')
    return true
  })
  assert.equal(calls, DEFAULT_BUSY_RETRY_ATTEMPTS)
})

test('a non-busy error propagates at once', async () => {
  let calls = 0
  const boom = Object.assign(new Error('malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 11 })
  await assert.rejects(withBusyRetry(() => { calls++; throw boom }, { sleep: async () => {} }), (err) => err === boom)
  assert.equal(calls, 1)
  assert.equal(isRetryableBusyError(boom), false)
  assert.equal(isRetryableBusyError(sqliteError(5)), true)
})

test('open refuses a missing file, an unreadable file and a missing node:sqlite', async (t) => {
  const dir = await tempDir()
  // rm needs no read bit on the file itself, only write on its directory.
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  await assert.rejects(openGooseSessionsDb(path.join(dir, 'absent.db')), (err) => err instanceof GooseSessionsDbError && err.code === 'missing')
  assert.throws(() => loadSqliteModule(() => { throw new Error('no such module') }), (err) => err instanceof GooseSessionsDbError && err.code === 'sqlite_unavailable')
  if (process.getuid?.() === 0) return t.diagnostic('running as root; the permission case is skipped')
  if (process.platform === 'win32') return t.diagnostic('chmod 0o000 does not make a file unreadable on win32; the permission case is skipped')
  const dbPath = buildFixtureSessionsDb(dir)
  await fs.chmod(dbPath, 0o000)
  await assert.rejects(openGooseSessionsDb(dbPath), (err) => err instanceof GooseSessionsDbError && err.code === 'permission_denied')
})
