// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildEnrichmentContract } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/contract.js'

/**
 * Fake graph kit: buildNode/buildEdge echo their spec so the test asserts the
 * contract's field mapping directly (the real kit's id/provenance stamping is
 * tested in the context-graph plugin).
 */
function fakeKit() {
  return {
    nodeId: (/** @type {string} */ t, /** @type {string} */ k) => `node:${t}:${k}`,
    edgeId: (/** @type {string} */ s, /** @type {string} */ t, /** @type {string} */ d) => `edge:${s}:${t}:${d}`,
    makeRowBuilders: (/** @type {any} */ meta) => ({
      buildNode: (/** @type {any} */ spec) => ({ __kind: 'node', ...spec, _meta: meta }),
      buildEdge: (/** @type {any} */ spec) => ({ __kind: 'edge', ...spec, _meta: meta }),
    }),
  }
}

const ROW = {
  item_id: 'redis-token-bucket',
  item_type: 'Decision',
  label: 'Use a Redis token bucket',
  props: { summary: 'Rate limit with Redis, not in-process.' },
  confidence: 0.9,
  anchor_type: 'Session',
  anchor_key: 'conv-1',
  source_keys: { message_id: ['m1', 'm2'] },
  committed_at: '2026-01-02T03:04:05Z',
}

test('contract reads only the committed dataset', () => {
  const contract = buildEnrichmentContract(fakeKit())
  assert.equal(contract.sourceDataset, 'enrichment_committed')
  for (const rule of contract.rules) {
    assert.match(rule.sql, /FROM enrichment_committed/)
  }
})

test('node rule maps item_type→type, item_id→key, folds confidence into props', () => {
  const contract = buildEnrichmentContract(fakeKit())
  const node = contract.rules.find((r) => r.kind === 'node')
  assert.ok(node)
  const built = /** @type {any} */ (node.toRow(ROW))
  assert.equal(built.type, 'Decision')
  assert.equal(built.key, 'redis-token-bucket')
  assert.equal(built.label, 'Use a Redis token bucket')
  assert.equal(built.props.confidence, 0.9)
  assert.equal(built.props.summary, 'Rate limit with Redis, not in-process.')
  assert.equal(built.firstSeen, '2026-01-02T03:04:05Z')
  assert.deepEqual(built.sourceKeys, { message_id: ['m1', 'm2'] })
})

test('edge rule links the anchor (Session) to the enrichment node via produced', () => {
  const contract = buildEnrichmentContract(fakeKit())
  const edge = contract.rules.find((r) => r.kind === 'edge')
  assert.ok(edge)
  const built = /** @type {any} */ (edge.toRow(ROW))
  assert.equal(built.type, 'produced')
  assert.equal(built.srcType, 'Session')
  assert.equal(built.srcKey, 'conv-1')
  assert.equal(built.dstType, 'Decision')
  assert.equal(built.dstKey, 'redis-token-bucket')
})

test('toRow parses a JSON-string props column (engine may return JSON as text)', () => {
  const contract = buildEnrichmentContract(fakeKit())
  const node = contract.rules.find((r) => r.kind === 'node')
  assert.ok(node)
  const built = /** @type {any} */ (node.toRow({ ...ROW, props: JSON.stringify(ROW.props) }))
  assert.equal(built.props.summary, 'Rate limit with Redis, not in-process.')
  assert.equal(built.props.confidence, 0.9)
})

test('toRow returns null when required fields are missing', () => {
  const contract = buildEnrichmentContract(fakeKit())
  for (const rule of contract.rules) {
    assert.equal(rule.toRow({}), null)
    assert.equal(rule.toRow({ item_id: 'x' }), null)
  }
})
