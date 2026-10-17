// @ts-check

/**
 * Issue #2279: a poll tick over many changed sessions loads each cache
 * partition's table metadata once for the whole batch, not once per session,
 * against the real Iceberg-backed cache.
 * @ref LLP 0527#batched-reconcile [tests]: one metadata load and commit per partition per tick.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { AI_GATEWAY_MESSAGES_DATASET, PROJECTED_EXCHANGE_KIND } from '../../src/core/backfill/scan_util.js'
import { AI_GATEWAY_MESSAGE_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'
import {
  HERMES_SESSIONS_PER_TICK,
  createHermesPollRunner,
  runHermesPollTick,
} from '../../hypaware-core/plugins-workspace/hermes/src/source.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

/** @param {string} dbPath */
function createStore(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, cwd TEXT,
      parent_session_id TEXT, started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT,
      billing_provider TEXT, billing_base_url TEXT, system_prompt TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      reasoning_tokens INTEGER, estimated_cost_usd REAL, actual_cost_usd REAL, api_call_count INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_calls TEXT, tool_name TEXT, tool_call_id TEXT, reasoning TEXT,
      timestamp TEXT NOT NULL, token_count INTEGER, finish_reason TEXT,
      active INTEGER DEFAULT 1, compacted INTEGER DEFAULT 0);
  `)
  return db
}

/** @param {DatabaseSync} db @param {number} from @param {number} count */
function insertSessions(db, from, count) {
  const session = db.prepare(`INSERT INTO sessions (id, source, model, cwd, started_at, billing_provider, billing_base_url)
    VALUES (?, 'cli', 'gpt-4o', '/home/dev/project', '2026-07-20T10:00:00Z', 'openai', 'https://api.openai.com/v1')`)
  const message = db.prepare(`INSERT INTO messages (id, session_id, role, content, timestamp)
    VALUES (?, ?, ?, ?, '2026-07-20T10:00:01Z')`)
  for (let i = from; i < from + count; i++) {
    const id = `s-${String(i).padStart(4, '0')}`
    session.run(id)
    message.run(i * 2 + 1, id, 'user', `question ${i}`)
    message.run(i * 2 + 2, id, 'assistant', `answer ${i}`)
  }
}

/**
 * Count icebird's metadata-directory listings: one per table metadata load.
 * @param {() => Promise<void>} fn
 */
async function countMetadataReads(fn) {
  const readdir = fs.readdirSync
  let reads = 0
  fs.readdirSync = /** @type {any} */ ((/** @type {any} */ dir, /** @type {any} */ options) => {
    if (options?.withFileTypes && String(dir).endsWith(`${path.sep}metadata`)) reads += 1
    return readdir(dir, options)
  })
  try {
    await fn()
  } finally {
    fs.readdirSync = readdir
  }
  return reads
}

test('a tick over a full batch of sessions loads partition metadata as often as a tick over one', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hermes-batch-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'state.db')
  const db = createStore(dbPath)
  t.after(() => db.close())
  const storage = createQueryStorageService({ cacheRoot: path.join(dir, 'cache') })

  // Other clients' partitions: each is one more table the reconcile visits.
  const others = 4
  for (let k = 0; k < others; k++) {
    const where = { client_name: `other-${k}`, session_id: 'x' }
    await storage.reconcileRows?.(AI_GATEWAY_MESSAGES_DATASET, [...AI_GATEWAY_MESSAGE_COLUMNS],
      [{ ...where, gateway_id: 'g', schema_version: 1, provider: 'openai',
        conversation_started_at: '2026-07-20T10:00:00Z', message_id: `m-${k}`, message_index: 0,
        message_created_at: '2026-07-20T10:00:00Z', role: 'user', part_id: `p-${k}`, part_index: 0,
        part_type: 'text', date: '2026-07-20' }], { where, key: 'part_id' })
  }

  const materializers = new Map([[PROJECTED_EXCHANGE_KIND, aiGatewayBackfillMaterializer()]])
  const ctx = /** @type {any} */ ({
    config: { state_db: dbPath }, env: {},
    paths: { rootDir: dir, stateDir: dir, cacheDir: dir, tempDir: dir },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    storage,
    query: { getDataset: (/** @type {string} */ name) => name === AI_GATEWAY_MESSAGES_DATASET
      ? { name, plugin: '@hypaware/ai-gateway', schema: { columns: AI_GATEWAY_MESSAGE_COLUMNS } } : undefined },
    backfillMaterializers: { get: (/** @type {string} */ kind) => materializers.get(kind) },
  })
  const runner = createHermesPollRunner(ctx)
  t.after(() => runner.db?.close())

  // The hermes partition exists before either measured tick, so both visit
  // the same set of tables.
  insertSessions(db, 0, 1)
  await runHermesPollTick(runner, ctx)

  insertSessions(db, 1, 1)
  const single = await countMetadataReads(() => runHermesPollTick(runner, ctx))
  insertSessions(db, 2, HERMES_SESSIONS_PER_TICK)
  const batched = await countMetadataReads(() => runHermesPollTick(runner, ctx))

  t.diagnostic(`metadata reads per tick over ${others + 1} partitions: 1 session ${single}, ${HERMES_SESSIONS_PER_TICK} sessions ${batched}`)
  assert.equal(runner.lastError ?? null, null)
  assert.equal(runner.sessionsPending, 0)
  assert.ok(single > 0, 'the counter sees the metadata loads')
  assert.equal(batched, single, 'metadata is loaded once per partition per tick, whatever the batch size')
  assert.equal(Object.keys(runner.watermark).length, 2 + HERMES_SESSIONS_PER_TICK)

  /** @type {Set<string>} */
  const sessions = new Set()
  for (const part of await storage.discoverCachePartitions()) {
    for await (const row of storage.readRows(part.path)) {
      if (row.client_name === 'hermes') sessions.add(String(row.session_id))
    }
  }
  assert.equal(sessions.size, 2 + HERMES_SESSIONS_PER_TICK, 'every session reconciled')
})
