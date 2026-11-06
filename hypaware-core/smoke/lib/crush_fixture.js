// @ts-check

/**
 * Crush v0.99.0 project databases for the crush tests and the hermetic
 * `crush_capture` smoke: the schema exactly as the probe dumped it
 * (`sqlite3 .schema`, minus `sqlite_sequence`, which AUTOINCREMENT creates),
 * written in WAL mode through its own connection, synthetic rows only. It
 * lives in `smoke/lib` because the smoke ships and `test/` does not.
 *
 * @import { DatabaseSync as SqliteDatabase } from 'node:sqlite'
 */

import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

/** The Crush v0.99.0 schema (`goose_db_version` is the migration table of its migration library). */
export const CRUSH_V0_99_0_SCHEMA = `CREATE TABLE goose_db_version (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id INTEGER NOT NULL,
    is_applied INTEGER NOT NULL,
    tstamp TIMESTAMP DEFAULT (datetime('now'))
  );
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT,
    title TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
    prompt_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
    completion_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens>= 0),
    cost REAL NOT NULL DEFAULT 0.0 CHECK (cost >= 0.0),
    updated_at INTEGER NOT NULL,  -- Unix timestamp in seconds
    created_at INTEGER NOT NULL   -- Unix timestamp in seconds
, summary_message_id TEXT, todos TEXT, channel TEXT);
CREATE TRIGGER update_sessions_updated_at
AFTER UPDATE ON sessions
BEGIN
UPDATE sessions SET updated_at = strftime('%s', 'now')
WHERE id = new.id;
END;
CREATE TABLE files (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,  -- Unix timestamp in seconds
    updated_at INTEGER NOT NULL,  -- Unix timestamp in seconds
    FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    UNIQUE(path, session_id, version)
);
CREATE INDEX idx_files_session_id ON files (session_id);
CREATE INDEX idx_files_path ON files (path);
CREATE TRIGGER update_files_updated_at
AFTER UPDATE ON files
BEGIN
UPDATE files SET updated_at = strftime('%s', 'now')
WHERE id = new.id;
END;
CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    parts TEXT NOT NULL default '[]',
    model TEXT,
    created_at INTEGER NOT NULL,  -- Unix timestamp in seconds
    updated_at INTEGER NOT NULL,  -- Unix timestamp in seconds
    finished_at INTEGER, provider TEXT, is_summary_message INTEGER DEFAULT 0 NOT NULL, prism_model_id TEXT, prism_model_name TEXT, prism_hypercredit_savings REAL, prism_dollar_savings REAL,  -- Unix timestamp in seconds
    FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);
CREATE INDEX idx_messages_session_id ON messages (session_id);
CREATE TRIGGER update_messages_updated_at
AFTER UPDATE ON messages
BEGIN
UPDATE messages SET updated_at = strftime('%s', 'now')
WHERE id = new.id;
END;
CREATE TRIGGER update_session_message_count_on_insert
AFTER INSERT ON messages
BEGIN
UPDATE sessions SET
    message_count = message_count + 1
WHERE id = new.session_id;
END;
CREATE TRIGGER update_session_message_count_on_delete
AFTER DELETE ON messages
BEGIN
UPDATE sessions SET
    message_count = message_count - 1
WHERE id = old.session_id;
END;
CREATE INDEX idx_sessions_created_at ON sessions (created_at);
CREATE INDEX idx_messages_created_at ON messages (created_at);
CREATE INDEX idx_files_created_at ON files (created_at);
CREATE TABLE read_files (
    session_id TEXT NOT NULL CHECK (session_id != ''),
    path TEXT NOT NULL CHECK (path != ''),
    read_at INTEGER NOT NULL,  -- Unix timestamp in seconds when file was last read
    FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    PRIMARY KEY (path, session_id)
);
CREATE INDEX idx_read_files_session_id ON read_files (session_id);
CREATE INDEX idx_read_files_path ON read_files (path);
CREATE INDEX idx_messages_role_created_at ON messages (role, created_at);
CREATE TABLE mcp_disabled_servers (
    name TEXT PRIMARY KEY
);
CREATE TABLE mcp_enabled_servers (
    name TEXT PRIMARY KEY
);`

/**
 * Create `<projectDir>/.crush/crush.db` with the v0.99.0 schema in WAL mode,
 * one applied migration row, then checkpoint and close, so the file holds
 * every page and SQLite removes the -wal and -shm on the last close.
 *
 * @param {string} projectDir
 * @param {{ dropColumn?: [string, string] }} [opts]
 * @returns {Promise<string>} the crush.db path
 */
export async function createCrushDb(projectDir, opts = {}) {
  const dataDir = path.join(projectDir, '.crush')
  await fs.mkdir(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'crush.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(CRUSH_V0_99_0_SCHEMA)
  if (opts.dropColumn) {
    const [table, column] = opts.dropColumn
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
  }
  db.exec('INSERT INTO goose_db_version (version_id, is_applied) VALUES (20250424200609, 1)')
  db.close()
  return dbPath
}

/**
 * A writer connection, the way Crush holds one: WAL mode.
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
 * @param {{ id: string, parent_session_id?: string | null, title?: string, cost?: number, created_at?: number, updated_at?: number }} session
 */
export function insertSession(db, session) {
  const createdAt = session.created_at ?? 1793738790
  db.prepare(`INSERT INTO sessions (id, parent_session_id, title, cost, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    session.id,
    session.parent_session_id ?? null,
    session.title ?? '',
    session.cost ?? 0,
    createdAt,
    session.updated_at ?? createdAt,
  )
}

/**
 * @param {SqliteDatabase} db
 * @param {{ id: string, session_id: string, role: string, parts: unknown[], model?: string | null, provider?: string | null, created_at?: number, finished_at?: number | null, is_summary_message?: boolean }} message
 */
export function insertMessage(db, message) {
  const createdAt = message.created_at ?? 1793738791
  db.prepare(`INSERT INTO messages (id, session_id, role, parts, model, provider, created_at, updated_at, finished_at, is_summary_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    message.id,
    message.session_id,
    message.role,
    JSON.stringify(message.parts),
    message.model ?? '',
    message.provider ?? null,
    createdAt,
    createdAt,
    message.finished_at === undefined ? createdAt : message.finished_at,
    message.is_summary_message ? 1 : 0,
  )
}
