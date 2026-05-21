// @ts-check

import path from 'node:path'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').ColumnSpec} ColumnSpec */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').DatasetRegistration} DatasetRegistration */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').DatasetDiscoveryContext} DatasetDiscoveryContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').DatasetDataSourceContext} DatasetDataSourceContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').QueryPartition} QueryPartition */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').QueryStorageService} QueryStorageService */

export const DATASET_NAME = 'gascity_messages'
export const PARTITION_LABEL = 'all'

/**
 * Stable column order for the `gascity_messages` dataset. A trimmed
 * projection of the donor schema (Collectivus `gascity_messages.schema`)
 * sufficient for V1 — `city` and `provider_session_id` carry session
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
 * Discover the single `gascity_messages` partition. The kernel cache
 * is HypAware-managed; per the design `discoverPartitions` only needs
 * to surface the path so the query layer can scan it.
 *
 * @param {DatasetDiscoveryContext} ctx
 * @returns {QueryPartition[]}
 */
export function discoverParts(ctx) {
  const cacheDir = ctx.cacheDir ?? ''
  if (!cacheDir) return []
  const tablePath = path.join(cacheDir, 'datasets', DATASET_NAME, PARTITION_LABEL)
  return [{
    dataset: DATASET_NAME,
    partition: { partition: PARTITION_LABEL },
    tablePath,
  }]
}

/**
 * Live-ingest refresh path — gascity writes rows through the kernel
 * cache service from the supervisor subscriber, so there is no external
 * source file to refresh here. The contract still wants a result, so
 * report `skipped` with zero rows (a sentinel the query layer tolerates
 * per `dataset.refreshPartition` semantics).
 *
 * @param {QueryPartition} _partition
 * @returns {Promise<import('../../../../collectivus-plugin-kernel-types').DatasetRefreshResult>}
 */
export async function refreshPartition(_partition) {
  return { status: 'skipped', rows: 0 }
}

/**
 * Build a squirreling-compatible data source over the gascity
 * partition. Returns an empty source when the table has not yet been
 * materialized so `select count(*) from gascity_messages` still
 * succeeds on a cold cache.
 *
 * @param {QueryPartition[]} partitions
 * @param {DatasetDataSourceContext} ctx
 */
export async function createDataSource(partitions, ctx) {
  const partition = partitions[0]
  if (!partition || !partition.tablePath) return emptySource()
  const storage = /** @type {import('../../../../src/core/cache/storage.js').ExtendedQueryStorageService} */ (
    ctx.storage
  )
  const source = await storage.dataSourceForTable(partition.tablePath)
  return source ?? emptySource()
}

function emptySource() {
  return {
    columns: GASCITY_SCHEMA_COLUMNS.map((c) => c.name),
    numRows: 0,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {},
      }
    },
  }
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
