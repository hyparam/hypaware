// @ts-check

import fsp from 'node:fs/promises'
import path from 'node:path'

import { isPlainObject, parseMaybeJson } from 'hypaware/core/util'

/**
 * @import { OpenclawRunContext } from './types.js'
 */

/**
 * The one reader of an OpenClaw run trajectory
 * (`~/.openclaw/agents/<agentId>/sessions/<sessionId>.trajectory.jsonl`),
 * the sibling stream of the session transcript LLP 0158's reader owns.
 *
 * The session file records the conversation; the trajectory records the run
 * that produced it. Only two of its facts are read here, the two the
 * transcript states nowhere and the sweep lane therefore could not fill:
 * the system prompt and the tool definitions each run compiled
 * (LLP 0265#decision). Everything else the stream carries is left on disk
 * rather than half-modelled.
 *
 * Kept beside the session reader and scoped the same way (LLP 0158's
 * placement decision): both files are OpenClaw's, both are read only by
 * `@hypaware/openclaw`, and neither has the cross-plugin consumer LLP 0003
 * asks for before a client format lands in core.
 *
 * @ref LLP 0265#trajectory-reader [implements]: one reader for the
 * trajectory file, surfacing the compiled system prompt and tool set per run
 */

/**
 * The `traceSchema` every trajectory event line states. Guarded on rather
 * than assumed: these files sit in the same directory as the session
 * transcripts, and a line that does not claim this schema is not a
 * trajectory event whatever else it parses as.
 */
export const OPENCLAW_TRAJECTORY_SCHEMA = 'openclaw-trajectory'

/**
 * The `traceSchema` of the pointer file OpenClaw writes beside a session
 * (`<sessionId>.trajectory-path.json`), naming where that session's
 * trajectory actually lives.
 */
export const OPENCLAW_TRAJECTORY_POINTER_SCHEMA = 'openclaw-trajectory-pointer'

/**
 * The character OpenClaw appends when it clips a recorded string
 * (`${value.slice(0, max)}…`, its convention throughout). The trailing
 * ellipsis is the only evidence the silent prompt cap leaves behind.
 */
const TRUNCATION_ELLIPSIS = '\u2026'

/**
 * Where a session's trajectory file is, resolved through OpenClaw's own
 * pointer file when it states a location and by the sibling naming
 * convention otherwise.
 *
 * The pointer is consulted first because it is the only thing that can
 * answer for a relocated trajectory, and it is consulted defensively: a
 * pointer that states a *different* session's id is not this session's
 * pointer, and its `runtimeFile` would attach one session's tool set to
 * another's rows. Convention is the fallback for both a missing pointer and
 * an unusable one, which is also what a version that stops writing pointers
 * would leave behind.
 *
 * The session id, not the session file's name, is the input: a rotated
 * transcript (`<id>.jsonl.reset.<ts>`) keeps the same trajectory sibling,
 * and `SESSION_FILE_NAME` already recovers the id from either spelling
 * (LLP 0205).
 *
 * @param {string} sessionsDir
 * @param {string} sessionId
 * @returns {Promise<string>}
 */
export async function resolveOpenclawTrajectoryPath(sessionsDir, sessionId) {
  const conventional = path.join(sessionsDir, `${sessionId}.trajectory.jsonl`)
  /** @type {string} */
  let text
  try {
    text = await fsp.readFile(path.join(sessionsDir, `${sessionId}.trajectory-path.json`), 'utf8')
  } catch {
    return conventional
  }
  const pointer = parseMaybeJson(text)
  if (!isPlainObject(pointer)) return conventional
  if (pointer.traceSchema !== OPENCLAW_TRAJECTORY_POINTER_SCHEMA) return conventional
  if (typeof pointer.sessionId === 'string' && pointer.sessionId !== sessionId) return conventional
  const runtimeFile = nonBlankString(pointer.runtimeFile)
  if (!runtimeFile || !path.isAbsolute(runtimeFile)) return conventional
  return runtimeFile
}

/**
 * Read the per-run contexts out of one trajectory file, in run order.
 *
 * Best-effort throughout, the same contract the session reader states: a
 * missing or unreadable file is an empty list (a session recorded no
 * trajectory, which is a fact about the session, not an error), and a line
 * that fails to parse, claims another schema, or belongs to another session
 * is skipped rather than aborting the file.
 *
 * One context is emitted per `context.compiled` event, which OpenClaw writes
 * once per run, immediately before the run's first message reaches the
 * session file. A run's `session.ended` closes its context; a context with
 * no end is open until the next one starts, which is what a session still
 * running at sweep time looks like.
 *
 * The `trace.metadata` event that precedes a run's compile carries a
 * `systemPromptReport`, and its `{ chars, hash }` is kept because it is the
 * only description of a system prompt too large for the trajectory to state
 * in full (see {@link readSystemPrompt}).
 *
 * @param {string} filePath
 * @param {{ sessionId?: string }} [options]
 * @returns {Promise<OpenclawRunContext[]>}
 */
