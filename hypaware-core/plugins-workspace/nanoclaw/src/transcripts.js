// @ts-check
import fs from 'node:fs/promises'
import { constants, statSync } from 'node:fs'
import path from 'node:path'
import { compareStrings } from 'hypaware/core/util'
import { transcriptEntryFromRow } from '../../claude/src/transcripts.js'
import { projectedExchangeFromEntries } from '../../claude/src/backfill.js'

/** @import { DatabaseSync } from 'node:sqlite' */
/** @import { Stats } from 'node:fs' */
/** @import { TranscriptEntry } from '../../../../hypaware-core/plugins-workspace/claude/src/types.js' */
/** @import { NanoclawFile, NanoclawGroup } from '../../../../hypaware-core/plugins-workspace/nanoclaw/src/types.js' */

export const MAX_FILE_BYTES = 16 * 1024 * 1024
export const MAX_SCAN_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 20000
const MAX_DISCOVERY = 10000

/** @param {string} file */
export function present(file) {
  try { statSync(file); return true } catch (error) {
    return !['ENOENT', 'ENOTDIR'].includes(String(/** @type {NodeJS.ErrnoException} */ (error).code))
  }
}

/** @param {Stats} stat */
export function fingerprint(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` }

/** Reject escaping paths and symlinks instead of importing a different installation. @param {string} root @param {string} file */
export async function containedPath(root, file) {
  const candidate = path.resolve(file)
  if (!candidate.startsWith(root + path.sep) || await fs.realpath(candidate) !== candidate) throw new Error('unsafe_path')
  return candidate
}

/**
 * Only read the local v2 group catalog. It supplies the host workspace for
 * privacy checks; a missing/remote/unknown catalog is not an empty history.
 * @param {string} root
 * @returns {Promise<NanoclawGroup[]>}
 * @ref LLP 0553#privacy: resolve workspace ownership from the host catalog
 */
export async function readGroups(root) {
  const file = await containedPath(root, path.join(root, 'data', 'v2.db'))
  const stat = await fs.stat(file)
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('catalog_budget')
  /** @type {DatabaseSync | undefined} */
  let db
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(file, { readOnly: true })
    db.exec('PRAGMA query_only = ON')
    const rows = db.prepare('SELECT substr(id, 1, 257) AS id, substr(folder, 1, 257) AS folder FROM agent_groups LIMIT 1025').all()
    if (rows.length > 1024) throw new Error('group_budget')
    const groups = []
    for (const row of rows) {
      if (typeof row.id !== 'string' || typeof row.folder !== 'string') throw new Error('unsupported_group')
      const id = String(row.id)
      const folder = String(row.folder)
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(folder)) throw new Error('unsupported_group')
      const cwd = await containedPath(root, path.join(root, 'groups', folder))
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error('workspace_unavailable')
      groups.push({ id, cwd, projects: path.join(root, 'data', 'v2-sessions', id, '.claude-shared', 'projects') })
    }
    return groups
  } finally { db?.close() }
}

/**
 * Validate at most eight caller-supplied installation candidates. Catalog and
 * directory metadata only; never enumerate or read conversation files.
 * @param {string[]} candidates
 * @ref LLP 0554#nanoclaw-discovery: discovery reports roots without enabling capture
 */
export async function discoverNanoclawRoots(candidates) {
  const roots = []
  const seen = new Set()
  for (const candidate of candidates.slice(0, 8)) {
    try {
      const root = await fs.realpath(candidate)
      if (seen.has(root)) continue
      seen.add(root)
      const groups = await readGroups(root)
      for (const group of groups) {
        try {
          await containedPath(root, group.projects)
          if (!(await fs.stat(group.projects)).isDirectory()) continue
          roots.push(root)
          break
        } catch { /* Another group may have initialized Claude. */ }
      }
    } catch { /* Missing, malformed, or unsafe roots are not suggestions. */ }
  }
  return roots
}

/**
 * Four levels cover project/session/subagents without an unbounded recursive
 * walk. Only native JSONL and NanoClaw's native rotated JSONL are eligible.
 * @param {string} root @param {NanoclawGroup[]} groups
 * @returns {Promise<NanoclawFile[]>}
 */
export async function discoverFiles(root, groups) {
  const files = []
  let count = 0
  for (const group of groups) {
    const dirs = [{ dir: group.projects, depth: 0 }]
    for (const { dir, depth } of dirs) {
      let handle
      try {
        await containedPath(root, dir)
        handle = await fs.opendir(dir)
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue
        throw error
      }
      for await (const entry of handle) {
        if (++count > MAX_DISCOVERY) throw new Error('discovery_budget')
        const file = path.join(dir, entry.name)
        if (entry.isDirectory() && depth < 3) dirs.push({ dir: file, depth: depth + 1 })
        else if (entry.isFile() && /\.jsonl(?:\.rotated-\d+)?$/.test(entry.name)) files.push({ file, group })
      }
    }
  }
  return files.sort((a, b) => compareStrings(a.file, b.file))
}

/**
 * Bounded snapshot, one file at a time. Preserve native message IDs and the
 * finalized usage. A partial final line is retried on the next scan.
 * @param {string} root @param {NanoclawFile} source @param {AbortSignal} [signal] @param {string} [expectedFingerprint]
 * @ref LLP 0553#bounds: finite file, line and entry budgets before projection
 */
export async function readTranscript(root, source, signal, expectedFingerprint) {
  const file = await containedPath(root, source.file)
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('file_budget')
    if (expectedFingerprint !== undefined && fingerprint(stat) !== expectedFingerprint) throw new Error('file_changed')
    const buffer = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < buffer.length) {
      if (signal?.aborted) throw new Error('aborted')
      const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) throw new Error('file_changed')
      offset += bytesRead
    }
    /** @type {Map<string, TranscriptEntry[]>} */
    const sessions = new Map()
    /** @type {Map<string, { id: string, start: number }>} */
    const pending = new Map()
    let count = 0
    let blocks = 0
    let start = 0
    while (start < buffer.length) {
      const end = buffer.indexOf(10, start)
      if ((end < 0 ? buffer.length : end) - start > 4 * 1024 * 1024) throw new Error('line_budget')
      if (end < 0) break
      if (++count > MAX_ENTRIES) throw new Error('entry_budget')
      const text = buffer.toString('utf8', start, end).trim()
      start = end + 1
      if (!text) continue
      const row = JSON.parse(text)
      // Bound row expansion as well as source lines: one JSONL record can
      // contain thousands of blocks, each of which materializes a cache row.
      const blockCount = Array.isArray(row?.message?.content) ? row.message.content.length : 1
      if (blockCount > MAX_ENTRIES) throw new Error('entry_budget')
      // Legacy records without finalized response metadata still need a
      // subsequent boundary. Never import cost-state's cumulative usage.
      if (row?.type === 'cost-state' && typeof row.sessionId === 'string') pending.delete(row.sessionId)
      const entry = transcriptEntryFromRow(row)
      if (!entry?.role) continue
      blocks += blockCount
      if (blocks > MAX_ENTRIES) throw new Error('entry_budget')
      if (!entry.provider_uuid || entry.timestampMs === undefined || !['user', 'assistant'].includes(entry.role)) throw new Error('unsupported_record')
      let entries = sessions.get(entry.sessionId)
      if (!entries) sessions.set(entry.sessionId, entries = [])
      // @ref LLP 0553#usage-carrier: finalized blocks can be captured without a turn marker, including subagent/crash tails
      if (entry.role === 'assistant' && entry.messageId && !(typeof row.message?.stop_reason === 'string' && row.message.stop_reason)) {
        if (pending.get(entry.sessionId)?.id !== entry.messageId) pending.set(entry.sessionId, { id: entry.messageId, start: entries.length })
      } else pending.delete(entry.sessionId)
      entries.push(entry)
    }
    if (fingerprint(await fd.stat()) !== fingerprint(stat)) throw new Error('file_changed')
    for (const [id, tail] of pending) sessions.get(id)?.splice(tail.start)
    return { sessions, fingerprint: fingerprint(stat), complete: pending.size === 0 && start === buffer.length }
  } finally { await fd.close() }
}

/**
 * @param {string} sessionId @param {TranscriptEntry[]} entries @param {NanoclawGroup} group
 * @param {{ sinceMs?: number, untilMs?: number }} window
 */
export async function projectTranscript(sessionId, entries, group, window) {
  const exchange = await projectedExchangeFromEntries({ sessionId, entries, clientName: 'nanoclaw', agentMeta: new Map(),
    record: { session_id: sessionId, cwd: group.cwd, transcript_path: undefined, git_branch: undefined, ts: undefined },
    deriveRepo: async () => ({}), usageCarrier: 'first',
  })
  if (!exchange) return undefined
  // Container cwd never names a host repo. Keep the proven group workspace
  // for policy, and do not fabricate host git identity or tool-path mappings.
  exchange.attributes = { nanoclaw: { agent_group_id: group.id } }
  const previous = new Map()
  const positions = new Map()
  for (const message of exchange.messages) {
    const thread = message.agent_id ?? ''
    const position = positions.get(thread) ?? 0
    message.message_index = position
    positions.set(thread, position + 1)
    message.previous_message_id = previous.has(thread) ? [previous.get(thread)] : []
    previous.set(thread, message.message_id)
  }
  exchange.messages = exchange.messages.filter(message => {
    const at = Date.parse(message.message_created_at ?? '')
    return !(window.sinceMs !== undefined && at < window.sinceMs) && !(window.untilMs !== undefined && at > window.untilMs)
  })
  return exchange.messages.length ? exchange : undefined
}
