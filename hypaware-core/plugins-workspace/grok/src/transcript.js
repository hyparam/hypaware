// @ts-check

import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { boundary, fingerprint, fingerprintSettled, lines } from '../../droid/src/transcript.js'
import { isPlainObject, stringValue } from '../../../../src/core/util/index.js'
import { createGrokFolder, grokExchange } from './projector.js'

/** @import { GrokCursor, GrokSession } from '../../../../hypaware-core/plugins-workspace/grok/src/types.js' */

export const UPDATES_FILE = 'updates.jsonl'
export const MAX_FILE_BYTES = 256 * 1024 * 1024
// User chunks carry images inline and tool updates carry whole outputs.
export const MAX_LINE_BYTES = 16 * 1024 * 1024
export const MAX_LIVE_BYTES = 8 * 1024 * 1024
const MAX_SUMMARY_BYTES = 1024 * 1024
const MAX_BATCH_MESSAGES = 64
const MAX_BATCH_BYTES = 1024 * 1024
const MAX_DISCOVERY_ENTRIES = 100000
/** A file untouched this long will not settle anything that is still open. */
export const IDLE_FLUSH_MS = 5 * 60 * 1000

/** @param {NodeJS.ProcessEnv} env */
export function grokSessionsRoot(env) {
  return path.resolve(env.GROK_HOME || path.join(env.HOME || os.homedir(), '.grok'), 'sessions')
}

/** @param {string} file */
async function readBounded(file) {
  let fd
  try {
    fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const buffer = Buffer.alloc(MAX_SUMMARY_BYTES + 1)
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0)
    return bytesRead > MAX_SUMMARY_BYTES ? undefined : buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return undefined
  } finally { await fd?.close() }
}

/**
 * Identity comes from the directory, which Grok names after the session. The
 * summary is rewritten as the session runs, and is absent early on, so the
 * bucket name stands in for its cwd. Hashed long buckets record theirs in .cwd.
 *
 * @param {string} dir
 * @returns {Promise<GrokSession>}
 * @ref LLP 0585#format: summary.json may lag the update stream
 */
export async function readGrokSession(dir) {
  const id = path.basename(dir)
  const bucket = path.dirname(dir)
  /** @type {any} */
  let summary
  const raw = await readBounded(path.join(dir, 'summary.json'))
  if (raw !== undefined) {
    try { summary = JSON.parse(raw) } catch { summary = undefined }
  }
  const info = isPlainObject(summary?.info) ? summary.info : undefined
  if (info?.id !== undefined && String(info.id) !== id) throw new Error('unsupported_session')
  let cwd = stringValue(info?.cwd)
  if (!cwd) cwd = (await readBounded(path.join(bucket, '.cwd')))?.trim()
  if (!cwd) {
    try { cwd = decodeURIComponent(path.basename(bucket)) } catch { cwd = undefined }
  }
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('unsupported_session')
  /** @type {GrokSession} */
  const session = { id, cwd }
  const model = stringValue(summary?.current_model_id)
  if (model) session.model = model
  const parent = stringValue(summary?.parent_session_id)
  // Forks also name a parent, but they are peer conversations, not subthreads.
  if (parent && String(summary?.session_kind ?? '').startsWith('subagent')) session.parent_thread_id = parent
  return session
}

/**
 * Snapshot one session's update stream, yielding bounded projections and then
 * a cursor. The consumer must finish writing a projection before asking for
 * the next item, and commits the cursor only after all writes succeeded.
 *
 * @param {string} file
 * @param {{ root: string, cursor?: GrokCursor, maxBytes?: number, sessionId?: string,
 *   allowed: (session: GrokSession) => boolean, signal?: AbortSignal,
 *   window?: { sinceMs?: number, untilMs?: number } }} opts
 * @ref LLP 0585#bounds: offset reads held before the earliest open item
 */
