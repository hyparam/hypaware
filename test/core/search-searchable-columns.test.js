// @ts-check

// The shared grep-search allowlist and brute-scan projection
// (LLP 0264 #shared). These constants are the thing the client and the
// server must agree on byte for byte: "zero hits" only means something
// if both sides looked at the same columns, so this suite pins the set
// itself, its order, its exclusions, and the wider projection a brute
// scan is allowed to decode.

import test from 'node:test'
import assert from 'node:assert/strict'

import { SCAN_COLUMNS, SEARCHABLE_COLUMNS } from '../../src/core/search/searchable_columns.js'
import { AI_GATEWAY_MESSAGE_COLUMNS } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'

test('the searchable allowlist is exactly the server-shared set, content column first', () => {
  assert.ok(SEARCHABLE_COLUMNS instanceof Set)
  assert.deepEqual([...SEARCHABLE_COLUMNS], [
    'content_text',
    'tool_name',
    'tool_args',
    'session_id',
    'conversation_id',
    'agent_id',
    'model',
    'cwd',
    'git_branch',
    'git_remote',
  ])
})

test('the bulk machinery columns stay out of the allowlist', () => {
  // Server LLP 0157 measured `system_text` alone at 90.8% of decoded
  // index-build text, which is why "every string column" is refuted.
  for (const column of ['system_text', 'tools', 'attributes', 'raw_frame', 'status']) {
    assert.equal(SEARCHABLE_COLUMNS.has(column), false, `${column} must not be searchable`)
  }
})

test('every searchable column exists on the ai_gateway_messages schema', () => {
  const schema = new Set(AI_GATEWAY_MESSAGE_COLUMNS.map((column) => column.name))
  for (const column of SEARCHABLE_COLUMNS) {
    assert.ok(schema.has(column), `${column} is not a column of ai_gateway_messages`)
  }
})

test('the scan projection is the allowlist plus the readers own columns', () => {
  assert.ok(Array.isArray(SCAN_COLUMNS))
  assert.deepEqual(SCAN_COLUMNS, [
    ...SEARCHABLE_COLUMNS,
    'date',
    'received_at',
    'part_id',
    'message_id',
    'message_created_at',
  ])
  assert.equal(new Set(SCAN_COLUMNS).size, SCAN_COLUMNS.length, 'no duplicate scan columns')
  for (const column of SEARCHABLE_COLUMNS) {
    assert.ok(SCAN_COLUMNS.includes(column), `${column} must be decodable by a brute scan`)
  }
})

test('the allowlist cannot be mutated out from under the scan projection', () => {
  // SCAN_COLUMNS is a load-time snapshot, so a mutated allowlist would make
  // a column searchable while the brute scan never decodes it: a hit on one
  // tier and a silent zero on the other.
  assert.throws(() => SEARCHABLE_COLUMNS.add('system_text'), /constant/)
  assert.throws(() => SEARCHABLE_COLUMNS.delete('content_text'), /constant/)
  assert.throws(() => SEARCHABLE_COLUMNS.clear(), /constant/)
  assert.equal(SEARCHABLE_COLUMNS.has('system_text'), false)
  assert.equal(SEARCHABLE_COLUMNS.has('content_text'), true)
  assert.equal(SCAN_COLUMNS.includes('system_text'), false)
})
