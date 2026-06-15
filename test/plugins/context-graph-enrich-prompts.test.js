// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCurateBatchRequest, buildProposeRequest, parseDecisions, parseProspects } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/prompts.js'

/** @param {string} name @param {any} input */
function toolResult(name, input) {
  return { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input }] }, model: 'm', stopReason: 'tool_use' }
}

test('buildProposeRequest forces the emit_prospects tool', () => {
  const req = buildProposeRequest({ text: 'hi', model: 'claude-haiku-4-5', maxTokens: 1024, maxCandidates: 8 })
  assert.equal(req.model, 'claude-haiku-4-5')
  assert.equal(req.tools?.[0].name, 'emit_prospects')
  assert.deepEqual(req.params?.tool_choice, { type: 'tool', name: 'emit_prospects' })
})

test('buildCurateBatchRequest batches prospects, shares source/neighborhood, no forced tool', () => {
  const req = buildCurateBatchRequest({
    prospects: [
      { type: 'Decision', label: 'a', summary: 'sa', recall: 'ra' },
      { type: 'Concept', label: 'b', summary: 'sb' },
    ],
    neighborhood: 'n',
    source: 's',
    model: 'claude-opus-4-8',
    maxTokens: 4096,
  })
  assert.equal(req.tools?.[0].name, 'curate_decisions')
  // Adaptive thinking forbids tool_choice:{type:'tool'} (400), so it stays at auto.
  assert.equal(req.params?.tool_choice, undefined)
  assert.deepEqual(req.params?.thinking, { type: 'adaptive' })
  assert.deepEqual(req.params?.output_config, { effort: 'high' })
  // Both prospects are numbered in one prompt; source appears once.
  const text = /** @type {string} */ (req.messages[0].content)
  assert.match(text, /\[1\] type: Decision/)
  assert.match(text, /\[2\] type: Concept/)
  assert.equal(text.split('SHARED SOURCE EXCERPT').length - 1, 1)
})

test('parseProspects keeps valid candidates and drops unknown types / missing labels', () => {
  const result = toolResult('emit_prospects', {
    prospects: [
      { type: 'Decision', label: 'Use Redis', summary: 's', confidence: 0.7, evidence: 'e' },
      { type: 'Bogus', label: 'Y' },
      { type: 'Concept', /* no label */ summary: 'z' },
    ],
  })
  const out = parseProspects(/** @type {any} */ (result))
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'Decision')
  assert.equal(out[0].label, 'Use Redis')
  assert.equal(out[0].confidence, 0.7)
})

test('parseProspects returns [] on a refusal', () => {
  const refused = { message: { role: 'assistant', content: [] }, model: 'm', stopReason: 'refusal' }
  assert.deepEqual(parseProspects(/** @type {any} */ (refused)), [])
})

test('parseDecisions keeps valid indexed decisions and drops invalid ones', () => {
  const out = parseDecisions(/** @type {any} */ (toolResult('curate_decisions', {
    decisions: [
      { index: 1, decision: 'commit', item_type: 'Decision', item_key: 'k', confidence: 0.8 },
      { index: 2, decision: 'frobnicate' },        // bad decision → dropped
      { decision: 'reject' },                       // missing index → dropped
      { index: 3, decision: 'merge', merge_into: 'x' },
    ],
  })))
  assert.equal(out.length, 2)
  assert.equal(out[0].index, 1)
  assert.equal(out[0].decision, 'commit')
  assert.equal(out[0].item_key, 'k')
  assert.equal(out[1].index, 3)
  assert.equal(out[1].merge_into, 'x')
})

test('parseDecisions returns [] when there is no tool call', () => {
  const textOnly = { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, model: 'm', stopReason: 'end_turn' }
  assert.deepEqual(parseDecisions(/** @type {any} */ (textOnly)), [])
})
