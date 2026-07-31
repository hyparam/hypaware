// @ts-check

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  OPENCLAW_SESSION_HEADER_PREFIX_BYTES,
  openclawSessionCwd,
  parseOpenclawSessionHeader,
  readOpenclawSessionHeader,
  readOpenclawSessionMessages,
} from '../../hypaware-core/plugins-workspace/openclaw/src/session_file.js'

// The single enforcement point for the OpenClaw session file's header and
// full-transcript reads (LLP 0158), consumed by the settlement enricher and
// the backfill provider so neither grows its own copy of these rules -
// exactly the drift LLP 0150 documented shipping twice for Codex's
// session_meta header.
//
// @ref LLP 0158 [tests]: the header guard/blank/absolute-path rules and the
// full-transcript message iteration

/**
 * A session header line whose top-level fields are `fields`.
 *
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
function headerLine(fields) {
  return JSON.stringify({ type: 'session', version: 3, ...fields })
}

/**
 * Write `contents` to a throwaway `<sessionId>.jsonl`.
 *
 * @param {string} contents
 * @returns {string}
 */
function tempSessionFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-openclaw-session-'))
  const file = path.join(dir, 'session-aaaa.jsonl')
  fs.writeFileSync(file, contents)
  return file
}

/* ------------------------------------------------------------------ */
/* Rule 2: the envelope type must be "session"                         */
/* ------------------------------------------------------------------ */

test('a non-session record type is not read as the header, even carrying id/cwd', () => {
  // model_change / thinking_level_change / custom / message all carry a plain
  // object payload of their own; without the type guard a session file whose
  // first line happened to be one of them would yield a plausible id and a
  // cwd that governs nothing.
  const fields = { id: 'session-abc', cwd: '/repo/here', timestamp: '2026-07-30T00:00:00.000Z' }
  for (const type of ['message', 'model_change', 'thinking_level_change', 'custom']) {
    assert.equal(
      parseOpenclawSessionHeader(JSON.stringify({ type, ...fields })),
      undefined,
      `${type} must not be read as the session header`
    )
  }
})

test('a missing, blank, or non-string type is not "session" either', () => {
  const fields = { id: 'session-abc', cwd: '/repo/here' }
  assert.equal(parseOpenclawSessionHeader(JSON.stringify(fields)), undefined)
  assert.equal(parseOpenclawSessionHeader(JSON.stringify({ type: '', ...fields })), undefined)
  assert.equal(parseOpenclawSessionHeader(JSON.stringify({ type: '  ', ...fields })), undefined)
  assert.equal(parseOpenclawSessionHeader(JSON.stringify({ type: 1, ...fields })), undefined)
  assert.equal(parseOpenclawSessionHeader(JSON.stringify({ type: 'Session', ...fields })), undefined)
})

test('a line that is not JSON, or JSON that is not an object, resolves nothing', () => {
  assert.equal(parseOpenclawSessionHeader('not json'), undefined)
  assert.equal(parseOpenclawSessionHeader(''), undefined)
  assert.equal(parseOpenclawSessionHeader(undefined), undefined)
  assert.equal(parseOpenclawSessionHeader('"session"'), undefined)
  assert.equal(parseOpenclawSessionHeader('[{"type":"session"}]'), undefined)
  assert.equal(parseOpenclawSessionHeader('null'), undefined)
})

/* ------------------------------------------------------------------ */
/* Rule 3: unconfirmable is unresolvable, per field                    */
/* ------------------------------------------------------------------ */

test('a blank or non-string field is absent, never a substitute value', () => {
  for (const blank of ['', '   ', '\t\n', 42, null, {}, []]) {
    const meta = parseOpenclawSessionHeader(headerLine({ id: blank, cwd: blank, timestamp: blank }))
    assert.ok(meta, 'the envelope is still a session header')
    assert.equal(meta.sessionId, undefined, `id ${JSON.stringify(blank)} must not resolve`)
    assert.equal(meta.cwd, undefined, `cwd ${JSON.stringify(blank)} must not resolve`)
    assert.equal(meta.startedAt, undefined, `timestamp ${JSON.stringify(blank)} must not resolve`)
  }
})

