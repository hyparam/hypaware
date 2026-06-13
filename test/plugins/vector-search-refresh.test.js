// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  collectShardTexts,
  refreshIndexes,
} from '../../hypaware-core/plugins-workspace/vector-search/src/refresh.js'
import { shardFileBase, shardPaths } from '../../hypaware-core/plugins-workspace/vector-search/src/shards.js'

/**
 * @import { CachePartitionMeta, EmbedderCapability } from '../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from '../../src/core/cache/types.d.ts'
 * @import { ShardMeta, VectorIndexDeclaration } from '../../hypaware-core/plugins-workspace/vector-search/src/types.d.ts'
 */

/** @type {VectorIndexDeclaration} */
const DECL = { dataset: 'd', column: 'text', name: 'd.text' }

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * @param {Record<string, string>} partition
 * @param {Array<Record<string, unknown>>} rows
 * @returns {CachePartitionMeta & { rows: Array<Record<string, unknown>> }}
 */
function part(partition, rows) {
  return {
    dataset: DECL.dataset,
    partition,
    path: `/cache/${shardFileBase(partition)}`,
    epoch: 0,
    rowCount: rows.length,
    rows,
  }
}

/**
 * Storage stub: partitions carry their rows inline; `readRows` streams
 * the rows of whichever partition owns the requested path.
 *
 * @param {Array<CachePartitionMeta & { rows: Array<Record<string, unknown>> }>} partitions
 * @returns {ExtendedQueryStorageService}
 */
function stubStorage(partitions) {
  return /** @type {ExtendedQueryStorageService} */ (/** @type {unknown} */ ({
    async discoverCachePartitions() {
      return partitions
    },
    async *readRows(/** @type {string} */ partitionPath) {
      const owner = partitions.find((p) => p.path === partitionPath)
      for (const row of owner?.rows ?? []) yield row
    },
  }))
}

/**
 * @param {{ dimensions?: number }} [opts]
 * @returns {EmbedderCapability & { calls: string[][] }}
 */
function stubEmbedder(opts = {}) {
  /** @type {string[][]} */
  const calls = []
  return {
    provider: 'stub',
    model: 'm1',
    ...(opts.dimensions !== undefined ? { dimensions: opts.dimensions } : {}),
    calls,
    async embed(texts) {
      calls.push(texts)
      return {
        vectors: texts.map((t) => Float32Array.from([t.length, 1, 0])),
        dimension: 3,
        model: 'm1',
      }
    },
  }
}

function tmpIndexesDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vector-refresh-test-'))
}

/**
 * @param {string} indexesDir
 * @param {Record<string, string>} partition
 * @param {Partial<ShardMeta>} [overrides]
 */
function writeShard(indexesDir, partition, overrides = {}) {
  const fileBase = shardFileBase(partition)
  const { file, meta } = shardPaths(indexesDir, DECL.name, fileBase)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'not-a-real-parquet')
  /** @type {ShardMeta} */
  const shardMeta = {
    schema_version: 1,
    index: DECL.name,
    dataset: DECL.dataset,
    column: DECL.column,
    partition,
    model: 'm1',
    dimension: 3,
    row_count: 2,
    source_row_count: 2,
    built_at: '2026-06-12T00:00:00.000Z',
    ...overrides,
  }
  fs.writeFileSync(meta, JSON.stringify(shardMeta))
  return { file, meta, fileBase }
}

test('refreshIndexes: an already-expired deadline skips every pending shard and reports exhaustion', async () => {
  const indexesDir = tmpIndexesDir()
  const partitions = [
    part({ source: 'alpha' }, [{ text: 'aaa' }]),
    part({ source: 'beta' }, [{ text: 'bbb' }]),
  ]
  const embedder = stubEmbedder()
  const report = await refreshIndexes({
    decls: [DECL],
    embedder,
    storage: stubStorage(partitions),
    indexesDir,
    log: noopLog,
    budget: { deadlineMs: Date.now() - 1 },
  })
  assert.equal(report.shardsBuilt, 0)
  assert.equal(report.shardsSkipped, 2)
  assert.equal(report.rowsEmbedded, 0)
  assert.equal(report.budgetExhausted, true)
  assert.equal(embedder.calls.length, 0, 'an exhausted budget must not spend embedding calls')
})

