// @ts-check

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { isPlainObject, parseMaybeJson } from 'hypaware/core/util'

/**
 * @import { OpenclawSessionHeader, OpenclawSessionMessage } from './types.js'
 */

/**
 * The one reader of an OpenClaw session JSONL file
 * (`~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`).
 *
 * Two `@hypaware/openclaw` consumers are about to read this file for
 * identity and policy decisions: the settlement enricher (upgrading
 * flush-time rows to native identity, and resolving the session's `cwd`
 * against `.hypignore`) and the backfill provider (projecting whole
 * sessions, gated by the same `cwd`). LLP 0150 already shipped two
 * privacy bugs (#453, #459) from exactly this shape, two callers each
 * holding their own copy of a session-header's read rules, drifting
 * apart. This module states the rules once so neither caller grows its
 * own copy.
 *
 * Both callers live inside `@hypaware/openclaw`, so per LLP 0158's
 * placement decision this stays plugin-local rather than moving into
 * `src/core/openclaw/`: the cross-plugin justification LLP 0003 asks for
 * before a client format lands in core does not exist yet. It moves the
 * day a consumer outside this plugin needs it.
 *
 * @ref LLP 0158 [implements]: one shared reader, header + full transcript,
 * for every `@hypaware/openclaw` consumer of the session file
 */

/**
 * How much of a session file is read to recover the header line. A session
 * file grows without bound across a conversation, but the header is its
 * first record, written once at session start, so a bounded prefix is the
 * whole of what the header read needs. Keeping it bounded is what lets the
 * flush-time settlement path do this read at all without paying for a large
 * transcript (LLP 0049 R6's affordability argument, the same bound LLP 0158
 * rule 4 states for this file).
 */
export const OPENCLAW_SESSION_HEADER_PREFIX_BYTES = 64 * 1024

/**
 * Parse an OpenClaw session file's first line into the header fields it
 * states, or `undefined` when the line is not a `type: "session"` header.
 *
 * Mirrors the three read rules LLP 0150 named for the Codex `session_meta`
 * header, applied to OpenClaw's flat (no `payload` wrapper) header shape:
 *
 * 1. **The raw JSONL line is the input, never a substitute struct.** An
 *    absent field reads as absent; nothing here backfills one field from
 *    another.
 * 2. **`type` must be `"session"`.** Every other record type this file
 *    carries (`message`, `model_change`, `thinking_level_change`,
 *    `custom`) is a plain object that could carry an `id` or `cwd`-shaped
 *    field of its own; without the guard, a session file whose first line
 *    happens to be one of them would yield a plausible-looking header that
 *    belongs to no session and a `cwd` that governs nothing.
 * 3. **Unconfirmable is unresolvable.** A field that is absent, not a
 *    string, or blank-after-trim comes back `undefined` rather than as a
 *    substitute or an empty string. For `cwd` this also means a relative
 *    path is unconfirmable ({@link openclawSessionCwd}): nothing on the
 *    line says what it would be relative *to*.
 *
 * A present-but-blank field is treated as absent; a field that survives the
 * blank test is returned byte-identical (these are opaque ids and a path,
 * never re-cased or re-trimmed).
 *
 * @ref LLP 0158#decision [implements]: the header guard/blank/absolute-path
 * rules, stated once
 * @param {string | undefined} line
 * @returns {OpenclawSessionHeader | undefined}
 */
export function parseOpenclawSessionHeader(line) {
  // One gate covers three non-answers: a non-string (an unreadable file's
  // undefined), a line that is not JSON, and JSON that is not an object.
  // parseMaybeJson returns its input unchanged for the first two, so none
  // of them reaches the field reads below.
  const row = parseMaybeJson(line)
  if (!isPlainObject(row)) return undefined
  if (row.type !== 'session') return undefined
  return {
    sessionId: nonBlankString(row.id),
    cwd: openclawSessionCwd(row.cwd),
    startedAt: nonBlankString(row.timestamp),
  }
}

/**
 * Read `filePath`'s bounded first line and parse it as an OpenClaw session
 * header. Any read failure (a missing file, a permissions error, an empty
 * file) is `undefined`, the same answer as a line that is not a header:
 * both mean "this file establishes nothing," and callers already have to
 * handle that (best-effort, never throws).
 *
 * @param {string} filePath
 * @returns {OpenclawSessionHeader | undefined}
 */
export function readOpenclawSessionHeader(filePath) {
  return parseOpenclawSessionHeader(readFirstLineBounded(filePath, OPENCLAW_SESSION_HEADER_PREFIX_BYTES))
}

