// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { VOLATILE_BLOCK_FIELDS, stripVolatileBlockFields } from '../../src/core/util/index.js'
import { computeMessageId } from '../../hypaware-core/plugins-workspace/ai-gateway/src/message_projector.js'
import { matchKey } from '../../hypaware-core/plugins-workspace/claude/src/transcripts.js'

/**
 * The ai-gateway fallback message id and the claude plugin's transcript
 * match key must canonicalize a content block identically, or the same
 * logical message gets a different identity depending on which channel
 * (wire request, wire response, transcript) delivered it. Both now
 * strip the one canonical list, `VOLATILE_BLOCK_FIELDS`; this test
 * pins that every field on the list is invisible to both identities.
 */

const base = [{ type: 'tool_use', id: 't1', name: 'exec', input: { cmd: 'ls' } }]
// The wire request echo carries a prompt-cache breakpoint...
const wire = [{ ...base[0], cache_control: { type: 'ephemeral' } }]
// ...while the transcript annotates the same block with tool provenance.
const transcript = [{ ...base[0], caller: { type: 'agent', id: 'a1' } }]

test('gateway fallback id is invariant under every volatile block field', () => {
  const canonical = computeMessageId('conv-1', 'assistant', base)
  assert.equal(computeMessageId('conv-1', 'assistant', wire), canonical)
  assert.equal(computeMessageId('conv-1', 'assistant', transcript), canonical)
})

test('claude transcript match key is invariant under every volatile block field', () => {
  const canonical = matchKey('assistant', base)
  assert.equal(matchKey('assistant', wire), canonical)
  assert.equal(matchKey('assistant', transcript), canonical)
})

test('stripVolatileBlockFields removes exactly the canonical list', () => {
  const decorated = [{
    ...base[0],
    ...Object.fromEntries(VOLATILE_BLOCK_FIELDS.map((field) => [field, 'volatile'])),
  }]
  assert.deepEqual(stripVolatileBlockFields(decorated), base)
  // Non-array content and blocks without volatile fields pass through untouched.
  assert.equal(stripVolatileBlockFields('plain text'), 'plain text')
  assert.equal(/** @type {any} */ (stripVolatileBlockFields(base))[0], base[0])
})
