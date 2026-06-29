// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { searchVectorIndexes } from '../../hypaware-core/plugins-workspace/vector-search/src/search.js'
import { shardFileBase, shardPaths } from '../../hypaware-core/plugins-workspace/vector-search/src/shards.js'

/**
 * @import { CachePartitionMeta, EmbedderCapability } from '../../collectivus-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../src/core/cache/types.js'
 * @import { ShardMeta, VectorIndexDeclaration, VectorSearchRuntime } from '../../hypaware-core/plugins-workspace/vector-search/src/types.js'
 */

/** @type {VectorIndexDeclaration} */
const DECL = { dataset: 'd', column: 'text', name: 'd.text' }
const PARTITION = { source: 'alpha' }

const noopLog = { debug() {}, info() {}, warn() {}, error() {} }

/**
 * The `--no-refresh` mismatch guarantees ("a mismatch is a hard error,
 * never a silent degraded search") never reach hypvector: the error
 * throws on sidecar metadata alone, so the shard parquet can be a
 * placeholder.
 *
 * @param {Partial<ShardMeta>} [metaOverrides]
 * @returns {VectorSearchRuntime}
 */
function makeRuntime(metaOverrides = {}) {
  const indexesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-search-test-'))
  const fileBase = shardFileBase(PARTITION)
  const { file, meta } = shardPaths(indexesDir, DECL.name, fileBase)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'placeholder')
  /** @type {ShardMeta} */
  const shardMeta = {
    schema_version: 1,
    index: DECL.name,
    dataset: DECL.dataset,
    column: DECL.column,
    partition: PARTITION,
    model: 'm1',
    dimension: 3,
    row_count: 2,
    source_row_count: 2,
    built_at: '2026-06-12T00:00:00.000Z',
    ...metaOverrides,
  }
  fs.writeFileSync(meta, JSON.stringify(shardMeta))

  /** @type {CachePartitionMeta} */
  const partitionMeta = { dataset: DECL.dataset, partition: PARTITION, path: '/cache/alpha', epoch: 0, rowCount: 2 }
  /** @type {EmbedderCapability} */
  const embedder = {
    provider: 'stub',
    model: 'm1',
    async embed(texts) {
      return {
        vectors: texts.map((t) => Float32Array.from([t.length, 1, 0])),
        dimension: 3,
        model: 'm1',
      }
    },
  }
  return {
    ctx: /** @type {any} */ ({}),
    config: { indexes: [DECL], refresh: { enabled: true, interval_minutes: 240, max_tick_ms: 30_000, max_rows_per_tick: 5_000 } },
    embedder,
    storage: /** @type {ExtendedQueryStorageService} */ (/** @type {unknown} */ ({
      async discoverCachePartitions() { return [partitionMeta] },
      async *readRows() {},
    })),
    log: noopLog,
    indexesDir,
  }
}

test('searchVectorIndexes: --no-refresh with a shard built by another model is vector_model_mismatch', async () => {
  const runtime = makeRuntime({ model: 'old-model' })
  await assert.rejects(
    () => searchVectorIndexes({ runtime, opts: { query: 'q', refresh: 'never' } }),
    (/** @type {Error & { hypErrorKind?: string }} */ err) => {
      assert.equal(err.hypErrorKind, 'vector_model_mismatch')
      assert.match(err.message, /'old-model'/)
      assert.match(err.message, /'m1'/)
      assert.match(err.message, /rerun without --no-refresh/)
      return true
    }
  )
})

test('searchVectorIndexes: --no-refresh with a shard at another dimension is vector_dimension_mismatch', async () => {
  const runtime = makeRuntime({ dimension: 1536 })
  await assert.rejects(
    () => searchVectorIndexes({ runtime, opts: { query: 'q', refresh: 'never' } }),
    (/** @type {Error & { hypErrorKind?: string }} */ err) => {
      assert.equal(err.hypErrorKind, 'vector_dimension_mismatch')
      assert.match(err.message, /dimension 1536/)
      assert.match(err.message, /embedded to 3/)
      assert.match(err.message, /rerun without --no-refresh/)
      return true
    }
  )
})

test('searchVectorIndexes: no configured index matching the filter is vector_no_indexes', async () => {
  const runtime = makeRuntime()
  await assert.rejects(
    () => searchVectorIndexes({ runtime, opts: { query: 'q', index: 'nope', refresh: 'never' } }),
    (/** @type {Error & { hypErrorKind?: string }} */ err) => err.hypErrorKind === 'vector_no_indexes'
  )
})
