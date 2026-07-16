// @ts-check

import path from 'node:path'
import { createHash } from 'node:crypto'

import { discoverCachePartitions } from '../../../../src/core/cache/partition.js'
import { unionSources, emptySource } from 'hypaware/core/query'

/**
 * @import { ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, QueryPartition, QueryStorageService } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 * @import { AsyncDataSource } from 'squirreling'
 */

export const PLUGIN_NAME = '@hypaware/context-graph-enrich'

/** Versioned partition label for the derived enrichment tables. */
export const PARTITION_LABEL = 'enrich_v1'

export const PROSPECTS_DATASET = 'enrichment_prospects'
export const RESOLUTIONS_DATASET = 'enrichment_resolutions'
export const COMMITTED_DATASET = 'enrichment_committed'

/**
 * T1 output: prospect knowledge items proposed from source text. Each
 * anchors to a T0 activity node (`anchor_type`/`anchor_key`) and carries
 * provenance back to the source rows. The working queue for T2.
 *
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const PROSPECT_COLUMNS = Object.freeze([
  { name: 'prospect_id',       type: 'STRING',    nullable: false },
  { name: 'prospect_type',     type: 'STRING',    nullable: false },
  { name: 'label',             type: 'STRING',    nullable: true  },
  { name: 'props',             type: 'JSON',      nullable: true  },
  { name: 'confidence',        type: 'DOUBLE',    nullable: true  },
  { name: 'evidence',          type: 'STRING',    nullable: true  },
  { name: 'anchor_type',       type: 'STRING',    nullable: false },
  { name: 'anchor_key',        type: 'STRING',    nullable: false },
  { name: 'source_dataset',    type: 'STRING',    nullable: false },
  { name: 'source_keys',       type: 'JSON',      nullable: true  },
  { name: 'extractor',         type: 'STRING',    nullable: false },
  { name: 'extractor_version', type: 'INT32',     nullable: false },
  { name: 'created_at',        type: 'TIMESTAMP', nullable: true  },
])

/**
 * T2 decisions, one row per resolved prospect. Append-only: a prospect is
 * "pending" iff its id has no resolution. Rejected prospects get a
 * `reject` row and are never written to {@link COMMITTED_DATASET}.
 *
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const RESOLUTION_COLUMNS = Object.freeze([
  { name: 'prospect_id',     type: 'STRING',    nullable: false },
  { name: 'decision',        type: 'STRING',    nullable: false }, // commit | merge | deepen | reject | skip (salience auto-skip)
  { name: 'committed_ids',   type: 'JSON',      nullable: true  },
  { name: 'note',            type: 'STRING',    nullable: true  },
  { name: 'curator',         type: 'STRING',    nullable: false },
  { name: 'curator_version', type: 'INT32',     nullable: false },
  { name: 'resolved_at',     type: 'TIMESTAMP', nullable: true  },
])

/**
 * T2 output: committed knowledge items. The only dataset the graph
 * contract reads. `item_id` is the enrichment node's natural key (the kit
 * hashes it into a node id); `anchor_*` links it back to its T0 activity node.
 *
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const COMMITTED_COLUMNS = Object.freeze([
  { name: 'item_id',         type: 'STRING',    nullable: false },
  { name: 'item_type',       type: 'STRING',    nullable: false },
  { name: 'label',           type: 'STRING',    nullable: true  },
  { name: 'props',           type: 'JSON',      nullable: true  },
  { name: 'confidence',      type: 'DOUBLE',    nullable: true  },
  { name: 'anchor_type',     type: 'STRING',    nullable: false },
  { name: 'anchor_key',      type: 'STRING',    nullable: false },
  { name: 'source_dataset',  type: 'STRING',    nullable: false },
  { name: 'source_keys',     type: 'JSON',      nullable: true  },
  { name: 'curator',         type: 'STRING',    nullable: false },
  { name: 'curator_version', type: 'INT32',     nullable: false },
  { name: 'committed_at',    type: 'TIMESTAMP', nullable: true  },
])

const COLUMNS = /** @type {Record<string, ReadonlyArray<ColumnSpec>>} */ ({
  [PROSPECTS_DATASET]: PROSPECT_COLUMNS,
  [RESOLUTIONS_DATASET]: RESOLUTION_COLUMNS,
  [COMMITTED_DATASET]: COMMITTED_COLUMNS,
})

/**
 * Spool/label table path the plugin appends to. Mirrors the context-graph
 * derived-table convention (see context-graph/src/datasets.js).
 *
 * @param {QueryStorageService} storage
 * @param {string} dataset
 */
export function enrichTablePath(storage, dataset) {
  return storage.cacheTablePath(dataset, [PARTITION_LABEL])
}

/**
 * Columns for a known enrichment dataset.
 *
 * @param {string} dataset
 * @returns {ReadonlyArray<ColumnSpec>}
 */
export function columnsFor(dataset) {
  const cols = COLUMNS[dataset]
  if (!cols) throw new Error(`${PLUGIN_NAME}: unknown dataset '${dataset}'`)
  return cols
}

/**
 * Build the `DatasetRegistration` for an enrichment dataset so its rows are
 * queryable by name (the contract's SQL and the curate queue both depend on
 * this). Generic over the three datasets: same discovery/data-source shape
 * the context-graph plugin uses for node/edge.
 *
 * @param {string} dataset
 * @param {string} timestampColumn
 * @returns {DatasetRegistration}
 */
export function enrichDatasetRegistration(dataset, timestampColumn) {
  return {
    name: dataset,
    plugin: PLUGIN_NAME,
    schema: { columns: [...columnsFor(dataset)] },
    primaryTimestampColumn: timestampColumn,
    discoverPartitions: (ctx) => discoverParts(ctx, dataset),
    refreshPartition: async () => /** @type {DatasetRefreshResult} */ ({ status: 'skipped', rows: 0 }),
    createDataSource: (partitions, ctx) => createDataSource(partitions, ctx, dataset),
  }
}

/**
 * @param {DatasetDiscoveryContext} ctx
 * @param {string} dataset
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
 * @param {QueryPartition[]} partitions
 * @param {DatasetDataSourceContext} ctx
 * @param {string} dataset
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
    // Skip only sources KNOWN empty. icebird omits numRows when the current
    // snapshot carries position deletes (a live count would need a scan), so
    // treating undefined as 0 here silently dropped every partition touched
    // by a retention or purge delete and blinded all queries to surviving rows.
    // @ref LLP 0104 [constrained-by]: position deletes leave an unknowable count that must not read as an empty partition
    if (source && source.numRows !== 0) sources.push(source)
  }

  if (sources.length === 0) return emptySource(columnsFor(dataset).map((c) => c.name))
  if (sources.length === 1) return sources[0]
  return unionSources(sources)
}

/**
 * Deterministic prospect id: stable across re-runs of the same extractor
 * version over the same source provenance + candidate key, so re-proposing
 * the same content dedups instead of duplicating. This determinism is what
 * lets propose filter against already-persisted ids for cross-tick idempotency
 * (see propose.js `filterNewProspects`).
 *
 * @ref LLP 0028#idempotent-prospects [implements]:
 *
 * @param {{ extractor: string, extractorVersion: number, anchorKey: string, candidateKey: string }} parts
 * @returns {string}
 */
export function prospectId({ extractor, extractorVersion, anchorKey, candidateKey }) {
  return createHash('sha256')
    .update(`prospect\0${extractor}\0${extractorVersion}\0${anchorKey}\0${candidateKey}`)
    .digest('hex')
    .slice(0, 24)
}