test('a session header with no other fields resolves no field', () => {
  const meta = parseOpenclawSessionHeader(JSON.stringify({ type: 'session' }))
  assert.ok(meta)
  assert.deepEqual(meta, { sessionId: undefined, cwd: undefined, startedAt: undefined })
})

test('a field that survives the blank test is returned byte-identical', () => {
  const meta = parseOpenclawSessionHeader(headerLine({
    id: ' session-abc ',
    cwd: '/repo/with space/',
    timestamp: '2026-07-30T00:00:00.000Z',
  }))
  assert.ok(meta)
  assert.equal(meta.sessionId, ' session-abc ')
  assert.equal(meta.cwd, '/repo/with space/')
  assert.equal(meta.startedAt, '2026-07-30T00:00:00.000Z')
})

/* ------------------------------------------------------------------ */
/* Rule 3 for cwd: a relative path has no base, so it is no container  */
/* ------------------------------------------------------------------ */

test('a relative cwd is no cwd, not a path resolved against the daemon', () => {
  // @ref LLP 0150#usable-cwd [tests]: a relative cwd is refused, not guessed at
  for (const relative of ['../elsewhere', './repo', 'repo', 'repo/sub', '   /repo']) {
    const meta = parseOpenclawSessionHeader(headerLine({ id: 'session-abc', cwd: relative }))
    assert.ok(meta, 'the envelope is still a session header')
    assert.equal(meta.cwd, undefined, `cwd ${JSON.stringify(relative)} must not resolve`)
    assert.equal(meta.sessionId, 'session-abc', 'the id on the same line is unaffected')
  }
})

test('an absolute cwd resolves', () => {
  const meta = parseOpenclawSessionHeader(headerLine({ id: 'session-abc', cwd: '/work/repo' }))
  assert.ok(meta)
  assert.equal(meta.cwd, '/work/repo')
})

test('openclawSessionCwd is the one cwd predicate, usable by a caller that reads its own record', () => {
  assert.equal(openclawSessionCwd('/work/repo'), '/work/repo')
  for (const bad of ['../elsewhere', 'repo', '', '   ', '\t\n', 42, null, undefined, {}, []]) {
    assert.equal(openclawSessionCwd(bad), undefined, `${JSON.stringify(bad)} is not a usable cwd`)
  }
})

/* ------------------------------------------------------------------ */
/* The file read: line 1 only, bounded, and errors are not answers      */
/* ------------------------------------------------------------------ */

test('readOpenclawSessionHeader reads the first line and ignores the rest of the file', () => {
  const file = tempSessionFile([
    headerLine({ id: 'session-first', cwd: '/repo/first', timestamp: '2026-07-30T00:00:00.000Z' }),
    headerLine({ id: 'session-later', cwd: '/repo/later', timestamp: '2026-07-30T01:00:00.000Z' }),
  ].join('\n') + '\n')
  const meta = readOpenclawSessionHeader(file)
  assert.ok(meta)
  assert.equal(meta.sessionId, 'session-first')
  assert.equal(meta.cwd, '/repo/first')
  assert.equal(meta.startedAt, '2026-07-30T00:00:00.000Z')
})

test('a first line longer than the read bound resolves nothing rather than half a line', () => {
  const padded = headerLine({ id: 'session-abc', cwd: '/repo/here', note: 'x'.repeat(OPENCLAW_SESSION_HEADER_PREFIX_BYTES) })
  assert.ok(padded.length > OPENCLAW_SESSION_HEADER_PREFIX_BYTES)
  assert.equal(readOpenclawSessionHeader(tempSessionFile(`${padded}\n`)), undefined)
})

