// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

const TITLE_DATABASE_BUDGET = 256 * 1024 * 1024

/**
 * The index is small metadata, never a second transcript scan. Bound both
 * bytes and retained threads, including a concurrent append to the file.
 * @ref LLP 0556#capture [implements]: native Codex names are keyed by thread
 * @param {string} file
 * @returns {Promise<Map<string, { title: string, updatedAt: string }>>}
 */
export async function readCodexSessionTitles(file) {
  const titles = new Map()
  let handle
  try {
    handle = await fs.open(file, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('title_index_budget')
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > stat.size) throw new Error('title_index_changed')
    const text = buffer.toString('utf8', 0, length)
    for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
      if (!line || line.length > 8192) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      if (typeof row?.id !== 'string' || row.id.length > 128 || typeof row.thread_name !== 'string'
          || !row.thread_name.trim() || Buffer.byteLength(row.thread_name) > 4096
          || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) continue
      const updatedAt = new Date(row.updated_at).toISOString()
      if (!titles.has(row.id) && titles.size >= 16384) throw new Error('title_index_budget')
      if (!titles.has(row.id) || updatedAt >= titles.get(row.id).updatedAt) {
        titles.set(row.id, { title: row.thread_name, updatedAt })
      }
    }
    return titles
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return titles
    throw err
  } finally { await handle?.close() }
}

/**
 * Desktop stores some generated names only in the native thread database.
 * Read `name`, never `title` (which can be a first-prompt preview). The
 * budget covers the main file plus its WAL and the snapshot the SELECT reads.
 * @param {string} codexHome
 * @param {number} [budget] bytes; tests lower it
 * @returns {Promise<Map<string, { title: string, updatedAt: string }>>}
 */
export async function readCodexTitleDatabase(codexHome, budget = TITLE_DATABASE_BUDGET) {
  const titles = new Map()
  let directory
  try { directory = await fs.opendir(codexHome) } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return titles
    throw err
  }
  let candidate = ''
  let version = -1
  let entries = 0
  for await (const entry of directory) {
    if (++entries > 4096) throw new Error('title_database_discovery_budget')
    const match = /^state_(\d+)\.sqlite$/.exec(entry.name)
    if (entry.isFile() && match && Number(match[1]) > version) {
      candidate = path.join(codexHome, entry.name)
      version = Number(match[1])
    }
  }
  if (!candidate) return titles
  // Opening replays the WAL, so its bytes count against the budget too.
  const wal = await fs.stat(`${candidate}-wal`).then(stat => stat.size, err => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return 0
    throw err
  })
  if ((await fs.stat(candidate)).size + wal > budget) throw new Error('title_database_budget')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(candidate, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 100')
    // A read-only open still sees committed WAL frames, so the file size
    // does not bound what the SELECT inspects. Bound the logical snapshot
    // inside the same read transaction the SELECT runs in.
    db.exec('BEGIN')
    const pages = db.prepare('PRAGMA page_count').get()?.page_count
    const size = db.prepare('PRAGMA page_size').get()?.page_size
    if (typeof pages !== 'number' || typeof size !== 'number' || pages * size > budget) {
      throw new Error('title_database_budget')
    }
    const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(row => row.name))
    if (!columns.has('id') || !columns.has('name') || !columns.has('updated_at')) throw new Error('title_database_schema')
    const time = columns.has('updated_at_ms') ? 'COALESCE(updated_at_ms, updated_at * 1000)' : 'updated_at * 1000'
    const rows = db.prepare(`SELECT substr(id, 1, 129) AS id, substr(name, 1, 4097) AS name, ${time} AS updated
      FROM threads WHERE name IS NOT NULL AND name != '' ORDER BY updated_at DESC LIMIT 16385`).all()
    if (rows.length > 16384) throw new Error('title_database_budget')
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id.length > 128 || typeof row.name !== 'string'
          || !row.name.trim() || Buffer.byteLength(row.name) > 4096
          || typeof row.updated !== 'number' || !Number.isFinite(row.updated) || Math.abs(row.updated) > 8640000000000000) continue
      titles.set(row.id, { title: row.name, updatedAt: new Date(row.updated).toISOString() })
    }
    return titles
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
    db.close()
  }
}
