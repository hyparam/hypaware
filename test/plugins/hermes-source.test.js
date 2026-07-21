// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createHermesPollRunner,
  runHermesPollTick,
  startHermesSource,
} from '../../hypaware-core/plugins-workspace/hermes/src/source.js'
import { readHermesWatermark } from '../../hypaware-core/plugins-workspace/hermes/src/watermark.js'
import { mintHermesSessionEndId } from '../../hypaware-core/plugins-workspace/hermes/src/projector.js'
import { AI_GATEWAY_MESSAGES_DATASET, PROJECTED_EXCHANGE_KIND } from '../../src/core/backfill/scan_util.js'
import { AI_GATEWAY_MESSAGE_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @ref LLP 0122#watermark [tests]: change-detection + per-tick whole-session
 * re-projection, leaning on the real `ai_gateway.projected_exchange`
 * materializer's pre-write `part_id` dedupe to turn a re-projection into
 * "append only the new tail".
 * @ref LLP 0118#requirements [tests]: spec R9, missing state.db idles cleanly, no error noise.
 * @ref LLP 0122#session-end-part [tests]: an `ended_at` transition with no
 * new messages still triggers re-projection and lands the synthetic
 * session-end part.
 */

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

// ---------------------------------------------------------------------------
// Fixture: a writable state.db this file mutates between poll ticks, mirroring
// the T1 fixture schema (test/plugins/hermes-state-db.test.js) closely enough
// for the reader's column set (LLP 0122#projection).
// ---------------------------------------------------------------------------

/** @returns {Promise<string>} */
async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hermes-source-'))
}

/** @param {string} dbPath */
function createFixtureSchema(dbPath) {
  const db = new DatabaseSync(dbPath)
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
  return db
}

/**
 * @param {DatabaseSync} db
 * @param {{ id: number, source?: string, model?: string, cwd?: string|null, startedAt?: string }} opts
 */
function insertSession(db, opts) {
  db.prepare(`
    INSERT INTO sessions (id, source, model, cwd, parent_session_id, started_at, ended_at, end_reason, billing_provider, billing_base_url, system_prompt, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd, api_call_count)
    VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, 'openai', 'https://api.openai.com/v1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
  `).run(
    opts.id,
    opts.source ?? 'cli',
    opts.model ?? 'gpt-4o',
    opts.cwd ?? null,
    opts.startedAt ?? '2026-07-20T10:00:00Z'
  )
}

/**
 * @param {DatabaseSync} db
 * @param {{ id: number, sessionId: number, role?: string, content?: string, timestamp?: string }} opts
 */
function insertMessage(db, opts) {
  db.prepare(`
    INSERT INTO messages (id, session_id, role, content, tool_calls, tool_name, tool_call_id, reasoning, timestamp, token_count, finish_reason)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, NULL)
  `).run(
    opts.id,
    opts.sessionId,
    opts.role ?? 'user',
    opts.content ?? 'hello',
    opts.timestamp ?? '2026-07-20T10:00:01Z'
  )
}

/**
 * @param {DatabaseSync} db
 * @param {{ id: number, endedAt: string, endReason?: string }} opts
 */
function endSession(db, opts) {
  db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?')
    .run(opts.endedAt, opts.endReason ?? 'completed', opts.id)
}

// ---------------------------------------------------------------------------
// Fake ctx: captures appended rows, drives the REAL ai_gateway backfill
// materializer (so its pre-write part_id dedupe is genuinely exercised, not
// stubbed), and a fake storage that persists appended rows so the
// materializer's dedupe scan sees them on a later tick.
// ---------------------------------------------------------------------------

/** @returns {{ storage: any, appended: Array<{ rows: Record<string, unknown>[] }> } } */
function createFakeStorage() {
  /** @type {Record<string, unknown>[]} */
  const committedRows = []
  /** @type {Array<{ rows: Record<string, unknown>[] }>} */
  const appended = []
  const storage = {
    async appendRowsToPartition(_dataset, _partitionSegments, _columns, rows) {
      appended.push({ rows })
      committedRows.push(...rows)
    },
    async discoverCachePartitions() {
      if (committedRows.length === 0) return []
      return [{ path: 'fake-partition', rowCount: committedRows.length }]
    },
    async *readRows(_tablePath, _columns) {
      for (const row of committedRows) yield row
    },
  }
  return { storage, appended }
}

/**
 * @param {{ stateDbPath: string, stateDir: string, pollInterval?: string }} opts
 */
