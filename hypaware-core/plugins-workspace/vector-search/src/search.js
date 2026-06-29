// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { loadHypvector } from './hypvector.js'
import { estimatePendingWork, newVectorError, refreshIndexes } from './refresh.js'
import { computeShardStates, contentId, mergeTopK, readShardMetas, shardFileBase, shardPaths } from './shards.js'

/**
 * @import { VectorSearchHit, VectorSearchOptions } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { ShardState, VectorIndexDeclaration, VectorSearchRuntime } from './types.js'
 */

const PLUGIN_NAME = '@hypaware/vector-search'
const DEFAULT_TOP_K = 10

/**
 * Embed the query, fan out across every shard of the matching indexes,
 * and merge the global top-K. The query embeds *before* any refresh:
 * its dimension is the staleness signal that catches dimension drift
 * (same model, different vector length: a changed embedder
 * `dimensions` config, or a different server behind the same model
 * name) so auto-refresh re-embeds instead of hard-failing on shards it
 * just declared fresh.
 *
 * Two refresh modes, mirroring `hyp query sql --refresh`:
 *
 *  - `auto` (default): missing/stale shards rebuild first. `onProgress`
 *    receives an upfront row estimate and one line per shard so an
 *    interactive caller sees where embedding spend goes.
 *  - `never`: search existing shards as-is. A shard built with a
 *    different model or dimension than the live embedder is a hard
 *    error here: cross-model scores are meaningless and must not
 *    silently degrade.
 *
 * @param {{ runtime: VectorSearchRuntime, opts: VectorSearchOptions, onProgress?: (line: string) => void }} args
 * @returns {Promise<VectorSearchHit[]>}
 * @ref LLP 0024#indexes-are-declared-in-config-sharded-per-partition [implements]: partition discovery via the registry-backed cache, fan-out, top-K merge; model/dimension mismatch is never a silent degraded search
 */
export async function searchVectorIndexes({ runtime, opts, onProgress }) {
  const decls = selectIndexes(runtime.config.indexes, opts)
  if (decls.length === 0) {
    throw newVectorError(
      'vector_no_indexes',
      runtime.config.indexes.length === 0
        ? 'no vector indexes configured - add indexes[] to the vector-search plugin config'
        : `no configured vector index matches${opts.index ? ` index '${opts.index}'` : ''}${opts.dataset ? ` dataset '${opts.dataset}'` : ''}`
    )
  }
  const refresh = opts.refresh ?? 'auto'
  const topK = opts.topK ?? DEFAULT_TOP_K

  return withSpan(
    'vector.search',
    {
      [Attr.COMPONENT]: 'vector-search',
      [Attr.OPERATION]: 'vector.search',
      [Attr.PLUGIN]: PLUGIN_NAME,
      index_count: decls.length,
      refresh_mode: refresh,
      top_k: topK,
      status: 'ok',
    },
    async (span) => {
      const hv = await loadHypvector()
      if (!hv.ok) throw newVectorError('vector_dependency_missing', hv.message)

      const queryEmbed = await runtime.embedder.embed([opts.query], { signal: opts.signal })
      const queryVector = queryEmbed.vectors[0]

      if (refresh === 'auto') {
        await refreshForSearch({ runtime, decls, dimension: queryEmbed.dimension, onProgress })
      }

      /** @type {Array<{ decl: VectorIndexDeclaration, state: ShardState }>} */
      const searchable = []
      for (const decl of decls) {
        const partitions = await runtime.storage.discoverCachePartitions({ datasets: [decl.dataset] })
        const metas = readShardMetas(runtime.indexesDir, decl.name)
        const states = computeShardStates({
          partitions,
          metas,
          decl,
          model: runtime.embedder.model,
          dimension: queryEmbed.dimension,
        })
        for (const state of states) {
          if (!state.meta || state.meta.row_count === 0) continue
          if (state.state === 'orphan') continue
          if (state.meta.model !== runtime.embedder.model) {
            // Only reachable under refresh=never (auto just rebuilt).
            throw newVectorError(
              'vector_model_mismatch',
              `shard ${decl.name}/${state.fileBase} was built with model '${state.meta.model}' but the configured embedder is '${runtime.embedder.model}'; rerun without --no-refresh to re-embed`
            )
          }
          if (state.meta.dimension !== queryEmbed.dimension) {
            // Under refresh=never this is dimension drift the rebuild
            // would fix; under auto the shard was just rebuilt, so a
            // mismatch means the embedder itself is non-deterministic.
            throw newVectorError(
              'vector_dimension_mismatch',
              refresh === 'never'
                ? `shard ${decl.name}/${state.fileBase} has dimension ${state.meta.dimension} but the query embedded to ${queryEmbed.dimension}; rerun without --no-refresh to re-embed`
                : `shard ${decl.name}/${state.fileBase} was just rebuilt at dimension ${state.meta.dimension} but the query embedded to ${queryEmbed.dimension} - the embedder is returning inconsistent dimensions for model '${runtime.embedder.model}'`
            )
          }
          searchable.push({ decl, state })
        }
      }
      span.setAttribute('shard_count', searchable.length)
      if (searchable.length === 0) {
        span.setAttribute('row_count', 0)
        return []
      }

      const hitLists = await Promise.all(
        searchable.map(async ({ decl, state }) => {
          const { file } = shardPaths(runtime.indexesDir, decl.name, state.fileBase)
          const raw = await hv.searchVectors({
            source: file,
            query: queryVector,
            topK,
            signal: opts.signal,
          })
          return raw.map((hit) => ({
            index: decl.name,
            dataset: decl.dataset,
            partition: state.meta?.partition ?? {},
            id: String(hit.id),
            score: hit.score,
          }))
        })
      )

      const merged = mergeTopK(hitLists, topK)
      await attachHitTexts({ runtime, decls, hits: merged })
      span.setAttribute('row_count', merged.length)
      return merged
    },
    { component: 'vector-search' }
  )
}

