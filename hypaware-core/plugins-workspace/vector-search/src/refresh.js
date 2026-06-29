// @ts-check

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { loadHypvector } from './hypvector.js'
import { computeShardStates, contentId, readShardMetas, REBUILD_STATES, shardPaths } from './shards.js'

/**
 * @import { CachePartitionMeta, EmbedderCapability, HypError, PluginLogger } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 * @import { RefreshBudget, RefreshReport, ShardMeta, ShardState, VectorIndexDeclaration } from './types.js'
 */

const PLUGIN_NAME = '@hypaware/vector-search'

/**
 * Bring every configured index up to date, incrementally: only
 * missing/stale shards are rebuilt, orphaned shards are swept, and the
 * optional budget bounds wall-clock and embedding spend. Budgets are
 * soft: they gate *starting* a shard, not finishing it, so one
 * oversized partition overshoots a tick once instead of starving
 * forever.
 *
 * Each shard write is durable (tmp file + rename), so an interrupted
 * cold build resumes where it left off on the next run.
 *
 * @param {{
 *   decls: VectorIndexDeclaration[],
 *   embedder: EmbedderCapability,
 *   storage: ExtendedQueryStorageService,
 *   indexesDir: string,
 *   log: PluginLogger,
 *   budget?: RefreshBudget,
 *   dimension?: number,
 *   onShard?: (info: { index: string, fileBase: string, state: string, rowsEmbedded: number }) => void,
 * }} args
 * @returns {Promise<RefreshReport>}
 * @ref LLP 0024#freshness-rides-the-cache-maintenance-pattern [implements]: incremental per-partition shard builds under a tick budget; per-shard writes are durable
 */
export async function refreshIndexes({ decls, embedder, storage, indexesDir, log, budget, dimension, onShard }) {
  /** @type {RefreshReport} */
  const report = {
    shardsBuilt: 0,
    shardsSkipped: 0,
    orphansSwept: 0,
    rowsEmbedded: 0,
    budgetExhausted: false,
  }

  for (const decl of decls) {
    const partitions = await storage.discoverCachePartitions({ datasets: [decl.dataset] })
    const metas = readShardMetas(indexesDir, decl.name)
    const states = computeShardStates({
      partitions,
      metas,
      decl,
      model: embedder.model,
      // Without a configured dimension the daemon cannot detect
      // dimension drift; the search path closes that gap with the
      // dimension the query embedded to.
      dimension: embedder.dimensions ?? dimension,
    })

    // Orphans sweep even on an exhausted budget: deletion is cheap and
    // never spends embedding tokens.
    for (const state of states) {
      if (state.state === 'orphan') {
        sweepOrphan(indexesDir, decl.name, state.fileBase, log)
        report.orphansSwept++
      }
    }

    const pending = states.filter((s) => REBUILD_STATES.has(s.state))
    for (let i = 0; i < pending.length; i++) {
      if (budgetSpent(budget, report)) {
        report.shardsSkipped += pending.length - i
        report.budgetExhausted = true
        break
      }
      const state = pending[i]
      const partition = /** @type {CachePartitionMeta} */ (state.partition)
      const built = await buildShard({ decl, partition, state, embedder, storage, indexesDir, log })
      report.shardsBuilt++
      report.rowsEmbedded += built.rowsEmbedded
      onShard?.({ index: decl.name, fileBase: state.fileBase, state: state.state, rowsEmbedded: built.rowsEmbedded })
    }
  }

  return report
}

/**
 * @param {RefreshBudget | undefined} budget
 * @param {RefreshReport} report
 * @returns {boolean}
 */
function budgetSpent(budget, report) {
  if (!budget) return false
  if (budget.deadlineMs !== undefined && Date.now() > budget.deadlineMs) return true
  if (budget.maxRows !== undefined && report.rowsEmbedded >= budget.maxRows) return true
  return false
}