test('an unreadable, empty, or absent session file resolves nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-openclaw-session-'))
  assert.equal(readOpenclawSessionHeader(path.join(dir, 'session-absent.jsonl')), undefined)
  assert.equal(readOpenclawSessionHeader(tempSessionFile('')), undefined)
  // A directory is not a file: the read throws, and a throw is not an answer.
  assert.equal(readOpenclawSessionHeader(dir), undefined)
})

test('a session file with no trailing newline is still one whole first line', () => {
  const meta = readOpenclawSessionHeader(tempSessionFile(headerLine({ id: 'session-abc', cwd: '/repo/here' })))
  assert.equal(meta?.sessionId, 'session-abc')
})

/* ------------------------------------------------------------------ */
/* The full-transcript iteration: message records only                 */
/* ------------------------------------------------------------------ */

test('readOpenclawSessionMessages returns only type:"message" records, in file order', async () => {
  const file = tempSessionFile([
    headerLine({ id: 'session-abc', cwd: '/repo/here' }),
    JSON.stringify({ type: 'model_change', model: 'claude-x' }),
    JSON.stringify({
      type: 'message',
      id: 'msg-1',
      timestamp: '2026-07-30T00:00:00.000Z',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    }),
    JSON.stringify({ type: 'thinking_level_change', level: 'high' }),
    JSON.stringify({
      type: 'message',
      id: 'msg-2',
      timestamp: '2026-07-30T00:00:05.000Z',
      role: 'assistant',
      model: 'claude-x',
      provider: 'anthropic',
      api: 'anthropic-messages',
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [{ type: 'text', text: 'hello' }],
    }),
    JSON.stringify({ type: 'custom', note: 'irrelevant' }),
  ].join('\n') + '\n')

  const messages = await readOpenclawSessionMessages(file)
  assert.equal(messages.length, 2)

  assert.equal(messages[0].id, 'msg-1')
  assert.equal(messages[0].timestampMs, Date.parse('2026-07-30T00:00:00.000Z'))
  assert.equal(messages[0].model, undefined)
  assert.equal(messages[0].usage, undefined)
  assert.deepEqual(messages[0].record.content, [{ type: 'text', text: 'hi' }])

  assert.equal(messages[1].id, 'msg-2')
  assert.equal(messages[1].model, 'claude-x')
  assert.equal(messages[1].provider, 'anthropic')
  assert.equal(messages[1].api, 'anthropic-messages')
  assert.equal(messages[1].stopReason, 'end_turn')
  assert.deepEqual(messages[1].usage, { input_tokens: 10, output_tokens: 20 })
  assert.deepEqual(messages[1].record.content, [{ type: 'text', text: 'hello' }])
})

test('readOpenclawSessionMessages skips blank and unparseable lines without aborting the rest', async () => {
  const file = tempSessionFile([
    headerLine({ id: 'session-abc' }),
    '',
    'not json',
    '{"type":"message","id":"msg-1"}',
    '   ',
  ].join('\n') + '\n')
  const messages = await readOpenclawSessionMessages(file)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, 'msg-1')
})

test('readOpenclawSessionMessages treats a blank id/timestamp/model as absent, not a substitute', async () => {
  const file = tempSessionFile(JSON.stringify({
    type: 'message',
    id: '   ',
    timestamp: '',
    model: 42,
    stopReason: null,
  }) + '\n')
  const messages = await readOpenclawSessionMessages(file)
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0], {
    record: { type: 'message', id: '   ', timestamp: '', model: 42, stopReason: null },
  })
})

test('readOpenclawSessionMessages resolves to an empty list for a missing or empty file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyp-openclaw-session-'))
  assert.deepEqual(await readOpenclawSessionMessages(path.join(dir, 'absent.jsonl')), [])
  assert.deepEqual(await readOpenclawSessionMessages(tempSessionFile('')), [])
})
