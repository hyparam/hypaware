// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { columnsFor, COMMITTED_DATASET, PROSPECTS_DATASET, prospectId } from '../../hypaware-core/plugins-workspace/context-graph-enrich/src/datasets.js'

test('prospectId is deterministic for the same inputs', () => {
  const a = prospectId({ extractor: 'enrich.t1', extractorVersion: 1, anchorKey: 'conv-1', candidateKey: 'Decision Use Redis' })
  const b = prospectId({ extractor: 'enrich.t1', extractorVersion: 1, anchorKey: 'conv-1', candidateKey: 'Decision Use Redis' })
  assert.equal(a, b)
  assert.equal(a.length, 24)
})

test('prospectId changes with any input (anchor, candidate, version)', () => {
  const base = prospectId({ extractor: 'enrich.t1', extractorVersion: 1, anchorKey: 'conv-1', candidateKey: 'Decision X' })
  assert.notEqual(base, prospectId({ extractor: 'enrich.t1', extractorVersion: 1, anchorKey: 'conv-2', candidateKey: 'Decision X' }))
  assert.notEqual(base, prospectId({ extractor: 'enrich.t1', extractorVersion: 1, anchorKey: 'conv-1', candidateKey: 'Decision Y' }))
  assert.notEqual(base, prospectId({ extractor: 'enrich.t1', extractorVersion: 2, anchorKey: 'conv-1', candidateKey: 'Decision X' }))
})

test('columnsFor returns the schema for known datasets and throws otherwise', () => {
  assert.ok(columnsFor(PROSPECTS_DATASET).some((c) => c.name === 'prospect_id'))
  assert.ok(columnsFor(COMMITTED_DATASET).some((c) => c.name === 'item_id'))
  assert.throws(() => columnsFor('nope'))
})

// The union data source the enrich datasets build over multiple committed
// partitions is the shared core helper; its limit/offset/where behavior is
// covered by test/core/union-source.test.js.
