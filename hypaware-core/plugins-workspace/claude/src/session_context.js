// @ts-check

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

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
 *
 * @typedef {Object} SessionContextRecord
 * @property {string} session_id
 * @property {string | undefined} transcript_path
 * @property {string | undefined} cwd
 * @property {string | undefined} git_branch
 * @property {string | undefined} ts
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
 * @returns {Promise<void>}
 */
export async function appendSessionContext(filePath, record) {
  if (!record || typeof record.session_id !== 'string' || record.session_id.length === 0) {
    throw new Error('appendSessionContext: session_id is required')
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const payload = JSON.stringify(record) + '\n'
  await fsp.appendFile(filePath, payload, 'utf8')
}

/**
 * Read every record from the state file. Returns `[]` on missing
 * file. Malformed lines are skipped (best-effort).
 *
 * @param {string} filePath
 * @returns {Promise<SessionContextRecord[]>}
 */
export async function readSessionContext(filePath) {
  /** @type {SessionContextRecord[]} */
  const out = []
  /** @type {fs.ReadStream} */
  let stream
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  } catch {
    return out
  }
  stream.on('error', () => {})
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
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
    ts: stringValue(value.ts),
  }
  return record
}

/** @param {unknown} value */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