/**
 * The one predicate for an OpenClaw-header-stated `cwd`: a non-blank
 * **absolute** path, byte-identical, else `undefined`. Exported so every
 * `.hypignore` gate this reader feeds (settlement, backfill) answers "is
 * this a usable container?" identically, sharing its behavior with the
 * Codex `session_meta` reader's `sessionMetaCwd` precedent
 * (`src/core/codex/rollout_session_meta.js`).
 *
 * A plain non-blank-string test is not enough: the usage-policy matcher's
 * first act is `path.resolve(cwd)`, and for a relative value that silently
 * supplies the *daemon's* process cwd as the base. A session whose header
 * said `../elsewhere` would then get a confident `.hypignore` verdict
 * governed by a directory the session never ran in, which is wrong in both
 * directions at once: it can drop a session no `.hypignore` covers, and it
 * can record a session whose real directory *is* ignored. Nothing on the
 * line says what a relative value is relative to, so it is refused rather
 * than resolved against a guessed base.
 *
 * @ref LLP 0150#usable-cwd [implements]: a relative cwd is not a usable
 * container, applied to the OpenClaw header's own `cwd` field
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function openclawSessionCwd(value) {
  const cwd = nonBlankString(value)
  return cwd !== undefined && path.isAbsolute(cwd) ? cwd : undefined
}

/**
 * Read every `type: "message"` record out of an OpenClaw session file, in
 * file order (the order OpenClaw itself appends them, already
 * chronological). Best-effort like the header read: a missing or
 * unreadable file yields an empty list, and a line that fails to parse as
 * JSON, is not a plain object, or is not a `message` record is skipped
 * rather than aborting the rest of the file.
 *
 * This is the full-transcript half of the LLP 0158 reader: the settlement
 * enricher builds its per-session match-key index from it, and the
 * backfill provider projects sessions directly from it. Unlike the header
 * read this is not bounded: a consumer of the message stream needs the
 * whole file, the same tradeoff the Claude/Codex full-transcript readers
 * already make for their own formats.
 *
 * @ref LLP 0158#decision [implements]: the shared full-transcript iteration
 * @param {string} filePath
 * @returns {Promise<OpenclawSessionMessage[]>}
 */
export async function readOpenclawSessionMessages(filePath) {
  /** @type {string} */
  let text
  try {
    text = await fsp.readFile(filePath, 'utf8')
  } catch {
    return []
  }
  /** @type {OpenclawSessionMessage[]} */
  const messages = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const message = parseOpenclawSessionMessage(trimmed)
    if (message) messages.push(message)
  }
  return messages
}

/**
 * Parse one JSONL line into an {@link OpenclawSessionMessage}, or
 * `undefined` when the line is not a `type: "message"` record. Guards the
 * same way the header parse does (rules 1-3 above), applied to the fields
 * LLP 0158's Context names as present on a message envelope: `id` and a
 * timestamp on every message, `model`/`provider`/`api`/`stopReason`/`usage`
 * on an assistant one. Every field this function does not normalize (role,
 * content blocks, and anything else OpenClaw writes) is still reachable
 * through `record`, the untouched envelope, so a caller that needs one is
 * not blocked on this reader growing a field for it.
 *
 * @param {string} line
 * @returns {OpenclawSessionMessage | undefined}
 */
function parseOpenclawSessionMessage(line) {
  const row = parseMaybeJson(line)
  if (!isPlainObject(row)) return undefined
  if (row.type !== 'message') return undefined
  /** @type {OpenclawSessionMessage} */
  const message = { record: row }
  const id = nonBlankString(row.id)
  if (id !== undefined) message.id = id
  const timestampMs = parseTimestampMs(row.timestamp)
  if (timestampMs !== undefined) message.timestampMs = timestampMs
  const model = nonBlankString(row.model)
  if (model !== undefined) message.model = model
  const provider = nonBlankString(row.provider)
  if (provider !== undefined) message.provider = provider
  const api = nonBlankString(row.api)
  if (api !== undefined) message.api = api
  const stopReason = nonBlankString(row.stopReason)
  if (stopReason !== undefined) message.stopReason = stopReason
  if (isPlainObject(row.usage)) message.usage = row.usage
  return message
}

/**
 * A non-blank string, byte-identical, else `undefined`. Stricter than
 * `stringValue` (core util) on purpose: a whitespace-only value matches no
 * session and no directory, so "present but blank" is rule 3's absent, not
 * a value to pass on. The trim is only the emptiness test - a value that
 * survives it is returned exactly as written, since these are opaque
 * provider ids or a path, never a display string to normalize.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * A message record's own timestamp, normalized to epoch millis so a
 * caller (the ordinal/time fallback match, LLP 0161 Section 5) can compare
 * it without re-parsing. `undefined` for anything that does not parse to a
 * finite time, matching the same-shaped helper the Claude/Codex transcript
 * readers already use for their own timestamp fields.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function parseTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return undefined
}

/**
 * The first line of `filePath` (without its newline), read from a bounded
 * prefix so a long session file costs the same as a short one to read its
 * header. `undefined` on any read error (missing file, permissions, a
 * directory) or an empty file.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {string | undefined}
 */
function readFirstLineBounded(filePath, maxBytes) {
  /** @type {number | undefined} */
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(maxBytes)
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0)
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
