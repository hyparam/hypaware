// @ts-check

/**
 * @import { TestContext } from 'node:test'
 * @import { MastraDb } from '../../hypaware-core/plugins-workspace/mastracode/src/mastra_db.js'
 */

import assert from 'node:assert/strict'
import nodeFs, { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import test, { mock } from 'node:test'

import * as mastraDb from '../../hypaware-core/plugins-workspace/mastracode/src/mastra_db.js'
import { MastraDbError } from '../../hypaware-core/plugins-workspace/mastracode/src/errors.js'
import {
  assistantContent,
  createMastraDb,
  insertMessage,
  insertThread,
  openWriter,
  stepStartPart,
  textPart,
  tmpDir,
  userContent,
} from '../helpers/mastracode_db_fixture.js'

const {
  DEFAULT_BUSY_RETRY_ATTEMPTS,
  NEW_ROWS_SQL,
  SQLITE_VERSION_SQL,
  THREAD_COUNTS_SQL,
  openMastraDb,
  sqliteVersionSupported,
  withBusyRetry,
} = mastraDb

const require = createRequire(import.meta.url)

/**
 * @ref LLP 0586#sqlite [tests]: read-only open that leaves mastra.db and its
 *   WAL as they were, the SQLite 3.45 floor, bounded busy retry, the table
 *   and column check, the D7 two-table guard, and the SEARCH plans.
 *
 * The fixture is the two tables from the probe's mastracode 0.49.0
 * `schema.sql` with the `@mastra/libsql` 1.29.0 message indexes and JSONB
 * thread metadata, synthetic rows only.
 */

const THREAD = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000002'

/** @param {string} dbPath */
function seed(dbPath) {
  const db = openWriter(dbPath)
  insertThread(db, {
    id: THREAD,
    title: 'Fixture thread',
    metadata: { currentModelId: 'mastracode/fixture/fixture-model', projectPath: '/fixture/project', tokenUsage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } },
    updatedAt: '2026-11-05T22:52:21.000Z',
  })
  insertThread(db, { id: OTHER, metadata: {} })
  insertMessage(db, { id: 'm1', thread_id: THREAD, role: 'signal', type: 'user', content: userContent('m1', 'fixture prompt'), createdAt: '2026-11-05T22:52:20.831Z' })
  insertMessage(db, { id: 'm2', thread_id: THREAD, role: 'assistant', type: 'v2', content: assistantContent([stepStartPart('fixture/fixture-model'), textPart('fixture reply')]), createdAt: '2026-11-05T22:52:20.900Z' })
  insertMessage(db, { id: 'o1', thread_id: OTHER, role: 'signal', type: 'user', content: userContent('o1', 'other prompt') })
  db.close()
}

/**
 * @param {TestContext} t
 * @param {Parameters<typeof createMastraDb>[1]} [opts]
 * @returns {Promise<{ dir: string, dbPath: string, closeAtEnd: <T extends { close(): unknown }>(handle: T) => T }>}
 */
