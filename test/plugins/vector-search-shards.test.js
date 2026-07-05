// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computeShardStates,
  contentId,
  mergeTopK,
  partitionLabel,
  shardFileBase,
} from '../../hypaware-core/plugins-workspace/vector-search/src/shards.js'

/**
 * @import { CachePartitionMeta } from '../../hypaware-plugin-kernel-types.js'
 * @import { ShardMeta, VectorIndexDeclaration } from '../../hypaware-core/plugins-workspace/vector-search/src/types.js'
 */

/** @type {VectorIndexDeclaration} */
const DECL = { dataset: 'd', column: 'c', name: 'd.c' }

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
 * @param {{ model?: string, sourceRows?: number, rows?: number, dimension?: number, index?: string, dataset?: string, column?: string, idColumn?: string }} [opts]
 * @returns {ShardMeta}
 */
function meta(partition, opts = {}) {
  return {
    schema_version: 1,
    index: opts.index ?? 'd.c',
    dataset: opts.dataset ?? 'd',
    column: opts.column ?? 'c',
    ...(opts.idColumn !== undefined ? { id_column: opts.idColumn } : {}),
    partition,
    model: opts.model ?? 'm1',
    dimension: opts.dimension ?? 3,
    row_count: opts.rows ?? 5,
    source_row_count: opts.sourceRows ?? 10,
    built_at: '2026-06-12T00:00:00.000Z',
  }
}

/**
 * @param {Record<string, string>} partition
 * @param {ShardMeta} m
 * @returns {Map<string, ShardMeta>}
 */
function metasFor(partition, m) {
  return new Map([[shardFileBase(partition), m]])
}

test('shardFileBase renders a sorted human label plus a partition hash', () => {
  assert.equal(shardFileBase({}), 'all')
  assert.match(shardFileBase({ source: 'claude' }), /^source=claude-[0-9a-f]{8}$/)
  // Sorted by key, independent of insertion order.
  assert.equal(shardFileBase({ b: '2', a: '1' }), shardFileBase({ a: '1', b: '2' }))
  assert.match(shardFileBase({ b: '2', a: '1' }), /^a=1,b=2-[0-9a-f]{8}$/)
  // Unsafe characters are sanitized in the label.
  assert.match(shardFileBase({ source: 'a b/c' }), /^source=a_b_c-[0-9a-f]{8}$/)
})

test('shardFileBase: partitions whose labels collide get distinct names', () => {
  // Sanitization is lossy: both labels render `source=a_b`.
  assert.notEqual(shardFileBase({ source: 'a/b' }), shardFileBase({ source: 'a_b' }))
  // A value containing `,`/`=` can mimic another partition's entry list.
  assert.notEqual(shardFileBase({ a: 'b,c=d' }), shardFileBase({ a: 'b', c: 'd' }))
  // Long values truncate in the label but stay distinct via the hash.
  const long1 = shardFileBase({ k: 'x'.repeat(200) + '1' })
  const long2 = shardFileBase({ k: 'x'.repeat(200) + '2' })
  assert.notEqual(long1, long2)
  assert.ok(long1.length < 120, `file base stays bounded (got ${long1.length})`)
})

test('partitionLabel renders unhashed display labels', () => {
  assert.equal(partitionLabel({}), 'all')
  assert.equal(partitionLabel({ source: 'claude' }), 'source=claude')
  assert.equal(partitionLabel({ b: '2', a: '1' }), 'a=1,b=2')
})

test('computeShardStates: live partition without a shard is missing', () => {
  const states = computeShardStates({
    partitions: [part({ source: 'claude' }, 10)],
    metas: new Map(),
    decl: DECL,
    model: 'm1',
  })
  assert.equal(states.length, 1)
  assert.equal(states[0].state, 'missing')
  assert.equal(states[0].fileBase, shardFileBase({ source: 'claude' }))
})

test('computeShardStates: matching declaration, model, and row count is fresh', () => {
  const p = { source: 'claude' }
  const states = computeShardStates({
    partitions: [part(p, 10)],
    metas: metasFor(p, meta(p, { sourceRows: 10 })),
    decl: DECL,
    model: 'm1',
  })
  assert.equal(states[0].state, 'fresh')
})

