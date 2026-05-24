// @ts-check

import path from 'node:path'

/**
 * @import { ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, QueryPartition, QueryStorageService } from '../../../../collectivus-plugin-kernel-types'
 */

export const PARTITION_LABEL = 'all'
export const PLUGIN_NAME = '@hypaware/otel'

/**
 * `logs` columns. Mirrors the donor `LOGS_COLUMNS` in
 * `collectivus/src/upload/schema.js`, but with `scope` already flattened
 * to `scope_name` / `scope_version` / `scope_attributes` so rows feed
 * `appendRows` without an intermediate extractor.
 *
 * @type {ReadonlyArray<ColumnSpec>}
 */
export const LOGS_COLUMNS = Object.freeze([
  { name: 'serviceName',            type: 'STRING',    nullable: false },
  { name: 'timestamp',              type: 'TIMESTAMP', nullable: true  },
  { name: 'observedTimestamp',      type: 'TIMESTAMP', nullable: true  },
  { name: 'severityNumber',         type: 'INT32',     nullable: true  },
  { name: 'severityText',           type: 'STRING',    nullable: true  },
  { name: 'body',                   type: 'JSON',      nullable: true  },
  { name: 'traceId',                type: 'STRING',    nullable: true  },
  { name: 'spanId',                 type: 'STRING',    nullable: true  },
  { name: 'flags',                  type: 'INT32',     nullable: true  },
  { name: 'droppedAttributesCount', type: 'INT32',     nullable: true  },
  { name: 'resource',               type: 'JSON',      nullable: true  },
  { name: 'scope_name',             type: 'STRING',    nullable: true  },
  { name: 'scope_version',          type: 'STRING',    nullable: true  },
  { name: 'scope_attributes',       type: 'JSON',      nullable: true  },
  { name: 'attributes',             type: 'JSON',      nullable: true  },
])

/** @type {ReadonlyArray<ColumnSpec>} */
export const TRACES_COLUMNS = Object.freeze([
  { name: 'serviceName',            type: 'STRING',    nullable: false },
  { name: 'traceId',                type: 'STRING',    nullable: true  },
  { name: 'spanId',                 type: 'STRING',    nullable: true  },
  { name: 'parentSpanId',           type: 'STRING',    nullable: true  },
  { name: 'name',                   type: 'STRING',    nullable: true  },
  { name: 'kind',                   type: 'INT32',     nullable: true  },
  { name: 'traceState',             type: 'STRING',    nullable: true  },
  { name: 'startTimestamp',         type: 'TIMESTAMP', nullable: true  },
  { name: 'endTimestamp',           type: 'TIMESTAMP', nullable: true  },
  { name: 'durationMs',             type: 'DOUBLE',    nullable: true  },
  { name: 'flags',                  type: 'INT32',     nullable: true  },
  { name: 'droppedAttributesCount', type: 'INT32',     nullable: true  },
  { name: 'droppedEventsCount',     type: 'INT32',     nullable: true  },
  { name: 'droppedLinksCount',      type: 'INT32',     nullable: true  },
  { name: 'status',                 type: 'JSON',      nullable: true  },
  { name: 'resource',               type: 'JSON',      nullable: true  },
  { name: 'scope_name',             type: 'STRING',    nullable: true  },
  { name: 'scope_version',          type: 'STRING',    nullable: true  },
  { name: 'scope_attributes',       type: 'JSON',      nullable: true  },
  { name: 'attributes',             type: 'JSON',      nullable: true  },
  { name: 'events',                 type: 'JSON',      nullable: true  },
  { name: 'links',                  type: 'JSON',      nullable: true  },
])

