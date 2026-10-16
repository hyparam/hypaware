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
  WATERMARK_FLUSH_SESSIONS,
} from '../../hypaware-core/plugins-workspace/hermes/src/source.js'
import { readHermesWatermark } from '../../hypaware-core/plugins-workspace/hermes/src/watermark.js'
import { mintHermesSessionEndId } from '../../hypaware-core/plugins-workspace/hermes/src/projector.js'
import { AI_GATEWAY_MESSAGES_DATASET, PROJECTED_EXCHANGE_KIND } from '../../src/core/backfill/scan_util.js'
import { AI_GATEWAY_MESSAGE_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @ref LLP 0449#reconciliation [tests]: whole-session projection through the
 * real materializer and a scoped snapshot writer, retaining unchanged parts.
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

/** @param {((sessionId: unknown) => void) | undefined} [beforeReconcile] @returns {{ storage: any, appended: Array<{ rows: Record<string, unknown>[] }> } } */
function createFakeStorage(beforeReconcile) {
  /** @type {Record<string, unknown>[]} */
  const committedRows = []
  /** @type {Array<{ rows: Record<string, unknown>[] }>} */
  const appended = []
  const storage = {
    async reconcileRows(_dataset, _columns, rows, scope) {
      beforeReconcile?.(scope.where.session_id)
      const fresh = rows.filter(row => !committedRows.some(old => JSON.stringify(old) === JSON.stringify(row)))
      for (let i = committedRows.length - 1; i >= 0; i--) {
        if (Object.entries(scope.where).every(([key, value]) => committedRows[i][key] === value)) committedRows.splice(i, 1)
      }
      committedRows.push(...rows)
      if (fresh.length) appended.push({ rows: fresh })
      return fresh.length
    },
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
 * @param {{ stateDbPath: string, stateDir: string, pollInterval?: string, beforeReconcile?: (sessionId: unknown) => void }} opts
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
  const { storage, appended } = createFakeStorage(opts.beforeReconcile)
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

  assert.deepEqual(runner.watermark['1'], { max_message_id: 2, ended_at: null, fingerprint: runner.watermark['1'].fingerprint })
  assert.match(runner.watermark['1'].fingerprint ?? '', /^[a-f0-9]{64}$/)
  assert.equal(runner.sessionsTracked, 1)

  const persisted = readHermesWatermark(dir)
  assert.deepEqual(persisted['1'], { max_message_id: 2, ended_at: null, fingerprint: runner.watermark['1'].fingerprint }, 'watermark persists to plugin kernel storage')

  // A tick with nothing changed leaves the watermark untouched and appends nothing.
  await runHermesPollTick(runner, ctx)
  assert.deepEqual(runner.watermark['1'], { max_message_id: 2, ended_at: null, fingerprint: runner.watermark['1'].fingerprint })
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
  assert.deepEqual(runner.watermark['1'], { max_message_id: 3, ended_at: null, fingerprint: runner.watermark['1'].fingerprint })

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
  assert.deepEqual(runner.watermark['7'], { max_message_id: 11, ended_at: null, fingerprint: runner.watermark['7'].fingerprint })

  // No new messages: only sessions.ended_at transitions from NULL to set.
  endSession(db, { id: 7, endedAt: '2026-07-20T09:05:00Z', endReason: 'completed' })
  await runHermesPollTick(runner, ctx)

  assert.equal(appended.length, 2, 'the ended_at transition alone still triggers a second re-projection pass')
  assert.equal(appended[1].rows.length, 1, 'dedupe drops the two already-written messages, only the end part is new')
  const endRow = appended[1].rows[0]
  assert.equal(endRow.part_id, `${mintHermesSessionEndId(7)}#0`)
  assert.equal(endRow.part_type, 'status')

  assert.deepEqual(runner.watermark['7'], { max_message_id: 11, ended_at: '2026-07-20T09:05:00Z', fingerprint: runner.watermark['7'].fingerprint })
  const persisted = readHermesWatermark(dir)
  assert.equal(persisted['7'].ended_at, '2026-07-20T09:05:00Z')
  assert.match(persisted['7'].fingerprint ?? '', /^[a-f0-9]{64}$/)

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

// ---------------------------------------------------------------------------
// A mid-loop failure keeps the progress it already made (issue #2283)
// ---------------------------------------------------------------------------

test('a session that fails mid-tick persists the sessions reconciled before it, so a restart does not re-examine them', async () => {
  const dir = await tmpDir()
  const stateDbPath = path.join(dir, 'state.db')
  const db = createFixtureSchema(stateDbPath)
  for (const id of [1, 2, 3]) {
    insertSession(db, { id, cwd: `/home/dev/p${id}` })
    insertMessage(db, { id: id * 10, sessionId: id, role: 'user', content: `hello ${id}` })
  }
  db.close()

  // Session 2 blows up in the middle of the loop over 1, 2, 3.
  const boom = new Error('reconcile exploded')
  const { ctx, logs } = makeCtx({
    stateDbPath,
    stateDir: dir,
    beforeReconcile(sessionId) {
      if (sessionId === 'hermes-2') throw boom
    },
  })

  const runner = createHermesPollRunner(ctx)
  await runHermesPollTick(runner, ctx)
  assert.equal(runner.lastError, boom.message, 'the tick degrades rather than throwing out')

  const persisted = readHermesWatermark(dir)
  assert.deepEqual(Object.keys(persisted), ['1'], 'session 1 completed before the failure, so its fingerprint is on disk')
  assert.match(persisted['1'].fingerprint ?? '', /^[a-f0-9]{64}$/)

  // The failure names the session that broke and how much progress survived.
  const partial = logs.find((entry) => entry.message === 'hermes.session_reconcile_failed')
  assert.ok(partial, 'a mid-loop failure logs which session broke')
  assert.equal(partial.fields?.session_id, '2')
  assert.equal(partial.fields?.sessions_persisted, 1)
  assert.equal(partial.fields?.sessions_examined, 3)

  // Restart: a fresh runner loads the watermark from disk, with no memory of
  // the tick above and nothing failing any more.
  const { ctx: nextCtx, logs: nextLogs } = makeCtx({ stateDbPath, stateDir: dir })
  const restarted = createHermesPollRunner(nextCtx)
  await runHermesPollTick(restarted, nextCtx)

  const tick = nextLogs.find((entry) => entry.message === 'hermes.poll_tick')
  assert.ok(tick, 'the restarted runner completes a tick')
  assert.equal(tick.fields?.sessions_examined, 2, 'only the failed session and the one after it are re-examined, not session 1')
  assert.deepEqual(Object.keys(readHermesWatermark(dir)).sort(), ['1', '2', '3'])
})

test('the watermark is flushed inside the loop, not only when the loop ends', async () => {
  const dir = await tmpDir()
  const stateDbPath = path.join(dir, 'state.db')
  const db = createFixtureSchema(stateDbPath)
  const total = WATERMARK_FLUSH_SESSIONS + 2
  for (let id = 1; id <= total; id++) {
    insertSession(db, { id, cwd: `/home/dev/p${id}` })
    insertMessage(db, { id: id * 10, sessionId: id, role: 'user', content: `hello ${id}` })
  }
  db.close()

  /** @type {number | null} */
  let onDiskAtLastSession = null
  const { ctx } = makeCtx({
    stateDbPath,
    stateDir: dir,
    beforeReconcile(sessionId) {
      // While the loop is still running its final session, a full batch is
      // already durable: a hard crash here would not repeat those sessions.
      if (sessionId === `hermes-${total}`) onDiskAtLastSession = Object.keys(readHermesWatermark(dir)).length
    },
  })

  const runner = createHermesPollRunner(ctx)
  await runHermesPollTick(runner, ctx)

  assert.equal(runner.lastError, undefined)
  assert.equal(onDiskAtLastSession, WATERMARK_FLUSH_SESSIONS, 'one flush per completed batch, mid-loop')
  assert.equal(Object.keys(readHermesWatermark(dir)).length, total, 'the trailing partial batch is flushed once the loop ends')
})

test('a sidecar write that fails while degrading does not replace the error that caused the degrade', async () => {
  const dir = await tmpDir()
  const stateDbPath = path.join(dir, 'state.db')
  const db = createFixtureSchema(stateDbPath)
  for (const id of [1, 2]) {
    insertSession(db, { id, cwd: `/home/dev/p${id}` })
    insertMessage(db, { id: id * 10, sessionId: id, role: 'user', content: `hello ${id}` })
  }
  db.close()

  const boom = new Error('reconcile exploded')
  // A state dir under a regular file makes every watermark write throw ENOTDIR,
  // so the flush in the degrade path fails on the same tick the reconcile does.
  const { ctx, logs } = makeCtx({
    stateDbPath,
    stateDir: path.join(stateDbPath, 'unwritable'),
    beforeReconcile(sessionId) {
      if (sessionId === 'hermes-2') throw boom
    },
  })

  const runner = createHermesPollRunner(ctx)
  await runHermesPollTick(runner, ctx)

  assert.equal(runner.lastError, boom.message, 'the reconcile failure is reported, not the failed sidecar write')
  const partial = logs.find((entry) => entry.message === 'hermes.session_reconcile_failed')
  assert.ok(partial, 'the partial-progress record survives a failed flush')
  assert.equal(partial.fields?.component, 'hermes')
  assert.equal(partial.fields?.operation, 'hermes.poll')
  assert.equal(partial.fields?.status, 'partial')
  assert.equal(partial.fields?.error_kind, 'unknown')
  assert.equal(partial.fields?.session_id, '2')
  assert.equal(partial.fields?.sessions_persisted, 0, 'nothing reached disk, and the count says so')
  assert.equal(partial.fields?.sessions_examined, 2)

  // Best-effort must not mean silent: a coinciding session error is the one
  // case where nothing else reports that the sidecar is unwritable.
  const flushFailed = logs.find((entry) => entry.message === 'hermes.watermark_flush_failed')
  assert.ok(flushFailed, 'the failed sidecar write is reported in its own right')
  assert.equal(flushFailed.fields?.component, 'hermes')
  assert.equal(flushFailed.fields?.operation, 'hermes.poll')
  assert.equal(flushFailed.fields?.error_kind, 'unknown')
  assert.match(String(flushFailed.fields?.error), /ENOTDIR/, 'the write failure names itself')
})

// ---------------------------------------------------------------------------
// The batch-boundary flush is a write step, not a reconcile (issue #2304)
// ---------------------------------------------------------------------------

test('an in-loop flush failure names the write, never a session whose reconcile completed', async () => {
  const dir = await tmpDir()
  const stateDbPath = path.join(dir, 'state.db')
  const db = createFixtureSchema(stateDbPath)
  const total = WATERMARK_FLUSH_SESSIONS + 6
  for (let id = 1; id <= total; id++) {
    insertSession(db, { id, cwd: `/home/dev/p${id}` })
    insertMessage(db, { id: id * 10, sessionId: id, role: 'user', content: `hello ${id}` })
  }
  db.close()

  // A state dir under a regular file makes every watermark write throw
  // ENOTDIR. No reconcile is rigged to fail, so the only thing that can throw
  // inside the loop is the batch-boundary flush after session
  // WATERMARK_FLUSH_SESSIONS, whose own reconcile has already committed.
  const unwritable = path.join(stateDbPath, 'unwritable')
  const { ctx, logs, appended } = makeCtx({ stateDbPath, stateDir: unwritable })

  const runner = createHermesPollRunner(ctx)
  await runHermesPollTick(runner, ctx)

  assert.equal(appended.length, WATERMARK_FLUSH_SESSIONS, 'every session the loop reached reconciled, the boundary one included')
  assert.match(String(runner.lastError), /ENOTDIR/, 'the write error is what degrades the runner')

  assert.equal(
    logs.find((entry) => entry.message === 'hermes.session_reconcile_failed'),
    undefined,
    'zero reconciles failed, so no record claims one did'
  )

  const flushFailed = logs.find((entry) => entry.message === 'hermes.watermark_flush_failed')
  assert.ok(flushFailed, 'the step that actually broke is named')
  assert.match(String(flushFailed.fields?.error), /ENOTDIR/)
  assert.equal(flushFailed.fields?.sessions_persisted, 0, 'nothing reached disk, and the count says so')
  assert.equal(flushFailed.fields?.sessions_examined, total)

  const pollFailed = logs.find((entry) => entry.message === 'hermes.poll_failed')
  assert.ok(pollFailed, 'the tick degrades')
  assert.match(String(pollFailed.fields?.error), /ENOTDIR/, 'the original error survives to the tick record')

  // Suppression is scoped to the flush, not to the record: the sessions the
  // aborted loop never reached are still changed, and a real failure among
  // them on the next tick still names its session.
  const boom = new Error('reconcile exploded')
  const failingId = WATERMARK_FLUSH_SESSIONS + 2
  const { ctx: nextCtx, logs: nextLogs } = makeCtx({
    stateDbPath,
    stateDir: unwritable,
    beforeReconcile(sessionId) {
      if (sessionId === `hermes-${failingId}`) throw boom
    },
  })
  await runHermesPollTick(runner, nextCtx)

  assert.equal(runner.lastError, boom.message, 'the reconcile failure is reported, not the failed sidecar write')
  const partial = nextLogs.find((entry) => entry.message === 'hermes.session_reconcile_failed')
  assert.ok(partial, 'a genuine reconcile failure still reports on a later tick')
  assert.equal(partial.fields?.session_id, String(failingId))
  assert.equal(partial.fields?.status, 'partial')
  assert.equal(partial.fields?.sessions_examined, total - WATERMARK_FLUSH_SESSIONS)
})

test('a trailing flush failure after a healthy loop reports the write, not a reconcile', async () => {
  const dir = await tmpDir()
  const stateDbPath = path.join(dir, 'state.db')
  const db = createFixtureSchema(stateDbPath)
  for (const id of [1, 2, 3]) {
    insertSession(db, { id, cwd: `/home/dev/p${id}` })
    insertMessage(db, { id: id * 10, sessionId: id, role: 'user', content: `hello ${id}` })
  }
  db.close()

  // Under WATERMARK_FLUSH_SESSIONS changed sessions, so the loop completes and
  // only the flush after it throws.
  const { ctx, logs, appended } = makeCtx({ stateDbPath, stateDir: path.join(stateDbPath, 'unwritable') })

  const runner = createHermesPollRunner(ctx)
  await runHermesPollTick(runner, ctx)

  assert.equal(appended.length, 3, 'all three sessions reconciled')
  assert.match(String(runner.lastError), /ENOTDIR/)
  assert.equal(
    logs.find((entry) => entry.message === 'hermes.session_reconcile_failed'),
    undefined,
    'the loop finished, so no session is named as failing'
  )
  const pollFailed = logs.find((entry) => entry.message === 'hermes.poll_failed')
  assert.ok(pollFailed, 'the write failure reaches the tick record')
  assert.match(String(pollFailed.fields?.error), /ENOTDIR/)
})