test('computeShardStates: model mismatch is stale_model, not an error', () => {
  const p = { source: 'claude' }
  const states = computeShardStates({
    partitions: [part(p, 10)],
    metas: metasFor(p, meta(p, { model: 'old-model', sourceRows: 10 })),
    decl: DECL,
    model: 'm1',
  })
  assert.equal(states[0].state, 'stale_model')
})

test('computeShardStates: row count drift is stale_rows', () => {
  const p = { source: 'claude' }
  const states = computeShardStates({
    partitions: [part(p, 12)],
    metas: metasFor(p, meta(p, { sourceRows: 10 })),
    decl: DECL,
    model: 'm1',
  })
  assert.equal(states[0].state, 'stale_rows')
})

test('computeShardStates: model mismatch wins over row drift (one rebuild fixes both)', () => {
  const p = { source: 'claude' }
  const states = computeShardStates({
    partitions: [part(p, 12)],
    metas: metasFor(p, meta(p, { model: 'old', sourceRows: 10 })),
    decl: DECL,
    model: 'm1',
  })
  assert.equal(states[0].state, 'stale_model')
})

test('computeShardStates: dataset/column/id_column drift is stale_config even when model and rows match', () => {
  const p = { source: 'claude' }
  for (const overrides of [{ dataset: 'other' }, { column: 'other' }, { idColumn: 'msg_id' }]) {
    const states = computeShardStates({
      partitions: [part(p, 10)],
      metas: metasFor(p, meta(p, { sourceRows: 10, ...overrides })),
      decl: DECL,
      model: 'm1',
    })
    assert.equal(states[0].state, 'stale_config', JSON.stringify(overrides))
  }
  // And the symmetric case: the declaration gained an id_column.
  const states = computeShardStates({
    partitions: [part(p, 10)],
    metas: metasFor(p, meta(p, { sourceRows: 10 })),
    decl: { ...DECL, id_column: 'msg_id' },
    model: 'm1',
  })
  assert.equal(states[0].state, 'stale_config')
})

test('computeShardStates: sidecar whose recorded partition disagrees is stale_config', () => {
  const p = { source: 'claude' }
  const states = computeShardStates({
    partitions: [part(p, 10)],
    metas: metasFor(p, meta({ source: 'codex' }, { sourceRows: 10 })),
    decl: DECL,
    model: 'm1',
  })
  assert.equal(states[0].state, 'stale_config')
})

test('computeShardStates: dimension drift is stale_dimension when an expected dimension is known', () => {
  const p = { source: 'claude' }
  const states = computeShardStates({
    partitions: [part(p, 10)],
    metas: metasFor(p, meta(p, { sourceRows: 10, dimension: 1536 })),
    decl: DECL,
    model: 'm1',
    dimension: 256,
  })
  assert.equal(states[0].state, 'stale_dimension')
})

test('computeShardStates: dimension is ignored when unknown, matching, or the shard is empty', () => {
  const p = { source: 'claude' }
  const fresh = computeShardStates({
    partitions: [part(p, 10)],
    metas: metasFor(p, meta(p, { sourceRows: 10, dimension: 1536 })),
    decl: DECL,
    model: 'm1',
  })
  assert.equal(fresh[0].state, 'fresh')
  const matching = computeShardStates({
    partitions: [part(p, 10)],
    metas: metasFor(p, meta(p, { sourceRows: 10, dimension: 1536 })),
    decl: DECL,
    model: 'm1',
    dimension: 1536,
  })
  assert.equal(matching[0].state, 'fresh')
  // An empty shard recorded dimension 0; that is not drift.
  const empty = computeShardStates({
    partitions: [part(p, 10)],
    metas: metasFor(p, meta(p, { sourceRows: 10, rows: 0, dimension: 0 })),
    decl: DECL,
    model: 'm1',
    dimension: 1536,
  })
  assert.equal(empty[0].state, 'fresh')
})

test('computeShardStates: shard for an evicted partition is orphan', () => {
  const live = { source: 'claude' }
  const evicted = { source: 'codex' }
  const states = computeShardStates({
    partitions: [part(live, 10)],
    metas: new Map([
      [shardFileBase(live), meta(live, { sourceRows: 10 })],
      [shardFileBase(evicted), meta(evicted)],
    ]),
    decl: DECL,
    model: 'm1',
  })
  const orphan = states.find((s) => s.fileBase === shardFileBase(evicted))
  assert.equal(orphan?.state, 'orphan')
  const fresh = states.find((s) => s.fileBase === shardFileBase(live))
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