/** @type {ReadonlyArray<ColumnSpec>} */
export const METRICS_COLUMNS = Object.freeze([
  { name: 'serviceName',            type: 'STRING',    nullable: false },
  { name: 'metricName',             type: 'STRING',    nullable: true  },
  { name: 'description',            type: 'STRING',    nullable: true  },
  { name: 'unit',                   type: 'STRING',    nullable: true  },
  { name: 'metricType',             type: 'STRING',    nullable: true  },
  { name: 'aggregationTemporality', type: 'INT32',     nullable: true  },
  { name: 'isMonotonic',            type: 'BOOLEAN',   nullable: true  },
  { name: 'startTimestamp',         type: 'TIMESTAMP', nullable: true  },
  { name: 'timestamp',              type: 'TIMESTAMP', nullable: true  },
  { name: 'flags',                  type: 'INT32',     nullable: true  },
  { name: 'value',                  type: 'DOUBLE',    nullable: true  },
  { name: 'valueInt',               type: 'INT64',     nullable: true  },
  { name: 'valueType',              type: 'STRING',    nullable: true  },
  { name: 'count',                  type: 'INT64',     nullable: true  },
  { name: 'sum',                    type: 'DOUBLE',    nullable: true  },
  { name: 'min',                    type: 'DOUBLE',    nullable: true  },
  { name: 'max',                    type: 'DOUBLE',    nullable: true  },
  { name: 'bucketCounts',           type: 'JSON',      nullable: true  },
  { name: 'explicitBounds',         type: 'JSON',      nullable: true  },
  { name: 'scale',                  type: 'INT32',     nullable: true  },
  { name: 'zeroCount',              type: 'INT64',     nullable: true  },
  { name: 'zeroThreshold',          type: 'DOUBLE',    nullable: true  },
  { name: 'positive',               type: 'JSON',      nullable: true  },
  { name: 'negative',               type: 'JSON',      nullable: true  },
  { name: 'quantileValues',         type: 'JSON',      nullable: true  },
  { name: 'exemplars',              type: 'JSON',      nullable: true  },
  { name: 'resource',               type: 'JSON',      nullable: true  },
  { name: 'scope_name',             type: 'STRING',    nullable: true  },
  { name: 'scope_version',          type: 'STRING',    nullable: true  },
  { name: 'scope_attributes',       type: 'JSON',      nullable: true  },
  { name: 'metadata',               type: 'JSON',      nullable: true  },
  { name: 'attributes',             type: 'JSON',      nullable: true  },
])

const COLUMN_SPECS = {
  logs: LOGS_COLUMNS,
  traces: TRACES_COLUMNS,
  metrics: METRICS_COLUMNS,
}

const PRIMARY_TIMESTAMP = {
  logs: 'timestamp',
  traces: 'startTimestamp',
  metrics: 'timestamp',
}

/**
 * @param {QueryStorageService} storage
 * @param {'logs' | 'traces' | 'metrics'} dataset
 */
export function otelTablePath(storage, dataset) {
  return storage.cacheTablePath(dataset, [PARTITION_LABEL])
}

/**
 * @param {'logs' | 'traces' | 'metrics'} dataset
 * @returns {ReadonlyArray<ColumnSpec>}
 */
export function columnsFor(dataset) {
  return COLUMN_SPECS[dataset]
}

/**
 * @param {'logs' | 'traces' | 'metrics'} dataset
 * @returns {DatasetRegistration}
 */
export function otelDatasetRegistration(dataset) {
  return {
    name: dataset,
    plugin: PLUGIN_NAME,
    schema: { columns: [...COLUMN_SPECS[dataset]] },
    sourceSignal: dataset,
    primaryTimestampColumn: PRIMARY_TIMESTAMP[dataset],
    discoverPartitions: (ctx) => discoverParts(ctx, dataset),
    refreshPartition: async () => /** @type {DatasetRefreshResult} */ ({ status: 'skipped', rows: 0 }),
    createDataSource: (partitions, ctx) => createDataSource(partitions, ctx, dataset),
  }
}

/**
 * @param {DatasetDiscoveryContext} ctx
 * @param {'logs' | 'traces' | 'metrics'} dataset
 * @returns {QueryPartition[]}
 */
function discoverParts(ctx, dataset) {
  const cacheDir = ctx.cacheDir ?? ''
  if (!cacheDir) return []
  const tablePath = path.join(cacheDir, 'datasets', dataset, PARTITION_LABEL)
  return [{
    dataset,
    partition: { partition: PARTITION_LABEL },
    tablePath,
  }]
}

/**
 * @param {QueryPartition[]} partitions
 * @param {DatasetDataSourceContext} ctx
 * @param {'logs' | 'traces' | 'metrics'} dataset
 */
async function createDataSource(partitions, ctx, dataset) {
  const partition = partitions[0]
  if (!partition || !partition.tablePath) return emptySource(dataset)
  const storage = /** @type {import('../../../../src/core/cache/storage.js').ExtendedQueryStorageService} */ (
    ctx.storage
  )
  const source = await storage.dataSourceForTable(partition.tablePath)
  return source ?? emptySource(dataset)
}

/**
 * @param {'logs' | 'traces' | 'metrics'} dataset
 */
function emptySource(dataset) {
  return {
    columns: COLUMN_SPECS[dataset].map((c) => c.name),
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
