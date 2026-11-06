// @ts-check

/**
 * Mastra Code 0.49.0 `mastra.db` databases for the mastracode tests and the
 * hermetic `mastracode_capture` smoke: the two tables the reader names,
 * exactly as the probe dumped them, the two message indexes the pinned
 * `@mastra/libsql` 1.29.0 creates, and thread `metadata` written as SQLite
 * JSONB through `jsonb()`, as Mastra Code stores it. Written in WAL mode
 * through its own connection, synthetic rows only. It lives in `smoke/lib`
 * because the smoke ships and `test/` does not.
 *
 * @import { DatabaseSync as SqliteDatabase } from 'node:sqlite'
 */

import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

/** `mastra_threads` and `mastra_messages` from the probe's `schema.sql` (mastracode 0.49.0). */
export const MASTRA_TABLES_SCHEMA = `CREATE TABLE mastra_messages (
  "id" TEXT NOT NULL PRIMARY KEY,
  "thread_id" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "resourceId" TEXT
);
CREATE TABLE mastra_threads (
  "id" TEXT NOT NULL PRIMARY KEY,
  "resourceId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "metadata" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);`

/** The message indexes `@mastra/libsql` 1.29.0 creates (`dist/index.js`, `MemoryLibSQL` init). */
export const MASTRA_LIBSQL_1_29_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_messages_thread_created_at ON mastra_messages (thread_id, "createdAt")',
  'CREATE INDEX IF NOT EXISTS idx_messages_thread_resource_created_at ON mastra_messages (thread_id, "resourceId", "createdAt")',
]

/**
 * Create `<dir>/mastra.db` with the two tables and their indexes in WAL
 * mode, then close it.
 *
 * @param {string} dir
 * @param {{ dropColumn?: [string, string], dropTable?: string, indexes?: boolean }} [opts]
 * @returns {Promise<string>} the mastra.db path
 */
