// @ts-check

import path from 'node:path'

import { discoverCachePartitions } from '../../../../src/core/cache/partition.js'

/**
 * @import { ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, QueryPartition, QueryStorageService } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'
 * @import { AsyncDataSource } from 'squirreling'
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
 * The kernel cache write path partitions rows that carry no
 * `cachePartitioning` declaration under `source=<client>` (here always
 * `source=unknown`, since OTLP rows have no client identity), *not*
 * under the `PARTITION_LABEL` directory the collector spools to. So a
 * lone hardcoded `<dataset>/all` partition never surfaces committed data.
 * Discovery has to scan the on-disk `source=` partitions the same way
 * every other cache-backed dataset does (cf. ai-gateway). The
 * `PARTITION_LABEL` spool path is still listed so any pending rows there
 * get flushed during query settlement before `createDataSource` reads.
 *
 * @param {DatasetDiscoveryContext} ctx
 * @param {'logs' | 'traces' | 'metrics'} dataset
 * @returns {Promise<QueryPartition[]>}
 */
async function discoverParts(ctx, dataset) {
  const cacheDir = ctx.cacheDir ?? ''
  if (!cacheDir) return []

  /** @type {QueryPartition[]} */
  const partitions = []
  /** @type {Set<string>} */
  const seen = new Set()

  const spoolPath = path.join(cacheDir, 'datasets', dataset, PARTITION_LABEL)
  partitions.push({ dataset, partition: { partition: PARTITION_LABEL }, tablePath: spoolPath })
  seen.add(spoolPath)

  const discovered = await discoverCachePartitions(cacheDir, { datasets: [dataset] })
  for (const p of discovered) {
    if (seen.has(p.path)) continue
    seen.add(p.path)
    partitions.push({ dataset, partition: p.partition, tablePath: p.path })
  }

  return partitions
}

/**
 * Union every discovered partition's source. Re-discovers from the live
 * cache root so rows flushed out of the spool during settlement (after
 * the initial `discoverParts`) are picked up.
 *
 * @param {QueryPartition[]} partitions
 * @param {DatasetDataSourceContext} ctx
 * @param {'logs' | 'traces' | 'metrics'} dataset
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

  if (sources.length === 0) return emptySource(dataset)
  if (sources.length === 1) return sources[0]
  return unionSources(sources)
}

/**
 * Merge multiple AsyncDataSources into one union source.
 *
 * @param {AsyncDataSource[]} sources
 * @returns {AsyncDataSource}
 */
function unionSources(sources) {
  /** @type {Set<string>} */
  const allColumns = new Set()
  let totalRows = 0
  for (const s of sources) {
    for (const col of s.columns) allColumns.add(col)
    totalRows += s.numRows ?? 0
  }
  return {
    columns: Array.from(allColumns),
    numRows: totalRows,
    scan(options) {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (const source of sources) {
            const scan = source.scan(options)
            for await (const row of scan.rows()) {
              yield row
            }
          }
        },
      }
    },
  }
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
