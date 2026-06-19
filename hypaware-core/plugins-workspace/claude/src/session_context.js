// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'

export const SESSION_CONTEXT_MAX_BYTES = 1024 * 1024
export const SESSION_CONTEXT_MAX_RECORDS = 4096
export const SESSION_CONTEXT_READ_TAIL_BYTES = 512 * 1024

/**
 * Session-context channel. Phase 2 swapped the HTTP endpoint
 * (`/_hypaware/session-context`) for a file-on-disk: the Claude
 * hook (installed by `@hypaware/claude` into `~/.claude/settings.json`)
 * appends JSONL lines into `<stateDir>/session-context.jsonl` and the
 * exchange projector reads the same file at projection time to
 * recover `cwd` / `git_branch` for the captured request.
 *
 * Lines are append-only and one JSON object per line; the projector
 * picks the most-recent matching entry. Match keys (in order of
 * preference): `transcript_path`, `session_id`.
 */

/**
 * @import { SessionContextRecord } from './types.d.ts'
 */

/**
 * @param {string} stateDir
 */
export function defaultSessionContextFile(stateDir) {
  return path.join(stateDir, 'session-context.jsonl')
}

/**
 * Append one record to the state file, creating parent directories as
 * needed. Atomic line write (single `appendFile`); concurrent hook
 * invocations interleave at line granularity, which is fine because
 * the reader picks newest-by-line — interleaving across lines just
 * means another writer will land its record on the next line.
 *
 * @param {string} filePath
 * @param {SessionContextRecord} record
 * @param {{ maxBytes?: number, maxRecords?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function appendSessionContext(filePath, record, opts = {}) {
  if (!record || typeof record.session_id !== 'string' || record.session_id.length === 0) {
    throw new Error('appendSessionContext: session_id is required')
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const payload = JSON.stringify(record) + '\n'
  await fsp.appendFile(filePath, payload, 'utf8')
  await compactSessionContextIfNeeded(filePath, opts)
}

/**
 * Read recent records from the state file. Returns `[]` on missing
 * file. Malformed lines are skipped (best-effort). Large files are
 * read from the tail so projection latency stays bounded even when a
 * long-lived Claude install has accumulated older hook events.
 *
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<SessionContextRecord[]>}
 */
export async function readSessionContext(filePath, opts = {}) {
  /** @type {SessionContextRecord[]} */
  const out = []
  const raw = await readTail(filePath, positiveInt(opts.maxBytes) ?? SESSION_CONTEXT_READ_TAIL_BYTES)
  if (!raw) return out
  const lines = raw.split('\n')
  try {
    for (const line of lines) {
      if (!line) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }
      const record = recordFrom(parsed)
      if (record) out.push(record)
    }
  } catch {
    /* truncated / rotated — return what we have */
  }
  return out
}

/**
 * Pick the most-recent record that matches one of the candidate
 * keys. Preference order: `transcript_path` (the strongest hint Claude
 * sends, when present), then `session_id`. Returns `undefined` when
 * no record matches.
 *
 * @param {SessionContextRecord[]} records
 * @param {{ sessionId?: string, transcriptPath?: string }} key
 * @returns {SessionContextRecord | undefined}
 */
export function pickLatestMatching(records, key) {
  if (records.length === 0) return undefined
  // Walk newest-first; the file is append-only so later lines win.
  if (key.transcriptPath) {
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]
      if (r.transcript_path && r.transcript_path === key.transcriptPath) return r
    }
  }
  if (key.sessionId) {
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]
      if (r.session_id === key.sessionId) return r
    }
  }
  return undefined
}

/** @param {unknown} value */
function recordFrom(value) {
  if (!isPlainObject(value)) return undefined
  const session_id = stringValue(value.session_id)
  if (!session_id) return undefined
  /** @type {SessionContextRecord} */
  const record = {
    session_id,
    transcript_path: stringValue(value.transcript_path),
    cwd: stringValue(value.cwd),
    git_branch: stringValue(value.git_branch),
    // @ref LLP 0032#capture — repo identity for the graph bridge.
    git_remote: stringValue(value.git_remote),
    head_sha: stringValue(value.head_sha),
    repo_root: stringValue(value.repo_root),
    ts: stringValue(value.ts),
  }
  return record
}

/**
 * Keep the append-only session context file bounded. Compaction is
 * best-effort because the hook must never interrupt Claude Code; the
 * projector also tail-reads, so a missed compaction does not put
 * projection back on an unbounded path.
 *
 * @param {string} filePath
 * @param {{ maxBytes?: number, maxRecords?: number }} opts
 */
async function compactSessionContextIfNeeded(filePath, opts) {
  const maxBytes = positiveInt(opts.maxBytes) ?? SESSION_CONTEXT_MAX_BYTES
  const maxRecords = positiveInt(opts.maxRecords) ?? SESSION_CONTEXT_MAX_RECORDS
  let stat
  try {
    stat = await fsp.stat(filePath)
  } catch {
    return
  }
  if (stat.size <= maxBytes) return

  const records = await readSessionContext(filePath, {
    maxBytes: Math.max(maxBytes * 2, SESSION_CONTEXT_READ_TAIL_BYTES),
  })
  const keep = records.slice(-maxRecords)
  let body = keep.map((record) => JSON.stringify(record)).join('\n')
  if (body.length > 0) body += '\n'
  while (Buffer.byteLength(body, 'utf8') > maxBytes && keep.length > 1) {
    keep.shift()
    body = keep.map((record) => JSON.stringify(record)).join('\n')
    if (body.length > 0) body += '\n'
  }

  const tmpPath = `${filePath}.${process.pid}.compact.tmp`
  await fsp.writeFile(tmpPath, body, 'utf8')
  await fsp.rename(tmpPath, filePath)
}

/**
 * @param {string} filePath
 * @param {number} maxBytes
 */
async function readTail(filePath, maxBytes) {
  let handle
  try {
    handle = await fsp.open(filePath, 'r')
    const stat = await handle.stat()
    const length = Math.min(stat.size, maxBytes)
    const start = Math.max(0, stat.size - length)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      text = newline === -1 ? '' : text.slice(newline + 1)
    }
    return text
  } catch {
    return ''
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** @param {unknown} value */
function positiveInt(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
