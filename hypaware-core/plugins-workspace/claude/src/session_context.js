// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'

import { atomicWriteFile, isPlainObject, stringValue } from 'hypaware/core/util'

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
 * @import { SessionContextRecord } from './types.js'
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
 * the reader picks newest-by-line (interleaving across lines just
 * means another writer will land its record on the next line).
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
    /* truncated / rotated: return what we have */
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
    // @ref LLP 0032#capture: repo identity for the graph bridge.
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
 * Two rules decide what survives.
 *
 * The cap is the module's, not the caller's: `opts.maxBytes` is clamped to
 * `SESSION_CONTEXT_MAX_BYTES`. The reader's window is a module constant and
 * `createSessionContextReader` has no seam to thread a per-call cap through,
 * so a caller compacting to a wider window would keep records no reader can
 * see, which is the silent eviction this file exists to avoid.
 *
 * Eviction is oldest-first, but a session's NEWEST record is evicted last.
 * Dropping purely by position takes out whichever sessions have been quiet,
 * however live they are: one neighbour firing the hook on every Bash call can
 * push a session that spent the turn reading files off the disk entirely. The
 * reader only ever asks for a session's latest record
 * (`pickLatestMatching`), so holding one record per session costs almost
 * nothing and is the difference between an attributed session and an
 * `undetermined` one whose spooled bodies are deleted unread.
 *
 * @ref LLP 0286#writer-cap-is-clamped [implements]: the caller's cap may not
 *   exceed the constant the reader's window is derived from
 * @ref LLP 0286#newest-per-session [implements]: a session's newest record is
 *   the last thing compaction gives up
 * @param {string} filePath
 * @param {{ maxBytes?: number, maxRecords?: number }} opts
 */
async function compactSessionContextIfNeeded(filePath, opts) {
  const maxBytes = Math.min(
    positiveInt(opts.maxBytes) ?? SESSION_CONTEXT_MAX_BYTES,
    SESSION_CONTEXT_MAX_BYTES
  )
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
  await atomicWriteFile(filePath, compactBody(records, { maxBytes, maxRecords }))
}

/**
 * Render the retained records, evicting until the body fits both bounds.
 *
 * Eviction order: older records of a session that has a newer one first
 * (oldest first), then the per-session newest records (oldest first), so a
 * session only loses its last record when every session's history is already
 * gone. The final record standing is never evicted, matching the byte loop
 * this replaces.
 *
 * @param {SessionContextRecord[]} records append-ordered, any session
 * @param {{ maxBytes: number, maxRecords: number }} bounds
 * @returns {string}
 */
function compactBody(records, { maxBytes, maxRecords }) {
  const lines = records.map((record) => JSON.stringify(record))
  const sizes = lines.map((line) => Buffer.byteLength(line, 'utf8') + 1)
  /** @type {Map<string, number>} */
  const newestBySession = new Map()
  records.forEach((record, index) => newestBySession.set(record.session_id, index))
  const newest = new Set(newestBySession.values())

  const dropped = new Array(records.length).fill(false)
  let kept = records.length
  let bytes = sizes.reduce((sum, size) => sum + size, 0)
  const order = [
    ...records.map((_, index) => index).filter((index) => !newest.has(index)),
    ...[...newest].sort((a, b) => a - b),
  ]
  for (const index of order) {
    if (kept <= maxRecords && bytes <= maxBytes) break
    if (kept <= 1) break
    dropped[index] = true
    kept -= 1
    bytes -= sizes[index]
  }

  const body = lines.filter((_, index) => !dropped[index]).join('\n')
  return body.length > 0 ? body + '\n' : body
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
 * Create a cached reader for the session-context channel. Re-reads the
 * JSONL file only when its size or mtime moved (the live projector
 * calls it on every captured exchange); degrades to `[]` after
 * reporting via `onError`, so a missing or unreadable channel never
 * aborts capture or backfill: the join is best-effort and `cwd` /
 * `git_branch` are nullable columns.
 *
 * @param {string} stateFile
 * @param {(err: unknown) => void} [onError]
 * @returns {() => Promise<SessionContextRecord[]>}
 */
export function createSessionContextReader(stateFile, onError) {
  /** @type {number | undefined} */
  let size
  /** @type {number | undefined} */
  let mtimeMs
  /** @type {SessionContextRecord[]} */
  let records = []
  return async function readCached() {
    try {
      const stat = await statIfExists(stateFile)
      if (!stat) {
        size = 0
        mtimeMs = 0
        records = []
        return records
      }
      if (size === stat.size && mtimeMs === stat.mtimeMs) return records
      records = await readSessionContext(stateFile)
      size = stat.size
      mtimeMs = stat.mtimeMs
      return records
    } catch (err) {
      onError?.(err)
      return []
    }
  }
}

/** @param {string} filePath */
async function statIfExists(filePath) {
  try {
    return await fsp.stat(filePath)
  } catch (err) {
    if (/** @type {{ code?: string }} */ (err)?.code === 'ENOENT') return undefined
    throw err
  }
}
