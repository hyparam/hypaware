// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildOrdinalFallbackIndex,
  canonicalMatchKey,
  matchOrdinalFallback,
  ORDINAL_FALLBACK_WINDOW_MS,
  ordinalFallbackKey,
  sessionMatchKey,
  wireMatchKey,
  withRoleOrdinals,
} from '../../hypaware-core/plugins-workspace/openclaw/src/match_key.js'

// @ref LLP 0161#match-keys [tests]: one canonical tuple format fed by two
// shape-specific builders, both funneling into one hash function.
test('canonicalMatchKey is a pure function of role and tuples', () => {
  const tuples = [{ kind: 'text', identity: 'abc' }]
  assert.equal(canonicalMatchKey('user', tuples), canonicalMatchKey('user', tuples))
  assert.notEqual(canonicalMatchKey('user', tuples), canonicalMatchKey('assistant', tuples))
  assert.notEqual(
    canonicalMatchKey('user', tuples),
    canonicalMatchKey('user', [{ kind: 'text', identity: 'xyz' }]),
  )
  // Key order inside a tuple must not change the hash: canonicalJson sorts.
  assert.equal(
    canonicalMatchKey('user', [{ kind: 'text', identity: 'abc' }]),
    canonicalMatchKey('user', [{ identity: 'abc', kind: 'text' }]),
  )
})

test('wireMatchKey: same text content on the same role matches regardless of key order', () => {
  const a = wireMatchKey('user', [{ type: 'text', text: 'hello' }])
  const b = wireMatchKey('user', [{ text: 'hello', type: 'text' }])
  assert.equal(a, b)
})

test('wireMatchKey: a bare string content and its one-block-array equivalent match', () => {
  const a = wireMatchKey('user', 'hello')
  const b = wireMatchKey('user', [{ type: 'text', text: 'hello' }])
  assert.equal(a, b)
})

test('wireMatchKey: empty string content and empty array content both yield the empty-block key', () => {
  assert.equal(wireMatchKey('user', ''), wireMatchKey('user', []))
})

// OpenClaw prepends a timestamp to user messages on the wire but stores the
// bare text in its session file; without normalization every user turn
// content-missed at settlement (the LLP 0175 residual, observed live).
// @ref LLP 0175#fix-direction [tests]: a wire-prefixed user text matches its
// bare session-file counterpart
test('wireMatchKey: an OpenClaw wire timestamp prefix matches the bare session text', () => {
  const wire = wireMatchKey('user', '[Mon 2026-08-03 15:33 PDT] What is the distance to Venus?')
  const session = sessionMatchKey('user', 'What is the distance to Venus?')
  assert.equal(wire, session)
})

test('wireMatchKey: the timestamp strip tolerates seconds and short zone names', () => {
  assert.equal(
    wireMatchKey('user', '[Tue 2026-12-01 9:05:59 Z] hello'),
    wireMatchKey('user', 'hello')
  )
})

test('wireMatchKey: a stamp on both sides still matches (strip is symmetric)', () => {
  const wire = wireMatchKey('user', '[Mon 2026-08-03 15:33 PDT] hello')
  const session = sessionMatchKey('user', '[Mon 2026-08-03 15:33 PDT] hello')
  assert.equal(wire, session)
})

test('wireMatchKey: near-miss brackets are not stripped', () => {
  // Not the OpenClaw stamp shape: lowercase weekday, missing zone, no
  // trailing space. Each must hash as-is rather than lose its prefix.
  for (const text of ['[mon 2026-08-03 15:33 PDT] x', '[Mon 2026-08-03 15:33] x', '[NOTE] x', '[Mon 2026-08-03 15:33 PDT]x']) {
    assert.notEqual(wireMatchKey('user', text), wireMatchKey('user', 'x'), text)
  }
})

test('wireMatchKey: only the leading stamp strips, not one mid-text', () => {
  assert.notEqual(
    wireMatchKey('user', 'said at [Mon 2026-08-03 15:33 PDT] noon'),
    wireMatchKey('user', 'said at noon')
  )
})

