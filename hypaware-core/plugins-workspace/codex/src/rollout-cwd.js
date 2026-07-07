// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { sessionIdFromPath } from './backfill.js'
import { isPlainObject, parseMaybeJson, stringValue } from 'hypaware/core/util'

/**
 * @import { RolloutCwdResolver } from './types.js'
 */

// Only the first `session_meta` line is read, so a bounded prefix is enough:
// Codex writes session_meta as line 1 of the rollout at session start. Reading
// a prefix (never the whole session) keeps the capture hot path cheap even for
// a long, large rollout.
const FIRST_LINE_MAX_BYTES = 64 * 1024

/**
 * Resolve a Codex session's `cwd` from its rollout file's `session_meta` line.
 *
 * The ChatGPT-subscription route (`provider='chatgpt'`, `/backend-api/codex/*`)
 * carries no in-band cwd — `codex-tui` sends no `x-codex-turn-metadata` header
 * and the subscription protocol has no `metadata.cwd` field — so the live
 * exchange projector would record `cwd = NULL` and `.hypignore` would fail open
 * for the whole traffic class. Codex nonetheless writes `session_meta.cwd` into
 * the rollout (`<sessionsDir>/.../rollout-<ts>-<session_id>.jsonl`, line 1) at
 * session start, for both auth modes — the same value the codex backfill reads.
 * This resolver gives the live projector that fallback, so folder coverage is
 * client-independent and live rows carry the cwd backfill already sees.
 * @ref LLP 0083 [implements] — rollout is the live cwd fallback for Codex
 *
 * Results (including misses) are cached per session id, so resolution adds no
 * unbounded filesystem work to the capture hot path. @ref LLP 0049#requirements R6
 *
 * @param {{ sessionsDir: string }} opts
 * @returns {RolloutCwdResolver}
 */
export function createRolloutCwdResolver(opts) {
  const sessionsDir = opts.sessionsDir
  /** @type {Map<string, string | undefined>} */
  const cache = new Map()
  return {
    resolve(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
      if (cache.has(sessionId)) return cache.get(sessionId)
      const cwd = readRolloutCwd(sessionsDir, sessionId)
      cache.set(sessionId, cwd)
      return cwd
    },
  }
}

/**
 * Find the rollout whose filename embeds `sessionId` (via `sessionIdFromPath`,
 * shared with the backfill) and read its `session_meta.cwd`. Best-effort: a
 * missing sessions root, no matching rollout, an unreadable file, or a first
 * line that is not a `session_meta` record all yield `undefined` (fail open on
 * a genuinely absent rollout, matching the nullable `cwd` column).
 *
 * @param {string} sessionsDir
 * @param {string} sessionId
 * @returns {string | undefined}
 */
function readRolloutCwd(sessionsDir, sessionId) {
  const rolloutPath = findRolloutFile(sessionsDir, sessionId)
  if (!rolloutPath) return undefined
  const firstLine = readFirstLine(rolloutPath)
  if (!firstLine) return undefined
  const row = parseMaybeJson(firstLine)
  if (!isPlainObject(row) || stringValue(row.type) !== 'session_meta') return undefined
  const payload = isPlainObject(row.payload) ? row.payload : undefined
  return stringValue(payload?.cwd)
}

/**
 * Recursively scan the sessions root for the rollout whose filename embeds
 * `sessionId`. Returns the first match in a deterministic (sorted) walk. A
 * missing or unreadable directory contributes nothing rather than throwing.
 *
 * @param {string} sessionsDir
 * @param {string} sessionId
 * @returns {string | undefined}
 */
function findRolloutFile(sessionsDir, sessionId) {
  /** @type {string[]} */
  const dirs = [sessionsDir]
  while (dirs.length > 0) {
    const dir = dirs.shift()
    if (dir === undefined) break
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    /** @type {string[]} */
    const subdirs = []
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        subdirs.push(entryPath)
      } else if (entry.isFile() && isRolloutFileName(entry.name) && sessionIdFromPath(entry.name) === sessionId) {
        return entryPath
      }
    }
    // Depth-first over sorted subdirs keeps the walk deterministic.
    dirs.unshift(...subdirs)
  }
  return undefined
}

/** @param {string} name */
function isRolloutFileName(name) {
  return name.startsWith('rollout-') && (name.endsWith('.jsonl') || name.endsWith('.json'))
}

/**
 * Read a bounded prefix of a file and return its first line (without the
 * trailing newline). Returns `undefined` on any read error.
 *
 * @param {string} filePath
 * @returns {string | undefined}
 */
function readFirstLine(filePath) {
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(FIRST_LINE_MAX_BYTES)
    const bytesRead = fs.readSync(fd, buffer, 0, FIRST_LINE_MAX_BYTES, 0)
    if (bytesRead === 0) return undefined
    const text = buffer.toString('utf8', 0, bytesRead)
    const newline = text.indexOf('\n')
    return newline === -1 ? text : text.slice(0, newline)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
  }
}