export async function readOpenclawRunContexts(filePath, options = {}) {
  /** @type {string} */
  let text
  try {
    text = await fsp.readFile(filePath, 'utf8')
  } catch {
    return []
  }
  const { sessionId } = options
  /** @type {OpenclawRunContext[]} */
  const contexts = []
  /** @type {OpenclawRunContext['systemPromptDigest'] | undefined} */
  let pendingDigest
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const row = parseMaybeJson(trimmed)
    if (!isPlainObject(row)) continue
    if (row.traceSchema !== OPENCLAW_TRAJECTORY_SCHEMA) continue
    // A trajectory file outlives the transcript it was opened beside: a
    // session reset rotates the `.jsonl` and keeps appending to the same
    // trajectory. Its own `sessionId` is therefore the field that says which
    // session a run belongs to, and a stated one that disagrees is another
    // session's run.
    if (sessionId && typeof row.sessionId === 'string' && row.sessionId !== sessionId) continue
    const data = isPlainObject(row.data) ? row.data : undefined
    if (row.type === 'trace.metadata') {
      pendingDigest = systemPromptReportDigest(data)
      continue
    }
    if (row.type === 'session.ended') {
      const open = contexts[contexts.length - 1]
      const endMs = parseTimestampMs(row.ts)
      if (open && open.endMs === undefined && endMs !== undefined) open.endMs = endMs
      continue
    }
    if (row.type !== 'context.compiled') continue
    const startMs = parseTimestampMs(row.ts)
    if (startMs === undefined) continue
    /** @type {OpenclawRunContext} */
    const context = { startMs }
    const runId = nonBlankString(row.runId)
    if (runId) context.runId = runId
    const { systemText, stub } = readSystemPrompt(data?.systemPrompt)
    if (systemText !== undefined) context.systemText = systemText
    // `pendingDigest` is this run's report, consumed here rather than left
    // standing: it belongs to the run that just compiled, not the next one.
    const digest = systemPromptDigest({ report: pendingDigest, stub, systemText })
    if (digest) context.systemPromptDigest = digest
    pendingDigest = undefined
    if (Array.isArray(data?.tools)) context.tools = data.tools
    contexts.push(context)
  }
  contexts.sort((a, b) => a.startMs - b.startMs)
  return contexts
}

/**
 * The context that was compiled for the run a message at `atMs` belongs to,
 * or `undefined` when no run's window covers it.
 *
 * The window is `[startMs, endMs]`, and a context with no end runs until the
 * next one starts. A message outside every window belongs to a run that
 * recorded no trajectory (an embedded CLI harness writes its own, and a
 * version that had the stream off writes none at all), and gets nothing:
 * the last compiled context is not evidence about a run that never
 * compiled one.
 *
 * `atMs` must be the session file's RECORDING time
 * (`OpenclawSessionMessage.recordedAtMs`), not the message's own timestamp.
 * A webchat prompt carries the moment the user sent it, which can predate
 * its own run's compile by seconds, and matching on it would either miss the
 * window or hit the previous run's.
 *
 * @param {OpenclawRunContext[]} contexts  ordered by `startMs`
 * @param {number | undefined} atMs
 * @returns {OpenclawRunContext | undefined}
 */
export function pickOpenclawRunContext(contexts, atMs) {
  if (atMs === undefined) return undefined
  /** @type {OpenclawRunContext | undefined} */
  let candidate
  for (const context of contexts) {
    if (context.startMs > atMs) break
    candidate = context
  }
  if (!candidate) return undefined
  if (candidate.endMs !== undefined && atMs > candidate.endMs) return undefined
  return candidate
}

/**
 * One `context.compiled` system prompt, split into the text the run wrote
 * (if any) and the stub it wrote instead (if any).
 *
 * OpenClaw truncates a recorded prompt at TWO caps, and only one of them
 * announces itself (LLP 0265#truncated-prompts):
 *
 *  - Past 32768 characters the trajectory writer replaces the whole value
 *    with a `{ truncated: true, originalChars, limitChars }` stub. That is
 *    the loud cap, and it is what this returns as `stub`.
 *  - Below it, the recording path can still clip a long prompt to 20000
 *    characters and append an ellipsis, writing a plain string with no
 *    marker of any kind. In the corpus this was verified against, EVERY
 *    string prompt longer than a probe's was exactly 20001 characters
 *    ending in `…`.
 *
 * So a string is not evidence of a complete prompt, and that is the whole
 * hazard here: the silent cap would otherwise put a clipped prompt in
 * `system_text` with nothing anywhere saying it was clipped.
 * {@link systemPromptDigest} does the detecting; this function only reads.
 *
 * @param {unknown} value
 * @returns {{ systemText?: string, stub?: { chars?: number } }}
 */
