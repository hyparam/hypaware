// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ROLLOUT_META_PREFIX_BYTES,
  parseRolloutSessionMeta,
  readRolloutSessionMeta,
  sessionMetaCwd,
} from '../../src/core/codex/rollout_session_meta.js'

// The single enforcement point for the Codex `session_meta` header, which two
// privacy controls read: `@hypaware/codex`'s live cwd resolver (LLP 0083) and
// `hyp session`'s id resolution (LLP 0066 / LLP 0067). Issue #465: the rules
// were stated in both callers and drifted apart twice (#453, #459), each time
// as a silent wrong id or wrong directory in a privacy control. This is the
// union of both callers' failure paths, so the invariant is tested once.
//
// @ref LLP 0143 [tests]: the three rules of the shared reader

/**
 * A rollout header line whose `payload` is `fields`.
 *
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
function metaLine(fields) {
  return JSON.stringify({ type: 'session_meta', payload: fields })
}

/* ------------------------------------------------------------------ */
/* Rule 1: the raw line is the input, and an absent field is absent    */
/* ------------------------------------------------------------------ */

test('a legacy rollout with no session_id reports none: the thread id is never back-filled', () => {
  // Codex's hand-written `Deserialize` back-fills `session_id` from `id`, so a
  // struct read answers "the thread" to a question about the session container
  // and looks confident doing it (#453). Reading the line means absent is absent.
  const meta = parseRolloutSessionMeta(metaLine({ id: 'thread-abc', cwd: '/repo/here' }))
  assert.ok(meta)
  assert.equal(meta.threadId, 'thread-abc')
  assert.equal(meta.sessionId, undefined, 'no session_id on the line means no session_id')
  assert.notEqual(meta.sessionId, meta.threadId, 'the thread id is not a stand-in for the container')
})

test('a subagent rollout keeps the container and the thread apart', () => {
  // The subagent shape from #459: the thread is this turn, the session_id is the
  // root's container. Collapsing them read the wrong session's cwd.
  const meta = parseRolloutSessionMeta(metaLine({
    id: 'thread-subagent',
    session_id: 'session-root',
    cwd: '/repo/here',
  }))
  assert.ok(meta)
  assert.equal(meta.threadId, 'thread-subagent')
  assert.equal(meta.sessionId, 'session-root')
})

test('a line that is not JSON at all resolves nothing', () => {
  assert.equal(parseRolloutSessionMeta('not json'), undefined)
  assert.equal(parseRolloutSessionMeta(''), undefined)
  assert.equal(parseRolloutSessionMeta(undefined), undefined)
})

test('a JSON line that is not an object resolves nothing', () => {
  assert.equal(parseRolloutSessionMeta('"session_meta"'), undefined)
  assert.equal(parseRolloutSessionMeta('[{"type":"session_meta"}]'), undefined)
  assert.equal(parseRolloutSessionMeta('null'), undefined)
})

/* ------------------------------------------------------------------ */
/* Rule 2: the envelope type must be session_meta                      */
/* ------------------------------------------------------------------ */

test('another envelope type carrying id/session_id/cwd is not the header', () => {
  // A `turn_context` record carries `cwd`, and any record may carry an id. Read
  // as the header it yields a plausible id belonging to no session and a cwd
  // governing nothing - a wrong answer that reports itself as a right one.
  const payload = { id: 'thread-abc', session_id: 'session-abc', cwd: '/repo/here' }
  for (const type of ['turn_context', 'response_item', 'event_msg', 'compacted']) {
    assert.equal(
      parseRolloutSessionMeta(JSON.stringify({ type, payload })),
      undefined,
      `${type} must not be read as the session header`
    )
  }
})

test('a missing, blank, or non-string envelope type is not session_meta either', () => {
  const payload = { id: 'thread-abc', cwd: '/repo/here' }
  assert.equal(parseRolloutSessionMeta(JSON.stringify({ payload })), undefined)
  assert.equal(parseRolloutSessionMeta(JSON.stringify({ type: '', payload })), undefined)
  assert.equal(parseRolloutSessionMeta(JSON.stringify({ type: '  ', payload })), undefined)
  assert.equal(parseRolloutSessionMeta(JSON.stringify({ type: 1, payload })), undefined)
  assert.equal(parseRolloutSessionMeta(JSON.stringify({ type: 'session_meta_v2', payload })), undefined)
})

/* ------------------------------------------------------------------ */
/* Rule 3: unconfirmable is unresolvable, per field                    */
/* ------------------------------------------------------------------ */

test('a blank or non-string field is absent, never an empty value passed on', () => {
  for (const blank of ['', '   ', '\t\n', 42, null, {}, []]) {
    const meta = parseRolloutSessionMeta(metaLine({ id: blank, session_id: blank, cwd: blank }))
    assert.ok(meta, 'the envelope is still a session_meta header')
    assert.equal(meta.threadId, undefined, `id ${JSON.stringify(blank)} must not resolve`)
    assert.equal(meta.sessionId, undefined, `session_id ${JSON.stringify(blank)} must not resolve`)
    assert.equal(meta.cwd, undefined, `cwd ${JSON.stringify(blank)} must not resolve`)
  }
})

test('a session_meta header with no payload resolves no field', () => {
  for (const line of ['{"type":"session_meta"}', '{"type":"session_meta","payload":"x"}']) {
    const meta = parseRolloutSessionMeta(line)
    assert.ok(meta)
    assert.deepEqual(meta, { threadId: undefined, sessionId: undefined, cwd: undefined })
  }
})

