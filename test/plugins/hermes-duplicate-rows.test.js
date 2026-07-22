// @ts-check

/**
 * Regression tests for issue #348: `@hypaware/hermes` writes duplicate
 * `part_id` rows in `ai_gateway_messages` (violates spec R2, LLP 0118).
 *
 * Two compounding defects are pinned here:
 *
 *  1. Self-starting source. `activate()` must NOT start the poll source, it
 *     may only register it (the shape `@hypaware/claude` and `@hypaware/codex`
 *     use). Plugin activation runs on every kernel boot, so a self-start ran a
 *     full poll tick in-process on every `hyp` CLI invocation, concurrently
 *     with the daemon runner. The daemon runtime is the sole intended starter
 *     (`src/core/daemon/runtime.js`, `startConfiguredSources`).
 *     @ref LLP 0121 [tests]: same activation shape as the claude/codex adapters,
 *       register-only, never self-start.
 *
 *  2. Stale dedupe seen-set. The shared `ai_gateway.projected_exchange`
 *     materializer scans the committed `part_id` set once per `devRunId` and
 *     memoizes it. When a fixed `devRunId` spans many poll ticks, rows another
 *     writer commits between ticks are invisible to the stale seen-set, so
 *     LLP 0122#watermark whole-session re-projection re-appends the
 *     already-written prefix instead of dropping it. A fresh scan per tick
 *     makes re-projection drop the already-committed prefix.
 *     @ref LLP 0122#watermark [tests]: whole-session re-projection leans on the
 *       materializer's pre-write dedupe dropping the already-imported prefix.
 *     @ref LLP 0118#requirements [tests]: spec R2, capture is idempotent, a
 *       re-poll over already-imported data writes no duplicate rows.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { activate } from '../../hypaware-core/plugins-workspace/hermes/src/index.js'
import {
  createHermesPollRunner,
  runHermesPollTick,
} from '../../hypaware-core/plugins-workspace/hermes/src/source.js'
import { AI_GATEWAY_MESSAGES_DATASET, PROJECTED_EXCHANGE_KIND } from '../../src/core/backfill/scan_util.js'
import { AI_GATEWAY_MESSAGE_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

/** @returns {Promise<string>} */
async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hermes-dup-'))
}

// ---------------------------------------------------------------------------
// Defect 1: activate() registers the source but never starts it.
// ---------------------------------------------------------------------------

test('activate() registers the hermes source but does not start it (matches claude/codex)', async () => {
  const dir = await tmpDir()
  /** @type {string[]} */
  const registered = []
  /** @type {string[]} */
  const started = []

  const ctx = /** @type {any} */ ({
    // Default config: `enabled` is unset, so resolveHermesEnabled() -> true.
    // The pre-fix code took that as licence to self-start; the fixed code
    // registers only and leaves starting to the daemon runtime.
    config: {},
    env: { HOME: dir },
    paths: { rootDir: dir, stateDir: dir, cacheDir: dir, tempDir: dir },
    configRegistry: { registerSection() {} },
    backfills: { register() {} },
    sources: {
      register(contribution) { registered.push(contribution.name) },
      async start(name) { started.push(name) },
    },
  })

  await activate(ctx)

  assert.deepEqual(registered, ['hermes'], 'activate registers the hermes source')
  assert.deepEqual(
    started,
    [],
    'activate must NOT start the poll source: activation runs on every CLI boot, ' +
      'the daemon runtime is the sole intended starter'
  )
})

// ---------------------------------------------------------------------------
// Defect 2: a re-projection after rows are already committed by another writer
// appends zero duplicate rows (the dedupe scan must be fresh per tick).
// ---------------------------------------------------------------------------

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

/** @param {DatabaseSync} db @param {number} id */
function insertOpenSession(db, id) {
  db.prepare(`
    INSERT INTO sessions (id, source, model, cwd, parent_session_id, started_at, ended_at, end_reason, billing_provider, billing_base_url, system_prompt, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, actual_cost_usd, api_call_count)
    VALUES (?, 'cli', 'gpt-4o', '/home/dev/project', NULL, '2026-07-20T10:00:00Z', NULL, NULL, 'openai', 'https://api.openai.com/v1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
  `).run(id)
}

/** @param {DatabaseSync} db @param {{ id: number, sessionId: number, role: string, content: string }} opts */
function insertMessage(db, opts) {
  db.prepare(`
    INSERT INTO messages (id, session_id, role, content, tool_calls, tool_name, tool_call_id, reasoning, timestamp, token_count, finish_reason)
    VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, '2026-07-20T10:00:01Z', NULL, NULL)
  `).run(opts.id, opts.sessionId, opts.role, opts.content)
}

