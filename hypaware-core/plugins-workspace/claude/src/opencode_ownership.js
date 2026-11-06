// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'
import { isPlainObject } from 'hypaware/core/util'

const PLUGIN_PREFIX = `plugin:${[...'opencode.provider.claude-agent'].map(c => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}:sessions/`
const MAX_SESSIONS = 65536

/** @param {unknown} name */
function isOpenCodeTool(name) {
  return typeof name === 'string' && name.startsWith('mcp__opencode__')
}

/**
 * OpenCode persists its native-session -> Claude UUID mapping in its own KV
 * namespace. Read it once per import, even when OpenCode is not configured in
 * HypAware: its privacy switch cannot authorize a second Claude capture lane.
 * No messages or checkpoint histories leave SQLite. The primary-key range
 * visits only this provider's records, with bounded values and retained IDs.
 * @ref LLP 0588#ownership [implements]: native UUID ownership covers text-only sessions on older Claude binaries
 * @param {string} homeDir
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<Set<string>>}
 */
export async function readOpenCodeClaudeSessions(homeDir, env) {
  const ids = new Set()
  const dataDir = path.join(env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share'), 'opencode')
  let files
  if (env.OPENCODE_DB) {
    if (env.OPENCODE_DB === ':memory:') return ids
    files = [path.resolve(dataDir, env.OPENCODE_DB)]
  } else {
    let directory
    try { directory = await fs.opendir(dataDir) } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return ids
      throw error
    }
    files = []
    let entries = 0
    for await (const entry of directory) {
      if (++entries > 4096) throw new Error('opencode_ownership_discovery_budget')
      if (!entry.isFile() || !/^opencode(?:-[a-zA-Z0-9._-]+)?\.db$/.test(entry.name)) continue
      if (files.length >= 32) throw new Error('opencode_ownership_database_budget')
      files.push(path.join(dataDir, entry.name))
    }
  }
  let count = 0
  let bytes = 0
  for (const file of files) {
    try { await fs.access(file) } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue
      throw error
    }
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 100')
      // OpenCode 1 has no Claude Agent provider and no KV table.
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()) continue
      const rows = db.prepare(`SELECT length(CAST(value AS BLOB)) AS bytes,
        CASE WHEN length(CAST(value AS BLOB)) <= 1048576 THEN json_extract(value, '$.claudeSessionID') END AS id
        FROM kv WHERE key >= ? AND key < ?`)
      for (const row of rows.iterate(PLUGIN_PREFIX, `${PLUGIN_PREFIX}\uffff`)) {
        bytes += Number(row.bytes)
        if (++count > MAX_SESSIONS || Number(row.bytes) > 1048576 || bytes > 16 * 1024 * 1024) throw new Error('opencode_ownership_record_budget')
        if (typeof row.id !== 'string' || !row.id || row.id.length > 128) throw new Error('opencode_ownership_invalid_id')
        if (ids.size >= MAX_SESSIONS) throw new Error('opencode_ownership_session_budget')
        ids.add(row.id)
      }
    } finally { db.close() }
  }
  return ids
}

/**
 * Structured provenance only, never a search through prompt or reply text.
 * Current Claude persists declarations even for text-only turns; older
 * binaries retain calls and attribution. Forks copy that same evidence.
 * @ref LLP 0588#ownership [implements]: tool provenance survives UUID changes and is independent of entrypoint
 * @param {unknown} row
 * @returns {string | undefined}
 */
export function openCodeTranscriptSession(row) {
  if (!isPlainObject(row) || typeof row.sessionId !== 'string') return undefined
  const message = isPlainObject(row.message) ? row.message : undefined
  const shape = row.type === 'api-request-shape' && isPlainObject(row.shape) ? row.shape : undefined
  const tools = shape?.tools
  const content = message?.content
  if (row.attributionMcpServer === 'opencode'
      || (Array.isArray(tools) && tools.some(tool => isPlainObject(tool) && isOpenCodeTool(tool.name)))
      || (message?.role === 'assistant' && Array.isArray(content) && content.some(block => isPlainObject(block) && block.type === 'tool_use' && isOpenCodeTool(block.name)))) {
    return row.sessionId
  }
  return undefined
}