test('refreshIndexes: the row budget stops further builds after the shard that crosses it', async () => {
  const indexesDir = tmpIndexesDir()
  const partitions = [
    part({ source: 'alpha' }, [{ text: 'one' }, { text: 'two' }, { text: 'three' }]),
    part({ source: 'beta' }, [{ text: 'four' }]),
  ]
  const embedder = stubEmbedder()
  /** @type {Array<{ index: string, fileBase: string, state: string, rowsEmbedded: number }>} */
  const shardEvents = []
  const report = await refreshIndexes({
    decls: [DECL],
    embedder,
    storage: stubStorage(partitions),
    indexesDir,
    log: noopLog,
    budget: { maxRows: 2 },
    onShard: (info) => shardEvents.push(info),
  })
  // Budgets are soft: the first shard starts under budget and finishes
  // (3 rows), the second never starts.
  assert.equal(report.shardsBuilt, 1)
  assert.equal(report.shardsSkipped, 1)
  assert.equal(report.rowsEmbedded, 3)
  assert.equal(report.budgetExhausted, true)
  assert.deepEqual(shardEvents.map((e) => e.fileBase), [shardFileBase({ source: 'alpha' })])
  const { file, meta } = shardPaths(indexesDir, DECL.name, shardFileBase({ source: 'alpha' }))
  assert.ok(fs.existsSync(file), 'built shard parquet exists')
  assert.ok(fs.existsSync(meta), 'built shard sidecar exists')
})

test('refreshIndexes: orphans sweep even when the budget is already spent', async () => {
  const indexesDir = tmpIndexesDir()
  const live = part({ source: 'alpha' }, [{ text: 'aaa' }])
  const orphan = writeShard(indexesDir, { source: 'gone' })
  const report = await refreshIndexes({
    decls: [DECL],
    embedder: stubEmbedder(),
    storage: stubStorage([live]),
    indexesDir,
    log: noopLog,
    budget: { deadlineMs: Date.now() - 1 },
  })
  assert.equal(report.orphansSwept, 1)
  assert.equal(report.budgetExhausted, true)
  assert.ok(!fs.existsSync(orphan.file), 'orphan parquet deleted')
  assert.ok(!fs.existsSync(orphan.meta), 'orphan sidecar deleted')
})

test('refreshIndexes: a fresh shard is not rebuilt, and the report says so', async () => {
  const indexesDir = tmpIndexesDir()
  const partition = { source: 'alpha' }
  const rows = [{ text: 'aa' }, { text: 'bb' }]
  writeShard(indexesDir, partition, { source_row_count: rows.length })
  const embedder = stubEmbedder()
  const report = await refreshIndexes({
    decls: [DECL],
    embedder,
    storage: stubStorage([part(partition, rows)]),
    indexesDir,
    log: noopLog,
  })
  assert.equal(report.shardsBuilt, 0)
  assert.equal(report.shardsSkipped, 0)
  assert.equal(report.budgetExhausted, false)
  assert.equal(embedder.calls.length, 0)
})

test('refreshIndexes: a configured embedder dimension that differs from the sidecar forces a rebuild', async () => {
  const indexesDir = tmpIndexesDir()
  const partition = { source: 'alpha' }
  const rows = [{ text: 'aa' }, { text: 'bb' }]
  // Sidecar matches on model and rows but was built at dimension 3;
  // the embedder is now configured for 256.
  writeShard(indexesDir, partition, { source_row_count: rows.length, dimension: 3 })
  const embedder = stubEmbedder({ dimensions: 256 })
  const report = await refreshIndexes({
    decls: [DECL],
    embedder,
    storage: stubStorage([part(partition, rows)]),
    indexesDir,
    log: noopLog,
  })
  assert.equal(report.shardsBuilt, 1)
  assert.equal(embedder.calls.length, 1)
})

test('collectShardTexts: identical texts collapse to one embedding by content hash', async () => {
  const partition = part({ source: 'alpha' }, [
    { text: 'repeated' },
    { text: 'repeated' },
    { text: 'unique' },
    { text: '' },
    { text: null },
    { other: 'no text column' },
  ])
  const texts = await collectShardTexts({
    decl: DECL,
    partition,
    storage: stubStorage([partition]),
  })
  assert.equal(texts.size, 2)
  assert.deepEqual(Array.from(texts.values()).sort(), ['repeated', 'unique'])
})

test('collectShardTexts: id_column keys rows by id and skips rows without one', async () => {
  /** @type {VectorIndexDeclaration} */
  const decl = { ...DECL, id_column: 'mid' }
  const partition = part({ source: 'alpha' }, [
    { text: 'same text', mid: 'a' },
    { text: 'same text', mid: 'b' },
    { text: 'first wins', mid: 'a' },
    { text: 'no id', mid: '' },
  ])
  const texts = await collectShardTexts({
    decl,
    partition,
    storage: stubStorage([partition]),
  })
  // Distinct ids keep their own entries even for identical text; a
  // duplicate id keeps the first row; an empty id is skipped.
  assert.equal(texts.size, 2)
  assert.equal(texts.get('a'), 'same text')
  assert.equal(texts.get('b'), 'same text')
})