async function fixture(t, opts) {
  const dir = await tmpDir()
  /** @type {Array<{ close(): unknown }>} */
  const handles = []
  // One hook owns the teardown order: close every handle, then remove the
  // tree. win32 cannot unlink a database an open handle still maps (EBUSY);
  // the retries cover the mapping sqlite releases just after close.
  t.after(async () => {
    for (const handle of handles.splice(0)) {
      try { handle.close() } catch { /* the test already closed it */ }
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  /** @template {{ close(): unknown }} T @param {T} handle */
  const closeAtEnd = (handle) => { handles.push(handle); return handle }
  const dbPath = await createMastraDb(path.join(dir, 'mastracode'), opts)
  if (!opts?.dropTable && !opts?.dropColumn) seed(dbPath)
  return { dir, dbPath, closeAtEnd }
}

/**
 * Every read the reader offers, once.
 *
 * @param {MastraDb} reader
 */
async function readEverything(reader) {
  await reader.maxima()
  await reader.newRows(0)
  await reader.listThreads()
  await reader.threadCounts(THREAD)
  await reader.readThreadSnapshot(THREAD)
}

/** @param {number} errcode */
function sqliteError(errcode) {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode })
}

test('the reader opens read-only: a write through its handle throws', async (t) => {
  const { dbPath, closeAtEnd } = await fixture(t)
  const reader = closeAtEnd(openMastraDb(dbPath))
  assert.throws(() => reader.db.exec("UPDATE mastra_threads SET title = 'x'"), /readonly/i)
})

test('with no -wal at the start, a read leaves mastra.db byte-identical and creates only an empty -wal and the -shm', async (t) => {
  const { dbPath } = await fixture(t)
  const dataDir = path.dirname(dbPath)
  assert.deepEqual((await fs.readdir(dataDir)).sort(), ['mastra.db'])
  const before = await fs.readFile(dbPath)
  const reader = openMastraDb(dbPath)
  await readEverything(reader)
  reader.close()
  assert.ok(before.equals(await fs.readFile(dbPath)), 'mastra.db bytes changed')
  // SQLite creates a missing -wal and -shm for a read-only WAL reader when
  // the directory is writable (LLP 0586#sqlite). The -wal stays empty, so
  // no content was written; nothing else appears.
  const after = (await fs.readdir(dataDir)).sort()
  assert.ok(after.every(name => ['mastra.db', 'mastra.db-shm', 'mastra.db-wal'].includes(name)), `unexpected files: ${after}`)
  if (after.includes('mastra.db-wal')) assert.equal((await fs.stat(`${dbPath}-wal`)).size, 0)
})

test('with a live -wal, a read leaves mastra.db and the -wal byte-identical and sees the WAL rows', async (t) => {
  const { dbPath, closeAtEnd } = await fixture(t)
  const writer = closeAtEnd(openWriter(dbPath))
  writer.exec('PRAGMA wal_autocheckpoint = 0')
  insertMessage(writer, { id: 'm3', thread_id: THREAD, role: 'signal', type: 'user', content: userContent('m3', 'later prompt'), createdAt: '2026-11-05T22:53:00.000Z' })
  const dbBefore = await fs.readFile(dbPath)
  const walBefore = await fs.readFile(`${dbPath}-wal`)
  assert.ok(walBefore.length > 0)
  const reader = openMastraDb(dbPath)
  await readEverything(reader)
  const snapshot = await reader.readThreadSnapshot(THREAD)
  reader.close()
  assert.deepEqual(snapshot?.messages.map(m => m.id), ['m1', 'm2', 'm3'])
  assert.ok(dbBefore.equals(await fs.readFile(dbPath)), 'mastra.db bytes changed')
  assert.ok(walBefore.equals(await fs.readFile(`${dbPath}-wal`)), 'mastra.db-wal bytes changed')
})

test('readThreadSnapshot decodes JSONB metadata and returns ordered messages with the watermark mark', async (t) => {
  const { dbPath, closeAtEnd } = await fixture(t)
  const reader = closeAtEnd(openMastraDb(dbPath))
  const snapshot = await reader.readThreadSnapshot(THREAD)
  assert.ok(snapshot)
  assert.equal(JSON.parse(String(snapshot.thread.metadata)).projectPath, '/fixture/project')
  assert.deepEqual(snapshot.messages.map(m => m.id), ['m1', 'm2'])
  assert.deepEqual(snapshot.messages.map(m => m.row_id), [1, 2])
  assert.equal(snapshot.mark.updated_at, '2026-11-05T22:52:21.000Z')
  assert.equal(snapshot.mark.message_count, 2)
  assert.equal(snapshot.mark.max_rowid, 2)
  assert.match(snapshot.mark.digest, /^[0-9a-f]{64}$/)
  assert.deepEqual(await reader.threadCounts(THREAD), { message_count: 2, max_rowid: 2 })
  assert.equal(await reader.readThreadSnapshot('absent'), null)
  assert.deepEqual(await reader.threadCounts('absent'), { message_count: 0, max_rowid: 0 })
})

test('the digest moves on an in-place rewrite that keeps the rowid and the thread updatedAt', async (t) => {
  const { dbPath, closeAtEnd } = await fixture(t)
  const reader = closeAtEnd(openMastraDb(dbPath))
  const before = await reader.readThreadSnapshot(THREAD)
  const writer = closeAtEnd(openWriter(dbPath))
  writer.prepare('UPDATE mastra_messages SET content = ? WHERE id = ?').run(JSON.stringify(assistantContent([textPart('fixture reply, grown')])), 'm2')
  const after = await reader.readThreadSnapshot(THREAD)
  assert.equal(after?.mark.max_rowid, before?.mark.max_rowid)
  assert.equal(after?.mark.updated_at, before?.mark.updated_at)
  assert.notEqual(after?.mark.digest, before?.mark.digest)
})

test('newRows(cursor) returns only threads with rows above the cursor, and maxima the baseline', async (t) => {
  const { dbPath, closeAtEnd } = await fixture(t)
  const reader = closeAtEnd(openMastraDb(dbPath))
  assert.deepEqual(await reader.newRows(0), { threadIds: [THREAD, OTHER], maxRowid: 3 })
  assert.deepEqual(await reader.newRows(2), { threadIds: [OTHER], maxRowid: 3 })
  assert.deepEqual(await reader.newRows(3), { threadIds: [], maxRowid: 3 })
  assert.deepEqual(await reader.maxima(), { maxRowid: 3, maxUpdatedAt: '2026-11-05T22:52:21.000Z' })
  assert.deepEqual((await reader.listThreads()).map(row => row.id).sort(), [THREAD, OTHER])
})

test('a missing required column or table fails with schema_unsupported naming it and no path', async (t) => {
  for (const [opts, expected] of /** @type {Array<[Parameters<typeof createMastraDb>[1], RegExp]>} */ ([
    [{ dropColumn: ['mastra_messages', 'type'] }, /mastra_messages\.type/],
    [{ dropColumn: ['mastra_threads', 'metadata'] }, /mastra_threads\.metadata/],
    [{ dropTable: 'mastra_threads' }, /no mastra_threads table/],
  ])) {
    const { dir, dbPath, closeAtEnd } = await fixture(t, opts)
    const reader = closeAtEnd(openMastraDb(dbPath))
    await assert.rejects(reader.listThreads(), (err) => {
      assert.ok(err instanceof MastraDbError)
      assert.equal(err.code, 'schema_unsupported')
      assert.match(err.message, expected)
      assert.ok(!err.message.includes(dir))
      return true
    })
  }
})

test('an additive column is ignored', async (t) => {
  const { dbPath, closeAtEnd } = await fixture(t)
  const writer = openWriter(dbPath)
  writer.exec('ALTER TABLE mastra_messages ADD COLUMN "extra" TEXT')
  writer.close()
  const reader = closeAtEnd(openMastraDb(dbPath))
  await readEverything(reader)
})

test('D7: the reader names only mastra_threads and mastra_messages, never selects *, and never reads resourceId', async (t) => {
  const { dbPath, closeAtEnd } = await fixture(t)
  const reader = closeAtEnd(openMastraDb(dbPath))
  /** @type {string[]} */
  const prepared = []
  const prepare = reader.db.prepare.bind(reader.db)
  const exec = reader.db.exec.bind(reader.db)
  reader.db.prepare = (sql) => { prepared.push(sql); return prepare(sql) }
  reader.db.exec = (sql) => { prepared.push(sql); return exec(sql) }
  await readEverything(reader)
  const exported = Object.entries(mastraDb).filter(([name, value]) => name.endsWith('_SQL') && typeof value === 'string').map(([, value]) => /** @type {string} */ (value))
  assert.ok(exported.length >= 8)
  for (const sql of [...prepared, ...exported]) {
    for (const table of sql.matchAll(/(?:\b(?:FROM|JOIN|INTO|UPDATE)\s+|\btable_info\()([A-Za-z_]\w*)/gi)) {
      assert.ok(['mastra_threads', 'mastra_messages'].includes(table[1]), `${sql} names ${table[1]}`)
    }
    assert.doesNotMatch(sql, /\bmastra_(?!threads\b|messages\b)\w+/, sql)
    assert.doesNotMatch(sql, /\bSELECT\s+\*|,\s*\*/i, sql)
    assert.doesNotMatch(sql, /resourceId/, sql)
    assert.doesNotMatch(sql, /^\s*(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA\s+wal_checkpoint)/i, sql)
  }
  // The source text too, so a query built outside the constants is caught.
  const source = readFileSync(new URL('../../hypaware-core/plugins-workspace/mastracode/src/mastra_db.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bmastra_(?!threads\b|messages\b)\w+/)
  assert.doesNotMatch(source, /\b(?:readFile|readFileSync|createReadStream|openSync)\b/)
})

test('D7: the reader opens no path other than the database', async (t) => {
  const { dbPath, closeAtEnd } = await fixture(t)
  const real = require('node:sqlite')
  /** @type {string[]} */
  const opened = []
  class SpyDatabaseSync extends real.DatabaseSync {
    /** @param {string} p @param {Record<string, unknown>} [o] */
    constructor(p, o) {
      opened.push(p)
      super(p, o)
    }
  }
  const reader = closeAtEnd(openMastraDb(dbPath, { requireFn: () => ({ DatabaseSync: SpyDatabaseSync }) }))
  await readEverything(reader)
  assert.deepEqual(opened, [dbPath])
})

test('a SQLite older than 3.45 is sqlite_unsupported and the connection is closed', async (t) => {
  const { dbPath } = await fixture(t)
  const real = require('node:sqlite')
  let closed = 0
  class OldSqlite extends real.DatabaseSync {
    /** @param {string} sql */
    prepare(sql) {
      if (sql === SQLITE_VERSION_SQL) return /** @type {any} */ ({ get: () => ({ version: '3.44.2' }) })
      return super.prepare(sql)
    }
    close() {
      closed++
      return super.close()
    }
  }
  assert.throws(() => openMastraDb(dbPath, { requireFn: () => ({ DatabaseSync: OldSqlite }) }), (err) => {
    assert.ok(err instanceof MastraDbError)
    assert.equal(err.code, 'sqlite_unsupported')
    assert.match(err.message, /3\.44\.2/)
    return true
  })
  assert.equal(closed, 1)
  assert.equal(sqliteVersionSupported('3.45.0'), true)
  assert.equal(sqliteVersionSupported('3.50.4'), true)
  assert.equal(sqliteVersionSupported('4.0.0'), true)
  assert.equal(sqliteVersionSupported('3.40.1'), false)
  assert.equal(sqliteVersionSupported('garbage'), false)
})

test('the rowid range read and the per-thread count-and-max read plan as a SEARCH', async (t) => {
  const { dbPath, closeAtEnd } = await fixture(t)
  const reader = closeAtEnd(openMastraDb(dbPath))
  for (const [sql, args] of /** @type {Array<[string, Array<string | number>]>} */ ([[NEW_ROWS_SQL, [0]], [THREAD_COUNTS_SQL, [THREAD]]])) {
    const plan = reader.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => String(row.detail))
    t.diagnostic(`${sql} => ${plan.join(' | ')}`)
    assert.ok(plan.some(detail => detail.startsWith('SEARCH mastra_messages')), `${sql}\n${plan.join('\n')}`)
    assert.ok(!plan.some(detail => detail.startsWith('SCAN mastra_messages')), `${sql}\n${plan.join('\n')}`)
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
    assert.ok(err instanceof MastraDbError)
    assert.equal(err.code, 'sqlite_busy')
    return true
  })
  assert.equal(calls, DEFAULT_BUSY_RETRY_ATTEMPTS)
  calls = 0
  const boom = Object.assign(new Error('malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 11 })
  await assert.rejects(withBusyRetry(() => { calls++; throw boom }, { sleep: async () => {} }), (err) => err === boom)
  assert.equal(calls, 1)
})

test('a read that stays busy fails the call with sqlite_busy and leaves the reader usable', async (t) => {
  const { dbPath, closeAtEnd } = await fixture(t)
  const reader = closeAtEnd(openMastraDb(dbPath, { sleep: async () => {} }))
  const prepare = reader.db.prepare.bind(reader.db)
  let busy = true
  reader.db.prepare = (sql) => {
    if (busy && sql === NEW_ROWS_SQL) throw sqliteError(5)
    return prepare(sql)
  }
  await assert.rejects(reader.newRows(0), (err) => err instanceof MastraDbError && err.code === 'sqlite_busy')
  busy = false
  assert.equal((await reader.newRows(0)).maxRowid, 3)
})

test('open refuses a missing file, an unreadable file and a missing node:sqlite, naming no path', async (t) => {
  const dir = await tmpDir()
  // maxRetries: win32 reports EBUSY while a just-closed sqlite handle still
  // releases its mapping; POSIX ignores the extra options.
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  assert.throws(() => openMastraDb(path.join(dir, 'absent.db')), (err) => err instanceof MastraDbError && err.code === 'missing' && !err.message.includes(dir))
  assert.throws(() => openMastraDb(path.join(dir, 'absent.db'), { requireFn: () => { throw new Error('no such module') } }), (err) => err instanceof MastraDbError && err.code === 'sqlite_unavailable')
  if (process.getuid?.() === 0) return t.diagnostic('running as root; the permission case is skipped')
  if (process.platform === 'win32') return t.diagnostic('chmod 0o000 does not make a file unreadable on win32; the permission case is skipped')
  const dbPath = await createMastraDb(path.join(dir, 'mastracode'))
  await fs.chmod(dbPath, 0o000)
  assert.throws(() => openMastraDb(dbPath), (err) => err instanceof MastraDbError && err.code === 'permission_denied' && !err.message.includes(dir))
})

test('any other access failure is a typed error whose message names no path', async (t) => {
  const dir = await tmpDir()
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const dbPath = await createMastraDb(path.join(dir, 'mastracode'))
  /** @param {string} code */
  const failWith = (code) => {
    mock.method(nodeFs, 'accessSync', () => {
      throw Object.assign(new Error(`${code}: failed, access '${dbPath}'`), { code })
    })
    syncBuiltinESMExports()
  }
  try {
    failWith('EIO')
    assert.throws(() => openMastraDb(dbPath), (err) => err instanceof MastraDbError && err.code === 'open_failed' && !err.message.includes(dir))
    // The file went between the existence check and the access check.
    failWith('ENOENT')
    assert.throws(() => openMastraDb(dbPath), (err) => err instanceof MastraDbError && err.code === 'missing' && !err.message.includes(dir))
  } finally {
    mock.restoreAll()
    syncBuiltinESMExports()
  }
})
