import test from 'node:test'
import assert from 'node:assert/strict'
import { hash, originalBody, verifiedEvidence, renderSection } from './run.mjs'

const manifest = { session_id: 'session', head_sha: 'a'.repeat(40), sources: [{ id: 'S1', message_id: 'message', part_id: 'part', sha256: hash('approved public text'), recorded_at: '2026-11-05' }] }
const row = { session_id: 'session', message_id: 'message', part_id: 'part', content_text: 'approved public text' }

test('only exact reviewed content and complete source identities are admitted', () => {
  assert.deepEqual(verifiedEvidence(manifest, [row]), [{ id: 'S1', text: row.content_text }])
  for (const changed of [{ ...row, content_text: 'other private content' }, { ...row, session_id: 'other' }, { ...row, message_id: 'other' }, { ...row, part_id: 'other' }]) assert.throws(() => verifiedEvidence(manifest, [changed]))
  assert.throws(() => verifiedEvidence(manifest, []))
  assert.throws(() => verifiedEvidence(manifest, [row, row]))
})

test('reruns preserve original text exactly, including trailing newlines', () => {
  const section = renderSection({ claims: [{ text: 'The recorded constraint explains the choice.', sources: ['S1'] }] }, manifest, 'https://github.com/hyparam/hypaware/actions/runs/1')
  for (const body of ['Human description', 'Human description\n', 'Human description\n\n']) assert.equal(originalBody(body + '\n\n' + section), body)
})

test('ambiguous markers and text after a generated section are rejected', () => {
  for (const body of ['<!-- hypaware-decision-demo:end -->', '<!-- hypaware-decision-demo:start -->', '<!-- hypaware-decision-demo:start --><!-- hypaware-decision-demo:start --><!-- hypaware-decision-demo:end -->', '<!-- hypaware-decision-demo:start --><!-- hypaware-decision-demo:end -->later human text']) assert.throws(() => originalBody(body))
})

test('every generated claim needs a known citation and safe bounded text', () => {
  for (const claim of [{ text: 'Why', sources: [] }, { text: 'Why', sources: ['invented'] }, { text: '<!-- marker -->', sources: ['S1'] }, { text: 'a'.repeat(1001), sources: ['S1'] }, { text: '', sources: ['S1'] }]) assert.throws(() => renderSection({ claims: [claim] }, manifest, 'run'))
})
