// @ts-check

import path from 'node:path'

import { discoverCachePartitions } from '../../../../src/core/cache/partition.js'
import { unionSources, emptySource } from 'hypaware/core/query'

/**
 * @import { ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, QueryPartition, QueryStorageService } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 * @import { AsyncDataSource } from 'squirreling'
 */

export const DATASET_NAME = 'gascity_messages'
export const PARTITION_LABEL = 'all'

/**
 * Stable column order for the `gascity_messages` dataset, trimmed to
 * what V1 needs: `city` and `provider_session_id` carry session
 * identity, `event_time` is the primary timestamp, and `metadata`
 * carries everything the normalizer doesn't hoist (including
 * `dev_run_id` from the harness so smoke flows can filter by run).
 *
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const GASCITY_SCHEMA_COLUMNS = Object.freeze([
  { name: 'city',                type: 'STRING',    nullable: false },
  { name: 'provider_session_id', type: 'STRING',    nullable: false },
  { name: 'event_time',          type: 'TIMESTAMP', nullable: false },
  { name: 'event_kind',          type: 'STRING',    nullable: false },
  { name: 'template',            type: 'STRING',    nullable: true  },
  { name: 'content_text',        type: 'STRING',    nullable: true  },
  { name: 'metadata',            type: 'JSON',      nullable: true  },
])

/**
 * Dataset schema in the `DatasetRegistration` shape.
 *
 * @type {{ columns: ColumnSpec[] }}
 */
export const GASCITY_SCHEMA = { columns: [...GASCITY_SCHEMA_COLUMNS] }

/**
 * Compute the on-disk table path for `gascity_messages`. The plugin
 * writes through the kernel cache service; the service owns durable
 * spool and Iceberg flush details.
 *
 * @param {QueryStorageService} storage
 */
export function gascityTablePath(storage) {
  return storage.cacheTablePath(DATASET_NAME, [PARTITION_LABEL])
}

/**
 * The kernel cache flush path commits spooled rows under
 * `source=<client>` partitions (gascity rows carry no
 * `cachePartitioning` declaration), *not* under the `PARTITION_LABEL`
 * directory the source spools to. So the lone hardcoded
 * `gascity_messages/all` partition never surfaces committed data.
 * Discovery scans the on-disk `source=` partitions the same way every
 * other cache-backed dataset does (cf. otel, ai-gateway). The
 * `PARTITION_LABEL` spool path is still listed so any pending rows
 * there get flushed during query settlement before `createDataSource`
 * reads.
 *
 * @param {DatasetDiscoveryContext} ctx
 * @returns {Promise<QueryPartition[]>}
 */
export async function discoverParts(ctx) {
  const cacheDir = ctx.cacheDir ?? ''
  if (!cacheDir) return []

  /** @type {QueryPartition[]} */
  const partitions = []
  /** @type {Set<string>} */
  const seen = new Set()

  const spoolPath = path.join(cacheDir, 'datasets', DATASET_NAME, PARTITION_LABEL)
  partitions.push({ dataset: DATASET_NAME, partition: { partition: PARTITION_LABEL }, tablePath: spoolPath })
  seen.add(spoolPath)

  const discovered = await discoverCachePartitions(cacheDir, { datasets: [DATASET_NAME] })
  for (const p of discovered) {
    if (seen.has(p.path)) continue
    seen.add(p.path)
    partitions.push({ dataset: DATASET_NAME, partition: p.partition, tablePath: p.path })
  }

  return partitions
}

/**
 * Live-ingest refresh path: gascity writes rows through the kernel
 * cache service from the supervisor subscriber, so there is no external
 * source file to refresh here. The contract still wants a result, so
 * report `skipped` with zero rows (a sentinel the query layer tolerates
 * per `dataset.refreshPartition` semantics).
 *
 * @param {QueryPartition} _partition
 * @returns {Promise<DatasetRefreshResult>}
 */
export async function refreshPartition(_partition) {
  return { status: 'skipped', rows: 0 }
}

/**
 * Union every discovered partition's source. Re-discovers from the live
 * cache root so rows flushed out of the spool during settlement (after
 * the initial `discoverParts`) are picked up. Returns an empty source
 * when no table has been materialized so
 * `select count(*) from gascity_messages` still succeeds on a cold cache.
 *
 * @param {QueryPartition[]} partitions
 * @param {DatasetDataSourceContext} ctx
 */
export async function createDataSource(partitions, ctx) {
  const storage = /** @type {ExtendedQueryStorageService} */ (ctx.storage)

  const fresh = await discoverCachePartitions(storage.cacheRoot, { datasets: [DATASET_NAME] })

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

  if (sources.length === 0) return emptySource(GASCITY_SCHEMA_COLUMNS.map((c) => c.name))
  if (sources.length === 1) return sources[0]
  return unionSources(sources)
}

/**
 * Resolve the dataset registration handed to `ctx.query.registerDataset`.
 *
 * @returns {DatasetRegistration}
 */
export function gascityDatasetRegistration() {
  return {
    name: DATASET_NAME,
    plugin: '@hypaware/gascity',
    schema: GASCITY_SCHEMA,
    primaryTimestampColumn: 'event_time',
    discoverPartitions: discoverParts,
    refreshPartition,
    createDataSource,
  }
}
