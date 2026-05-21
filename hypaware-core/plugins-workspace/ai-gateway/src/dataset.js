// @ts-check

import path from 'node:path'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').ColumnSpec} ColumnSpec */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').DatasetRegistration} DatasetRegistration */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').DatasetDiscoveryContext} DatasetDiscoveryContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').DatasetDataSourceContext} DatasetDataSourceContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').QueryPartition} QueryPartition */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').QueryStorageService} QueryStorageService */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').DatasetRefreshResult} DatasetRefreshResult */

export const DATASET_NAME = 'ai_gateway_messages'
export const PARTITION_LABEL = 'all'

/**
 * Column shape for `ai_gateway_messages`. Captures the request/response
 * envelope of one exchange plus enough provenance for queries to
 * filter by upstream, dev_run_id (in `metadata`), and SSE-ness.
 *
 * Headers and metadata land in JSON (Iceberg variant) so callers can
 * use `JSON_VALUE(metadata, '$.dev_run_id')` and friends at query time.
 * `request_body` and `response_body` are strings — providers send UTF-8
 * JSON in practice, and storing as STRING keeps the cache schema
 * simple while preserving the exact bytes the gateway saw.
 *
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const AI_GATEWAY_SCHEMA_COLUMNS = Object.freeze([
  { name: 'exchange_id',      type: 'STRING',    nullable: false },
  { name: 'ts_start',         type: 'TIMESTAMP', nullable: false },
  { name: 'ts_end',           type: 'TIMESTAMP', nullable: true  },
  { name: 'duration_ms',      type: 'INT64',     nullable: true  },
  { name: 'upstream',         type: 'STRING',    nullable: false },
  { name: 'method',           type: 'STRING',    nullable: true  },
  { name: 'path',             type: 'STRING',    nullable: true  },
  { name: 'status_code',      type: 'INT32',     nullable: true  },
  { name: 'request_bytes',    type: 'INT64',     nullable: true  },
  { name: 'response_bytes',   type: 'INT64',     nullable: true  },
  { name: 'is_sse',           type: 'BOOLEAN',   nullable: true  },
  { name: 'stream_event_count', type: 'INT64',   nullable: true  },
  { name: 'request_headers',  type: 'JSON',      nullable: true  },
  { name: 'request_body',     type: 'STRING',    nullable: true  },
  { name: 'response_headers', type: 'JSON',      nullable: true  },
  { name: 'response_body',    type: 'STRING',    nullable: true  },
  { name: 'error',            type: 'STRING',    nullable: true  },
  { name: 'metadata',         type: 'JSON',      nullable: true  },
])

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
    primaryTimestampColumn: 'ts_start',
    discoverPartitions: discoverParts,
    refreshPartition,
    createDataSource,
  }
}