/**
 * Estimate the refresh work a search would trigger: cache rows behind
 * every missing/stale shard. An over-estimate when texts repeat (the
 * content-hash id dedups before embedding), which is the right
 * direction for an upfront spend warning.
 *
 * @param {ShardState[]} states
 * @returns {{ shards: number, rows: number }}
 */
export function estimatePendingWork(states) {
  let shards = 0
  let rows = 0
  for (const s of states) {
    if (REBUILD_STATES.has(s.state)) {
      shards++
      rows += s.partition?.rowCount ?? 0
    }
  }
  return { shards, rows }
}

/**
 * In-process per-shard build serialization. Search-time refresh and the
 * daemon tick share a process when search runs through the capability,
 * so two builds of the same shard can otherwise interleave their
 * parquet/sidecar writes. Keyed by the shard's final file path; entries
 * are dropped once the tail build settles.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const shardBuildLocks = new Map()

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withShardBuildLock(key, fn) {
  const tail = shardBuildLocks.get(key) ?? Promise.resolve()
  const run = tail.then(fn, fn)
  const settled = run.catch(() => {})
  shardBuildLocks.set(key, settled)
  settled.then(() => {
    if (shardBuildLocks.get(key) === settled) shardBuildLocks.delete(key)
  })
  return run
}

/**
 * Build one shard: read the partition's rows from the cache, dedup by
 * id, embed, and write the hypvector file + sidecar atomically. Builds
 * of the same shard serialize in-process; temp names carry pid + a
 * UUID so concurrent processes (CLI search vs daemon tick) can never
 * write the same temp file, and the final rename stays atomic:
 * last-writer-wins on identical inputs.
 *
 * @param {{
 *   decl: VectorIndexDeclaration,
 *   partition: CachePartitionMeta,
 *   state: ShardState,
 *   embedder: EmbedderCapability,
 *   storage: ExtendedQueryStorageService,
 *   indexesDir: string,
 *   log: PluginLogger,
 * }} args
 * @returns {Promise<{ rowsEmbedded: number }>}
 * @ref LLP 0024#index-files-are-plugin-state [implements]: shards are derived artifacts under plugin state, rebuilt from the cache
 */
async function buildShard({ decl, partition, state, embedder, storage, indexesDir, log }) {
  const { file } = shardPaths(indexesDir, decl.name, state.fileBase)
  return withShardBuildLock(file, () => buildShardLocked({ decl, partition, state, embedder, storage, indexesDir, log }))
}

/**
 * @param {{
 *   decl: VectorIndexDeclaration,
 *   partition: CachePartitionMeta,
 *   state: ShardState,
 *   embedder: EmbedderCapability,
 *   storage: ExtendedQueryStorageService,
 *   indexesDir: string,
 *   log: PluginLogger,
 * }} args
 * @returns {Promise<{ rowsEmbedded: number }>}
 */