/**
 * One shared "disk": every storage handed out reads and writes the same
 * committed-row array, so two writers (the daemon runner and a second
 * concurrent writer with its own materializer) see each other's commits, the
 * way two OS processes sharing one on-disk cache would.
 *
 * @returns {{ committed: Record<string, unknown>[], makeStorage: () => { storage: any, appended: Array<{ rows: Record<string, unknown>[] }> } }}
 */
function createSharedDisk() {
  /** @type {Record<string, unknown>[]} */
  const committed = []
  return {
    committed,
    makeStorage() {
      /** @type {Array<{ rows: Record<string, unknown>[] }>} */
      const appended = []
      const storage = {
        async appendRowsToPartition(_dataset, _segments, _columns, rows) {
          appended.push({ rows })
          committed.push(...rows)
        },
        async discoverCachePartitions() {
          if (committed.length === 0) return []
          return [{ path: 'shared-partition', rowCount: committed.length }]
        },
        async *readRows(_tablePath, _columns) {
          // Snapshot so a concurrent append mid-iteration cannot mutate it.
          for (const row of committed.slice()) yield row
        },
      }
      return { storage, appended }
    },
  }
}

/**
 * @param {{ stateDbPath: string, stateDir: string, storage: any }} opts
 * @returns {any}
 */
function makeCtx(opts) {
  const log = {
    debug() {}, info() {}, warn() {}, error() {},
  }
  // Each ctx gets its OWN materializer instance, modelling two independent
  // processes (a daemon and a concurrent writer) that share on-disk cache but
  // not in-memory dedupe state.
  const materializer = aiGatewayBackfillMaterializer()
  const materializers = new Map([[PROJECTED_EXCHANGE_KIND, materializer]])
  return /** @type {any} */ ({
    config: { state_db: opts.stateDbPath },
    env: {},
    paths: { rootDir: opts.stateDir, stateDir: opts.stateDir, cacheDir: opts.stateDir, tempDir: opts.stateDir },
    log,
    storage: opts.storage,
    query: {
      getDataset(name) {
        if (name !== AI_GATEWAY_MESSAGES_DATASET) return undefined
        return { name, plugin: '@hypaware/ai-gateway', schema: { columns: AI_GATEWAY_MESSAGE_COLUMNS } }
      },
    },
    backfillMaterializers: { get(kind) { return materializers.get(kind) } },
  })
}

test('a re-projection after another writer committed the tail appends zero duplicate rows (spec R2)', async () => {
  const disk = createSharedDisk()

  // The daemon: its own state dir (watermark) and storage view of shared disk.
  const daemonDir = await tmpDir()
  const dbPath = path.join(daemonDir, 'state.db')
  const db = createFixtureSchema(dbPath)
  insertOpenSession(db, 1)
  insertMessage(db, { id: 1, sessionId: 1, role: 'user', content: 'hello' })

  const daemonView = disk.makeStorage()
  const daemonCtx = makeCtx({ stateDbPath: dbPath, stateDir: daemonDir, storage: daemonView.storage })
  const daemonRunner = createHermesPollRunner(daemonCtx)

  // Tick 1: only message 1 exists. The daemon writes the first part.
  await runHermesPollTick(daemonRunner, daemonCtx)
  const afterFirst = disk.committed.length
  assert.ok(afterFirst >= 1, 'the daemon commits message 1 on the first tick')
  assert.equal(daemonView.appended.length, 1, 'daemon appended once so far')

  // Message 2 lands on the still-open session.
  insertMessage(db, { id: 2, sessionId: 1, role: 'assistant', content: 'hi there' })

  // A SECOND writer (a separate process: the pre-fix self-starting CLI, or a
  // backfill) re-projects the whole session first and commits the new tail.
  // It has its own materializer, so it correctly scans the shared disk, sees
  // message 1 already committed, and appends only message 2's part.
  const cliDir = await tmpDir()
  const cliView = disk.makeStorage()
  const cliCtx = makeCtx({ stateDbPath: dbPath, stateDir: cliDir, storage: cliView.storage })
  const cliRunner = createHermesPollRunner(cliCtx)
  await runHermesPollTick(cliRunner, cliCtx)
  const afterConcurrentWriter = disk.committed.length
  assert.ok(
    afterConcurrentWriter > afterFirst,
    'the concurrent writer commits the new tail (message 2) to the shared disk'
  )

  // Tick 2 on the daemon: message 2 advanced the watermark, so the whole
  // session is re-projected. The tail is ALREADY committed by the other
  // writer. A correct dedupe drops the whole re-projection; a stale seen-set
  // (scanned once at tick 1, before the tail existed) re-appends it.
  await runHermesPollTick(daemonRunner, daemonCtx)

  assert.equal(
    disk.committed.length,
    afterConcurrentWriter,
    'the daemon re-projection must add zero rows: every part is already committed'
  )
  assert.equal(
    daemonView.appended.length,
    1,
    'the daemon must not append a second batch: the already-committed prefix is dropped, not re-written'
  )

  db.close()
})
