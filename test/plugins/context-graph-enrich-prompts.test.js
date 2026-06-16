// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCurateBatchRequest, buildProposeRequest, parseDecisions, parseProspects } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/prompts.js'

/** @param {string} name @param {any} input */
function toolResult(name, input) {
  return { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input }] }, model: 'm', stopReason: 'tool_use' }
}

test('buildProposeRequest forces the emit_prospects tool via the neutral toolChoice', () => {
  const req = buildProposeRequest({ text: 'hi', model: 'claude-haiku-4-5', maxTokens: 1024, maxCandidates: 8 })
  assert.equal(req.model, 'claude-haiku-4-5')
  assert.equal(req.tools?.[0].name, 'emit_prospects')
  // Provider-neutral: no Anthropic-specific params, so it works on OpenAI too.
  assert.deepEqual(req.toolChoice, { name: 'emit_prospects' })
  assert.equal(req.params, undefined)
})

/** @param {string} provider */
function curateReq(provider) {
  return buildCurateBatchRequest({
    prospects: [
      { type: 'Decision', label: 'a', summary: 'sa', recall: 'ra' },
      { type: 'Concept', label: 'b', summary: 'sb' },
    ],
    neighborhood: 'n',
    source: 's',
    model: 'm',
    maxTokens: 4096,
    provider,
  })
}

test('buildCurateBatchRequest batches prospects and shares source/neighborhood once', () => {
  const req = curateReq('anthropic')
  assert.equal(req.tools?.[0].name, 'curate_decisions')
  // Both prospects are numbered in one prompt; source appears once.
  const text = /** @type {string} */ (req.messages[0].content)
  assert.match(text, /\[1\] type: Decision/)
  assert.match(text, /\[2\] type: Concept/)
  assert.equal(text.split('SHARED SOURCE EXCERPT').length - 1, 1)
})

test('buildCurateBatchRequest on Anthropic uses thinking + high effort, no forced tool', () => {
  const req = curateReq('anthropic')
  // Adaptive thinking forbids tool_choice:{type:'tool'} (400), so it stays at auto.
  assert.equal(req.toolChoice, undefined)
  assert.deepEqual(req.params?.thinking, { type: 'adaptive' })
  assert.deepEqual(req.params?.output_config, { effort: 'high' })
})

test('buildCurateBatchRequest on a non-Anthropic provider forces the tool, no thinking params', () => {
  const req = curateReq('openai-compatible')
  assert.deepEqual(req.toolChoice, { name: 'curate_decisions' })
  assert.equal(req.params, undefined)
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
