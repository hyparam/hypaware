// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { routeDecision } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/curate.js'

const AT = '2026-06-15T00:00:00.000Z'

/** @param {Record<string, unknown>} [o] */
function prospect(o = {}) {
  return {
    prospect_id: 'pid-1',
    anchor_type: 'Session',
    anchor_key: 'conv-1',
    source_dataset: 'ai_gateway_messages',
    source_keys: { message_id: ['m1'] },
    ...o,
  }
}

const VIEW = { type: 'Decision', label: 'Use Redis', summary: 'cache layer', confidence: 0.6 }

test('routeDecision commit writes a committed row + a resolution, never rejected', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'commit', confidence: 0.9, note: 'good' }, AT)
  assert.equal(r.rejected, false)
  assert.ok(r.committed)
  assert.equal(r.committed?.item_id, 'Use Redis') // falls back to the view label as the key
  assert.equal(r.committed?.item_type, 'Decision')
  assert.deepEqual(r.committed?.props, { summary: 'cache layer' })
  assert.equal(r.committed?.confidence, 0.9) // decision confidence wins over the view's
  assert.equal(r.committed?.anchor_key, 'conv-1')
  assert.deepEqual(r.committed?.source_keys, { message_id: ['m1'] })
  assert.equal(r.resolution.decision, 'commit')
  assert.deepEqual(r.resolution.committed_ids, ['Use Redis'])
  assert.equal(r.resolution.note, 'good')
})

test('routeDecision commit reuses an explicit item_key (convergence) over the label', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'commit', item_key: 'redis-decision', item_type: 'Decision' }, AT)
  assert.equal(r.committed?.item_id, 'redis-decision')
  assert.deepEqual(r.resolution.committed_ids, ['redis-decision'])
})

test('routeDecision deepen also commits an item', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'deepen', summary: 'better summary' }, AT)
  assert.equal(r.rejected, false)
  assert.ok(r.committed)
  assert.deepEqual(r.committed?.props, { summary: 'better summary' })
  assert.equal(r.resolution.decision, 'deepen')
})

test('routeDecision reject commits nothing — a rejected prospect never reaches the graph', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'reject', note: 'noise' }, AT)
  assert.equal(r.rejected, true)
  assert.equal(r.committed, null)
  assert.equal(r.resolution.decision, 'reject')
  assert.equal(r.resolution.committed_ids, null)
  assert.equal(r.resolution.note, 'noise')
})

test('routeDecision treats an omitted decision as an implicit reject', () => {
  const r = routeDecision(prospect(), VIEW, undefined, AT)
  assert.equal(r.rejected, true)
  assert.equal(r.committed, null)
  assert.equal(r.resolution.decision, 'reject')
  assert.equal(r.resolution.note, 'omitted by curator')
})

test('routeDecision merge records the target and commits nothing', () => {
  const r = routeDecision(prospect(), VIEW, { index: 1, decision: 'merge', merge_into: 'existing-key' }, AT)
  assert.equal(r.rejected, false)
  assert.equal(r.committed, null)
  assert.equal(r.resolution.decision, 'merge')
  assert.deepEqual(r.resolution.committed_ids, ['existing-key'])
})