test('a field that survives the blank test is returned byte-identical', () => {
  // The ids are opaque provider tokens (LLP 0066 R5) and the cwd is a path, so
  // the trim is the emptiness test only - it never edits the value.
  const meta = parseRolloutSessionMeta(metaLine({
    id: ' thread-abc ',
    session_id: 'Session-ABC ',
    cwd: '/repo/with space/',
  }))
  assert.ok(meta)
  assert.equal(meta.threadId, ' thread-abc ')
  assert.equal(meta.sessionId, 'Session-ABC ')
  assert.equal(meta.cwd, '/repo/with space/')
})

/* ------------------------------------------------------------------ */
/* Rule 3 for cwd: a relative path has no base, so it is no container  */
/* ------------------------------------------------------------------ */

test('a relative session_meta.cwd is no cwd, not a path resolved against the daemon', () => {
  // The matcher's first act is `path.resolve(cwd)`, which for a relative value
  // silently supplies the *daemon's* process cwd as the base, so the header's
  // `../elsewhere` would yield a confident `.hypignore` verdict governed by a
  // file under wherever the daemon was started - the #459 shape through a
  // different field. Nothing on the line names the base, so there is none.
  // @ref LLP 0143#usable-cwd [tests]: a relative cwd is refused, not guessed at
  for (const relative of ['../elsewhere', './repo', 'repo', 'repo/sub', '   /repo']) {
    const meta = parseRolloutSessionMeta(metaLine({ id: 'thread-abc', cwd: relative }))
    assert.ok(meta, 'the envelope is still a session_meta header')
    assert.equal(meta.cwd, undefined, `cwd ${JSON.stringify(relative)} must not resolve`)
    assert.equal(meta.threadId, 'thread-abc', 'the id on the same line is unaffected')
  }
})

test('an absolute cwd still resolves, and the ids are never path-tested', () => {
  // The absoluteness test applies to `cwd` alone: `threadId` / `sessionId` are
  // opaque provider tokens (LLP 0066 R5) and a uuid is not an absolute path, so
  // path-testing them would refuse every real header.
  const meta = parseRolloutSessionMeta(metaLine({
    id: '019e60b5-1111-4222-8333-444455556666',
    session_id: '019e60b5-9999-4222-8333-444455556666',
    cwd: '/work/repo',
  }))
  assert.ok(meta)
  assert.equal(meta.cwd, '/work/repo')
  assert.equal(meta.threadId, '019e60b5-1111-4222-8333-444455556666')
  assert.equal(meta.sessionId, '019e60b5-9999-4222-8333-444455556666')
})

test('sessionMetaCwd is the one cwd predicate, usable by a caller that cannot delegate', () => {
  // Exported for the codex backfill, which reads whole rollout files and folds
  // `turn_context`, so it cannot call the first-line reader but must still
  // answer "is this a usable container?" the same way.
  assert.equal(sessionMetaCwd('/work/repo'), '/work/repo')
  for (const bad of ['../elsewhere', 'repo', '', '   ', '\t\n', 42, null, undefined, {}, []]) {
    assert.equal(sessionMetaCwd(bad), undefined, `${JSON.stringify(bad)} is not a usable cwd`)
  }
})

/* ------------------------------------------------------------------ */
/* The file read: line 1 only, bounded, and errors are not answers      */
/* ------------------------------------------------------------------ */

test('readRolloutSessionMeta reads the first line and ignores the rest of the rollout', () => {
  const file = tempRollout([
    metaLine({ id: 'thread-first', session_id: 'session-first', cwd: '/repo/first' }),
    metaLine({ id: 'thread-later', session_id: 'session-later', cwd: '/repo/later' }),
  ].join('\n') + '\n')
  const meta = readRolloutSessionMeta(file)
  assert.ok(meta)
  assert.equal(meta.threadId, 'thread-first')
  assert.equal(meta.sessionId, 'session-first')
  assert.equal(meta.cwd, '/repo/first')
})

test('a rollout whose first line is longer than the read bound resolves nothing rather than half a line', () => {
  // A truncated prefix is not parseable JSON, so it refuses. The bound is what
  // makes this read affordable on the live capture path (LLP 0049 R6); it must
  // not turn into a partial, plausible read.
  const padded = metaLine({ id: 'thread-abc', cwd: '/repo/here', note: 'x'.repeat(ROLLOUT_META_PREFIX_BYTES) })
  assert.ok(padded.length > ROLLOUT_META_PREFIX_BYTES)
  assert.equal(readRolloutSessionMeta(tempRollout(`${padded}\n`)), undefined)
})

test('an unreadable, empty, or absent rollout resolves nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-rollout-meta-'))
  assert.equal(readRolloutSessionMeta(path.join(dir, 'rollout-absent.jsonl')), undefined)
  assert.equal(readRolloutSessionMeta(tempRollout('')), undefined)
  // A directory is not a file: the read throws, and a throw is not an answer.
  assert.equal(readRolloutSessionMeta(dir), undefined)
})

test('a rollout with no trailing newline is still one whole first line', () => {
  const meta = readRolloutSessionMeta(tempRollout(metaLine({ id: 'thread-abc', cwd: '/repo/here' })))
  assert.equal(meta?.threadId, 'thread-abc')
})

/**
 * Write `contents` to a throwaway `rollout-*.jsonl`.
 *
 * @param {string} contents
 * @returns {string}
 */
function tempRollout(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-rollout-meta-'))
  const file = path.join(dir, 'rollout-2026-01-01T00-00-00-aaaa.jsonl')
  fs.writeFileSync(file, contents)
  return file
}
