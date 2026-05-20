import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { QUERY_CACHE_SCHEMA_VERSION, isQueryDataset } from './schema.js'
import { readCacheCursor, stableFingerprint, writeCacheCursor } from './iceberg/cursor.js'
import { readJsonlEntryBatches } from './iceberg/jsonl.js'
import { collectionColumnsToSpecs } from './iceberg/schema.js'
import { appendRowsToTable, queryCacheTableExists, queryCacheTableUrl } from './iceberg/store.js'

/**
 * @import {
 *   CollectionCacheMeta,
 *   CollectionCachePartition,
 *   CollectionColumnMeta,
 *   CollectionsManifest,
 *   JsonlCollection,
 *   QueryPaths,
 *   QueryScope,
 *   RefreshResult,
 * } from './types.js'
 * @import { CollectionCacheCursor, JsonlEntry } from './iceberg/types.d.ts'
 */

const MANIFEST_VERSION = 2
const SUPPORTED_MANIFEST_VERSIONS = new Set([1, 2])
/** @type {CollectionColumnMeta[]} */
const META_COLUMNS = [
  { name: '_ctvs_source_path', type: 'STRING', nullable: false },
  { name: '_ctvs_line_number', type: 'INT32', nullable: false },
  { name: '_ctvs_raw', type: 'JSON', nullable: false },
]

const RESERVED_SQL_WORDS = new Set([
  'all', 'and', 'as', 'by', 'distinct', 'false', 'from',
  'group', 'having', 'join', 'limit', 'not', 'null', 'offset',
  'on', 'or', 'order', 'select', 'true', 'union', 'where', 'with',
])

const TIMESTAMP_CANDIDATES = new Set([
  'timestamp', 'time', 'ts', 'date', 'datetime', 'created_at',
  'createdat', 'created', 'created_time', 'createdtime',
  'observed_timestamp', 'observedtimestamp',
])

/**
 * @param {string} recordingRoot
 * @returns {string}
 */
export function collectionsManifestPath(recordingRoot) {
  return path.join(recordingRoot, '.collectivus-query', 'collections.json')
}

/**
 * @param {string} cacheDir
 * @param {string} table
 * @returns {string}
 */
export function collectionTableDir(cacheDir, table) {
  return path.join(cacheDir, 'collections', table)
}

/**
 * @param {string} cacheDir
 * @param {string} table
 * @param {string} absSourcePath
 * @returns {string}
 */
function collectionSourceDir(cacheDir, table, absSourcePath) {
  return path.join(collectionTableDir(cacheDir, table), `source=${collectionPartitionKey(absSourcePath)}`)
}

/**
 * @param {string} absSourcePath
 * @returns {string}
 */
function collectionPartitionKey(absSourcePath) {
  return crypto.createHash('sha256').update(absSourcePath).digest('hex').slice(0, 12)
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeTableName(value) {
  return normalizeSqlIdentifier(value, 'collection', 'table')
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeColumnName(value) {
  return normalizeSqlIdentifier(value, 'field', 'field')
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isCollectionTableName(value) {
  return normalizeTableName(value) === value
}

/**
 * @param {string} recordingRoot
 * @returns {CollectionsManifest}
 */
export function readCollectionsManifest(recordingRoot) {
  const manifestPath = collectionsManifestPath(recordingRoot)
  let raw
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return emptyManifest()
    throw err
  }
  try {
    return normalizeManifest(JSON.parse(raw), manifestPath)
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`collection manifest ${manifestPath} is not valid JSON: ${formatError(err)}`)
    }
    throw err
  }
}

/**
 * @param {string} recordingRoot
 * @param {CollectionsManifest} manifest
 * @returns {void}
 */
