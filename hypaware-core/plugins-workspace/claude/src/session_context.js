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
 * The cap is the module's, not the caller's: `opts.maxBytes` is clamped to the
 * SMALLER of `SESSION_CONTEXT_MAX_BYTES` and `SESSION_CONTEXT_READ_TAIL_BYTES`.
 * Every reader calls `readSessionContext` with no opts
 * (`createSessionContextReader`, settlement, backfill), so the tail constant is
 * the real limit on what any reader can see; retaining past it keeps records on
 * disk that no reader will ever read, which is the silent eviction this file
 * exists to avoid, reached through the other door. Widening the retained window
 * means widening the read window first.
 *
 * Eviction gives up a session's history before its presence; `compactBody` has
 * the two tiers and the order within each.
 *
 * @ref LLP 0286#writer-cap-is-clamped [implements]: the retained window may not
 *   exceed the window readers are able to read
 * @param {string} filePath
 * @param {{ maxBytes?: number, maxRecords?: number }} opts
 */
async function compactSessionContextIfNeeded(filePath, opts) {
  const maxBytes = Math.min(
    positiveInt(opts.maxBytes) ?? SESSION_CONTEXT_MAX_BYTES,
    SESSION_CONTEXT_MAX_BYTES,
    SESSION_CONTEXT_READ_TAIL_BYTES
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
 * Eviction runs in two tiers. Tier one is a session's INTERIOR records (the
 * ones with both an older and a newer record of their own session), oldest
 * record first across all sessions. Tier two is its ENDPOINTS (its earliest and
 * its newest record, which are the same record for a single-record session). So
 * a session gives up its middle before either endpoint, and gives up an endpoint
 * only once every session's middle is already gone.
 *
 * Tier two is ordered by how stale the SESSION is (the position of its newest
 * record), not by where the endpoint itself sits. Ordering endpoints by their
 * own position reads the front of the file as "oldest", but the front of the
 * file is exactly where a long-running session's session-start record lives: the
 * first endpoint evicted would be the session-start record of the session that
 * has been alive longest, while every record of a session that ended hours ago
 * survived. That is the eviction this rule exists to prevent, so a whole stale
 * session goes before a live one gives up either end.
 *
 * Why both ends: ingest asks only for a session's latest record
 * (`pickLatestMatching`), so the newest is what presence costs; settlement
 * resolves an OPENING row against the record live at that row's own time
 * (LLP 0085), which for an opening row is the session-start record, so the
 * earliest is what a correct drop costs. The alternative is an `undetermined`
 * session whose spooled bodies are deleted unread, or an opening row in an
 * ignored dir resolved against a later clean cwd and retained: a leak, which is
 * the direction that cannot be taken back.
 *
 * The final record standing is never evicted, matching the byte loop this
 * replaces: the file's last record is always its own session's newest, and that
 * session is by construction the freshest, so it sorts last in tier two.
 *
 * Earliest is by append order rather than by `ts`, because append order is the
 * order the hook observed and a record's `ts` is optional.
 *
 * @ref LLP 0286#endpoints-evicted-last [implements]: a session's session-start and
 *   latest records are the last things compaction gives up, and the session that
 *   went quiet longest ago gives them up first
 * @param {SessionContextRecord[]} records append-ordered, any session
 * @param {{ maxBytes: number, maxRecords: number }} bounds
 * @returns {string}
 */
function compactBody(records, { maxBytes, maxRecords }) {
  const lines = records.map((record) => JSON.stringify(record))
  const sizes = lines.map((line) => Buffer.byteLength(line, 'utf8') + 1)
  /** @type {Map<string, number>} */
  const newestBySession = new Map()
  /** @type {Map<string, number>} */
  const earliestBySession = new Map()
  records.forEach((record, index) => {
    newestBySession.set(record.session_id, index)
    if (!earliestBySession.has(record.session_id)) earliestBySession.set(record.session_id, index)
  })
  const endpoints = new Set([...newestBySession.values(), ...earliestBySession.values()])

  const dropped = new Array(records.length).fill(false)
  let kept = records.length
  let bytes = sizes.reduce((sum, size) => sum + size, 0)
  const indexes = records.map((_, index) => index)
  /** @param {number} index */
  const lastSeen = (index) => newestBySession.get(records[index].session_id) ?? index
  const order = [
    ...indexes.filter((index) => !endpoints.has(index)),
    ...indexes
      .filter((index) => endpoints.has(index))
      .sort((a, b) => lastSeen(a) - lastSeen(b) || a - b),
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
 * Read the last `maxBytes` of the channel, with the partial record the cut
 * leaves at the front discarded.
 *
 * The read starts one byte before the tail offset, so the newline ending the
 * previous record always leads the buffer. Without that byte a boundary that
 * happens to land on a record edge is indistinguishable from a mid-record cut,
 * and the discard eats a whole intact record: silently, because this reader is
 * best-effort, so the projector simply loses that session's `cwd` /
 * `git_branch`. The `start === 0` return is the other half: a file shorter
 * than the window is read from byte 0 and has no fragment in front of it.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 */
async function readTail(filePath, maxBytes) {
  let handle
  try {
    handle = await fsp.open(filePath, 'r')
    const stat = await handle.stat()
    const offset = Math.max(0, stat.size - maxBytes)
    const start = offset > 0 ? offset - 1 : 0
    const length = stat.size - start
    if (length <= 0) return ''
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    if (start === 0) return text
    const newline = text.indexOf('\n')
    return newline === -1 ? '' : text.slice(newline + 1)
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
