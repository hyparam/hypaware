// @ts-check

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { isPlainObject, parseMaybeJson } from 'hypaware/core/util'
import { resolveClientSettingsPath } from '../../../../src/core/daemon/client_settings_path.js'

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
 * The `agents/` root of an OpenClaw install, the parent of every
 * `<agentId>/sessions/*.jsonl` this module reads. HOME-relative, with
 * `OPENCLAW_HOME` replacing the leading `.openclaw` component, resolved
 * through the same generic core seam the retired settings write and the
 * daemon status probe used, so no consumer of this reader can grow a
 * second opinion about where an OpenClaw install lives.
 *
 * @ref LLP 0158#decision [implements]: the session-file *location* is part
 * of the one reader's knowledge, not something each consumer re-derives
 * @param {NodeJS.ProcessEnv | undefined} env
 * @param {string} homeDir
 * @returns {string}
 */
export function defaultOpenclawAgentsDir(env, homeDir) {
  return resolveClientSettingsPath('openclaw', '.openclaw/agents', env, homeDir)
}

/**
 * The session-file names a scan accepts, capturing the session id as group
 * 1: `<sessionId>.jsonl`, optionally followed by the marker OpenClaw appends
 * when it rotates a session in place (`.reset.<ts>`, `.deleted.<ts>`). A
 * rotated file is the same session's history under a name that no longer
 * ends in `.jsonl`, so an `endsWith('.jsonl')` scan lost the whole session
 * silently (#694: 5 of 7 sessions on a live install).
 *
 * Deliberately not a `*.jsonl*` glob. The rotation alternatives are named
 * rather than open, so an unrelated `sess.jsonl.bak` is not a session file at
 * all, and a `sess.trajectory.jsonl` sibling keeps `sess.trajectory` as its
 * own identity instead of collapsing into the session's: group 1 is the name
 * up to the earliest `.jsonl` whose remainder is either empty or one of the
 * named rotation markers, and it is that named alternation, not the lazy
 * capture, doing the distinguishing. The capture stays lazy so a rotation
 * timestamp does not get pulled into the id instead, e.g.
 * `a.jsonl.reset.b.jsonl` resolves to `a`, not `a.jsonl.reset.b`.
 *
 * Exported so every OpenClaw session-file scan, live settlement enumeration
 * and backfill's directory walk alike, agrees on what counts as a session
 * file: the two walks are not the same function (settlement's is
 * mtime-unfiltered and unsorted, backfill's applies the quiesce window and
 * sorts), but the filename contract they apply is one place, not two private
 * copies that can drift.
 *
 * @ref LLP 0205#decision [implements]: the widened session-filename contract,
 * rotation markers included, trajectory siblings still distinguishable
 * @type {RegExp}
 */
export const SESSION_FILE_NAME = /^(.+?)\.jsonl(?:\.(?:reset|deleted)\..+)?$/

/**
 * Enumerate the session files under an OpenClaw `agents/` root
 * (`<agentsDir>/<agentId>/sessions/*.jsonl`, rotated names included per
 * {@link SESSION_FILE_NAME}), each with its `mtimeMs` so a caller can order
 * or window candidates by recency without a second stat pass.
 *
 * Best-effort throughout, like every other read here: a missing root, an
 * unreadable agent directory, or a file that vanished between the readdir
 * and the stat contributes nothing instead of aborting the enumeration.
 * The result is unsorted (directory order); callers that care sort it.
 *
 * @ref LLP 0158#decision [implements]: the session-file layout
 * (`agents/<id>/sessions/*.jsonl`) is part of the one reader's knowledge
 * @ref LLP 0205#decision [implements]: this settlement-lane enumeration
 * shares {@link SESSION_FILE_NAME} with the backfill scan, so a session
 * rotated between capture and flush is still a candidate here too; `rename`
 * preserves mtime (LLP 0205#consequences), so the mtime-slack filter the
 * caller applies would not have excluded a rotated file even before this
 * changed
 * @param {string} agentsDir
 * @returns {Promise<Array<{ path: string, mtimeMs: number }>>}
 */