function makeCtx(opts) {
  /** @type {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} */
  const logs = []
  const log = {
    debug(message, fields) { logs.push({ level: 'debug', message, fields }) },
    info(message, fields) { logs.push({ level: 'info', message, fields }) },
    warn(message, fields) { logs.push({ level: 'warn', message, fields }) },
    error(message, fields) { logs.push({ level: 'error', message, fields }) },
  }
  const { storage, appended } = createFakeStorage()
  const materializer = aiGatewayBackfillMaterializer()
  const materializers = new Map([[PROJECTED_EXCHANGE_KIND, materializer]])

  const ctx = /** @type {any} */ ({
    config: { state_db: opts.stateDbPath, ...(opts.pollInterval ? { poll_interval: opts.pollInterval } : {}) },
    env: {},
    paths: { rootDir: opts.stateDir, stateDir: opts.stateDir, cacheDir: opts.stateDir, tempDir: opts.stateDir },
    log,
    storage,
    query: {
      getDataset(name) {
        if (name !== AI_GATEWAY_MESSAGES_DATASET) return undefined
        return { name, plugin: '@hypaware/ai-gateway', schema: { columns: AI_GATEWAY_MESSAGE_COLUMNS } }
      },
    },
    backfillMaterializers: {
      get(kind) { return materializers.get(kind) },
    },
  })
  return { ctx, logs, appended }
}

// ---------------------------------------------------------------------------
// Idle mode (spec R9)
// ---------------------------------------------------------------------------

test('a missing state.db idles cleanly: no db opened, no error noise, idle logged once', async () => {
  const dir = await tmpDir()
  const stateDbPath = path.join(dir, 'state.db') // never created
  const { ctx, logs } = makeCtx({ stateDbPath, stateDir: dir })

  const runner = createHermesPollRunner(ctx)
  await runHermesPollTick(runner, ctx)
  await runHermesPollTick(runner, ctx)
  await runHermesPollTick(runner, ctx)

  assert.equal(runner.db, null, 'no db opened when the file is missing')
  assert.equal(runner.lastError, undefined, 'idle is not an error condition')
  assert.equal(runner.rowsWritten, 0)

  const idleLogs = logs.filter((entry) => entry.message === 'hermes.source_idle')
  assert.equal(idleLogs.length, 1, 'idle is logged once, not every tick ("no error noise")')
  const errorLogs = logs.filter((entry) => entry.level === 'error')
  assert.deepEqual(errorLogs, [], 'a missing store never logs at error level')
})

test('startHermesSource reports ready/idle status when hermes is not installed', async () => {
  const dir = await tmpDir()
  const stateDbPath = path.join(dir, 'state.db')
  const { ctx } = makeCtx({ stateDbPath, stateDir: dir })

  const source = await startHermesSource(ctx)
  try {
    assert.ok(source.status, 'source exposes status()')
    const status = await source.status()
    assert.equal(status.state, 'ready')
    assert.equal(status.message, 'no hermes installation detected')
    assert.equal(status.rowsWritten, 0)
  } finally {
    await source.stop()
  }
})

// ---------------------------------------------------------------------------
// Watermark advance
// ---------------------------------------------------------------------------

test('a poll tick advances the per-session watermark to the store\'s current state and persists it', async () => {
  const dir = await tmpDir()
  const stateDbPath = path.join(dir, 'state.db')
  const db = createFixtureSchema(stateDbPath)
  insertSession(db, { id: 1, cwd: '/home/dev/project' })
  insertMessage(db, { id: 1, sessionId: 1, role: 'user', content: 'hello' })
  insertMessage(db, { id: 2, sessionId: 1, role: 'assistant', content: 'hi there' })
  db.close()

  const { ctx } = makeCtx({ stateDbPath, stateDir: dir })
  const runner = createHermesPollRunner(ctx)
  await runHermesPollTick(runner, ctx)

  assert.deepEqual(runner.watermark['1'], { max_message_id: 2, ended_at: null })
  assert.equal(runner.sessionsTracked, 1)

  const persisted = readHermesWatermark(dir)
  assert.deepEqual(persisted['1'], { max_message_id: 2, ended_at: null }, 'watermark persists to plugin kernel storage')

  // A tick with nothing changed leaves the watermark untouched and appends nothing.
  await runHermesPollTick(runner, ctx)
  assert.deepEqual(runner.watermark['1'], { max_message_id: 2, ended_at: null })
})

// ---------------------------------------------------------------------------
// Dedupe-reliant re-projection: only the new tail gets appended
// ---------------------------------------------------------------------------

