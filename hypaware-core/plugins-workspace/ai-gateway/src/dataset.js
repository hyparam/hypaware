// @ts-check

import path from 'node:path'

import { AI_GATEWAY_MESSAGE_COLUMNS } from './message_projector.js'

/**
 * @import { ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, QueryPartition, QueryStorageService } from '../../../../collectivus-plugin-kernel-types'
 */

export const DATASET_NAME = 'ai_gateway_messages'
export const PARTITION_LABEL = 'proxy_messages_v4'

/**
 * Column shape for `ai_gateway_messages`. The shape is owned by the
 * AI gateway plugin and versioned through the partition label.
 *
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const AI_GATEWAY_SCHEMA_COLUMNS = AI_GATEWAY_MESSAGE_COLUMNS

/** @type {{ columns: ColumnSpec[] }} */
export const AI_GATEWAY_SCHEMA = { columns: [...AI_GATEWAY_SCHEMA_COLUMNS] }

/**
 * On-disk table path under the kernel-managed cache. The plugin writes
 * through `ctx.storage.appendRows`; the storage service owns durable
 * spool and Iceberg flush details.
 *
 * @param {QueryStorageService} storage
 * @returns {string}
 */
export function aiGatewayTablePath(storage) {
  return storage.cacheTablePath(DATASET_NAME, [PARTITION_LABEL])
}

/**
 * Surface the single partition for `ai_gateway_messages`. The kernel
 * cache discovers its own files, so this only needs to return the
 * partition descriptor pointing at the table path.
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
 * Live-ingest refresh path. Rows are written through the kernel cache
 * service from the gateway recorder, so there is no external source
 * file to refresh here.
 *
 * @returns {Promise<DatasetRefreshResult>}
 */
export async function refreshPartition() {
  return { status: 'skipped', rows: 0 }
}

/**
 * Build a squirreling-compatible AsyncDataSource over the partition.
 * Returns an empty source when the table has not yet been materialized
 * so `select count(*) from ai_gateway_messages` still succeeds on a
 * cold cache.
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
    columns: AI_GATEWAY_SCHEMA_COLUMNS.map((c) => c.name),
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
 * The DatasetRegistration passed to `ctx.query.registerDataset` from
 * activate().
 *
 * @returns {DatasetRegistration}
 */
export function aiGatewayDatasetRegistration() {
  return {
    name: DATASET_NAME,
    plugin: '@hypaware/ai-gateway',
    schema: AI_GATEWAY_SCHEMA,
    primaryTimestampColumn: 'message_created_at',
    discoverPartitions: discoverParts,
    refreshPartition,
    createDataSource,
  }
}
