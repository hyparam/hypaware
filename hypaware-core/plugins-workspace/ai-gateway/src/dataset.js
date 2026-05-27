// @ts-check

import path from 'node:path'

import { discoverCachePartitions } from '../../../../src/core/cache/partition.js'
import { AI_GATEWAY_MESSAGE_COLUMNS } from './message_projector.js'

/**
 * @import { ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRefreshResult, DatasetRegistration, QueryPartition, QueryStorageService } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'
 * @import { AsyncDataSource } from 'squirreling'
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
 * Discover all partitions for `ai_gateway_messages`, including
 * new-style per-client/date partitions and legacy `proxy_messages_v4`
 * or `all` partitions.  Always includes the legacy spool path so
 * pending data gets flushed during query settlement.
 *
 * @param {DatasetDiscoveryContext} ctx
 * @returns {Promise<QueryPartition[]>}
 */
export async function discoverParts(ctx) {
  const cacheDir = ctx.cacheDir ?? ''
  if (!cacheDir) return []

  /** @type {QueryPartition[]} */
  const partitions = []
  const seen = new Set()

  const legacyPath = path.join(cacheDir, 'datasets', DATASET_NAME, PARTITION_LABEL)
  partitions.push({
    dataset: DATASET_NAME,
    partition: { partition: PARTITION_LABEL },
    tablePath: legacyPath,
  })
  seen.add(legacyPath)

  const discovered = await discoverCachePartitions(cacheDir, buildDiscoveryScope(ctx.scope))
  for (const p of discovered) {
    if (seen.has(p.path)) continue
    seen.add(p.path)
    partitions.push({
      dataset: DATASET_NAME,
      partition: p.partition,
      tablePath: p.path,
    })
  }

  return partitions
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
 * Build a squirreling-compatible AsyncDataSource over all discovered
 * partitions.  Unions data from legacy and new-style partitions so
 * queries see a seamless view across the transition.
 *
 * @param {QueryPartition[]} partitions
 * @param {DatasetDataSourceContext} ctx
 */
export async function createDataSource(partitions, ctx) {
  const storage = /** @type {ExtendedQueryStorageService} */ (ctx.storage)

  // Re-discover partitions to pick up any newly flushed data that
  // wasn't visible during the initial discoverParts call.
  const freshPartitions = await discoverCachePartitions(storage.cacheRoot, buildDiscoveryScope(ctx.scope))

  /** @type {Set<string>} */
  const tablePaths = new Set()
  for (const p of partitions) {
    if (p.tablePath) tablePaths.add(p.tablePath)
  }
  for (const p of freshPartitions) {
    tablePaths.add(p.path)
  }

  /** @type {AsyncDataSource[]} */
  const sources = []
  for (const tablePath of tablePaths) {
    const source = await storage.dataSourceForTable(tablePath)
    if (source && (source.numRows ?? 0) > 0) sources.push(source)
  }

  if (sources.length === 0) return emptySource()
  if (sources.length === 1) return sources[0]
  return unionSources(sources)
}

/**
 * @param {DatasetDiscoveryContext['scope'] | DatasetDataSourceContext['scope'] | undefined} scope
 */
function buildDiscoveryScope(scope) {
  return {
    datasets: [DATASET_NAME],
    ...(scope?.date ? { date: scope.date } : {}),
    ...(scope?.dates ? { dates: scope.dates } : {}),
    ...(scope?.from ? { from: scope.from } : {}),
    ...(scope?.to ? { to: scope.to } : {}),
  }
}

/**
 * Merge multiple AsyncDataSources into a single union source.
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
    cachePartitioning: {
      source: {
        columns: ['client_name', 'conversation_source', 'provider'],
        fallback: 'unknown',
      },
      iceberg: {
        fields: [
          { column: 'conversation_id', transform: 'identity', required: true },
          { column: 'cwd', transform: 'identity' },
          { column: 'date', transform: 'identity', required: true },
        ],
      },
    },
    discoverPartitions: discoverParts,
    refreshPartition,
    createDataSource,
  }
}
