// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_BUSY_RETRY_ATTEMPTS,
  HermesStateDb,
  isRetryableBusyError,
  loadSqliteModule,
  openHermesStateDb,
  withBusyRetry,
} from '../../hypaware-core/plugins-workspace/hermes/src/state_db.js'
import { HermesStateDbError } from '../../hypaware-core/plugins-workspace/hermes/src/errors.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

// ---------------------------------------------------------------------------
// Fixture: a small state.db generated with node:sqlite, mirroring the hermes
// schema (LLP 0118) close enough for the reader's column set (LLP 0122#projection).
// ---------------------------------------------------------------------------

const SESSION_COLUMNS = [
  'id', 'source', 'model', 'cwd', 'parent_session_id', 'started_at', 'ended_at',
  'end_reason', 'billing_provider', 'billing_base_url', 'system_prompt',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'reasoning_tokens', 'estimated_cost_usd', 'actual_cost_usd', 'api_call_count',
]

const MESSAGE_COLUMNS = [
  'id', 'session_id', 'role', 'content', 'tool_calls', 'tool_name',
  'tool_call_id', 'reasoning', 'timestamp', 'token_count', 'finish_reason',
]

/**
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function buildFixtureStateDb(dir) {
  const dbPath = path.join(dir, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      model TEXT,
      cwd TEXT,
      parent_session_id INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      billing_provider TEXT,
      billing_base_url TEXT,
      system_prompt TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      reasoning_tokens INTEGER,
      estimated_cost_usd REAL,
      actual_cost_usd REAL,
      api_call_count INTEGER
    )
  `)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      tool_call_id TEXT,
      reasoning TEXT,
      timestamp TEXT NOT NULL,
      token_count INTEGER,
      finish_reason TEXT
    )
  `)

  const insertSession = db.prepare(
    `INSERT INTO sessions (${SESSION_COLUMNS.join(', ')}) VALUES (${SESSION_COLUMNS.map(() => '?').join(', ')})`
  )
  const insertMessage = db.prepare(
    `INSERT INTO messages (${MESSAGE_COLUMNS.join(', ')}) VALUES (${MESSAGE_COLUMNS.map(() => '?').join(', ')})`
  )

  // Session 1: open (ended_at NULL), interactive, normal cwd.
  insertSession.run(
    1, 'cli', 'gpt-4o', '/home/dev/project', null, '2026-07-20T10:00:00Z', null,
    null, 'openai', 'https://api.openai.com/v1', 'You are a helpful assistant.',
    null, null, null, null, null, null, null, null
  )
  insertMessage.run(1, 1, 'user', 'list the files here', null, null, null, null, '2026-07-20T10:00:01Z', null, null)
  insertMessage.run(
    2, 1, 'assistant', null,
    JSON.stringify([{ id: 'call_1', name: 'list_files', arguments: '{"path":"."}' }]),
    'list_files', 'call_1', 'the user wants a directory listing, I should call list_files',
    '2026-07-20T10:00:02Z', 42, 'tool_calls'
  )
  insertMessage.run(3, 1, 'tool', 'a.txt\nb.txt', null, 'list_files', 'call_1', null, '2026-07-20T10:00:03Z', null, null)

  // Session 2: channel session, cwd NULL (hermes does not stamp a cwd for
  // channel sources; the projector, T2, is what maps these to the LLP 0124
  // scope path). No messages yet.
  insertSession.run(
    2, 'telegram', 'gpt-4o-mini', null, null, '2026-07-20T11:00:00Z', null,
    null, 'openai', 'https://api.openai.com/v1', null,
    null, null, null, null, null, null, null, null
  )

  // Session 3: ended, with final totals and a reasoning message.
  insertSession.run(
    3, 'cli', 'o3', '/home/dev/other', null, '2026-07-20T09:00:00Z', '2026-07-20T09:05:00Z',
    'completed', 'openai', 'https://api.openai.com/v1', null,
    120, 80, 10, 0, 200, 0.0041, 0.0039, 2
  )
  insertMessage.run(4, 3, 'user', 'why is the sky blue', null, null, null, null, '2026-07-20T09:00:01Z', null, null)
  insertMessage.run(
    5, 3, 'assistant', 'Rayleigh scattering.', null, null, null,
    'the user is asking a physics question, keep it short', '2026-07-20T09:04:59Z', 200, 'stop'
  )

  db.close()
  return dbPath
}

/**
 * @returns {Promise<string>}
 */
async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hermes-state-db-'))
}

// ---------------------------------------------------------------------------
// Readonly open + queries
// ---------------------------------------------------------------------------

