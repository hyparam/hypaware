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
 * `opts.maxBytes` is the writer's compaction cap, and it may only narrow the
 * module default: see `clampToReadableWindow`.
 *
 * @param {string} filePath
 * @param {SessionContextRecord} record
 * @param {{ maxBytes?: number, maxRecords?: number }} [opts] `maxBytes` is
 *   clamped to the reader's window (the smaller of `SESSION_CONTEXT_MAX_BYTES`
 *   and `SESSION_CONTEXT_READ_TAIL_BYTES`); a larger value has no effect.
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
 * @param {string} filePath
 * @param {{ maxBytes?: number, maxRecords?: number }} opts
 */
async function compactSessionContextIfNeeded(filePath, opts) {
  const maxBytes = clampToReadableWindow(positiveInt(opts.maxBytes) ?? SESSION_CONTEXT_MAX_BYTES)
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

  await atomicWriteFile(filePath, body)
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

/**
 * The writer may never keep more of the file than a reader will look at.
 *
 * `appendSessionContext` takes a per-call compaction cap, and so does
 * `readSessionContext`, but the reader every production path actually goes
 * through has no matching seam: `createSessionContextReader` (the live
 * projector, the backfill, and the telemetry listener) tail-reads at
 * `SESSION_CONTEXT_READ_TAIL_BYTES` and takes no options. So a file kept above
 * that tail carries records no reader ever sees, which is indistinguishable
 * from the hook never having recorded them.
 *
 * That is not a nullable column on the ingest path: an unseen record resolves
 * to an `undetermined` usage policy, the listener withholds the batch, and the
 * session's spooled bodies are deleted unread. Clamping keeps the invariant
 * structural rather than a JSDoc promise. Narrowing stays allowed: a smaller
 * cap only ever keeps less than the reader can see.
 *
 * The binding cap is the smaller of the two module constants, not
 * `SESSION_CONTEXT_MAX_BYTES` alone. Today the read tail is half the writer
 * cap, so bytes between the two are retained-but-invisible and dropping them
 * costs no reader anything; if the read window is later widened to follow the
 * writer cap, this `Math.min` reverts to the writer cap on its own.
 *
 * Note the narrowing is one-way on upgrade. No production caller passes
 * `maxBytes`, so the effective cap drops from `SESSION_CONTEXT_MAX_BYTES` to
 * the read tail, and the first hook append on an install whose file already
 * sits between the two rewrites it down permanently. Nothing reachable is
 * lost, because no reader could see those bytes before either, but the
 * invariant is closed by dropping the unreadable bytes rather than by
 * widening the window that would have made them readable.
 *
 * @ref LLP 0254#policy-inline [constrained-by]: the hook's cwd is what the
 *   ingest verdict is resolved from, so the writer may not retain a record
 *   outside the window the reader reads
 *
 * @param {number} maxBytes
 */
function clampToReadableWindow(maxBytes) {
  return Math.min(maxBytes, SESSION_CONTEXT_MAX_BYTES, SESSION_CONTEXT_READ_TAIL_BYTES)
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
