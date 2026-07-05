// @ts-check

import { computeShardStates, readShardMetas } from './shards.js'

/**
 * @import { VectorIndexStatus } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { VectorSearchRuntime } from './types.js'
 */

/**
 * Per-index, per-partition shard coverage: state, model, dimension,
 * row counts, build time. Works without the optional hypvector
 * dependency. Everything here reads sidecar metas and the cache
 * partition listing only.
 *
 * @param {VectorSearchRuntime} runtime
 * @returns {Promise<VectorIndexStatus[]>}
 */
export async function collectIndexStatus(runtime) {
  /** @type {VectorIndexStatus[]} */
  const out = []
  for (const decl of runtime.config.indexes) {
    const partitions = await runtime.storage.discoverCachePartitions({ datasets: [decl.dataset] })
    const metas = readShardMetas(runtime.indexesDir, decl.name)
    const states = computeShardStates({
      partitions,
      metas,
      decl,
      model: runtime.embedder.model,
      dimension: runtime.embedder.dimensions,
    })
    out.push({
      index: decl.name,
      dataset: decl.dataset,
      column: decl.column,
      model: runtime.embedder.model,
      shards: states.map((s) => ({
        partition: s.partition?.partition ?? s.meta?.partition ?? {},
        state: s.state,
        ...(s.meta
          ? {
              rows: s.meta.row_count,
              model: s.meta.model,
              dimension: s.meta.dimension,
              built_at: s.meta.built_at,
            }
          : {}),
      })),
    })
  }
  return out
}