test('openHermesStateDb opens read-only and lists sessions in id order', async () => {
  const dir = await tmpDir()
  const dbPath = await buildFixtureStateDb(dir)
  const reader = await openHermesStateDb(dbPath)
  try {
    const sessions = await reader.listSessions()
    assert.equal(sessions.length, 3)
    assert.deepEqual(sessions.map((s) => s.id), [1, 2, 3])
    assert.equal(sessions[0].cwd, '/home/dev/project')
    assert.equal(sessions[1].cwd, null, 'channel session has NULL cwd from hermes')
    assert.equal(sessions[2].ended_at, '2026-07-20T09:05:00Z')
    assert.equal(sessions[2].end_reason, 'completed')
    assert.equal(sessions[2].actual_cost_usd, 0.0039)
  } finally {
    reader.close()
  }
})

test('openHermesStateDb.listMessagesForSession returns tool-call and reasoning fields', async () => {
  const dir = await tmpDir()
  const dbPath = await buildFixtureStateDb(dir)
  const reader = await openHermesStateDb(dbPath)
  try {
    const messages = await reader.listMessagesForSession(1)
    assert.equal(messages.length, 3)
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool'])
    const toolCallMessage = messages[1]
    assert.equal(toolCallMessage.tool_name, 'list_files')
    assert.equal(toolCallMessage.tool_call_id, 'call_1')
    assert.match(/** @type {string} */ (toolCallMessage.tool_calls), /list_files/)
    assert.match(/** @type {string} */ (toolCallMessage.reasoning), /directory listing/)

    const reasoningOnly = await reader.listMessagesForSession(3)
    assert.match(/** @type {string} */ (reasoningOnly[1].reasoning), /physics question/)

    const noMessages = await reader.listMessagesForSession(2)
    assert.deepEqual(noMessages, [])
  } finally {
    reader.close()
  }
})

test('the reader connection is genuinely read-only', async () => {
  const dir = await tmpDir()
  const dbPath = await buildFixtureStateDb(dir)
  const reader = await openHermesStateDb(dbPath)
  try {
    assert.throws(
      () => reader.db.exec("INSERT INTO sessions (id, source, started_at) VALUES (99, 'cli', 'now')"),
      /readonly|read-only/i
    )
  } finally {
    reader.close()
  }
})

// ---------------------------------------------------------------------------
// Missing-file probe
// ---------------------------------------------------------------------------

test('openHermesStateDb refuses cleanly when state.db does not exist', async () => {
  const dir = await tmpDir()
  const missingPath = path.join(dir, 'state.db')
  await assert.rejects(
    () => openHermesStateDb(missingPath),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof HermesStateDbError)
      assert.equal(err.code, 'missing')
      assert.match(err.message, /state\.db/)
      return true
    }
  )
})

// ---------------------------------------------------------------------------
// Activation probe: absent node:sqlite builtin -> clear refusal, not a crash
// ---------------------------------------------------------------------------

test('loadSqliteModule turns a missing node:sqlite builtin into a HermesStateDbError', () => {
  const fakeRequire = (/** @type {string} */ id) => {
    throw new Error(`Cannot find module '${id}'`)
  }
  assert.throws(
    () => loadSqliteModule(fakeRequire),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof HermesStateDbError)
      assert.equal(err.code, 'sqlite_unavailable')
      assert.match(err.message, /Node >= 22\.12/)
      return true
    }
  )
})

test('openHermesStateDb propagates the activation refusal via requireFn injection', async () => {
  const dir = await tmpDir()
  const dbPath = await buildFixtureStateDb(dir)
  const fakeRequire = (/** @type {string} */ id) => {
    throw new Error(`Cannot find module '${id}'`)
  }
  await assert.rejects(
    () => openHermesStateDb(dbPath, { requireFn: fakeRequire }),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof HermesStateDbError)
      assert.equal(err.code, 'sqlite_unavailable')
      return true
    }
  )
})

// ---------------------------------------------------------------------------
// Bounded SQLITE_BUSY retry
// ---------------------------------------------------------------------------

/**
 * @param {string} message
 * @param {number} errcode
 */
function makeSqliteError(message, errcode) {
  const err = /** @type {Error & { code: string, errcode: number }} */ (new Error(message))
  err.code = 'ERR_SQLITE_ERROR'
  err.errcode = errcode
  return err
}

test('isRetryableBusyError classifies real node:sqlite busy/locked errors and nothing else', () => {
  assert.equal(isRetryableBusyError(makeSqliteError('database is locked', 5)), true, 'SQLITE_BUSY')
  assert.equal(isRetryableBusyError(makeSqliteError('database table is locked', 6)), true, 'SQLITE_LOCKED')
  assert.equal(isRetryableBusyError(makeSqliteError('attempt to write a readonly database', 8)), false, 'SQLITE_READONLY')
  assert.equal(isRetryableBusyError(new Error('boom')), false)
  assert.equal(isRetryableBusyError(null), false)
  assert.equal(isRetryableBusyError('nope'), false)
})

test('withBusyRetry retries busy errors within the bound then succeeds', async () => {
  let calls = 0
  /** @type {number[]} */
  const sleeps = []
  const result = await withBusyRetry(
    () => {
      calls++
      if (calls < 3) throw makeSqliteError('database is locked', 5)
      return 'ok'
    },
    { attempts: 5, delayMs: 10, sleep: async (ms) => { sleeps.push(ms) } }
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [10, 10])
})