export async function createMastraDb(dir, opts = {}) {
  await fs.mkdir(dir, { recursive: true })
  const dbPath = path.join(dir, 'mastra.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(MASTRA_TABLES_SCHEMA)
  if (opts.indexes !== false) for (const sql of MASTRA_LIBSQL_1_29_INDEXES) db.exec(sql)
  if (opts.dropColumn) {
    const [table, column] = opts.dropColumn
    db.exec(`ALTER TABLE ${table} DROP COLUMN "${column}"`)
  }
  if (opts.dropTable) db.exec(`DROP TABLE ${opts.dropTable}`)
  db.close()
  return dbPath
}

/**
 * A writer connection, the way Mastra Code holds one: WAL mode.
 *
 * @param {string} dbPath
 * @returns {SqliteDatabase}
 */
export function openWriter(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  return db
}

/**
 * @param {SqliteDatabase} db
 * @param {{ id: string, title?: string, metadata?: Record<string, unknown>, createdAt?: string, updatedAt?: string }} thread
 */
export function insertThread(db, thread) {
  const createdAt = thread.createdAt ?? '2026-11-05T22:52:20.800Z'
  db.prepare(`INSERT INTO mastra_threads (id, "resourceId", title, metadata, "createdAt", "updatedAt")
    VALUES (?, ?, ?, jsonb(?), ?, ?)`).run(
    thread.id,
    'fixture-resource',
    thread.title ?? '',
    JSON.stringify(thread.metadata ?? {}),
    createdAt,
    thread.updatedAt ?? createdAt,
  )
}

/**
 * @param {SqliteDatabase} db
 * @param {string} id
 * @param {{ metadata?: Record<string, unknown>, updatedAt: string }} update
 */
export function updateThread(db, id, update) {
  if (update.metadata) {
    db.prepare('UPDATE mastra_threads SET metadata = jsonb(?), "updatedAt" = ? WHERE id = ?').run(JSON.stringify(update.metadata), update.updatedAt, id)
  } else {
    db.prepare('UPDATE mastra_threads SET "updatedAt" = ? WHERE id = ?').run(update.updatedAt, id)
  }
}

/**
 * @param {SqliteDatabase} db
 * @param {{ id: string, thread_id: string, role: string, type: string, content: Record<string, unknown>, createdAt?: string }} message
 */
export function insertMessage(db, message) {
  db.prepare(`INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    message.id,
    message.thread_id,
    JSON.stringify(message.content),
    message.role,
    message.type,
    message.createdAt ?? '2026-11-05T22:52:20.831Z',
    'fixture-resource',
  )
}

/**
 * Rewrite a message's content in place, keeping its rowid, as a growing
 * assistant turn does.
 *
 * @param {SqliteDatabase} db
 * @param {string} id
 * @param {Record<string, unknown>} content
 */
export function rewriteMessage(db, id, content) {
  db.prepare('UPDATE mastra_messages SET content = ? WHERE id = ?').run(JSON.stringify(content), id)
}

/**
 * A user message's `content`, the a4 sample's shape.
 *
 * @param {string} id
 * @param {string} text
 * @param {number} [createdAtMs]
 */
export function userContent(id, text, createdAtMs = 1793919140831) {
  return {
    format: 2,
    parts: [{ type: 'text', text, createdAt: createdAtMs }],
    metadata: { signal: { id, type: 'user', tagName: 'user', createdAt: new Date(createdAtMs).toISOString() } },
  }
}

/**
 * A `tool-invocation` part, the a4 sample's shape.
 *
 * @param {{ toolCallId: string, command: string, result?: string, state?: string }} call
 */
export function toolInvocationPart(call) {
  /** @type {Record<string, unknown>} */
  const invocation = {
    state: call.state ?? 'result',
    toolCallId: call.toolCallId,
    toolName: 'execute_command',
    args: { description: 'fixture command', command: call.command },
  }
  if ((call.state ?? 'result') === 'result') invocation.result = call.result ?? ''
  return { type: 'tool-invocation', toolInvocation: invocation, updatedAt: 1793919140958 }
}

/**
 * A `data-workspace-metadata` part, the a4 sample's shape, carrying the
 * workspace paths the projector must drop.
 *
 * @param {string} toolCallId
 * @param {string} basePath
 */
export function workspaceMetadataPart(toolCallId, basePath) {
  return {
    type: 'data-workspace-metadata',
    data: {
      toolName: 'mastra_workspace_execute_command',
      toolCallId,
      id: `mastra-code-workspace-${basePath}`,
      name: 'Mastra Code Workspace',
      filesystem: { id: 'local-fs-fixture', provider: 'local', metadata: { basePath, allowedPaths: [`${basePath}/.mastracode/skills`] } },
      sandbox: { provider: 'local', resources: { memoryMB: 1024, cpuCores: 2 } },
    },
    createdAt: 1793919140940,
  }
}

/**
 * A `data-sandbox-exit` part.
 *
 * @param {string} toolCallId
 * @param {number} [exitCode]
 */
export function sandboxExitPart(toolCallId, exitCode = 0) {
  return { type: 'data-sandbox-exit', data: { exitCode, success: exitCode === 0, toolCallId }, createdAt: 1793919140950 }
}

/**
 * @param {string} model
 * @param {number} [createdAtMs]
 */
export function stepStartPart(model, createdAtMs = 1793919140964) {
  return { type: 'step-start', model, createdAt: createdAtMs }
}

/**
 * @param {string} text
 * @param {number} [createdAtMs]
 */
export function textPart(text, createdAtMs = 1793919140970) {
  return { type: 'text', text, createdAt: createdAtMs }
}

/**
 * An assistant message's `content`, the a4 sample's shape.
 *
 * @param {Array<Record<string, unknown>>} parts
 * @param {{ modelId?: string, provider?: string }} [meta]
 */
export function assistantContent(parts, meta = {}) {
  /** @type {Record<string, unknown>} */
  const metadata = { traceId: 'fixture-trace' }
  if (meta.modelId) metadata.modelId = meta.modelId
  if (meta.provider) metadata.provider = meta.provider
  return { format: 2, parts, metadata }
}