export async function* readGrokTranscript(file, opts) {
  const realRoot = await fs.realpath(opts.root)
  const realFile = await fs.realpath(file)
  const parts = path.relative(realRoot, realFile).split(path.sep)
  if (parts.length !== 3 || parts[0].startsWith('.') || parts[2] !== UPDATES_FILE) throw new Error('transcript_outside_root')
  const session = await readGrokSession(path.dirname(realFile))
  if (opts.sessionId !== undefined && session.id !== opts.sessionId) throw new Error('unsupported_session')
  if (!opts.allowed(session)) {
    yield { dropped: true }
    return
  }
  const fd = await fs.open(realFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('file_budget')
    const inode = `${stat.dev}:${stat.ino}`
    const currentFingerprint = fingerprint(stat)
    let offset = 0
    let lineNumber = 0
    const cursor = opts.cursor
    if (cursor && cursor.inode === inode && cursor.offset <= stat.size &&
        (cursor.offset < stat.size || (cursor.fingerprint === currentFingerprint && fingerprintSettled(stat))) &&
        cursor.boundary === await boundary(fd, cursor.offset)) {
      offset = cursor.offset
      lineNumber = cursor.line
    }
    const end = Math.min(stat.size, offset + (opts.maxBytes ?? stat.size))
    const folder = createGrokFolder(session)
    let settledOffset = offset
    let settledLine = lineNumber
    let batch = []
    let batchBytes = 0
    const window = opts.window
    /** @param {any[]} closed */
    const add = closed => {
      /** @type {any[]} */
      const ready = []
      for (const item of closed) {
        if ((window?.sinceMs !== undefined && item.atMs < window.sinceMs) || (window?.untilMs !== undefined && item.atMs > window.untilMs)) continue
        if (batch.length && (batch.length >= MAX_BATCH_MESSAGES || batchBytes + item.bytes > MAX_BATCH_BYTES)) {
          ready.push(batch)
          batch = []
          batchBytes = 0
        }
        batch.push(item.message)
        batchBytes += item.bytes
      }
      return ready
    }
    let start = offset
    for await (const line of lines(fd, offset, end, MAX_LINE_BYTES)) {
      if (opts.signal?.aborted) return
      const at = { line: lineNumber, offset: start, bytes: line.bytes }
      lineNumber++
      start = line.end
      let closed = []
      if (line.text.trim()) {
        let entry
        // A crash can tear a line that a resumed session then appends after.
        // Skipping it keeps every later line number, and so every identity.
        try { entry = JSON.parse(line.text) } catch { entry = undefined }
        if (isPlainObject(entry)) closed = folder.push(entry, at)
      }
      for (const ready of add(closed)) {
        if (!opts.allowed(session)) {
          yield { dropped: true }
          return
        }
        const projection = grokExchange(session, ready)
        if (projection) yield { projection }
      }
      const open = folder.earliestOpen()
      settledOffset = open ? open.offset : line.end
      settledLine = open ? open.line : lineNumber
    }
    // @ref LLP 0585#folding: a quiet file has nothing left to settle what is open
    if (start === stat.size && Date.now() - stat.mtimeMs >= IDLE_FLUSH_MS) {
      for (const ready of add(folder.flush())) {
        if (!opts.allowed(session)) {
          yield { dropped: true }
          return
        }
        const projection = grokExchange(session, ready)
        if (projection) yield { projection }
      }
      settledOffset = start
      settledLine = lineNumber
    }
    if (!opts.allowed(session)) {
      yield { dropped: true }
      return
    }
    const projection = grokExchange(session, batch)
    if (projection) yield { projection }
    if (opts.signal?.aborted) return
    /** @type {GrokCursor} */
    const next = { offset: settledOffset, line: settledLine, inode, fingerprint: currentFingerprint, boundary: await boundary(fd, settledOffset) }
    yield { cursor: next }
  } finally { await fd.close() }
}

/** Two levels, bucket then session, with no symlink traversal. @param {string} root */
export async function* grokSessionFiles(root) {
  let count = 0
  /** @param {string} dir */
  async function* entries(dir) {
    let handle
    try { handle = await fs.opendir(dir) } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return
      throw error
    }
    for await (const entry of handle) {
      if (++count > MAX_DISCOVERY_ENTRIES) throw new Error('discovery_budget')
      // Dot directories are Grok's relocation staging.
      if (entry.isDirectory() && !entry.name.startsWith('.')) yield path.join(dir, entry.name)
    }
  }
  for await (const bucket of entries(root)) {
    for await (const session of entries(bucket)) yield path.join(session, UPDATES_FILE)
  }
}
