// @ts-check

import path from 'node:path'

import { discoverCachePartitions } from '../../../../src/core/cache/partition.js'
import { unionSources, emptySource } from 'hypaware/core/query'

/**
 * @import { ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, QueryPartition, QueryStorageService } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'
 * @import { AsyncDataSource } from 'squirreling'
 */

export const PLUGIN_NAME = '@hypaware/context-graph'

/** Versioned partition label for the derived graph tables. */
export const PARTITION_LABEL = 'graph_v1'

export const NODE_DATASET = 'node'
export const EDGE_DATASET = 'edge'

/**
 * `node` columns. Provenance is carried inline (source_dataset / source_keys /
 * projector / projector_version) — a v1 simplification of the separate
 * provenance-table design.
 *
 * @type {ReadonlyArray<ColumnSpec>}
 * @ref LLP 0023#inline-provenance — first sighting's keys as exemplar; a join table waits for a consumer that needs full lineage
 */
export const NODE_COLUMNS = Object.freeze([
  { name: 'node_id',           type: 'STRING',    nullable: false },
  { name: 'node_type',         type: 'STRING',    nullable: false },
  { name: 'natural_key',       type: 'STRING',    nullable: false },
  { name: 'label',             type: 'STRING',    nullable: true  },
  { name: 'props',             type: 'JSON',      nullable: true  },
  { name: 'first_seen',        type: 'TIMESTAMP', nullable: true  },
  { name: 'source_dataset',    type: 'STRING',    nullable: false },
  { name: 'source_keys',       type: 'JSON',      nullable: true  },
  { name: 'projector',         type: 'STRING',    nullable: false },
  { name: 'projector_version', type: 'INT32',     nullable: false },
])

/** @type {ReadonlyArray<ColumnSpec>} */
export const EDGE_COLUMNS = Object.freeze([
  { name: 'edge_id',           type: 'STRING',    nullable: false },
  { name: 'edge_type',         type: 'STRING',    nullable: false },
  { name: 'src_id',            type: 'STRING',    nullable: false },
  { name: 'dst_id',            type: 'STRING',    nullable: false },
  { name: 'src_type',          type: 'STRING',    nullable: false },
  { name: 'dst_type',          type: 'STRING',    nullable: false },
  { name: 'props',             type: 'JSON',      nullable: true  },
  { name: 'first_seen',        type: 'TIMESTAMP', nullable: true  },
  { name: 'source_dataset',    type: 'STRING',    nullable: false },
  { name: 'source_keys',       type: 'JSON',      nullable: true  },
  { name: 'projector',         type: 'STRING',    nullable: false },
  { name: 'projector_version', type: 'INT32',     nullable: false },
])

const COLUMNS = { node: NODE_COLUMNS, edge: EDGE_COLUMNS }

/**
 * Spool/label table path the projector appends to. On flush the storage
 * service re-routes rows to `<dataset>/source=<...>/table/`; queries find
 * them via `discoverCachePartitions` (see createDataSource).
 *
 * @param {QueryStorageService} storage
 * @param {'node' | 'edge'} dataset
 */
export function graphTablePath(storage, dataset) {
  return storage.cacheTablePath(dataset, [PARTITION_LABEL])
}

/**
 * @param {'node' | 'edge'} dataset
 * @returns {DatasetRegistration}
 */
export function graphDatasetRegistration(dataset) {
  return {
    name: dataset,
    plugin: PLUGIN_NAME,
    schema: { columns: [...COLUMNS[dataset]] },
    primaryTimestampColumn: 'first_seen',
    discoverPartitions: (ctx) => discoverParts(ctx, dataset),
    refreshPartition: async () => /** @type {DatasetRefreshResult} */ ({ status: 'skipped', rows: 0 }),
    createDataSource: (partitions, ctx) => createDataSource(partitions, ctx, dataset),
  }
}

/**
 * Discover partitions for a derived graph dataset. Always includes the
 * label/spool path first so query settlement flushes pending rows, then
 * unions any committed `source=...` partitions found on disk.
 *
 * @param {DatasetDiscoveryContext} ctx
 * @param {'node' | 'edge'} dataset
 * @returns {Promise<QueryPartition[]>}
 */
async function discoverParts(ctx, dataset) {
  const cacheDir = ctx.cacheDir ?? ''
  if (!cacheDir) return []

  /** @type {QueryPartition[]} */
  const partitions = []
  const seen = new Set()

  const labelPath = path.join(cacheDir, 'datasets', dataset, PARTITION_LABEL)
  partitions.push({ dataset, partition: { partition: PARTITION_LABEL }, tablePath: labelPath })
  seen.add(labelPath)

  const discovered = await discoverCachePartitions(cacheDir, { datasets: [dataset] })
  for (const p of discovered) {
    if (seen.has(p.path)) continue
    seen.add(p.path)
    partitions.push({ dataset, partition: p.partition, tablePath: p.path })
  }

  return partitions
}

/**
 * Build a squirreling AsyncDataSource over every committed partition for
 * the dataset. Re-discovers to pick up partitions flushed during query
 * settlement (the label path holds only the spool; flushed rows land under
 * `source=...`).
 *
 * @param {QueryPartition[]} partitions
 * @param {DatasetDataSourceContext} ctx
 * @param {'node' | 'edge'} dataset
 * @returns {Promise<AsyncDataSource>}
 */
async function createDataSource(partitions, ctx, dataset) {
  const storage = /** @type {ExtendedQueryStorageService} */ (ctx.storage)
  const fresh = await discoverCachePartitions(storage.cacheRoot, { datasets: [dataset] })

  /** @type {Set<string>} */
  const tablePaths = new Set()
  for (const p of partitions) {
    if (p.tablePath) tablePaths.add(p.tablePath)
  }
  for (const p of fresh) tablePaths.add(p.path)

  /** @type {AsyncDataSource[]} */
  const sources = []
  for (const tablePath of tablePaths) {
    const source = await storage.dataSourceForTable(tablePath)
    if (source && (source.numRows ?? 0) > 0) sources.push(source)
  }

  if (sources.length === 0) return emptySource(COLUMNS[dataset].map((c) => c.name))
  if (sources.length === 1) return sources[0]
  return unionSources(sources)
}
