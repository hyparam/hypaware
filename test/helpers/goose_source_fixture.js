// @ts-check

/**
 * Shared fixture for the goose poll source tests: a reduced copy of the Goose
 * v1.57.0 schema v17 written through its own connection, synthetic rows only,
 * and a fake ctx that runs the REAL ai_gateway materializer over a storage
 * that keeps committed rows.
 */

import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { AI_GATEWAY_MESSAGES_DATASET, PROJECTED_EXCHANGE_KIND } from '../../src/core/backfill/scan_util.js'
import { AI_GATEWAY_MESSAGE_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { aiGatewayBackfillMaterializer } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

/** @returns {Promise<string>} */
export async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'goose-source-'))
}

let clock = 0
/** A strictly increasing `updated_at` in Goose's `YYYY-MM-DD HH:MM:SS` form. */
export function nextTimestamp() {
  clock += 1
  return new Date(Date.UTC(2026, 10, 2, 22, 0, 0) + clock * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * The indexes Goose v1.57.0 creates on these two tables (schema v17,
 * `session_manager.rs`), for a fixture whose query plans must match a real
 * install's.
 */
export const GOOSE_V17_INDEXES = [
  'CREATE INDEX idx_messages_session ON messages(session_id)',
  'CREATE INDEX idx_messages_timestamp ON messages(timestamp)',
  'CREATE INDEX idx_messages_message_id ON messages(message_id)',
  'CREATE INDEX idx_messages_session_created ON messages(session_id, created_timestamp, id)',
  'CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC)',
  'CREATE INDEX idx_sessions_type ON sessions(session_type)',
  'CREATE INDEX idx_sessions_parent ON sessions(parent_session_id)',
]

/**
 * @param {string} dbPath
 * @param {{ indexes?: boolean }} [opts] create {@link GOOSE_V17_INDEXES}
 * @returns {DatabaseSync}
 */
export function createFixtureDb(dbPath, opts = {}) {
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
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    metadata_json TEXT
  )`)
  if (opts.indexes) for (const sql of GOOSE_V17_INDEXES) db.exec(sql)
  return db
}

/**
 * @param {DatabaseSync} db
 * @param {{ id: string, workingDir: string, name?: string }} opts
 */
export function insertSession(db, opts) {
  const at = nextTimestamp()
  db.prepare(`INSERT INTO sessions (id, name, session_type, working_dir, created_at, updated_at, provider_name, model_config_json)
    VALUES (?, ?, 'user', ?, ?, ?, 'openai', '{"model_name":"fixture-model"}')`)
    .run(opts.id, opts.name ?? 'Fixture session', opts.workingDir, at, at)
}

/**
 * Append one message and bump the session's `updated_at`, as Goose does.
 *
 * @param {DatabaseSync} db
 * @param {{ sessionId: string, role: 'user' | 'assistant', text: string }} opts
 */
export function insertMessage(db, opts) {
  db.prepare(`INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json)
    VALUES (NULL, ?, ?, ?, ?, '{"userVisible":true,"agentVisible":true}')`)
    .run(opts.sessionId, opts.role, JSON.stringify([{ type: 'text', text: opts.text }]), 1793744391 + clock)
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(nextTimestamp(), opts.sessionId)
}

/**
 * @param {DatabaseSync} db
 * @param {string} sessionId
 * @param {string} name
 */
export function renameSession(db, sessionId, name) {
  db.prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?').run(name, nextTimestamp(), sessionId)
}

// ---------------------------------------------------------------------------
// Fake ctx: the REAL ai_gateway materializer over a fake storage that keeps
// committed rows, so a reconcile genuinely replaces a session's rows.
// ---------------------------------------------------------------------------

/**
 * @param {{ failBatch?: () => boolean, failReconcile?: (sessionId: unknown) => boolean }} [hooks]
 */
export function createFakeStorage(hooks = {}) {
  /** @type {Record<string, unknown>[]} */
  const committed = []
  /** @type {Set<string>} */
  const held = new Set()
  /** @type {unknown[][]} */
  const batches = []
  /** @type {any} */
  const storage = {
    async reconcileRows(_dataset, _columns, rows, scope) {
      if (hooks.failReconcile?.(scope.where.session_id)) throw new Error('reconcile failed')
      for (let i = committed.length - 1; i >= 0; i--) {
        if (Object.entries(scope.where).every(([key, value]) => committed[i][key] === value)) committed.splice(i, 1)
      }
      committed.push(...rows)
      return rows.length
    },
    async reconcileRowsBatch(dataset, columns, snapshots) {
      batches.push(snapshots.map(snapshot => snapshot.scope.where.session_id))
      if (hooks.failBatch?.()) throw new Error('batch failed')
      let written = 0
      for (const { rows, scope } of snapshots) written += await storage.reconcileRows(dataset, columns, rows, scope)
      return written
    },
    claimReconcileScope(_dataset, where) {
      if (held.has(where.session_id)) {
        throw Object.assign(new Error('scope busy'), { error_kind: 'cache_partition_mutation_busy' })
      }
      held.add(where.session_id)
      return () => { held.delete(where.session_id) }
    },
    async appendRowsToPartition(_dataset, _segments, _columns, rows) {
      committed.push(...rows)
    },
    async discoverCachePartitions() {
      return committed.length ? [{ path: 'fake-partition', rowCount: committed.length }] : []
    },
    async *readRows() {
      for (const row of committed) yield row
    },
  }
  return { storage, committed, held, batches }
}

/**
 * @param {{ dir: string, sessionsDb: string, config?: Record<string, unknown>,
 *   hooks?: Parameters<typeof createFakeStorage>[0] }} opts
 */
export function makeCtx(opts) {
  /** @type {Array<{ level: string, message: string, fields?: Record<string, unknown> }>} */
  const logs = []
  const log = {
    debug(message, fields) { logs.push({ level: 'debug', message, fields }) },
    info(message, fields) { logs.push({ level: 'info', message, fields }) },
    warn(message, fields) { logs.push({ level: 'warn', message, fields }) },
    error(message, fields) { logs.push({ level: 'error', message, fields }) },
  }
  const fake = createFakeStorage(opts.hooks)
  const materializers = new Map([[PROJECTED_EXCHANGE_KIND, aiGatewayBackfillMaterializer()]])
  const ctx = /** @type {any} */ ({
    config: { sessions_db: opts.sessionsDb, ...opts.config },
    env: { HOME: opts.dir, HYP_HOME: opts.dir },
    paths: { rootDir: opts.dir, stateDir: opts.dir, cacheDir: opts.dir, tempDir: opts.dir },
    log,
    storage: fake.storage,
    query: {
      getDataset(name) {
        if (name !== AI_GATEWAY_MESSAGES_DATASET) return undefined
        return { name, plugin: '@hypaware/ai-gateway', schema: { columns: AI_GATEWAY_MESSAGE_COLUMNS } }
      },
    },
    backfillMaterializers: { get(kind) { return materializers.get(kind) } },
  })
  return { ctx, logs, ...fake }
}

/** @param {Array<{ message: string, fields?: Record<string, unknown> }>} logs @param {string} status */
export function pollLogs(logs, status) {
  return logs.filter(entry => entry.message === 'goose.poll' && (entry.fields?.poll_status ?? entry.fields?.status) === status)
}
