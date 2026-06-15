// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCurateRequest, buildProposeRequest, parseDecision, parseProspects } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/prompts.js'

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

test('buildCurateRequest offers curate_decision with adaptive thinking + effort, and does NOT force the tool', () => {
  const req = buildCurateRequest({
    prospect: { type: 'Decision', label: 'x' },
    recall: 'r',
    neighborhood: 'n',
    source: 's',
    model: 'claude-opus-4-8',
    maxTokens: 4096,
  })
  assert.equal(req.tools?.[0].name, 'curate_decision')
  // Adaptive thinking forbids tool_choice:{type:'tool'} (400), so it stays at auto.
  assert.equal(req.params?.tool_choice, undefined)
  assert.deepEqual(req.params?.thinking, { type: 'adaptive' })
  assert.deepEqual(req.params?.output_config, { effort: 'high' })
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

test('parseDecision validates the decision enum', () => {
  const ok = parseDecision(/** @type {any} */ (toolResult('curate_decision', { decision: 'commit', item_type: 'Decision', item_key: 'k', confidence: 0.8 })))
  assert.equal(ok?.decision, 'commit')
  assert.equal(ok?.item_key, 'k')
  const bad = parseDecision(/** @type {any} */ (toolResult('curate_decision', { decision: 'frobnicate' })))
  assert.equal(bad, null)
})

test('parseDecision returns null when there is no tool call', () => {
  const textOnly = { message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, model: 'm', stopReason: 'end_turn' }
  assert.equal(parseDecision(/** @type {any} */ (textOnly)), null)
})
