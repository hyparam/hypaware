// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { FORK_FINGERPRINT_UUIDS } from '../control/session_ignore_store.js'

/**
 * Reading a Claude Code transcript well enough to fingerprint it, and finding
 * which transcript belongs to a session id.
 *
 * This lives in core, beside `src/core/codex/rollout_session_meta.js`, for the
 * same reason that one does: the on-disk formats it reads are inputs to the
 * client-agnostic `hyp session` verb and to the privacy store, neither of
 * which may import a plugin. It is not a second `@hypaware/claude` context
 * reader: that one returns typed records for the projector and compacts the
 * channel as it goes, while this answers one question off a bounded tail read.
 *
 * Nothing in this module retains, logs, or returns transcript content. A line
 * is parsed only to take its `uuid`, and the parsed value is dropped.
 * @ref LLP 0419#fingerprint [constrained-by]: a fingerprint is line uuids and
 * nothing else
 */

/** How much of the session-context channel's tail is scanned for a match. */
const CONTEXT_TAIL_BYTES = 512 * 1024

/**
 * How much of a transcript's head is read to collect its leading uuids.
 *
 * A bound rather than a line count: an early line can carry a large tool
 * result, and this read happens on a client hook path. Claude writes its
 * session-start lines first and they are small, so 64 KiB reaches well past
 * the eight lines a fingerprint needs in every transcript that is not already
 * pathological - and one that is simply yields fewer uuids, which any-match
 * tolerates.
 */
const TRANSCRIPT_HEAD_BYTES = 64 * 1024

/**
 * The channel the managed Claude hook appends to and the exchange projector
 * reads: `<stateRoot>/plugins/@hypaware/claude/session-context.jsonl`.
 *
 * @param {string} stateRoot
 * @returns {string}
 */
export function claudeSessionContextFile(stateRoot) {
  return path.join(stateRoot, 'plugins', '@hypaware', 'claude', 'session-context.jsonl')
}

/**
 * The transcript path last recorded for `sessionId`, or `undefined` when the
 * channel has no record of it (no managed hook, a Desktop session that never
 * ran one, a Codex or OpenCode id, an id typed by hand).
 *
 * The channel is append-only, so the newest matching line wins; the scan is
 * newest-first over a bounded tail and stops at the first hit.
 *
 * @param {string} stateRoot
 * @param {string} sessionId
 * @returns {string | undefined}
 */
export function claudeTranscriptPathForSession(stateRoot, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const raw = readTail(claudeSessionContextFile(stateRoot), CONTEXT_TAIL_BYTES)
  if (!raw) return undefined
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    /** @type {unknown} */
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = /** @type {Record<string, unknown>} */ (parsed)
    if (record.session_id !== sessionId) continue
    const transcript = record.transcript_path
    if (typeof transcript === 'string' && transcript.length > 0) return transcript
  }
  return undefined
}

/**
 * The leading line uuids of a transcript, in file order, at most `limit` of
 * them. Empty when the file is missing, unreadable, or carries no uuid in its
 * head: an empty fingerprint is never written and never matches, so every
 * failure here loses fork protection rather than inventing one.
 *
 * @param {string} filePath
 * @param {number} [limit]
 * @returns {string[]}
 */
export function readTranscriptHeadUuids(filePath, limit = FORK_FINGERPRINT_UUIDS) {
  /** @type {string[]} */
  const out = []
  if (typeof filePath !== 'string' || filePath.length === 0) return out
  let handle
  /** @type {string} */
  let text
  let complete = false
  try {
    handle = fs.openSync(filePath, 'r')
    const size = fs.fstatSync(handle).size
    const length = Math.min(size, TRANSCRIPT_HEAD_BYTES)
    complete = length === size
    const buffer = Buffer.alloc(length)
    const read = fs.readSync(handle, buffer, 0, length, 0)
    text = buffer.subarray(0, read).toString('utf8')
  } catch {
    return out
  } finally {
    if (handle !== undefined) try { fs.closeSync(handle) } catch { /* already gone */ }
  }
  const lines = text.split('\n')
  // The read cuts mid-line unless it reached the end of the file, so the last
  // fragment is dropped rather than parsed as a record.
  if (!complete) lines.pop()
  for (const line of lines) {
    if (out.length >= limit) break
    if (!line) continue
    /** @type {unknown} */
    let parsed
    try { parsed = JSON.parse(line) } catch { continue }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const uuid = /** @type {Record<string, unknown>} */ (parsed).uuid
    if (typeof uuid === 'string' && uuid.length > 0) out.push(uuid)
  }
  return out
}

/**
 * Read at most the last `maxBytes` of a file, or `''` when it cannot be read.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {string}
 */
function readTail(filePath, maxBytes) {
  let handle
  try {
    handle = fs.openSync(filePath, 'r')
    const size = fs.fstatSync(handle).size
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length <= 0) return ''
    const buffer = Buffer.alloc(length)
    const read = fs.readSync(handle, buffer, 0, length, start)
    const text = buffer.subarray(0, read).toString('utf8')
    if (start === 0) return text
    // The cut leaves a partial record at the front; drop it.
    const newline = text.indexOf('\n')
    return newline === -1 ? '' : text.slice(newline + 1)
  } catch {
    return ''
  } finally {
    if (handle !== undefined) try { fs.closeSync(handle) } catch { /* already gone */ }
  }
}
