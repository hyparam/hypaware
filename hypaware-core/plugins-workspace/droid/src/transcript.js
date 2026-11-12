// @ts-check

import fs from 'node:fs/promises'
import { constants, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { droidSessionHeader, droidUsageScope, projectDroidEntries, projectDroidUsage } from './projector.js'

/** @import { DroidCursor } from '../../../../hypaware-core/plugins-workspace/droid/src/types.js' */
/** @import { FileHandle } from 'node:fs/promises' */
/** @import { Stats } from 'node:fs' */

export const MAX_FILE_BYTES = 64 * 1024 * 1024
export const MAX_LINE_BYTES = 1024 * 1024
export const MAX_LIVE_BYTES = 8 * 1024 * 1024
export const MAX_SETTINGS_BYTES = 1024 * 1024

/** @param {string} file */
export async function droidSettingsStat(file) {
  try {
    const stat = await fs.lstat(file.replace(/\.jsonl$/, '.settings.json'))
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error('settings_budget_or_symlink')
    return stat
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined
    throw error
  }
}

/** @param {NodeJS.ProcessEnv} env */
export function droidSessionsRoot(env) {
  return path.resolve(env.FACTORY_HOME_OVERRIDE || env.HOME || os.homedir(), '.factory', 'sessions')
}

/**
 * A path that cannot be probed counts as present, so an unreadable .hypignore
 * resolves through the fail-closed read path instead of as absent.
 *
 * @param {string} file
 */
export function present(file) {
  try {
    statSync(file)
    return true
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

/** @param {Stats} stat */
export function fingerprint(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` }

/**
 * How long a file's timestamps must have stood before its fingerprint can
 * vouch that nothing was rewritten in place. Filesystem timestamps move in
 * ticks - roughly 16ms for the NTFS clock, a full second on HFS+ - so a
 * same-size rewrite landing in the same tick as the write the fingerprint
 * was taken from leaves every field of it unchanged. Until the stat has aged
 * past the coarsest of those ticks a matching fingerprint is treated as
 * unsettled and the file is read again, which replays rows that are harmless
 * by native ID, rather than skipping a rewrite the stat cannot distinguish.
 */
const FINGERPRINT_SETTLE_MS = 2000

/** @param {Stats} stat */
export function fingerprintSettled(stat) {
  return Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs) >= FINGERPRINT_SETTLE_MS
}

/**
 * Snapshot one transcript, yielding bounded batches and a success-only cursor.
 * The consumer must finish writing a batch before requesting the next item.
 * @param {string} file
 * @param {{ root: string, cursor?: DroidCursor, maxBytes?: number, sessionId?: string,
 *   allowed: (session: Record<string, any>) => boolean, signal?: AbortSignal,
 *   window?: { sinceMs?: number, untilMs?: number },
 *   claimUsage?: (where: Record<string, string>) => (() => void) }} opts
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
    let firstMessageAt
    const cursor = opts.cursor
    if (cursor?.firstMessageAt && cursor.inode === inode && cursor.header === header && cursor.offset <= stat.size &&
        // A same-size edit is not an append, and a fingerprint can only rule
        // one out once the stat has aged past the timestamp tick (see
        // `fingerprintSettled`). Replaying is harmless by native ID.
        (cursor.offset < stat.size || (cursor.fingerprint === currentFingerprint && fingerprintSettled(stat))) &&
        cursor.boundary === await boundary(fd, cursor.offset)) {
      offset = cursor.offset
      sequence = cursor.sequence
      firstMessageAt = cursor.firstMessageAt
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
        firstMessageAt ??= new Date(at).toISOString()
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
    let usageFingerprint
    if (offset === stat.size && firstMessageAt &&
      !(opts.window?.sinceMs !== undefined && Date.parse(firstMessageAt) < opts.window.sinceMs) &&
      !(opts.window?.untilMs !== undefined && Date.parse(firstMessageAt) > opts.window.untilMs)) {
      const before = await droidSettingsStat(realFile)
      const unchanged = before && cursor?.header === header && cursor.inode === inode &&
        cursor.firstMessageAt === firstMessageAt && cursor.usageFingerprint === fingerprint(before) && fingerprintSettled(before)
      if (unchanged) usageFingerprint = cursor.usageFingerprint
      else if (before) {
        const where = droidUsageScope(session)
        const release = opts.claimUsage?.(where) ?? (() => {})
        try {
          // Re-read under the scope guard. Keep no settings payload in cursors.
          const settingsStat = await droidSettingsStat(realFile)
          if (settingsStat) {
            const settingsFd = await fs.open(realFile.replace(/\.jsonl$/, '.settings.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
            try {
              const buffer = Buffer.alloc(Math.min(settingsStat.size + 1, MAX_SETTINGS_BYTES + 1))
              const { bytesRead } = await settingsFd.read(buffer, 0, buffer.length, 0)
              if (bytesRead > MAX_SETTINGS_BYTES || fingerprint(await settingsFd.stat()) !== fingerprint(settingsStat)) throw new Error('settings_changed_or_over_budget')
              const settings = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
              const usage = projectDroidUsage(session, settings, firstMessageAt, settingsStat.mtime.toISOString())
              if (!opts.allowed(session)) {
                yield { dropped: true }
                return
              }
              if (usage) yield { projection: usage, reconcile: { where, key: 'part_id' } }
              usageFingerprint = fingerprint(settingsStat)
            } finally { await settingsFd.close() }
          }
        } finally { release() }
      }
    }
    yield { cursor: { offset, sequence, header, inode, fingerprint: currentFingerprint, firstMessageAt, usageFingerprint, boundary: await boundary(fd, offset) }, complete: offset === stat.size }
  } finally { await fd.close() }
}

/** @param {FileHandle} fd @param {number} offset */
export async function boundary(fd, offset) {
  const buffer = Buffer.alloc(Math.min(128, offset))
  const { bytesRead } = await fd.read(buffer, 0, buffer.length, offset - buffer.length)
  return buffer.subarray(0, bytesRead).toString('base64')
}

/**
 * LF framing only: never parse an unfinished append.
 * @param {FileHandle} fd
 * @param {number} start
 * @param {number} end
 * @param {number} [maxLineBytes]
 * @param {boolean} [skipOversized] yield an oversized line as `oversized` with empty text, instead of throwing
 */
export async function* lines(fd, start, end, maxLineBytes = MAX_LINE_BYTES, skipOversized = false) {
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
      const oversized = bytes > maxLineBytes
      if (oversized && !skipOversized) throw new Error('line_budget')
      if (oversized && newline >= 0) {
        offset += bytes + 1
        yield { text: '', end: offset, bytes, oversized: true }
        fragments = []
        bytes = 0
        index = stop + 1
        continue
      }
      if (oversized) {
        fragments = []
        break
      }
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
