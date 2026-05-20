import fs from 'node:fs'
import { asyncRow, collect, extractTables, parseSql } from 'squirreling'
import { parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { icebergDataSource, loadLatestFileCatalogMetadata } from 'icebird'
import {
  QUERY_DATASETS,
  columnsForDataset,
  fallbackTimestampColumns,
  isQueryDataset,
} from './schema.js'
import { expectedCachePartitions } from './paths.js'
import {
  expectedCollectionPartitions,
  findCollection,
  readCollectionCacheMeta,
  readCollectionsManifest,
} from './collections.js'
import { readCacheCursor } from './iceberg/cursor.js'
import { createLocalIcebergIO } from './iceberg/resolver.js'
import { queryCacheTableExists } from './iceberg/store.js'
import { executeSqlWithRandomSample } from './random-sample.js'

/**
 * @import { AsyncDataSource, AsyncRow, ScanOptions, ScanResults, SelectStatement, SetOperationStatement, Statement } from 'squirreling'
 * @import { CachePartition, QueryDataset, QueryPaths, QueryResultSet, QueryScope, ResolvedQueryTableInfo, ResolvedQueryTables } from './types.js'
 * @import { Lister, Resolver, TableMetadata } from 'icebird/src/types.js'
 */

/**
 * @param {string} sql
 * @param {number} rowLimit
 * @returns {{ statement: Statement, tableNames: string[] }}
 */
export function prepareReadOnlySql(sql, rowLimit) {
  const trimmed = sql.trim()
  if (trimmed.length === 0) throw new Error('SQL query is required')
  /** @type {Statement} */
  let statement
  try {
    statement = parseSql({ query: trimmed })
  } catch (err) {
    throw new Error(`SQL must be a single read-only SELECT statement: ${formatError(err)}`)
  }
  const tableNames = uniqueStrings(extractTables(statement))
  applyResultLimit(statement, rowLimit)
  return { statement, tableNames }
}

/**
 * @param {{
 *   paths: QueryPaths,
 *   scope: QueryScope,
 *   statement: Statement,
 *   datasets?: string[],
 *   resolvedTables?: ResolvedQueryTables,
 * }} args
 * @returns {Promise<QueryResultSet>}
 */
export async function executeLogicalSql(args) {
  const tables = args.resolvedTables
    ? args.resolvedTables.tables
    : args.datasets && args.datasets.length > 0
      ? await buildTables(args.paths, { ...args.scope, datasets: args.datasets })
      : {}
  const results = executeSqlWithRandomSample({ tables, query: args.statement })
  const rows = await collect(results)
  return { columns: results.columns, rows }
}

/**
 * Resolve the SQL table names referenced by a query into Squirreling data
 * sources. The SQL-facing name is kept as the key in `tables`; the canonical
 * dataset name is carried separately for cache freshness and refresh.
 *
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @param {string[]} tableNames
 * @returns {Promise<ResolvedQueryTables>}
 */
export async function resolveQueryTables(paths, scope, tableNames) {
  const names = uniqueStrings(tableNames)
  /** @type {Record<string, AsyncDataSource>} */
  const tables = {}
  /** @type {string[]} */
  const datasets = []
  /** @type {ResolvedQueryTables['resolved']} */
  const resolved = []
  /** @type {Promise<{ resolver: Resolver, lister: Lister }> | undefined} */
  let localIcebergIO
  function getLocalIcebergIO() {
    localIcebergIO ??= createLocalIcebergIO()
    return localIcebergIO
  }

  for (const name of names) {
    const table = resolveQueryTableInfo(paths, name)
    if (!datasets.includes(table.dataset)) datasets.push(table.dataset)
    if (table.kind === 'builtin') {
      const { dataset } = table
      const partitions = expectedCachePartitions(paths, { ...scope, datasets: [dataset] })
      tables[name] = dataset === 'gascity_messages'
        ? gascityDataSource(dataset, partitions, scope)
        : buildCacheDataSource(dataset, partitions, scope, await getLocalIcebergIO())
    } else {
      const partitions = expectedCollectionPartitions(paths, { ...scope, datasets: [table.dataset] })
      tables[name] = buildCollectionDataSource(name, partitions, scope, await getLocalIcebergIO())
    }
    resolved.push({
      name,
      dataset: table.dataset,
      kind: table.kind,
      columns: tables[name].columns,
    })
  }

  return { tableNames: names, datasets, tables, resolved }
}

/**
 * @param {QueryPaths} paths
 * @param {string} name
 * @returns {ResolvedQueryTableInfo}
 */
export function resolveQueryTableInfo(paths, name) {
  if (isQueryDataset(name)) return { name, kind: 'builtin', dataset: name }
  const manifest = readCollectionsManifest(paths.recordingRoot)
  const collection = findCollection(manifest, name)
  if (collection) return { name, kind: 'collection', dataset: collection.table, collection }
  throw new Error(`unknown query table "${name}"${queryTableHint(manifest)}`)
}

/**
 * @param {import('./types.js').CollectionsManifest} manifest
 * @returns {string}
 */
function queryTableHint(manifest) {
  /** @type {string[]} */
  const names = [...QUERY_DATASETS]
  for (const collection of Object.values(manifest.collections)) {
    names.push(collection.table)
    if (collection.name !== collection.table) names.push(collection.name)
  }
  return names.length > 0 ? `; available tables: ${uniqueStrings(names).join(', ')}` : ''
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function uniqueStrings(values) {
  return [...new Set(values)]
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {Promise<Record<string, AsyncDataSource>>}
 */
export async function buildTables(paths, scope) {
  const requested = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  const builtinDatasets = requested ? requested.filter(isQueryDataset) : [...QUERY_DATASETS]
  const collectionDatasets = requested
    ? requested.filter((dataset) => !isQueryDataset(dataset))
    : expectedCollectionPartitions(paths, scope).map((partition) => partition.table)

  /** @type {Record<string, CachePartition[]>} */
  const byDataset = {}
  for (const dataset of builtinDatasets) byDataset[dataset] = []
  if (builtinDatasets.length > 0) {
    for (const partition of expectedCachePartitions(paths, { ...scope, datasets: builtinDatasets })) {
      if (!byDataset[partition.dataset]) byDataset[partition.dataset] = []
      byDataset[partition.dataset].push(partition)
    }
  }

  /** @type {Record<string, AsyncDataSource>} */
  const tables = {}
  /** @type {Promise<{ resolver: Resolver, lister: Lister }> | undefined} */
  let localIcebergIO
  function getLocalIcebergIO() {
    localIcebergIO ??= createLocalIcebergIO()
    return localIcebergIO
  }
  for (const dataset of builtinDatasets) {
    tables[dataset] = dataset === 'gascity_messages'
      ? gascityDataSource(dataset, byDataset[dataset] ?? [], scope)
      : buildCacheDataSource(dataset, byDataset[dataset] ?? [], scope, await getLocalIcebergIO())
  }
  /** @type {Record<string, import('./types.js').CollectionCachePartition[]>} */
  const byCollection = {}
  for (const dataset of collectionDatasets) byCollection[dataset] = []
  for (const partition of expectedCollectionPartitions(paths, { ...scope, datasets: collectionDatasets })) {
    if (!byCollection[partition.table]) byCollection[partition.table] = []
    byCollection[partition.table].push(partition)
  }
  for (const dataset of collectionDatasets) {
    tables[dataset] = buildCollectionDataSource(dataset, byCollection[dataset] ?? [], scope, await getLocalIcebergIO())
  }
  return tables
}

/**
 * @param {QueryDataset} dataset
 * @param {CachePartition[]} partitions
 * @param {QueryScope} scope
 * @returns {Promise<AsyncDataSource>}
 */
export async function cacheDataSource(dataset, partitions, scope) {
  if (dataset === 'gascity_messages') return gascityDataSource(dataset, partitions, scope)
  return buildCacheDataSource(dataset, partitions, scope, await createLocalIcebergIO())
}

/**
 * @param {QueryDataset} dataset
 * @param {CachePartition[]} partitions
 * @param {QueryScope} scope
 * @param {{ resolver: Resolver, lister: Lister }} io
 * @returns {AsyncDataSource}
 */
function buildCacheDataSource(dataset, partitions, scope, io) {
  const columns = columnsForDataset(dataset).map((column) => column.name)
  const sources = /** @type {Promise<Array<{ partition: CachePartition, source: AsyncDataSource }>>} */ (
    loadIcebergPartitionSources(partitions, io, 'builtin')
  )
  const numRows = canUseBuiltinRowCount(scope)
    ? partitions.reduce((sum, partition) => sum + readRowCountHint(partition), 0)
    : undefined
  /** @type {AsyncDataSource} */
  const source = {
    columns,
    scan(options) {
      return {
        rows: () => scanBuiltinIcebergRows(dataset, sources, columns, scope, options),
        appliedWhere: false,
        appliedLimitOffset: false,
      }
    },
  }
  if (numRows !== undefined) source.numRows = numRows
  return source
}

/**
 * @param {QueryDataset} dataset
 * @param {CachePartition[]} partitions
 * @param {QueryScope} scope
 * @returns {AsyncDataSource}
 */
function gascityDataSource(dataset, partitions, scope) {
  const columns = columnsForDataset(dataset).map((column) => column.name)
  return {
    columns,
    scan(options) {
      return {
        rows: () => scanGascityRows(dataset, partitions, scope, options),
        appliedWhere: false,
        appliedLimitOffset: false,
      }
    },
  }
}

/**
 * @param {string} table
 * @param {import('./types.js').CollectionCachePartition[]} partitions
 * @param {QueryScope} scope
 * @returns {Promise<AsyncDataSource>}
 */
export async function collectionDataSource(table, partitions, scope) {
  return buildCollectionDataSource(table, partitions, scope, await createLocalIcebergIO())
}

/**
 * @param {string} table
 * @param {import('./types.js').CollectionCachePartition[]} partitions
 * @param {QueryScope} scope
 * @param {{ resolver: Resolver, lister: Lister }} io
 * @returns {AsyncDataSource}
 */
function buildCollectionDataSource(table, partitions, scope, io) {
  const columns = collectionColumns(partitions)
  const sources = /** @type {Promise<Array<{ partition: import('./types.js').CollectionCachePartition, source: AsyncDataSource, meta?: import('./types.js').CollectionCacheMeta }>>} */ (
    loadIcebergPartitionSources(partitions, io, 'collection')
  )
  const numRows = canUseCollectionRowCount(scope)
    ? partitions.reduce((sum, partition) => sum + readCollectionRowCountHint(partition), 0)
    : undefined
  return {
    columns,
    ...(numRows === undefined ? {} : { numRows }),
    scan(options) {
      return {
        rows: () => scanCollectionIcebergRows(table, sources, columns, scope, options),
        appliedWhere: false,
        appliedLimitOffset: false,
      }
    },
  }
}

/**
 * @param {QueryDataset} dataset
 * @param {CachePartition[]} partitions
 * @param {QueryScope} scope
 * @param {ScanOptions} options
 * @returns {AsyncGenerator<AsyncRow>}
 */
async function* scanGascityRows(dataset, partitions, scope, options) {
  const requestedColumns = options.columns && options.columns.length > 0
    ? options.columns
    : columnsForDataset(dataset).map((column) => column.name)
  /** @type {Set<string>} */
  const seenRowIds = new Set()
  for (const partition of partitions) {
    if (options.signal?.aborted) return
    const rows = await readGascityParquetRows(partition)
    for (const row of rows) {
      if (options.signal?.aborted) return
      const rowId = row._ctvs_row_id
      if (typeof rowId === 'string') {
        if (seenRowIds.has(rowId)) continue
        seenRowIds.add(rowId)
      }
      const logical = normalizeLogicalRow(row, partition)
      if (!rowMatchesScope(dataset, logical, scope)) continue
      yield asyncRow(projectRow(logical, requestedColumns), requestedColumns)
    }
  }
}

/**
 * @param {QueryDataset} dataset
 * @param {Promise<Array<{ partition: CachePartition, source: AsyncDataSource }>>} sourcesPromise
 * @param {string[]} columns
 * @param {QueryScope} scope
 * @param {ScanOptions} options
 * @returns {AsyncGenerator<AsyncRow>}
 */
async function* scanBuiltinIcebergRows(dataset, sourcesPromise, columns, scope, options) {
  const requestedColumns = options.columns && options.columns.length > 0
    ? options.columns
    : columns
  const innerColumns = scanColumnsWithPrivateColumns(
    requestedColumns,
    builtinScopeColumns(dataset, scope)
  )
  /** @type {Set<string>} */
  const seenRowIds = new Set()
  const sources = await sourcesPromise
  const innerLimit = builtinInnerScanLimit(scope, options, sources.length)
  for (const { partition, source } of sources) {
    if (options.signal?.aborted) return
    const scan = source.scan({
      columns: innerColumns,
      where: options.where,
      ...(innerLimit === undefined ? {} : { limit: innerLimit }),
      signal: options.signal,
    })
    for await (const sourceRow of scan.rows()) {
      if (options.signal?.aborted) return
      const row = await resolveAsyncRow(sourceRow)
      const rowId = row._ctvs_row_id
      if (typeof rowId === 'string') {
        if (seenRowIds.has(rowId)) continue
        seenRowIds.add(rowId)
      }
      const logical = normalizeLogicalRow(row, partition)
      if (!rowMatchesScope(dataset, logical, scope)) continue
      yield asyncRow(projectRow(logical, requestedColumns), requestedColumns)
    }
  }
}

/**
 * @param {string} table
 * @param {Promise<Array<{ partition: import('./types.js').CollectionCachePartition, source: AsyncDataSource, meta?: import('./types.js').CollectionCacheMeta }>>} sourcesPromise
 * @param {string[]} columns
 * @param {QueryScope} scope
 * @param {ScanOptions} options
 * @returns {AsyncGenerator<AsyncRow>}
 */
async function* scanCollectionIcebergRows(table, sourcesPromise, columns, scope, options) {
  const requestedColumns = options.columns && options.columns.length > 0
    ? options.columns
    : columns
  /** @type {Set<string>} */
  const seenRowIds = new Set()
  const sources = await sourcesPromise
  const innerLimit = collectionInnerScanLimit(scope, options, sources.length)
  for (const { source, meta } of sources) {
    if (options.signal?.aborted) return
    const innerColumns = scanColumnsWithPrivateColumns(
      requestedColumns,
      collectionScopeColumns(meta, scope)
    )
    const scan = source.scan({
      columns: innerColumns,
      where: options.where,
      ...(innerLimit === undefined ? {} : { limit: innerLimit }),
      signal: options.signal,
    })
    for await (const sourceRow of scan.rows()) {
      if (options.signal?.aborted) return
      const row = await resolveAsyncRow(sourceRow)
      const rowId = row._ctvs_row_id
      if (typeof rowId === 'string') {
        if (seenRowIds.has(rowId)) continue
        seenRowIds.add(rowId)
      }
      const logical = normalizePlainRow(row)
      if (!collectionRowMatchesScope(table, logical, scope, meta)) continue
      yield asyncRow(projectRow(logical, requestedColumns), requestedColumns)
    }
  }
}

/**
 * @param {CachePartition} partition
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readGascityParquetRows(partition) {
  const buf = fs.readFileSync(partition.cachePath)
  const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return await parquetReadObjects({ file, compressors })
}

/**
 * @param {Array<CachePartition | import('./types.js').CollectionCachePartition>} partitions
 * @param {{ resolver: Resolver, lister: Lister }} io
 * @param {'builtin' | 'collection'} kind
 * @returns {Promise<Array<{ partition: CachePartition | import('./types.js').CollectionCachePartition, source: AsyncDataSource, meta?: import('./types.js').CollectionCacheMeta }>>}
 */
async function loadIcebergPartitionSources(partitions, io, kind) {
  const loaded = await Promise.all(partitions.map(async (partition) => {
    const cursor = readCacheCursor(partition.cursorPath)
    if (!cursor || cursor.kind !== kind) return undefined
    if (!queryCacheTableExists(cursor.table_path)) return undefined
    const tableUrl = cursor.table_url || partition.tableUrl
    const { metadata } = await loadLatestFileCatalogMetadata({
      tableUrl,
      resolver: io.resolver,
      lister: io.lister,
    })
    if (!hasCurrentSnapshot(metadata)) return undefined
    const source = await icebergDataSource({
      tableUrl,
      metadata,
      resolver: io.resolver,
      lister: io.lister,
    })
    return {
      partition,
      source,
      ...(kind === 'collection' ? { meta: readCollectionCacheMeta(partition.cursorPath) } : {}),
    }
  }))
  return loaded.filter((entry) => entry !== undefined)
}

/**
 * @param {TableMetadata} metadata
 * @returns {boolean}
 */
function hasCurrentSnapshot(metadata) {
  const snapshotId = metadata['current-snapshot-id']
  return snapshotId !== undefined &&
    snapshotId !== null &&
    Boolean(metadata.snapshots?.some((snapshot) => snapshot['snapshot-id'] === snapshotId))
}

/**
 * @param {AsyncRow} row
 * @returns {Promise<Record<string, unknown>>}
 */
async function resolveAsyncRow(row) {
  /** @type {Record<string, unknown>} */
  const out = row.resolved ? { ...row.resolved } : {}
  for (const column of row.columns) {
    if (Object.prototype.hasOwnProperty.call(out, column)) continue
    out[column] = await row.cells[column]?.()
  }
  return out
}

/**
 * @param {string[]} requestedColumns
 * @param {string[]} scopeColumns
 * @returns {string[]}
 */
function scanColumnsWithPrivateColumns(requestedColumns, scopeColumns) {
  return [...new Set([...requestedColumns, ...scopeColumns, '_ctvs_row_id'])]
}

/**
 * @param {QueryDataset} dataset
 * @param {QueryScope} scope
 * @returns {string[]}
 */
function builtinScopeColumns(dataset, scope) {
  /** @type {string[]} */
  const columns = []
  if (scope.service) columns.push('serviceName')
  if (scope.from || scope.to) columns.push(...fallbackTimestampColumns(dataset))
  return columns
}

/**
 * @param {import('./types.js').CollectionCacheMeta | undefined} meta
 * @param {QueryScope} scope
 * @returns {string[]}
 */
function collectionScopeColumns(meta, scope) {
  /** @type {string[]} */
  const columns = []
  if (scope.service) columns.push('serviceName', 'service_name')
  if (scope.date || scope.dates || scope.from || scope.to) {
    if (meta?.timestamp_column) columns.push(meta.timestamp_column)
    columns.push('timestamp', 'time', 'ts', 'created_at', 'createdat', 'date')
  }
  return columns
}

/**
 * @param {QueryScope} scope
 * @returns {boolean}
 */
function canUseBuiltinRowCount(scope) {
  return !scope.service && !scope.from && !scope.to
}

/**
 * @param {QueryScope} scope
 * @returns {boolean}
 */
function canUseCollectionRowCount(scope) {
  return !scope.service && !scope.date && !scope.dates && !scope.from && !scope.to
}

/**
 * @param {QueryScope} scope
 * @param {ScanOptions} options
 * @param {number} sourceCount
 * @returns {number | undefined}
 */
function builtinInnerScanLimit(scope, options, sourceCount) {
  if (sourceCount !== 1 || options.limit === undefined || options.offset !== undefined || options.where) return undefined
  if (scope.service || scope.from || scope.to) return undefined
  return options.limit
}

/**
 * @param {QueryScope} scope
 * @param {ScanOptions} options
 * @param {number} sourceCount
 * @returns {number | undefined}
 */
function collectionInnerScanLimit(scope, options, sourceCount) {
  if (sourceCount !== 1 || options.limit === undefined || options.offset !== undefined || options.where) return undefined
  if (scope.gatewayId || scope.service || scope.date || scope.dates || scope.from || scope.to) return undefined
  return options.limit
}

/**
 * @param {Record<string, unknown>} row
 * @param {CachePartition} partition
 * @returns {Record<string, import('squirreling').SqlPrimitive>}
 */
function normalizeLogicalRow(row, partition) {
  const out = normalizePlainRow(row)
  out.gateway_id = typeof out.gateway_id === 'string' ? out.gateway_id : partition.gatewayId
  out.date = partition.date
  return out
}

/**
 * @param {Record<string, unknown>} row
 * @returns {Record<string, import('squirreling').SqlPrimitive>}
 */
function normalizePlainRow(row) {
  /** @type {Record<string, import('squirreling').SqlPrimitive>} */
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = normalizeCell(value)
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {import('squirreling').SqlPrimitive}
 */
function normalizeCell(value) {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeCell(entry))
  }
  if (typeof value === 'object') return /** @type {Record<string, unknown>} */ (value)
  return String(value)
}

/**
 * @param {Record<string, import('squirreling').SqlPrimitive>} row
 * @param {string[]} columns
 * @returns {Record<string, import('squirreling').SqlPrimitive>}
 */
function projectRow(row, columns) {
  /** @type {Record<string, import('squirreling').SqlPrimitive>} */
  const out = {}
  for (const column of columns) out[column] = row[column] ?? null
  return out
}

/**
 * @param {QueryDataset} dataset
 * @param {Record<string, import('squirreling').SqlPrimitive>} row
 * @param {QueryScope} scope
 * @returns {boolean}
 */
function rowMatchesScope(dataset, row, scope) {
  if (scope.gatewayId && row.gateway_id !== scope.gatewayId) return false
  if (!dateMatchesScope(row.date, scope)) return false
  if (scope.service && 'serviceName' in row && row.serviceName !== scope.service) return false
  if (!scope.from && !scope.to) return true
  const timestampMs = rowTimestampMs(dataset, row)
  if (timestampMs === undefined) return true
  if (scope.from && timestampMs < Date.parse(scope.from)) return false
  if (scope.to && timestampMs > Date.parse(scope.to)) return false
  return true
}

/**
 * @param {string} _table
 * @param {Record<string, import('squirreling').SqlPrimitive>} row
 * @param {QueryScope} scope
 * @param {import('./types.js').CollectionCacheMeta | undefined} meta
 * @returns {boolean}
 */
function collectionRowMatchesScope(_table, row, scope, meta) {
  if (scope.gatewayId && 'gateway_id' in row && row.gateway_id !== scope.gatewayId) return false
  if (scope.service) {
    if ('serviceName' in row && row.serviceName !== scope.service) return false
    if ('service_name' in row && row.service_name !== scope.service) return false
  }
  if (!scope.date && !scope.dates && !scope.from && !scope.to) return true
  const timestampMs = collectionRowTimestampMs(row, meta)
  if (timestampMs === undefined) return true
  if (!dateMatchesScope(new Date(timestampMs).toISOString().slice(0, 10), scope)) return false
  if (scope.from && timestampMs < Date.parse(scope.from)) return false
  if (scope.to && timestampMs > Date.parse(scope.to)) return false
  return true
}

/**
 * @param {unknown} date
 * @param {QueryScope} scope
 * @returns {boolean}
 */
function dateMatchesScope(date, scope) {
  if (scope.date && date !== scope.date) return false
  if (scope.dates && !scope.dates.includes(String(date))) return false
  return true
}

/**
 * @param {QueryDataset} dataset
 * @param {Record<string, import('squirreling').SqlPrimitive>} row
 * @returns {number | undefined}
 */
function rowTimestampMs(dataset, row) {
  for (const column of fallbackTimestampColumns(dataset)) {
    const ms = timestampMs(row[column])
    if (ms !== undefined) return ms
  }
}

/**
 * @param {Record<string, import('squirreling').SqlPrimitive>} row
 * @param {import('./types.js').CollectionCacheMeta | undefined} meta
 * @returns {number | undefined}
 */
function collectionRowTimestampMs(row, meta) {
  if (meta?.timestamp_column) {
    const ms = timestampMs(row[meta.timestamp_column])
    if (ms !== undefined) return ms
  }
  for (const column of ['timestamp', 'time', 'ts', 'created_at', 'createdat', 'date']) {
    const ms = timestampMs(row[column])
    if (ms !== undefined) return ms
  }
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function timestampMs(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    const n = Date.parse(String(value))
    if (Number.isFinite(n)) return n
  }
}

/**
 * @param {CachePartition} partition
 * @returns {number}
 */
function readRowCountHint(partition) {
  const cursor = readCacheCursor(partition.cursorPath)
  return cursor?.kind === 'builtin' ? cursor.row_count : 0
}

/**
 * @param {import('./types.js').CollectionCachePartition} partition
 * @returns {number}
 */
function readCollectionRowCountHint(partition) {
  const meta = readCollectionCacheMeta(partition.cursorPath)
  return meta?.row_count ?? 0
}

/**
 * @param {import('./types.js').CollectionCachePartition[]} partitions
 * @returns {string[]}
 */
function collectionColumns(partitions) {
  /** @type {Set<string>} */
  const columns = new Set(['_ctvs_source_path', '_ctvs_line_number', '_ctvs_raw'])
  for (const partition of partitions) {
    const meta = readCollectionCacheMeta(partition.cursorPath)
    if (!meta) continue
    for (const column of meta.columns) columns.add(column.name)
  }
  return [...columns]
}

/**
 * @param {Statement} statement
 * @param {number} limit
 */
function applyResultLimit(statement, limit) {
  const target = topLevelStatement(statement)
  if (target && isLimitableStatement(target) && (target.limit === undefined || target.limit > limit)) {
    target.limit = limit
  }
}

/**
 * @param {Statement} statement
 * @returns {Statement | undefined}
 */
function topLevelStatement(statement) {
  if (statement.type === 'with') return topLevelStatement(statement.query)
  return statement
}

/**
 * @param {Statement} statement
 * @returns {statement is SelectStatement | SetOperationStatement}
 */
function isLimitableStatement(statement) {
  return statement.type === 'select' || statement.type === 'compound'
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
