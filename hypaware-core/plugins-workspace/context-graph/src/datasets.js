// @ts-check

import path from 'node:path'

import { discoverCachePartitions } from '../../../../src/core/cache/partition.js'
import { unionSources, emptySource } from 'hypaware/core/query'

/**
 * @import { ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, QueryPartition, QueryStorageService, ScannableDataSource } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 */

export const PLUGIN_NAME = '@hypaware/context-graph'

/** Versioned partition label for the derived graph tables. */
export const PARTITION_LABEL = 'graph_v1'

export const NODE_DATASET = 'node'
export const EDGE_DATASET = 'edge'

/**
 * `node` columns. Provenance is carried inline (source_dataset / source_keys /
 * projector / projector_version), a v1 simplification of the separate
 * provenance-table design.
 *
 * @type {ReadonlyArray<ColumnSpec>}
 * @ref LLP 0023#inline-provenance: first sighting's keys as exemplar; a join table waits for a consumer that needs full lineage
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
  // @ref LLP 0616#column [implements]: the folders that contributed, as a sorted JSON array string; null means unknown
  { name: 'source_cwds',       type: 'STRING',    nullable: true  },
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
  { name: 'source_cwds',       type: 'STRING',    nullable: true  },
])

const COLUMNS = { node: NODE_COLUMNS, edge: EDGE_COLUMNS }

/**
 * Content-bearing columns per graph dataset, for the LLP 0105 query
 * visibility filter. Graph rows aggregate across sessions and carry no
 * per-row `cwd`; instead each row records the folders that contributed to it
 * in `source_cwds`. The shared filter classifies those folders at read time:
 * a caller whose context may not see one of them, or any caller reading a row
 * whose provenance is unknown (null), gets these columns nulled while the
 * structural columns (content-addressed ids and types) keep the graph
 * walkable. Keys, labels, and props can carry session-derived text and
 * paths; `source_keys` carries the originating row keys; `source_cwds` is
 * itself folder paths.
 *
 * @ref LLP 0105#graph-provenance [implements]: graph rows expose structure, never content, to callers their folders outrank
 * @ref LLP 0616#column [implements]: source_cwds is declared content, so it never names a local-only folder to a syncing caller
 */
const CONTENT_COLUMNS = {
  node: ['natural_key', 'label', 'props', 'source_keys', 'source_cwds'],
  edge: ['props', 'source_keys', 'source_cwds'],
}

// Stable callbacks let maintenance distinguish this unscoped read union from
// a host-provided discovery function that explicitly selects one org's graph.
/** @type {Record<'node' | 'edge', DatasetRegistration['discoverPartitions']>} */
const DISCOVER_PARTITIONS = {
  node: ctx => discoverParts(ctx, NODE_DATASET),
  edge: ctx => discoverParts(ctx, EDGE_DATASET),
}

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
    localOnlyContentColumns: [...CONTENT_COLUMNS[dataset]],
    primaryTimestampColumn: 'first_seen',
    discoverPartitions: DISCOVER_PARTITIONS[dataset],
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
 * @returns {Promise<ScannableDataSource>}
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

  /** @type {ScannableDataSource[]} */
  const sources = []
  for (const tablePath of tablePaths) {
    const source = await storage.dataSourceForTable(tablePath)
    // Skip only sources KNOWN empty. icebird omits numRows when the current
    // snapshot carries position deletes (a live count would need a scan), so
    // treating undefined as 0 here silently dropped every partition touched
    // by a retention or purge delete and blinded all queries to surviving rows.
    // @ref LLP 0104 [constrained-by]: position deletes leave an unknowable count that must not read as an empty partition
    if (source && source.numRows !== 0) sources.push(source)
  }

  if (sources.length === 0) return emptySource(COLUMNS[dataset].map((c) => c.name))
  if (sources.length === 1) return sources[0]
  return unionSources(sources)
}