test('re-projecting a whole session on each tick appends only the new tail (materializer part_id dedupe)', async () => {
  const dir = await tmpDir()
  const stateDbPath = path.join(dir, 'state.db')
  const db = createFixtureSchema(stateDbPath)
  insertSession(db, { id: 1, cwd: '/home/dev/project' })
  insertMessage(db, { id: 1, sessionId: 1, role: 'user', content: 'hello' })
  insertMessage(db, { id: 2, sessionId: 1, role: 'assistant', content: 'hi there' })

  const { ctx, appended } = makeCtx({ stateDbPath, stateDir: dir })
  const runner = createHermesPollRunner(ctx)

  await runHermesPollTick(runner, ctx)
  assert.equal(appended.length, 1, 'first tick appends once')
  assert.equal(appended[0].rows.length, 2, 'both messages land on the first tick')
  assert.equal(runner.rowsWritten, 2)

  // A new message lands on the still-open session; the reader re-projects
  // the WHOLE session again, but dedupe must drop the two already-written
  // parts and append only the new one.
  insertMessage(db, { id: 3, sessionId: 1, role: 'assistant', content: 'one more thing' })
  await runHermesPollTick(runner, ctx)

  assert.equal(appended.length, 2, 'second tick appends once more')
  assert.equal(appended[1].rows.length, 1, 'only the new tail (message 3) is appended, not a re-write of 1-2')
  assert.equal(runner.rowsWritten, 3, 'rows written accumulates across ticks')
  assert.deepEqual(runner.watermark['1'], { max_message_id: 3, ended_at: null })

  db.close()
})

// ---------------------------------------------------------------------------
// Session ending with no new messages still triggers re-projection
// ---------------------------------------------------------------------------

test('a session ending with no new messages still triggers re-projection and lands the session-end part', async () => {
  const dir = await tmpDir()
  const stateDbPath = path.join(dir, 'state.db')
  const db = createFixtureSchema(stateDbPath)
  insertSession(db, { id: 7, cwd: '/home/dev/other' })
  insertMessage(db, { id: 10, sessionId: 7, role: 'user', content: 'why is the sky blue' })
  insertMessage(db, { id: 11, sessionId: 7, role: 'assistant', content: 'Rayleigh scattering.' })

  const { ctx, appended } = makeCtx({ stateDbPath, stateDir: dir })
  const runner = createHermesPollRunner(ctx)

  await runHermesPollTick(runner, ctx)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].rows.length, 2, 'the two messages land while the session is open')
  assert.deepEqual(runner.watermark['7'], { max_message_id: 11, ended_at: null })

  // No new messages: only sessions.ended_at transitions from NULL to set.
  endSession(db, { id: 7, endedAt: '2026-07-20T09:05:00Z', endReason: 'completed' })
  await runHermesPollTick(runner, ctx)

  assert.equal(appended.length, 2, 'the ended_at transition alone still triggers a second re-projection pass')
  assert.equal(appended[1].rows.length, 1, 'dedupe drops the two already-written messages, only the end part is new')
  const endRow = appended[1].rows[0]
  assert.equal(endRow.part_id, `${mintHermesSessionEndId(7)}#0`)
  assert.equal(endRow.part_type, 'status')

  assert.deepEqual(runner.watermark['7'], { max_message_id: 11, ended_at: '2026-07-20T09:05:00Z' })
  const persisted = readHermesWatermark(dir)
  assert.deepEqual(persisted['7'], { max_message_id: 11, ended_at: '2026-07-20T09:05:00Z' })

  db.close()
})

// ---------------------------------------------------------------------------
// stop() closes cleanly
// ---------------------------------------------------------------------------

test('stop() clears the timer, closes the db, and is safe to call twice', async () => {
  const dir = await tmpDir()
  const stateDbPath = path.join(dir, 'state.db')
  const db = createFixtureSchema(stateDbPath)
  insertSession(db, { id: 1, cwd: '/home/dev/project' })
  insertMessage(db, { id: 1, sessionId: 1, role: 'user', content: 'hello' })
  db.close()

  const { ctx } = makeCtx({ stateDbPath, stateDir: dir, pollInterval: '5m' })
  const source = await startHermesSource(ctx)
  assert.ok(source.status, 'source exposes status()')

  const beforeStop = await source.status()
  assert.equal(beforeStop.state, 'ready')
  assert.ok(beforeStop.message?.includes(stateDbPath))

  await assert.doesNotReject(() => source.stop())
  await assert.doesNotReject(() => source.stop(), 'a second stop() call must not throw (idempotent close)')

  const afterStop = await source.status()
  assert.equal(afterStop.state, 'stopped')
})

