// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computeShardStates,
  contentId,
  mergeTopK,
  shardFileBase,
} from '../../hypaware-core/plugins-workspace/vector-search/src/shards.js'

/**
 * @import { CachePartitionMeta } from '../../collectivus-plugin-kernel-types.d.ts'
 * @import { ShardMeta } from '../../hypaware-core/plugins-workspace/vector-search/src/types.d.ts'
 */

/**
 * @param {Record<string, string>} partition
 * @param {number} rowCount
 * @returns {CachePartitionMeta}
 */
function part(partition, rowCount) {
  return { dataset: 'd', partition, path: '/cache/d/x', epoch: 0, rowCount }
}

/**
 * @param {Record<string, string>} partition
 * @param {{ model?: string, sourceRows?: number, rows?: number }} [opts]
 * @returns {ShardMeta}
 */
function meta(partition, opts = {}) {
  return {
    schema_version: 1,
    index: 'd.c',
    dataset: 'd',
    column: 'c',
    partition,
    model: opts.model ?? 'm1',
    dimension: 3,
    row_count: opts.rows ?? 5,
    source_row_count: opts.sourceRows ?? 10,
    built_at: '2026-06-12T00:00:00.000Z',
  }
}

test('shardFileBase renders sorted key=value pairs and falls back to all', () => {
  assert.equal(shardFileBase({}), 'all')
  assert.equal(shardFileBase({ source: 'claude' }), 'source=claude')
  // Sorted by key, independent of insertion order.
  assert.equal(shardFileBase({ b: '2', a: '1' }), 'a=1,b=2')
  assert.equal(shardFileBase({ a: '1', b: '2' }), 'a=1,b=2')
  // Unsafe characters are sanitized.
  assert.equal(shardFileBase({ source: 'a b/c' }), 'source=a_b_c')
})

test('computeShardStates: live partition without a shard is missing', () => {
  const states = computeShardStates({
    partitions: [part({ source: 'claude' }, 10)],
    metas: new Map(),
    model: 'm1',
  })
  assert.equal(states.length, 1)
  assert.equal(states[0].state, 'missing')
  assert.equal(states[0].fileBase, 'source=claude')
})

test('computeShardStates: matching model and row count is fresh', () => {
  const states = computeShardStates({
    partitions: [part({ source: 'claude' }, 10)],
    metas: new Map([['source=claude', meta({ source: 'claude' }, { sourceRows: 10 })]]),
    model: 'm1',
  })
  assert.equal(states[0].state, 'fresh')
})

test('computeShardStates: model mismatch is stale_model, not an error', () => {
  const states = computeShardStates({
    partitions: [part({ source: 'claude' }, 10)],
    metas: new Map([['source=claude', meta({ source: 'claude' }, { model: 'old-model', sourceRows: 10 })]]),
    model: 'm1',
  })
  assert.equal(states[0].state, 'stale_model')
})

test('computeShardStates: row count drift is stale_rows', () => {
  const states = computeShardStates({
    partitions: [part({ source: 'claude' }, 12)],
    metas: new Map([['source=claude', meta({ source: 'claude' }, { sourceRows: 10 })]]),
    model: 'm1',
  })
  assert.equal(states[0].state, 'stale_rows')
})

test('computeShardStates: model mismatch wins over row drift (one rebuild fixes both)', () => {
  const states = computeShardStates({
    partitions: [part({ source: 'claude' }, 12)],
    metas: new Map([['source=claude', meta({ source: 'claude' }, { model: 'old', sourceRows: 10 })]]),
    model: 'm1',
  })
  assert.equal(states[0].state, 'stale_model')
})

test('computeShardStates: shard for an evicted partition is orphan', () => {
  const states = computeShardStates({
    partitions: [part({ source: 'claude' }, 10)],
    metas: new Map([
      ['source=claude', meta({ source: 'claude' }, { sourceRows: 10 })],
      ['source=codex', meta({ source: 'codex' })],
    ]),
    model: 'm1',
  })
  const orphan = states.find((s) => s.fileBase === 'source=codex')
  assert.equal(orphan?.state, 'orphan')
  const fresh = states.find((s) => s.fileBase === 'source=claude')
  assert.equal(fresh?.state, 'fresh')
})

test('mergeTopK merges descending by score across shards', () => {
  const merged = mergeTopK(
    [
      [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.2 }],
      [{ id: 'c', score: 0.95 }, { id: 'd', score: 0.5 }],
      [],
    ],
    3
  )
  assert.deepEqual(merged.map((h) => h.id), ['c', 'a', 'd'])
})

test('mergeTopK with fewer hits than topK returns everything', () => {
  const merged = mergeTopK([[{ id: 'a', score: 0.1 }]], 10)
  assert.equal(merged.length, 1)
})

test('contentId is stable and collision-distinct for different texts', () => {
  assert.equal(contentId('hello'), contentId('hello'))
  assert.notEqual(contentId('hello'), contentId('hello!'))
  assert.match(contentId('hello'), /^[0-9a-f]{32}$/)
})