async function buildShardLocked({ decl, partition, state, embedder, storage, indexesDir, log }) {
  return withSpan(
    'vector.build_shard',
    {
      [Attr.COMPONENT]: 'vector-search',
      [Attr.OPERATION]: 'vector.build_shard',
      [Attr.PLUGIN]: PLUGIN_NAME,
      [Attr.DATASET]: decl.dataset,
      vector_index: decl.name,
      shard: state.fileBase,
      shard_reason: state.state,
      status: 'ok',
    },
    async (span) => {
      const hv = await loadHypvector()
      if (!hv.ok) throw newVectorError('vector_dependency_missing', hv.message)

      const texts = await collectShardTexts({ decl, partition, storage })
      span.setAttribute('unique_text_count', texts.size)

      const { file, meta } = shardPaths(indexesDir, decl.name, state.fileBase)
      await fsPromises.mkdir(path.dirname(file), { recursive: true })

      let dimension = 0
      let rowsEmbedded = 0
      if (texts.size > 0) {
        const ids = Array.from(texts.keys())
        const result = await embedder.embed(Array.from(texts.values()))
        dimension = result.dimension
        rowsEmbedded = result.vectors.length

        const tmpFile = `${file}.tmp-${process.pid}-${randomUUID()}`
        try {
          await hv.writeVectors({
            writer: hv.fileWriter(tmpFile),
            vectors: ids.map((id, i) => ({ id, vector: result.vectors[i] })),
            dimension,
            normalize: true,
            metric: 'cosine',
          })
          await fsPromises.rename(tmpFile, file)
        } catch (err) {
          await fsPromises.rm(tmpFile, { force: true })
          throw err
        }
      } else {
        // Nothing embeddable: drop any previous generation so search
        // cannot hit stale vectors, and record an empty shard so the
        // next tick does not re-read the partition.
        await fsPromises.rm(file, { force: true })
      }

      /** @type {ShardMeta} */
      const shardMeta = {
        schema_version: 1,
        index: decl.name,
        dataset: decl.dataset,
        column: decl.column,
        ...(decl.id_column !== undefined ? { id_column: decl.id_column } : {}),
        partition: partition.partition,
        model: embedder.model,
        dimension,
        row_count: rowsEmbedded,
        source_row_count: partition.rowCount,
        built_at: new Date().toISOString(),
      }
      const tmpMeta = `${meta}.tmp-${process.pid}-${randomUUID()}`
      await fsPromises.writeFile(tmpMeta, JSON.stringify(shardMeta, null, 2) + '\n', 'utf8')
      await fsPromises.rename(tmpMeta, meta)

      span.setAttribute('row_count', rowsEmbedded)
      span.setAttribute('dimension', dimension)
      span.setAttribute('embed_model', embedder.model)

      log.info('vector.shard_built', {
        [Attr.DATASET]: decl.dataset,
        vector_index: decl.name,
        shard: state.fileBase,
        shard_reason: state.state,
        row_count: rowsEmbedded,
        source_row_count: partition.rowCount,
      })

      return { rowsEmbedded }
    },
    { component: 'vector-search' }
  )
}

/**
 * Materialize the partition's embeddable texts, deduplicated by id.
 * Only non-empty string cells embed; everything else is skipped. The
 * id is the configured `id_column` value, or a hash of the text itself
 * (which collapses repeated texts into one vector).
 *
 * @param {{ decl: VectorIndexDeclaration, partition: CachePartitionMeta, storage: ExtendedQueryStorageService }} args
 * @returns {Promise<Map<string, string>>}
 */
export async function collectShardTexts({ decl, partition, storage }) {
  /** @type {Map<string, string>} */
  const texts = new Map()
  const columns = decl.id_column ? [decl.column, decl.id_column] : [decl.column]
  for await (const row of storage.readRows(partition.path, columns)) {
    const text = row[decl.column]
    if (typeof text !== 'string' || text.length === 0) continue
    const id = decl.id_column ? row[decl.id_column] : contentId(text)
    if (typeof id !== 'string' || id.length === 0) continue
    if (!texts.has(id)) texts.set(id, text)
  }
  return texts
}

/**
 * @param {string} indexesDir
 * @param {string} indexName
 * @param {string} fileBase
 * @param {PluginLogger} log
 */
function sweepOrphan(indexesDir, indexName, fileBase, log) {
  const { file, meta } = shardPaths(indexesDir, indexName, fileBase)
  try {
    fs.rmSync(file, { force: true })
    fs.rmSync(meta, { force: true })
    log.info('vector.orphan_swept', { vector_index: indexName, shard: fileBase })
  } catch (err) {
    log.warn('vector.orphan_sweep_failed', {
      vector_index: indexName,
      shard: fileBase,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * @param {string} kind
 * @param {string} message
 * @returns {HypError}
 */
export function newVectorError(kind, message) {
  const err = /** @type {HypError} */ (new Error(message))
  err.hypErrorKind = kind
  return err
}
