// @ts-check

import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { droidSessionHeader, projectDroidEntries } from './projector.js'

/** @import { DroidCursor } from '../../../../hypaware-core/plugins-workspace/droid/src/types.js' */
/** @import { FileHandle } from 'node:fs/promises' */
/** @import { Stats } from 'node:fs' */

export const MAX_FILE_BYTES = 64 * 1024 * 1024
export const MAX_LINE_BYTES = 1024 * 1024
export const MAX_LIVE_BYTES = 8 * 1024 * 1024

/** @param {NodeJS.ProcessEnv} env */
export function droidSessionsRoot(env) {
  return path.resolve(env.FACTORY_HOME_OVERRIDE || env.HOME || os.homedir(), '.factory', 'sessions')
}

/** @param {Stats} stat */
export function fingerprint(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` }

/**
 * Snapshot one transcript, yielding bounded batches and a success-only cursor.
 * The consumer must finish writing a batch before requesting the next item.
 * @param {string} file
 * @param {{ root: string, cursor?: DroidCursor, maxBytes?: number, sessionId?: string,
 *   allowed: (session: Record<string, any>) => boolean, signal?: AbortSignal,
 *   window?: { sinceMs?: number, untilMs?: number } }} opts
 * @ref LLP 0551#bounds: bounded offset reads; rewrites invalidate the live cursor
 */
export async function* readDroidTranscript(file, opts) {
  const realRoot = await fs.realpath(opts.root)
  const realFile = await fs.realpath(file)
  if (!realFile.startsWith(realRoot + path.sep) || !realFile.endsWith('.jsonl')) throw new Error('transcript_outside_root')
  const fd = await fs.open(realFile, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('file_budget')
    const head = Buffer.alloc(Math.min(stat.size, 16 * 1024))
    const headRead = await fd.read(head, 0, head.length, 0)
    const newline = head.subarray(0, headRead.bytesRead).indexOf(10)
    if (newline < 0) throw new Error('incomplete_header')
    const header = head.subarray(0, newline).toString('utf8')
    const session = droidSessionHeader(JSON.parse(header))
    if (!session || (opts.sessionId !== undefined && session.id !== opts.sessionId)) throw new Error('unsupported_session')
    if (!opts.allowed(session)) {
      yield { dropped: true }
      return
    }
    const inode = `${stat.dev}:${stat.ino}`
    const currentFingerprint = fingerprint(stat)
    let offset = newline + 1
    let sequence = -1
    const cursor = opts.cursor
    if (cursor && cursor.inode === inode && cursor.header === header && cursor.offset <= stat.size &&
        // A same-size edit is not an append. Replaying is harmless by native ID.
        (cursor.offset < stat.size || cursor.fingerprint === currentFingerprint) &&
        cursor.boundary === await boundary(fd, cursor.offset)) {
      offset = cursor.offset
      sequence = cursor.sequence
    }
    const end = Math.min(stat.size, offset + (opts.maxBytes ?? MAX_FILE_BYTES))
    let batch = []
    let positions = []
    let batchBytes = 0
    let records = 0
    for await (const line of lines(fd, offset, end)) {
      if (opts.signal?.aborted) return
      if (++records > 100000) throw new Error('entry_budget')
      if (!line.text.trim()) {
        offset = line.end
        continue
      }
      const entry = JSON.parse(line.text)
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid_entry')
      if (entry.type === 'message') {
        // A pending placeholder is rewritten in place by Droid. Leave the
        // cursor before it until a later hook or full recovery sees the result.
        if (Array.isArray(entry.message?.content) && entry.message.content.some(b => b?.type === 'tool_result' && b.content === '__TOOL_RESULT_PENDING__')) break
        sequence = entry.seq ?? sequence + 1
        if (!Number.isInteger(sequence) || sequence < 0 || sequence > 2147483647) throw new Error('invalid_sequence')
        const at = Date.parse(entry.timestamp)
        if (!Number.isFinite(at)) throw new Error('invalid_timestamp')
        const window = opts.window
        if (!(window?.sinceMs !== undefined && at < window.sinceMs) && !(window?.untilMs !== undefined && at > window.untilMs)) {
          if (batch.length && (batch.length >= 64 || batchBytes + line.bytes > MAX_LINE_BYTES)) {
            if (!opts.allowed(session)) {
              yield { dropped: true }
              return
            }
            const projection = projectDroidEntries(session, batch, positions)
            if (projection) yield { projection }
            batch = []
            positions = []
            batchBytes = 0
          }
          batch.push(entry)
          positions.push(sequence)
          batchBytes += line.bytes
        }
      }
      offset = line.end
    }
    if (!opts.allowed(session)) {
      yield { dropped: true }
      return
    }
    const projection = projectDroidEntries(session, batch, positions)
    if (projection) yield { projection }
    if (opts.signal?.aborted) return
    // Never acknowledge a file that changed while we were reading it.
    if (fingerprint(await fd.stat()) !== currentFingerprint) return
    yield { cursor: { offset, sequence, header, inode, fingerprint: currentFingerprint, boundary: await boundary(fd, offset) }, complete: offset === stat.size }
  } finally { await fd.close() }
}

/** @param {FileHandle} fd @param {number} offset */
async function boundary(fd, offset) {
  const buffer = Buffer.alloc(Math.min(128, offset))
  const { bytesRead } = await fd.read(buffer, 0, buffer.length, offset - buffer.length)
  return buffer.subarray(0, bytesRead).toString('base64')
}

/** LF framing only: never parse an unfinished append. @param {FileHandle} fd @param {number} start @param {number} end */
async function* lines(fd, start, end) {
  if (start >= end) return
  /** @type {Buffer[]} */
  let fragments = []
  let bytes = 0
  let offset = start
  let readOffset = start
  while (readOffset < end) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, end - readOffset))
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, readOffset)
    if (!bytesRead) break
    readOffset += bytesRead
    const chunk = buffer.subarray(0, bytesRead)
    let index = 0
    while (index < chunk.length) {
      const newline = chunk.indexOf(10, index)
      const stop = newline < 0 ? chunk.length : newline
      const fragment = chunk.subarray(index, stop)
      bytes += fragment.length
      if (bytes > MAX_LINE_BYTES) throw new Error('line_budget')
      if (newline < 0) {
        fragments.push(fragment)
        break
      }
      const text = fragments.length ? Buffer.concat([...fragments, fragment], bytes).toString('utf8') : fragment.toString('utf8')
      offset += bytes + 1
      yield { text, end: offset, bytes }
      fragments = []
      bytes = 0
      index = stop + 1
    }
  }
}

/** One level per project, with bounded enumeration and no symlink traversal. @param {string} root */
export async function* droidSessionFiles(root) {
  const dirs = [root]
  let count = 0
  for (const dir of dirs) {
    let handle
    try { handle = await fs.opendir(dir) } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue
      throw error
    }
    for await (const entry of handle) {
      if (++count > 10000) throw new Error('discovery_budget')
      if (entry.isDirectory() && dir === root) dirs.push(path.join(dir, entry.name))
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path.join(dir, entry.name)
    }
  }
}