function readSystemPrompt(value) {
  if (typeof value === 'string') {
    return value.length > 0 ? { systemText: value } : {}
  }
  if (!isPlainObject(value) || value.truncated !== true) return {}
  const originalChars = finiteNumber(value.originalChars)
  return { stub: originalChars === undefined ? {} : { chars: originalChars } }
}

/**
 * What is known about a run's system prompt beyond the text itself: its true
 * size, its content hash, and whether what was recorded is all of it.
 *
 * `truncated` means "the recorded prompt is not the whole prompt", and it is
 * one flag for both caps, because a consumer asking "can I trust this text
 * to be complete" does not care which limit clipped it. It is reached three
 * ways:
 *
 *  - the loud stub, which states truncation outright;
 *  - a recorded string the run's own report says is shorter than the prompt
 *    it assembled (a report `chars` of 0 or less is a report that computed
 *    nothing, and is not evidence of anything);
 *  - a recorded string ending in OpenClaw's truncation ellipsis, which is
 *    the only trace the silent 20000-character cap leaves.
 *
 * The ellipsis test can in principle fire on a prompt that genuinely ends
 * that way. That costs a spurious flag on a complete prompt, where the
 * alternative costs a clipped prompt presented as complete, so it errs in
 * the direction that cannot mislead.
 *
 * @param {{
 *   report?: OpenclawRunContext['systemPromptDigest'],
 *   stub?: { chars?: number },
 *   systemText?: string,
 * }} parts
 * @returns {OpenclawRunContext['systemPromptDigest'] | undefined}
 */
function systemPromptDigest(parts) {
  const { report, stub, systemText } = parts
  /** @type {NonNullable<OpenclawRunContext['systemPromptDigest']>} */
  const digest = {}
  if (report?.hash !== undefined) digest.hash = report.hash
  // A stated size only counts as one when it is positive: a report that ran
  // before the prompt existed states `chars: 0` beside a real prompt.
  if (report?.chars !== undefined && report.chars > 0) digest.chars = report.chars
  if (stub) {
    digest.truncated = true
    if (digest.chars === undefined && stub.chars !== undefined) digest.chars = stub.chars
  }
  if (systemText !== undefined) {
    const clipped = systemText.endsWith(TRUNCATION_ELLIPSIS)
      || (digest.chars !== undefined && digest.chars > systemText.length)
    if (clipped) {
      digest.truncated = true
      digest.recordedChars = systemText.length
    }
  }
  return Object.keys(digest).length === 0 ? undefined : digest
}

/**
 * The `{ chars, hash }` a run's `trace.metadata` states for the system
 * prompt it is about to compile, or `undefined` when the event carries no
 * report. The hash is OpenClaw's own digest of the assembled prompt, so two
 * runs that compiled the same prompt are identifiable as such even when
 * neither could state it in full.
 *
 * @param {Record<string, unknown> | undefined} data
 * @returns {OpenclawRunContext['systemPromptDigest'] | undefined}
 */
function systemPromptReportDigest(data) {
  const prompting = isPlainObject(data?.prompting) ? data.prompting : undefined
  const report = isPlainObject(prompting?.systemPromptReport) ? prompting.systemPromptReport : undefined
  const systemPrompt = isPlainObject(report?.systemPrompt) ? report.systemPrompt : undefined
  if (!systemPrompt) return undefined
  /** @type {NonNullable<OpenclawRunContext['systemPromptDigest']>} */
  const digest = {}
  const chars = finiteNumber(systemPrompt.chars)
  if (chars !== undefined) digest.chars = chars
  const hash = nonBlankString(systemPrompt.hash)
  if (hash) digest.hash = hash
  return digest.chars === undefined && digest.hash === undefined ? undefined : digest
}

/**
 * A stated non-blank string, or `undefined`. The session reader's rule 3
 * ("unconfirmable is unresolvable"), applied to this file's fields.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonBlankString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * An event's `ts`, in epoch milliseconds. Trajectory events state an ISO
 * string; a number is accepted for the same reason the session reader
 * accepts one, so a format change costs a null rather than a silent
 * mismatch.
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
