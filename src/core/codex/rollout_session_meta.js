// @ts-check

import fs from 'node:fs'

import { isPlainObject, parseMaybeJson } from '../util/index.js'

/**
 * @import { CodexRolloutSessionMeta } from '../../../src/core/codex/types.js'
 */

/**
 * The one reader of a Codex rollout's `session_meta` header.
 *
 * Two plugins ask this file the same question: `@hypaware/codex`'s live cwd
 * resolver wants `cwd` for the `.hypignore` match ([LLP 0083](../../../llp/0083-codex-live-cwd-from-rollout.decision.md)),
 * and `@hypaware/ai-gateway`'s `hyp session` verb wants an id for the session
 * opt-out ([LLP 0066](../../../llp/0066-session-opt-out.spec.md) /
 * [LLP 0067](../../../llp/0067-session-opt-out.design.md)). Both answers gate a
 * privacy control, so getting the read wrong does not fail loudly: it names the
 * wrong session or the wrong directory and reports success. It shipped wrong
 * twice from two copies of the rule (#453, #459), so the rule lives here once
 * and neither plugin owns it.
 *
 * @ref LLP 0143 [implements]: one reader, in core, because neither plugin may
 * reach into the other's internals and both must agree byte-for-byte.
 */

/**
 * How much of a rollout is read to get line 1. A rollout grows without bound
 * across a session, but `session_meta` is its first record, written at session
 * start, so a bounded prefix is the whole of what either caller needs. Keeping
 * it bounded is what lets the live capture path do this read at all
 * (@ref LLP 0049#requirements R6).
 */
export const ROLLOUT_META_PREFIX_BYTES = 64 * 1024

/**
 * Parse a rollout's first line into the identifiers its `session_meta` header
 * states, or `undefined` when that line is not a `session_meta` header.
 *
 * Three rules, each load-bearing, and each one of them has been the bug:
 *
 * 1. **The raw JSONL line is the input, never a deserialized struct.** Codex's
 *    hand-written `Deserialize` for the record back-fills `session_id` from
 *    `id` when the field is absent, so anything that goes through it answers
 *    "the thread" to a question about the container and looks confident doing
 *    it (#453). Reading the line means an absent field reads as absent.
 * 2. **`type` must be `session_meta`.** Other rollout records carry `id` and
 *    `cwd` in their payload too (`turn_context` does), so without the guard a
 *    rollout whose first line is any of them yields a plausible id that belongs
 *    to no session and a cwd that governs nothing.
 * 3. **Unconfirmable is unresolvable.** A field that is absent, not a string,
 *    or blank comes back `undefined` rather than as a substitute or an empty
 *    string. A caller that needs it must refuse; none of them may guess. In
 *    particular `sessionId` is never derived from `threadId` (see rule 1): the
 *    two are the same uuid for a root thread and different for a subagent
 *    thread, which is exactly how #459 read the wrong session's cwd.
 *
 * A present-but-blank field is treated as absent. The trim is only the
 * emptiness test: a field that survives it is returned byte-identical, because
 * these ids are opaque provider tokens (LLP 0066 R5) and a `cwd` is a path.
 *
 * @param {string | undefined} line
 * @returns {CodexRolloutSessionMeta | undefined}
 */
export function parseRolloutSessionMeta(line) {
  // One gate covers three non-answers: a non-string (an unreadable file's
  // `undefined`), a line that is not JSON, and JSON that is not an object.
  // `parseMaybeJson` returns its input unchanged for the first two, so none of
  // them reaches the field reads.
  const row = parseMaybeJson(line)
  if (!isPlainObject(row)) return undefined
  if (row.type !== 'session_meta') return undefined
  // A non-object `payload` needs no separate rule: the optional-chained reads
  // below already yield `undefined` for one. This narrows `unknown` so those
  // reads typecheck, which is the whole of its job.
  const payload = isPlainObject(row.payload) ? row.payload : undefined
  return {
    threadId: metaField(payload?.id),
    sessionId: metaField(payload?.session_id),
    cwd: metaField(payload?.cwd),
  }
}

/**
 * Read `filePath`'s bounded first line and parse it as a `session_meta` header.
 * Any read failure (a missing file, a permissions error, an empty file) is
 * `undefined`, the same answer as a line that is not a header: both mean "this
 * file establishes nothing", and callers already have to handle that.
 *
 * @param {string} filePath
 * @returns {CodexRolloutSessionMeta | undefined}
 */
export function readRolloutSessionMeta(filePath) {
  return parseRolloutSessionMeta(readRolloutFirstLine(filePath))
}

/**
 * The first line of `filePath` (without its newline), read from a bounded
 * prefix so a long rollout costs the same as a short one. `undefined` on any
 * read error or an empty file.
 *
 * @param {string} filePath
 * @returns {string | undefined}
 */
function readRolloutFirstLine(filePath) {
  /** @type {number | undefined} */
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(ROLLOUT_META_PREFIX_BYTES)
    const bytesRead = fs.readSync(fd, buffer, 0, ROLLOUT_META_PREFIX_BYTES, 0)
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

/**
 * A non-blank string, byte-identical, else `undefined`. Stricter than
 * `stringValue` on purpose: a whitespace-only `cwd` matches no directory and a
 * whitespace-only id names no session, so "present but blank" is rule 3's
 * absent, not a value to pass on.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function metaField(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}