/**
 * @param {VectorIndexDeclaration[]} indexes
 * @param {VectorSearchOptions} opts
 * @returns {VectorIndexDeclaration[]}
 */
function selectIndexes(indexes, opts) {
  return indexes.filter((decl) => {
    if (opts.index && decl.name !== opts.index) return false
    if (opts.dataset && decl.dataset !== opts.dataset) return false
    return true
  })
}

/**
 * Search-time refresh: report the pending work upfront (so the caller
 * sees the embedding spend before it happens), then rebuild with no row
 * budget: an interactive search wants a complete answer. `dimension`
 * is the length the query embedded to, so dimension drift classifies
 * stale here even when the embedder has no configured `dimensions`.
 *
 * @param {{ runtime: VectorSearchRuntime, decls: VectorIndexDeclaration[], dimension: number, onProgress?: (line: string) => void }} args
 */
async function refreshForSearch({ runtime, decls, dimension, onProgress }) {
  let pendingShards = 0
  let pendingRows = 0
  for (const decl of decls) {
    const partitions = await runtime.storage.discoverCachePartitions({ datasets: [decl.dataset] })
    const metas = readShardMetas(runtime.indexesDir, decl.name)
    const states = computeShardStates({ partitions, metas, decl, model: runtime.embedder.model, dimension })
    const estimate = estimatePendingWork(states)
    pendingShards += estimate.shards
    pendingRows += estimate.rows
  }
  if (pendingShards === 0) return

  onProgress?.(`vector: refreshing ${pendingShards} shard(s), ~${pendingRows} row(s) to embed (use --no-refresh to skip)`)
  await refreshIndexes({
    decls,
    embedder: runtime.embedder,
    storage: runtime.storage,
    indexesDir: runtime.indexesDir,
    log: runtime.log,
    dimension,
    onShard: (info) => {
      onProgress?.(`vector: built ${info.index}/${info.fileBase} (${info.rowsEmbedded} embedded, was ${info.state})`)
    },
  })
}

/**
 * Resolve hit texts back out of the cache. One pass per partition that
 * actually holds hits, stopping early once every id in that partition
 * is resolved. Never a scan over partitions without hits.
 *
 * @param {{ runtime: VectorSearchRuntime, decls: VectorIndexDeclaration[], hits: VectorSearchHit[] }} args
 */
async function attachHitTexts({ runtime, decls, hits }) {
  const declByName = new Map(decls.map((d) => [d.name, d]))

  /** @type {Map<string, { decl: VectorIndexDeclaration, partitionPath: string, byId: Map<string, VectorSearchHit[]> }>} */
  const groups = new Map()
  for (const hit of hits) {
    const decl = declByName.get(hit.index)
    if (!decl) continue
    const key = `${hit.index}|${shardFileBase(hit.partition)}`
    let group = groups.get(key)
    if (!group) {
      const partitions = await runtime.storage.discoverCachePartitions({ datasets: [decl.dataset] })
      const partition = partitions.find((p) => shardFileBase(p.partition) === shardFileBase(hit.partition))
      if (!partition) continue
      group = { decl, partitionPath: partition.path, byId: new Map() }
      groups.set(key, group)
    }
    const list = group.byId.get(hit.id) ?? []
    list.push(hit)
    group.byId.set(hit.id, list)
  }

  for (const group of groups.values()) {
    const { decl } = group
    const columns = decl.id_column ? [decl.column, decl.id_column] : [decl.column]
    let remaining = group.byId.size
    for await (const row of runtime.storage.readRows(group.partitionPath, columns)) {
      const text = row[decl.column]
      if (typeof text !== 'string' || text.length === 0) continue
      const id = decl.id_column ? row[decl.id_column] : contentId(text)
      if (typeof id !== 'string') continue
      const matched = group.byId.get(id)
      if (!matched || matched[0].text !== undefined) continue
      for (const hit of matched) hit.text = text
      remaining--
      if (remaining === 0) break
    }
  }
}