test('withBusyRetry gives up after the bound and throws a typed sqlite_busy error', async () => {
  let calls = 0
  await assert.rejects(
    () => withBusyRetry(
      () => {
        calls++
        throw makeSqliteError('database is locked', 5)
      },
      { attempts: 3, delayMs: 1, sleep: async () => {} }
    ),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof HermesStateDbError)
      assert.equal(err.code, 'sqlite_busy')
      return true
    }
  )
  assert.equal(calls, 3)
})

test('withBusyRetry lets a non-busy error propagate immediately, no retry', async () => {
  let calls = 0
  await assert.rejects(
    () => withBusyRetry(
      () => {
        calls++
        throw new Error('schema mismatch')
      },
      { attempts: 5, delayMs: 1, sleep: async () => { throw new Error('should not sleep') } }
    ),
    /schema mismatch/
  )
  assert.equal(calls, 1)
})

test('withBusyRetry defaults to DEFAULT_BUSY_RETRY_ATTEMPTS', async () => {
  let calls = 0
  await assert.rejects(
    () => withBusyRetry(
      () => {
        calls++
        throw makeSqliteError('database is locked', 5)
      },
      { delayMs: 1, sleep: async () => {} }
    )
  )
  assert.equal(calls, DEFAULT_BUSY_RETRY_ATTEMPTS)
})

test('HermesStateDb read methods retry through a transiently busy connection', async () => {
  let attempts = 0
  const fakeDb = /** @type {any} */ ({
    prepare() {
      return {
        all() {
          attempts++
          if (attempts < 2) throw makeSqliteError('database is locked', 5)
          return [{ id: 1 }]
        },
      }
    },
  })
  const reader = new HermesStateDb(fakeDb, { attempts: 4, delayMs: 1, sleep: async () => {} })
  const rows = await reader.listSessions()
  assert.deepEqual(rows, [{ id: 1 }])
  assert.equal(attempts, 2)
})

// ---------------------------------------------------------------------------
// Changed-session detection (LLP 0122#watermark)
// ---------------------------------------------------------------------------

test('listChangedSessions flags every session on an empty watermark', async () => {
  const dir = await tmpDir()
  const dbPath = await buildFixtureStateDb(dir)
  const reader = await openHermesStateDb(dbPath)
  try {
    const changed = await reader.listChangedSessions({})
    // Session 2 has no messages and is not ended: nothing to catch up on yet.
    const bySession = new Map(changed.map((c) => [c.session_id, c]))
    assert.equal(bySession.has(2), false, 'session with no messages and not ended is not "changed"')
    assert.equal(bySession.get(1)?.reason, 'new_messages')
    assert.equal(bySession.get(1)?.max_message_id, 3)
    assert.equal(bySession.get(3)?.reason, 'new_messages')
  } finally {
    reader.close()
  }
})

test('listChangedSessions is empty once the watermark matches current state', async () => {
  const dir = await tmpDir()
  const dbPath = await buildFixtureStateDb(dir)
  const reader = await openHermesStateDb(dbPath)
  try {
    const changed = await reader.listChangedSessions({
      1: { max_message_id: 3, ended_at: null },
      3: { max_message_id: 5, ended_at: '2026-07-20T09:05:00Z' },
    })
    assert.deepEqual(changed, [])
  } finally {
    reader.close()
  }
})

test('listChangedSessions catches a new message appended to an open session', async () => {
  const dir = await tmpDir()
  const dbPath = await buildFixtureStateDb(dir)
  const reader = await openHermesStateDb(dbPath)
  try {
    const changed = await reader.listChangedSessions({
      1: { max_message_id: 2, ended_at: null },
      3: { max_message_id: 5, ended_at: '2026-07-20T09:05:00Z' },
    })
    assert.equal(changed.length, 1)
    assert.equal(changed[0].session_id, 1)
    assert.equal(changed[0].reason, 'new_messages')
    assert.equal(changed[0].max_message_id, 3)
  } finally {
    reader.close()
  }
})

test('listChangedSessions catches the ended_at NULL -> set transition with no new messages', async () => {
  const dir = await tmpDir()
  const dbPath = await buildFixtureStateDb(dir)
  const reader = await openHermesStateDb(dbPath)
  try {
    const changed = await reader.listChangedSessions({
      1: { max_message_id: 3, ended_at: null },
      // stale watermark: same message count as now, but recorded before the session ended
      3: { max_message_id: 5, ended_at: null },
    })
    assert.equal(changed.length, 1)
    assert.equal(changed[0].session_id, 3)
    assert.equal(changed[0].reason, 'ended')
    assert.equal(changed[0].ended_at, '2026-07-20T09:05:00Z')
  } finally {
    reader.close()
  }
})