export async function listOpenclawSessionFiles(agentsDir) {
  /** @type {Array<{ path: string, mtimeMs: number }>} */
  const files = []
  /** @type {string[]} */
  let agents
  try {
    agents = (await fsp.readdir(agentsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return files
  }
  for (const agent of agents) {
    const sessionsDir = path.join(agentsDir, agent, 'sessions')
    /** @type {string[]} */
    let names
    try {
      names = await fsp.readdir(sessionsDir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!SESSION_FILE_NAME.test(name)) continue
      const filePath = path.join(sessionsDir, name)
      try {
        const stat = await fsp.stat(filePath)
        if (!stat.isFile()) continue
        files.push({ path: filePath, mtimeMs: stat.mtimeMs })
      } catch {
        continue
      }
    }
  }
  return files
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
 * LLP 0158's Context names, at the level it names them at: `id` on the
 * record line, a timestamp, `role` and `content` on every message, and
 * `model`/`provider`/`api`/`stopReason`/`usage` on an assistant one. Every
 * field this function does not normalize is still reachable through
 * `record`, the untouched record line, so a caller that needs one is not
 * blocked on this reader growing a field for it. `record` is the LINE,
 * though, not the message: `parentId` is on it, but a message-level field
 * this reader does not normalize (`idempotencyKey`, `toolCallId`) is at
 * `record.message`. Naming the level is the whole point here, since reading
 * a message field off the line is exactly #543.
 *
 * `role` and `content` are normalized here rather than left to `record`
 * precisely because their location is the non-obvious part
 * ({@link openclawMessageEnvelope}): both consumers used to reach into
 * `record.role`/`record.content` themselves, so both read one level too high
 * and both dropped every real session (#543). A field whose *address* is the
 * thing that is easy to get wrong belongs to the one reader.
 *
 * @param {string} line
 * @returns {OpenclawSessionMessage | undefined}
 */
function parseOpenclawSessionMessage(line) {
  const row = parseMaybeJson(line)
  if (!isPlainObject(row)) return undefined
  if (row.type !== 'message') return undefined
  const envelope = openclawMessageEnvelope(row)
  /** @type {OpenclawSessionMessage} */
  const message = { record: row }
  // `id` is the one field read the other way round, and deliberately so.
  // LLP 0158's verified shape puts message IDENTITY on the record line; the
  // nested envelope is OpenClaw's normalization of a provider response, and
  // the day a version starts copying the provider's own `msg_...` id into it,
  // envelope-first would silently repoint every `message_id` (and so every
  // `part_id`) that backfill and settlement agree on. Already-committed rows
  // would stop deduping against the new ones and the history would double,
  // with nothing raised anywhere. The envelope stays the fallback, so a record
  // that states identity only there is still read.
  const id = nonBlankString(row.id) ?? nonBlankString(envelope.id)
  if (id !== undefined) message.id = id
  const timestampMs = messageField(envelope, row, 'timestamp', parseTimestampMs)
  if (timestampMs !== undefined) message.timestampMs = timestampMs
  const role = messageField(envelope, row, 'role', nonBlankString)
  if (role !== undefined) message.role = role
  const content = messageField(envelope, row, 'content', statedValue)
  if (content !== undefined) message.content = content
  const model = messageField(envelope, row, 'model', nonBlankString)
  if (model !== undefined) message.model = model
  const provider = messageField(envelope, row, 'provider', nonBlankString)
  if (provider !== undefined) message.provider = provider
  const api = messageField(envelope, row, 'api', nonBlankString)
  if (api !== undefined) message.api = api
  const stopReason = messageField(envelope, row, 'stopReason', nonBlankString)
  if (stopReason !== undefined) message.stopReason = stopReason
  const usage = messageField(envelope, row, 'usage', plainObject)
  if (usage !== undefined) message.usage = usage
  return message
}

/**
 * The message envelope of a `type: "message"` record: the nested `message`
 * object, not the record line.
 *
 * A record line states only what identifies and positions the message
 * (`id`, `parentId`, `timestamp`, `type`); the message itself - `role`,
 * `content`, and for an assistant turn `model`, `provider`, `api`,
 * `stopReason`, `usage` - is one level down under `message`. Read at the top
 * level every one of those fields is absent, which is not a loud failure:
 * `provider` reads `undefined`, the backfill's backend exclusion resolves the
 * record to `unknown`, and the run reports a clean "0 rows" for a session it simply
 * failed to read (#543). Fail-closed exclusion and a parse miss are
 * indistinguishable at that seam, so the address has to be right here.
 *
 * The record line is the fallback, not a second address to prefer: a record
 * that nests no `message` object states its fields on the line itself, and
 * reading them there is better than reading a message with no role and no
 * content. A field the envelope does state is never overridden by a
 * same-named field on the line. The fallback is per FIELD, not per record
 * ({@link messageField}), so a record that nests a partial envelope still
 * recovers the rest of its fields from the line rather than reading as a
 * message that is missing them. `id` is the single documented exception,
 * read line-first because it is identity rather than content
 * ({@link parseOpenclawSessionMessage}).
 *
 * @ref LLP 0158#decision [implements]: where a message's fields live is part
 * of the one reader's knowledge, not something each consumer re-derives
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
function openclawMessageEnvelope(row) {
  return isPlainObject(row.message) ? row.message : row
}

/**
 * One message field, read from the envelope first and the record line
 * second. Not a substitution across fields (rule 1): it is the same field
 * name, looked for at the two levels one record can state it at.
 *
 * `stated` is the field's own present-value test, and it runs at BOTH
 * levels before the fallback decides. Running it only on the result would
 * let a blank or wrong-typed envelope value shadow a usable one on the
 * line, which would make that value absent (rule 3) and load-bearing at the
 * same time: a nested `provider: "  "` beside a line-level
 * `provider: "anthropic"` would resolve the record to `unknown` and the
 * backfill's backend exclusion would drop it fail-closed, the same silent
 * drop #543 was. If a level does not state the field, it does not get a vote.
 *
 * @template T
 * @param {Record<string, unknown>} envelope
 * @param {Record<string, unknown>} row
 * @param {string} key
 * @param {(value: unknown) => T | undefined} stated
 * @returns {T | undefined}
 */
function messageField(envelope, row, key, stated) {
  const fromEnvelope = stated(envelope[key])
  return fromEnvelope !== undefined ? fromEnvelope : stated(row[key])
}

/**
 * `content`'s present-value test. Unlike every other normalized field it has
 * no single shape to check: OpenClaw writes a string on some turns and a
 * block array on others, and both consumers already accept either, so the
 * value passes through as written. Only `null` is refused, so a nulled-out
 * envelope field counts as unstated and the record line still gets its turn.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function statedValue(value) {
  return value === null ? undefined : value
}

/**
 * A plain object, else `undefined`: `usage`'s present-value test, so a
 * non-object `usage` reads as absent at whichever level wrote it.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown> | undefined}
 */
function plainObject(value) {
  return isPlainObject(value) ? value : undefined
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