export function writeCollectionsManifest(recordingRoot, manifest) {
  const manifestPath = collectionsManifestPath(recordingRoot)
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  const tmp = `${manifestPath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n')
  fs.renameSync(tmp, manifestPath)
}

/**
 * @param {string} recordingRoot
 * @returns {JsonlCollection[]}
 */
export function listCollections(recordingRoot) {
  return collectionsFromManifest(readCollectionsManifest(recordingRoot))
}

/**
 * @param {CollectionsManifest} manifest
 * @returns {JsonlCollection[]}
 */
export function collectionsFromManifest(manifest) {
  return Object.values(manifest.collections).sort(compareCollections)
}

/**
 * @param {CollectionsManifest} manifest
 * @param {string} nameOrTable
 * @returns {JsonlCollection | undefined}
 */
export function findCollection(manifest, nameOrTable) {
  if (manifest.collections[nameOrTable]) return manifest.collections[nameOrTable]
  const normalized = normalizeTableName(nameOrTable)
  if (manifest.collections[normalized]) return manifest.collections[normalized]
  return collectionsFromManifest(manifest).find((collection) => collection.name === nameOrTable)
}

/**
 * @param {{
 *   recordingRoot: string,
 *   filePath?: string,
 *   glob?: string,
 *   name: string,
 *   timestampColumn?: string,
 *   replace?: boolean,
 * }} args
 * @returns {JsonlCollection}
 */
export function registerCollection(args) {
  const { recordingRoot, name, timestampColumn, replace = false } = args
  const hasPath = typeof args.filePath === 'string' && args.filePath.length > 0
  const hasGlob = typeof args.glob === 'string' && args.glob.length > 0
  if (hasPath === hasGlob) throw new Error('registerCollection requires exactly one of filePath or glob')

  const table = normalizeTableName(name)
  if (isQueryDataset(table)) throw new Error(`collection table "${table}" conflicts with a built-in query dataset`)

  /** @type {string | undefined} */
  let sourcePath
  /** @type {string | undefined} */
  let sourceGlob
  if (hasPath) {
    sourcePath = path.resolve(/** @type {string} */ (args.filePath))
    const stat = safeStat(sourcePath)
    if (!stat || !stat.isFile()) throw new Error(`JSONL file not found: ${sourcePath}`)
  } else {
    sourceGlob = path.isAbsolute(/** @type {string} */ (args.glob))
      ? /** @type {string} */ (args.glob)
      : path.resolve(/** @type {string} */ (args.glob))
  }

  const manifest = readCollectionsManifest(recordingRoot)
  const existing = manifest.collections[table]
  if (existing && !replace) throw new Error(`collection "${table}" already exists; pass --replace to update it`)

  const now = new Date().toISOString()
  const collection = {
    name,
    table,
    ...(sourcePath ? { source_path: sourcePath } : {}),
    ...(sourceGlob ? { source_glob: sourceGlob } : {}),
    ...(timestampColumn ? { timestamp_column: timestampColumn } : {}),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  }
  manifest.collections[table] = collection
  writeCollectionsManifest(recordingRoot, manifest)
  return collection
}

/**
 * @param {string} recordingRoot
 * @param {string} nameOrTable
 * @returns {JsonlCollection | undefined}
 */
export function removeCollection(recordingRoot, nameOrTable) {
  const manifest = readCollectionsManifest(recordingRoot)
  const collection = findCollection(manifest, nameOrTable)
  if (!collection) return undefined
  delete manifest.collections[collection.table]
  writeCollectionsManifest(recordingRoot, manifest)
  return collection
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {CollectionCachePartition[]}
 */
export function expectedCollectionPartitions(paths, scope) {
  if (!paths.cacheDir) return []
  const manifest = readCollectionsManifest(paths.recordingRoot)
  const wanted = collectionTablesForScope(manifest, scope)
  const sourcePaths = sourcePathFilter(scope)
  const partitions = wanted.flatMap((collection) => collectionPartitionsFor(paths.cacheDir, collection))
  if (!sourcePaths) return partitions
  return partitions.filter((partition) => sourcePaths.has(path.resolve(partition.jsonlPath)))
}

/**
 * @param {string} cacheDir
 * @param {JsonlCollection} collection
 * @returns {CollectionCachePartition[]}
 */
export function collectionPartitionsFor(cacheDir, collection) {
  /** @type {Set<string>} */
  const paths = new Set()
  if (typeof collection.source_glob === 'string') {
    for (const match of resolveGlobMatches(collection.source_glob)) paths.add(match)
    for (const cursor of listCollectionCursors(cacheDir, collection)) paths.add(path.resolve(cursor.source_path))
  } else if (typeof collection.source_path === 'string') {
    paths.add(path.resolve(collection.source_path))
    for (const cursor of listCollectionCursors(cacheDir, collection)) paths.add(path.resolve(cursor.source_path))
  }
  return [...paths].sort().map((absPath) => buildPartition(cacheDir, collection, absPath))
}

/**
 * @param {string} cacheDir
 * @param {JsonlCollection} collection
 * @returns {CollectionCachePartition}
 */
export function collectionPartitionFor(cacheDir, collection) {
  const partitions = collectionPartitionsFor(cacheDir, collection)
  if (partitions.length === 0) throw new Error(`collection "${collection.table}" has no resolvable source partitions`)
  return partitions[0]
}

/**
 * @param {string} cacheDir
 * @param {JsonlCollection} collection
 * @param {string} absSourcePath
 * @returns {CollectionCachePartition}
 */
function buildPartition(cacheDir, collection, absSourcePath) {
  const sourceDir = collectionSourceDir(cacheDir, collection.table, absSourcePath)
  const cursorPath = path.join(sourceDir, 'cursor.json')
  const cursor = readCollectionCursor(cursorPath)
  const tablePath = cursor?.table_path ?? path.join(sourceDir, 'epoch=0')
  const stat = safeStat(absSourcePath)
  return {
    kind: 'collection',
    dataset: collection.table,
    table: collection.table,
    collection,
    jsonlPath: absSourcePath,
    sourceExists: Boolean(stat?.isFile()),
    sourceSize: stat?.isFile() ? stat.size : cursor?.source_size ?? -1,
    sourceMtimeMs: stat?.isFile() ? stat.mtimeMs : cursor?.source_mtime_ms ?? -1,
    cachePath: sourceDir,
    cursorPath,
    tablePath,
    tableUrl: cursor?.table_url ?? queryCacheTableUrl(tablePath),
  }
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {JsonlCollection[]}
 */
export function collectionTablesForQuery(paths, scope) {
  const manifest = readCollectionsManifest(paths.recordingRoot)
  return collectionTablesForScope(manifest, scope)
}

/**
 * @param {CollectionCachePartition} partition
 * @returns {{ partition: CollectionCachePartition, status: 'fresh' | 'missing' | 'stale', meta?: CollectionCacheMeta, reason?: string }}
 */
export function inspectCollectionCachePartition(partition) {
  const cursor = readCollectionCursor(partition.cursorPath)
  if (!cursor) return { partition, status: 'missing', reason: 'cache cursor is missing' }
  const reason = collectionCursorIdentityReason(partition, cursor)
  if (reason) return { partition, status: 'stale', meta: cursorToMeta(cursor), reason }
  if (!queryCacheTableExists(cursor.table_path)) {
    return { partition, status: 'stale', meta: cursorToMeta(cursor), reason: 'cache table is missing' }
  }
  if (!partition.sourceExists) return { partition, status: 'fresh', meta: cursorToMeta(cursor) }
  if (partition.sourceSize < cursor.byte_offset) {
    return { partition, status: 'stale', meta: cursorToMeta(cursor), reason: 'source was truncated' }
  }
  if (partition.sourceSize > cursor.byte_offset) {
    return { partition, status: 'stale', meta: cursorToMeta(cursor), reason: 'source size changed' }
  }
  return { partition, status: 'fresh', meta: cursorToMeta(cursor) }
}

/**
 * @param {CollectionCachePartition[]} partitions
 * @returns {Array<ReturnType<typeof inspectCollectionCachePartition>>}
 */
export function inspectCollectionCachePartitions(partitions) {
  return partitions.map((partition) => inspectCollectionCachePartition(partition))
}

/**
 * @param {string} cacheDir
 * @param {JsonlCollection} collection
 * @returns {CollectionCacheMeta | undefined}
 */
export function readAnyCollectionMeta(cacheDir, collection) {
  /** @type {CollectionCacheMeta | undefined} */
  let base
  /** @type {Map<string, CollectionColumnMeta>} */
  const columns = new Map()
  for (const partition of collectionPartitionsFor(cacheDir, collection)) {
    const cursor = readCollectionCursor(partition.cursorPath)
    if (!cursor) continue
    const meta = cursorToMeta(cursor)
    if (!base) base = meta
    for (const column of meta.columns) {
      if (!columns.has(column.name)) columns.set(column.name, column)
    }
  }
  if (!base) return undefined
  return { ...base, columns: [...columns.values()] }
}

/**
 * @param {string} cursorPath
 * @returns {CollectionCacheMeta | undefined}
 */
export function readCollectionCacheMeta(cursorPath) {
  const cursor = readCollectionCursor(cursorPath)
  return cursor ? cursorToMeta(cursor) : undefined
}

/**
 * @param {{
 *   paths: QueryPaths,
 *   scope: QueryScope,
 *   force?: boolean,
 *   stdout?: { write: (s: string) => void },
 * }} args
 * @returns {Promise<RefreshResult>}
 */
export async function refreshCollectionCache(args) {
  const { paths, scope, force = false, stdout } = args
  if (!paths.cacheEnabled || !paths.cacheDir) {
    throw new Error('query cache is disabled; pass --cache-dir to refresh explicitly')
  }

  /** @type {RefreshResult} */
  const result = { written: 0, skipped: 0, rows: 0, failures: 0, files: [] }
  for (const partition of expectedCollectionPartitions(paths, scope)) {
    const state = inspectCollectionCachePartition(partition)
    if (!force && state.status === 'fresh') {
      result.skipped++
      result.files.push({
        dataset: partition.table,
        gatewayId: '',
        date: '',
        rows: state.meta?.row_count ?? 0,
        cachePath: partition.cachePath,
        status: 'skipped',
      })
      stdout?.write(`fresh ${partition.table}\n`)
      continue
    }

    try {
      if (!partition.sourceExists) throw new Error(`source JSONL file not found: ${partition.jsonlPath}`)
      const materialized = await materializeCollectionIncremental(partition, force)
      result.written++
      result.rows += materialized.rows
      result.files.push({
        dataset: partition.table,
        gatewayId: '',
        date: '',
        rows: materialized.rows,
        cachePath: partition.cachePath,
        status: 'written',
      })
      stdout?.write(`wrote ${partition.cachePath} (${materialized.rows} rows)\n`)
    } catch (err) {
      result.failures++
      result.files.push({
        dataset: partition.table,
        gatewayId: '',
        date: '',
        rows: 0,
        cachePath: partition.cachePath,
        status: 'failed',
        error: formatError(err),
      })
    }
  }
  return result
}

/**
 * @param {CollectionCachePartition} partition
 * @param {boolean} force
 * @returns {Promise<{ rows: number }>}
 */
async function materializeCollectionIncremental(partition, force) {
  const existing = readCollectionCursor(partition.cursorPath)
  const sourceId = existing?.source_id ?? stableCollectionSourceId(partition)
  let reset = force || !existing || existing.cache_schema_version !== QUERY_CACHE_SCHEMA_VERSION
  if (existing && partition.sourceSize < existing.byte_offset) reset = true

  let columns = existing?.columns
  let timestampColumn = existing?.timestamp_column
  let startByteOffset = reset ? 0 : existing?.byte_offset ?? 0
  let startLineNumber = reset ? 0 : existing?.line_number ?? 0
  if (!reset && existing) {
    const nextColumns = await inferCollectionColumnsFromJsonl(
      partition.jsonlPath,
      partition.collection.timestamp_column,
      startByteOffset,
      startLineNumber
    )
    if (!columnsCompatible(existing.columns, nextColumns)) {
      reset = true
      startByteOffset = 0
      startLineNumber = 0
    }
  }
  if (reset || !columns) {
    columns = await inferCollectionColumnsFromJsonl(partition.jsonlPath, partition.collection.timestamp_column, 0, 0)
    timestampColumn = resolveTimestampColumn(columns, partition.collection.timestamp_column)
  }
  const materializedColumns = columns

  const epoch = reset ? (existing?.source_epoch ?? -1) + 1 : existing?.source_epoch ?? 0
  const tablePath = reset ? path.join(partition.cachePath, `epoch=${epoch}`) : existing?.table_path ?? partition.tablePath
  const tableUrl = queryCacheTableUrl(tablePath)
  const columnSpecs = collectionColumnsToSpecs(materializedColumns)
  let rowsWritten = 0
  const read = await readJsonlEntryBatches(
    partition.jsonlPath,
    { startByteOffset, startLineNumber },
    async (batch) => {
      const rows = batch.entries.map((entry) => materializeRow(entry, materializedColumns, partition.jsonlPath, sourceId, epoch))
      await appendRowsToTable(tablePath, columnSpecs, rows)
      rowsWritten += rows.length
    }
  )
  if (!reset && read.nextByteOffset === existing?.byte_offset && rowsWritten === 0) return { rows: 0 }
  if (rowsWritten === 0) await appendRowsToTable(tablePath, columnSpecs, [])
  writeCacheCursor(partition.cursorPath, {
    cache_schema_version: QUERY_CACHE_SCHEMA_VERSION,
    kind: 'collection',
    table: partition.table,
    name: partition.collection.name,
    source_id: sourceId,
    source_path: partition.jsonlPath,
    source_epoch: epoch,
    table_path: tablePath,
    table_url: tableUrl,
    source_size: read.nextByteOffset,
    source_mtime_ms: read.fileMtimeMs,
    byte_offset: read.nextByteOffset,
    line_number: read.nextLineNumber,
    row_count: (reset ? 0 : existing?.row_count ?? 0) + rowsWritten,
    schema_fingerprint: stableFingerprint(materializedColumns),
    refreshed_at: new Date().toISOString(),
    columns: materializedColumns,
    ...(timestampColumn ? { timestamp_column: timestampColumn } : {}),
  })
  return { rows: rowsWritten }
}

/**
 * @param {CollectionColumnMeta[]} existing
 * @param {CollectionColumnMeta[]} next
 * @returns {boolean}
 */
function columnsCompatible(existing, next) {
  const bySource = new Map(existing.filter((column) => column.source_field).map((column) => [column.source_field, column]))
  for (const column of next) {
    if (!column.source_field) continue
    const prior = bySource.get(column.source_field)
    if (!prior) return false
    if (prior.type !== column.type && column.type !== 'JSON') return false
  }
  return true
}

/**
 * @param {JsonlEntry} entry
 * @param {CollectionColumnMeta[]} columns
 * @param {string} sourcePath
 * @param {string} sourceId
 * @param {number} epoch
 * @returns {Record<string, unknown>}
 */
function materializeRow(entry, columns, sourcePath, sourceId, epoch) {
  /** @type {Record<string, unknown>} */
  const out = {
    _ctvs_source_path: sourcePath,
    _ctvs_line_number: entry.lineNumber,
    _ctvs_raw: entry.raw,
    _ctvs_row_id: `${sourceId}:${epoch}:${entry.lineNumber}`,
    _ctvs_source_id: sourceId,
    _ctvs_source_epoch: epoch,
    _ctvs_byte_offset: entry.byteOffset,
  }
  for (const column of columns) {
    if (!column.source_field) continue
    out[column.name] = entry.raw[column.source_field]
  }
  return out
}

/**
 * @param {string} pattern
 * @returns {string[]}
 */
function resolveGlobMatches(pattern) {
  const abs = path.isAbsolute(pattern) ? pattern : path.resolve(pattern)
  const { root, regex } = compileGlobPattern(abs)
  if (!isDir(root)) return []
  /** @type {string[]} */
  const out = []
  walkDir(root, (filePath) => {
    if (regex.test(filePath)) out.push(filePath)
  })
  out.sort()
  return out
}

/**
 * @param {string} absPattern
 * @returns {{ root: string, regex: RegExp }}
 */
function compileGlobPattern(absPattern) {
  const segments = absPattern.split('/')
  /** @type {string[]} */
  const rootSegments = []
  let rootDone = false
  for (const seg of segments) {
    if (!rootDone && !hasGlobChars(seg)) rootSegments.push(seg)
    else rootDone = true
  }
  const root = rootSegments.join('/') || '/'
  /** @type {string[]} */
  const out = []
  for (let i = 0; i < absPattern.length; i++) {
    const ch = absPattern[i]
    if (ch === '*' && absPattern[i + 1] === '*') { out.push('.*'); i++; continue }
    if (ch === '*') { out.push('[^/]*'); continue }
    if (ch === '?') { out.push('[^/]'); continue }
    if (/[.+^$(){}|[\]\\]/.test(ch)) { out.push(`\\${ch}`); continue }
    out.push(ch)
  }
  return { root, regex: new RegExp(`^${out.join('')}$`) }
}

/**
 * @param {string} seg
 * @returns {boolean}
 */
function hasGlobChars(seg) {
  return /[*?[\]{}]/.test(seg)
}

/**
 * @param {string} dir
 * @param {(filePath: string) => void} onFile
 * @returns {void}
 */
function walkDir(dir, onFile) {
  /** @type {fs.Dirent[]} */
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkDir(full, onFile)
    else if (entry.isFile()) onFile(full)
  }
}

/**
 * @param {string} filePath
 * @param {string | undefined} requestedTimestampColumn
 * @param {number} startByteOffset
 * @param {number} startLineNumber
 * @returns {Promise<CollectionColumnMeta[]>}
 */
async function inferCollectionColumnsFromJsonl(filePath, requestedTimestampColumn, startByteOffset, startLineNumber) {
  const inference = createCollectionColumnInference(requestedTimestampColumn)
  await readJsonlEntryBatches(
    filePath,
    { startByteOffset, startLineNumber },
    (batch) => {
      for (const entry of batch.entries) inference.observe(entry.raw)
    }
  )
  return inference.columns()
}

/**
 * @param {string | undefined} requestedTimestampColumn
 * @returns {{
 *   observe: (raw: Record<string, unknown>) => void,
 *   columns: () => CollectionColumnMeta[],
 * }}
 */
function createCollectionColumnInference(requestedTimestampColumn) {
  /** @type {CollectionColumnMeta[]} */
  const baseColumns = [...META_COLUMNS]
  /** @type {Map<string, {
   *   sourceField: string,
   *   present: number,
   *   nullable: boolean,
   *   hasValue: boolean,
   *   allBooleans: boolean,
   *   allNumbers: boolean,
   *   allStrings: boolean,
   *   allTimestamps: boolean,
   * }>} */
  const stats = new Map()
  let rows = 0

  return {
    observe(raw) {
      rows++
      for (const [sourceField, value] of Object.entries(raw)) {
        let stat = stats.get(sourceField)
        if (!stat) {
          stat = {
            sourceField,
            present: 0,
            nullable: false,
            hasValue: false,
            allBooleans: true,
            allNumbers: true,
            allStrings: true,
            allTimestamps: true,
          }
          stats.set(sourceField, stat)
        }
        stat.present++
        if (value === undefined || value === null) {
          stat.nullable = true
          continue
        }
        stat.hasValue = true
        if (typeof value !== 'boolean') stat.allBooleans = false
        if (typeof value !== 'number' || !Number.isFinite(value)) stat.allNumbers = false
        if (typeof value !== 'string') stat.allStrings = false
        if (!isTimestampValue(value)) stat.allTimestamps = false
      }
    },
    columns() {
      /** @type {CollectionColumnMeta[]} */
      const columns = [...baseColumns]
      /** @type {Set<string>} */
      const usedNames = new Set(columns.map((column) => column.name))

      for (const stat of stats.values()) {
        const baseName = normalizeColumnName(stat.sourceField)
        const name = uniqueName(baseName, usedNames)
        usedNames.add(name)
        columns.push({
          name,
          source_field: stat.sourceField,
          type: inferColumnType(stat.sourceField, name, stat, requestedTimestampColumn),
          nullable: stat.nullable || stat.present < rows,
        })
      }
      return columns
    },
  }
}

/**
 * @param {string} sourceField
 * @param {string} columnName
 * @param {{
 *   hasValue: boolean,
 *   allBooleans: boolean,
 *   allNumbers: boolean,
 *   allStrings: boolean,
 *   allTimestamps: boolean,
 * }} stat
 * @param {string | undefined} requestedTimestampColumn
 * @returns {CollectionColumnMeta['type']}
 */
function inferColumnType(sourceField, columnName, stat, requestedTimestampColumn) {
  if (!stat.hasValue) return 'JSON'
  const requested = requestedTimestampColumn && (
    requestedTimestampColumn === sourceField ||
    normalizeColumnName(requestedTimestampColumn) === columnName
  )
  if ((requested || isTimestampCandidate(sourceField) || isTimestampCandidate(columnName)) && stat.allTimestamps) return 'TIMESTAMP'
  if (stat.allBooleans) return 'BOOLEAN'
  if (stat.allNumbers) return 'DOUBLE'
  if (stat.allStrings) return 'STRING'
  return 'JSON'
}

/**
 * @param {CollectionColumnMeta[]} columns
 * @param {string | undefined} requestedTimestampColumn
 * @returns {string | undefined}
 */
function resolveTimestampColumn(columns, requestedTimestampColumn) {
  if (requestedTimestampColumn) {
    const normalized = normalizeColumnName(requestedTimestampColumn)
    const requested = columns.find((column) => (
      column.source_field === requestedTimestampColumn ||
      column.name === requestedTimestampColumn ||
      column.name === normalized
    ))
    return requested?.name
  }
  const typed = columns.find((column) => column.type === 'TIMESTAMP' && (
    isTimestampCandidate(column.name) ||
    (column.source_field ? isTimestampCandidate(column.source_field) : false)
  ))
  return typed?.name
}

/**
 * @param {CollectionCachePartition} partition
 * @returns {string}
 */
function stableCollectionSourceId(partition) {
  return crypto.createHash('sha256').update(`${partition.table}\0${path.resolve(partition.jsonlPath)}`).digest('hex').slice(0, 16)
}

/**
 * @param {string} cacheDir
 * @param {JsonlCollection} collection
 * @returns {CollectionCacheCursor[]}
 */
function listCollectionCursors(cacheDir, collection) {
  const tableDir = collectionTableDir(cacheDir, collection.table)
  /** @type {CollectionCacheCursor[]} */
  const out = []
  for (const entry of safeReadDir(tableDir)) {
    if (!entry.startsWith('source=')) continue
    const cursor = readCollectionCursor(path.join(tableDir, entry, 'cursor.json'))
    if (cursor) out.push(cursor)
  }
  return out.sort((a, b) => a.source_path < b.source_path ? -1 : a.source_path > b.source_path ? 1 : 0)
}

/**
 * @param {string} cursorPath
 * @returns {CollectionCacheCursor | undefined}
 */
function readCollectionCursor(cursorPath) {
  const cursor = readCacheCursor(cursorPath)
  return cursor?.kind === 'collection' ? cursor : undefined
}

/**
 * @param {CollectionCacheCursor} cursor
 * @returns {CollectionCacheMeta}
 */
function cursorToMeta(cursor) {
  return {
    cache_schema_version: cursor.cache_schema_version,
    kind: 'collection',
    table: cursor.table,
    name: cursor.name,
    source_path: cursor.source_path,
    source_size: cursor.source_size,
    source_mtime_ms: cursor.source_mtime_ms,
    row_count: cursor.row_count,
    refreshed_at: cursor.refreshed_at,
    columns: cursor.columns,
    ...(cursor.timestamp_column ? { timestamp_column: cursor.timestamp_column } : {}),
  }
}

/**
 * @param {CollectionCachePartition} partition
 * @param {CollectionCacheCursor} cursor
 * @returns {string | undefined}
 */
function collectionCursorIdentityReason(partition, cursor) {
  if (cursor.cache_schema_version !== QUERY_CACHE_SCHEMA_VERSION) return 'cache schema version changed'
  if (cursor.table !== partition.table) return 'cache cursor table does not match partition'
  if (path.resolve(cursor.source_path) !== path.resolve(partition.jsonlPath)) return 'cache cursor source path does not match source'
}

/**
 * @param {CollectionsManifest} manifest
 * @param {QueryScope} scope
 * @returns {JsonlCollection[]}
 */
function collectionTablesForScope(manifest, scope) {
  const all = collectionsFromManifest(manifest)
  const requested = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  if (!requested) return all
  const wanted = new Set(requested.filter((dataset) => !isQueryDataset(dataset)))
  return all.filter((collection) => wanted.has(collection.table))
}

/**
 * @param {QueryScope} scope
 * @returns {Set<string> | undefined}
 */
function sourcePathFilter(scope) {
  if (!scope.sourcePaths) return undefined
  return new Set(scope.sourcePaths.map((sourcePath) => path.resolve(sourcePath)))
}

/**
 * @returns {CollectionsManifest}
 */
function emptyManifest() {
  return { version: MANIFEST_VERSION, collections: {} }
}

/**
 * @param {unknown} parsed
 * @param {string} manifestPath
 * @returns {CollectionsManifest}
 */
function normalizeManifest(parsed, manifestPath) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`collection manifest ${manifestPath} must be a JSON object`)
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed)
  if (typeof obj.version !== 'number' || !SUPPORTED_MANIFEST_VERSIONS.has(obj.version)) {
    throw new Error(`collection manifest ${manifestPath} has unsupported version ${JSON.stringify(obj.version)}`)
  }
  if (!obj.collections || typeof obj.collections !== 'object' || Array.isArray(obj.collections)) {
    throw new Error(`collection manifest ${manifestPath} is missing an object collections field`)
  }
  const manifest = emptyManifest()
  for (const [table, value] of Object.entries(/** @type {Record<string, unknown>} */ (obj.collections))) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const collection = /** @type {Partial<JsonlCollection>} */ (value)
    if (typeof collection.name !== 'string') continue
    if (typeof collection.table !== 'string') continue
    if (collection.table !== table) continue
    const hasPath = typeof collection.source_path === 'string'
    const hasGlob = typeof collection.source_glob === 'string'
    if (hasPath === hasGlob) continue
    if (collection.timestamp_column !== undefined && typeof collection.timestamp_column !== 'string') continue
    if (typeof collection.created_at !== 'string') continue
    if (typeof collection.updated_at !== 'string') continue
    manifest.collections[table] = /** @type {JsonlCollection} */ (collection)
  }
  return manifest
}

/**
 * @param {string} value
 * @param {string} fallback
 * @param {'table' | 'field'} kind
 * @returns {string}
 */
function normalizeSqlIdentifier(value, fallback, kind) {
  let out = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  out = out.replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!out) out = fallback
  if (/^\d/.test(out)) out = `_${out}`
  if (RESERVED_SQL_WORDS.has(out)) out = kind === 'table' ? `${out}_table` : `${out}_field`
  return out
}

/**
 * @param {string} base
 * @param {Set<string>} used
 * @returns {string}
 */
function uniqueName(base, used) {
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}_${n}`)) n++
  return `${base}_${n}`
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isTimestampCandidate(value) {
  return TIMESTAMP_CANDIDATES.has(normalizeColumnName(value))
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTimestampValue(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime())
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return Number.isFinite(Date.parse(String(value)))
  return false
}

/**
 * @param {string} p
 * @returns {fs.Stats | undefined}
 */
function safeStat(p) {
  try {
    return fs.statSync(p)
  } catch {
    return undefined
  }
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir).sort()
  } catch {
    return []
  }
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {JsonlCollection} a
 * @param {JsonlCollection} b
 * @returns {number}
 */
function compareCollections(a, b) {
  return a.table < b.table ? -1 : a.table > b.table ? 1 : 0
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