// @ref LLP 0159#open-questions [tests]: the cache_control/caller volatile
// fields must not change wire match key identity.
test('wireMatchKey strips volatile block fields before hashing', () => {
  const withoutVolatile = wireMatchKey('assistant', [{ type: 'text', text: 'hi' }])
  const withVolatile = wireMatchKey('assistant', [
    { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' }, caller: 'sub-agent' },
  ])
  assert.equal(withoutVolatile, withVolatile)
})

test('wireMatchKey: tool_use identity is content-based, not id-based', () => {
  const a = wireMatchKey('assistant', [
    { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
  ])
  const b = wireMatchKey('assistant', [
    { type: 'tool_use', id: 'toolu_2', name: 'bash', input: { command: 'ls' } },
  ])
  assert.equal(a, b)

  const differentArgs = wireMatchKey('assistant', [
    { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'pwd' } },
  ])
  assert.notEqual(a, differentArgs)
})

test('wireMatchKey: tool_result identity depends only on content', () => {
  const a = wireMatchKey('user', [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
  ])
  const b = wireMatchKey('user', [
    { type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok' },
  ])
  assert.equal(a, b)

  const different = wireMatchKey('user', [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'not ok' },
  ])
  assert.notEqual(a, different)
})

// @ref LLP 0159#open-questions [tests]: the toolCall/tool_use divergence,
// verified against the real session-file fixture shape.
test('sessionMatchKey: toolCall session block matches an equivalent wire tool_use block', () => {
  const wireKey = wireMatchKey('assistant', [
    { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
  ])
  const sessionKey = sessionMatchKey('assistant', [
    { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
  ])
  assert.equal(wireKey, sessionKey)
})

test('sessionMatchKey: toolUse and function_call synonyms fold onto the same tool_use identity', () => {
  const base = sessionMatchKey('assistant', [
    { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
  ])
  const toolUse = sessionMatchKey('assistant', [
    { type: 'toolUse', id: 'call_2', name: 'bash', arguments: { command: 'ls' } },
  ])
  const functionCall = sessionMatchKey('assistant', [
    { type: 'function_call', id: 'call_3', name: 'bash', arguments: { command: 'ls' } },
  ])
  assert.equal(base, toolUse)
  assert.equal(base, functionCall)
})

test('sessionMatchKey: redacted_thinking folds onto the thinking kind', () => {
  const thinking = sessionMatchKey('assistant', [{ type: 'thinking', thinking: 'because' }])
  const redacted = sessionMatchKey('assistant', [
    { type: 'redacted_thinking', thinking: 'because' },
  ])
  assert.equal(thinking, redacted)
})

// @ref LLP 0159#open-questions [tests]: the toolResult message-shape
// reconciliation verified against the real session-file fixture shape
// (a standalone role: "toolResult" record folds to a synthetic tool_result
// tuple under the user role, matching how the Anthropic Messages wire
// nests a tool_result block inside a user turn).
test('sessionMatchKey: a standalone toolResult record matches the wire tool_result-in-user shape', () => {
  const wireKey = wireMatchKey('user', [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
  ])
  const sessionKey = sessionMatchKey('toolResult', 'ok')
  assert.equal(wireKey, sessionKey)
})

test('sessionMatchKey: toolResult content array and equivalent string content agree with the wire side', () => {
  const wireKey = wireMatchKey('user', [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] },
  ])
  const sessionKey = sessionMatchKey('toolResult', [{ type: 'text', text: 'ok' }])
  assert.equal(wireKey, sessionKey)
})

test('sessionMatchKey: toolResult identity ignores toolCallId, mirroring wireMatchKey ignoring tool_use_id', () => {
  const a = sessionMatchKey('toolResult', 'ok')
  const b = sessionMatchKey('toolResult', 'ok')
  assert.equal(a, b)
})

test('sessionMatchKey: an OpenAI-shaped role: "tool" record is an accepted residue, not normalized', () => {
  // Documented in the module: OpenAI-shaped captures (role: "tool", not
  // nested in a user turn) do not match this normalization and fall
  // through to the ordinal/time fallback matcher instead.
  const wireKey = wireMatchKey('user', [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' },
  ])
  const sessionKey = sessionMatchKey('tool', 'ok')
  assert.notEqual(wireKey, sessionKey)
})

test('ordinalFallbackKey combines role and ordinal into one readable string', () => {
  assert.equal(ordinalFallbackKey('user', 1), 'user#1')
  assert.equal(ordinalFallbackKey('assistant', 3), 'assistant#3')
})

test('withRoleOrdinals assigns 1-based ordinals per role in given order', () => {
  const entries = [
    { role: 'user' },
    { role: 'assistant' },
    { role: 'user' },
    { role: 'assistant' },
  ]
  const result = withRoleOrdinals(entries, (e) => e.role)
  assert.deepEqual(
    result.map((r) => [r.role, r.ordinal]),
    [['user', 1], ['assistant', 1], ['user', 2], ['assistant', 2]],
  )
})

// @ref LLP 0161#match-keys [tests]: retry once against (role, ordinal among
// same-role messages in the session) bounded to a five-minute window, as a
// narrower, second-pass matcher rather than a merged first-pass score.
test('matchOrdinalFallback finds the closest-in-time candidate within the window', () => {
  const base = Date.parse('2026-07-15T10:00:00.000Z')
  const index = buildOrdinalFallbackIndex([
    { role: 'user', timestampMs: base, value: 'first' },
    { role: 'assistant', timestampMs: base + 1000, value: 'reply-1' },
    { role: 'user', timestampMs: base + 60_000, value: 'second' },
    { role: 'assistant', timestampMs: base + 61_000, value: 'reply-2' },
  ])

  assert.equal(matchOrdinalFallback(index, 'user', 1, base), 'first')
  assert.equal(matchOrdinalFallback(index, 'assistant', 2, base + 61_500), 'reply-2')
})

test('matchOrdinalFallback returns undefined outside the window bound', () => {
  const base = Date.parse('2026-07-15T10:00:00.000Z')
  const index = buildOrdinalFallbackIndex([{ role: 'user', timestampMs: base, value: 'only' }])

  assert.equal(
    matchOrdinalFallback(index, 'user', 1, base + ORDINAL_FALLBACK_WINDOW_MS),
    'only',
  )
  assert.equal(
    matchOrdinalFallback(index, 'user', 1, base + ORDINAL_FALLBACK_WINDOW_MS + 1),
    undefined,
  )
})

test('matchOrdinalFallback returns undefined for an unknown role/ordinal position', () => {
  const index = buildOrdinalFallbackIndex([{ role: 'user', timestampMs: 0, value: 'only' }])
  assert.equal(matchOrdinalFallback(index, 'user', 2, 0), undefined)
  assert.equal(matchOrdinalFallback(index, 'assistant', 1, 0), undefined)
})

test('matchOrdinalFallback picks the nearest candidate when several share a position across replays', () => {
  const base = Date.parse('2026-07-15T10:00:00.000Z')
  const index = buildOrdinalFallbackIndex([
    { role: 'user', timestampMs: base, value: 'attempt-1' },
    { role: 'user', timestampMs: base + 2000, value: 'attempt-2-replay' },
  ])
  assert.equal(matchOrdinalFallback(index, 'user', 1, base + 100), 'attempt-1')
})
