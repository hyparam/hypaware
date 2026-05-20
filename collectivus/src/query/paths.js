import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultSinkDir as defaultServerIngestDir } from '../server/ingest.js'
import { defaultGascityRoot } from '../gascity/paths.js'
import { GASCITY_GATEWAY_ID } from '../gascity/schema.js'
import {
  QUERY_CACHE_SCHEMA_VERSION,
  QUERY_DATASETS,
  isQueryDataset,
  sourceSignalForDataset,
} from './schema.js'
import { readCacheCursor, stableId } from './iceberg/cursor.js'
import { queryCacheTableExists, queryCacheTableUrl } from './iceberg/store.js'

/**
 * @import { CollectivusConfig } from '../types.js'
 * @import {
 *   CachePartition,
 *   CachePartitionState,
 *   QueryDataset,
 *   QueryPaths,
 *   QueryScope,
 *   SourceFile,
 * } from './types.js'
 * @import { BuiltinCacheCursor } from './iceberg/types.d.ts'
 */

const DATE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const GATEWAY_PARTITION_PATTERN = /^gateway_id=(.+)$/
const DATE_PARTITION_PATTERN = /^date=(\d{4}-\d{2}-\d{2})$/
const CITY_PARTITION_PATTERN = /^city=(.+)$/
const GASCITY_PART_FILE_PATTERN = /^part-.+\.parquet$/

/**
 * @param {CollectivusConfig} config
 * @returns {string | undefined}
 */
export function resolveRecordingRoot(config) {
  if (config.role === 'server') return config.server?.sink_dir ?? defaultServerIngestDir()
  return config.sink?.dir
}

/**
 * @param {CollectivusConfig} config
 * @param {string} recordingRoot
 * @param {string | undefined} explicitCacheDir
 * @returns {{ cacheDir?: string, cacheEnabled: boolean, explicitCacheDir: boolean }}
 */
export function resolveCacheSettings(config, recordingRoot, explicitCacheDir) {
  if (explicitCacheDir) {
    return { cacheDir: explicitCacheDir, cacheEnabled: true, explicitCacheDir: true }
  }
  const cache = config.query?.cache
  const enabled = cache?.enabled !== false
  const cacheDir = cache?.dir ?? path.join(recordingRoot, '.collectivus-query', 'cache')
  return { cacheDir, cacheEnabled: enabled, explicitCacheDir: false }
}

/**
 * @param {CollectivusConfig} config
 * @param {string} configPath
 * @param {string | undefined} explicitCacheDir
 * @returns {QueryPaths}
 */
export function resolveQueryPaths(config, configPath, explicitCacheDir) {
  const recordingRoot = resolveRecordingRoot(config)
  if (!recordingRoot) {
    throw new Error('config has no local recording root; set sink.dir or server.sink_dir')
  }
  const cache = resolveCacheSettings(config, recordingRoot, explicitCacheDir)
  return { config, configPath, recordingRoot, ...cache }
}

/**
 * @param {string} cacheDir
 * @param {QueryDataset} dataset
 * @param {string} gatewayId
 * @param {string} date
 * @returns {string}
 */
export function builtinPartitionDir(cacheDir, dataset, gatewayId, date) {
  return path.join(cacheDir, 'datasets', dataset, `gateway_id=${gatewayId}`, `date=${date}`)
}

/**
 * @param {string} cacheDir
 * @param {QueryDataset} dataset
 * @param {SourceFile} source
 * @returns {CachePartition}
 */
export function cachePartitionForSource(cacheDir, dataset, source) {
  const cachePath = builtinPartitionDir(cacheDir, dataset, source.gatewayId, source.date)
  const cursorPath = path.join(cachePath, 'cursor.json')
  const cursor = readCacheCursor(cursorPath)
  const tablePath = cursor?.kind === 'builtin'
    ? cursor.table_path
    : path.join(cachePath, 'epoch=0')
  return {
    dataset,
    gatewayId: source.gatewayId,
    date: source.date,
    jsonlPath: source.jsonlPath,
    sourceSize: source.size,
    sourceMtimeMs: source.mtimeMs,
    cachePath,
    cursorPath,
    tablePath,
    tableUrl: queryCacheTableUrl(tablePath),
  }
}

/**
 * @param {string} cacheDir
 * @param {BuiltinCacheCursor} cursor
 * @returns {CachePartition}
 */
function cachePartitionFromCursor(cacheDir, cursor) {
  const stat = safeStat(cursor.source_path)
  const cachePath = builtinPartitionDir(cacheDir, cursor.dataset, cursor.gateway_id, cursor.date)
  return {
    dataset: cursor.dataset,
    gatewayId: cursor.gateway_id,
    date: cursor.date,
    jsonlPath: cursor.source_path,
    sourceSize: stat?.isFile() ? stat.size : cursor.source_size,
    sourceMtimeMs: stat?.isFile() ? stat.mtimeMs : cursor.source_mtime_ms,
    cachePath,
    cursorPath: path.join(cachePath, 'cursor.json'),
    tablePath: cursor.table_path,
    tableUrl: cursor.table_url,
  }
}

/**
 * @param {SourceFile} source
 * @param {QueryDataset[] | undefined} datasets
 * @returns {QueryDataset[]}
 */
export function datasetsForSource(source, datasets) {
  /** @type {QueryDataset[]} */
  const out = []
  if (source.signal === 'proxy') out.push('proxy_messages')
  else out.push(source.signal)
  if (!datasets || datasets.length === 0) return out
  return out.filter((dataset) => datasets.includes(dataset))
}

/**
 * @param {string} root
 * @param {QueryScope} scope
 * @returns {SourceFile[]}
 */
export function discoverSourceFiles(root, scope) {
  const requestedDatasets = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  const datasets = requestedDatasets?.filter(isQueryDataset)
  if (requestedDatasets && datasets?.length === 0) return []
  const wantedSignals = datasets
    ? new Set(datasets.map((dataset) => sourceSignalForDataset(dataset)))
    : new Set(['logs', 'traces', 'metrics', 'proxy'])
  const sourcePaths = sourcePathFilter(scope)
  /** @type {SourceFile[]} */
  const files = []
  const gatewayIds = scope.gatewayId ? [scope.gatewayId] : safeReadDir(root)
  for (const gatewayId of gatewayIds) {
    const idDir = path.join(root, gatewayId)
    if (!isDirectory(idDir)) continue
    for (const signal of ['logs', 'traces', 'metrics', 'proxy']) {
      if (!wantedSignals.has(signal)) continue
      const signalDir = path.join(idDir, signal)
      if (!isDirectory(signalDir)) continue
      for (const entry of safeReadDir(signalDir)) {
        const match = DATE_FILE_PATTERN.exec(entry)
        if (!match) continue
        const date = match[1]
        if (!dateMatchesScope(date, scope)) continue
        const jsonlPath = path.join(signalDir, entry)
        if (sourcePaths && !sourcePaths.has(path.resolve(jsonlPath))) continue
        const stat = safeStat(jsonlPath)
        if (!stat || !stat.isFile()) continue
        files.push({
          gatewayId,
          signal: /** @type {SourceFile['signal']} */ (signal),
          date,
          jsonlPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      }
    }
  }
  files.sort(compareSourceFiles)
  return files
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {CachePartition[]}
 */
export function expectedCachePartitions(paths, scope) {
  const requestedDatasets = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  const datasets = requestedDatasets?.filter(isQueryDataset)
  if (requestedDatasets && datasets?.length === 0) return []

  /** @type {CachePartition[]} */
  const partitions = []
  if (!datasets || datasets.includes('gascity_messages')) {
    partitions.push(...discoverGascityPartitions(scope))
  }

  const otherRequested = datasets ? datasets.filter((d) => d !== 'gascity_messages') : undefined
  const wantsOther = !datasets || (otherRequested && otherRequested.length > 0)
  if (!wantsOther || !paths.cacheDir) return partitions

  /** @type {Set<string>} */
  const seen = new Set()
  for (const source of discoverSourceFiles(paths.recordingRoot, scope)) {
    for (const dataset of datasetsForSource(source, otherRequested)) {
      const partition = cachePartitionForSource(paths.cacheDir, dataset, source)
      seen.add(partitionKey(partition))
      partitions.push(partition)
    }
  }
  for (const cursor of listBuiltinCacheCursors(paths.cacheDir, otherRequested ? { ...scope, datasets: otherRequested } : scope)) {
    const key = `${cursor.dataset}\0${cursor.gateway_id}\0${cursor.date}`
    if (seen.has(key)) continue
    partitions.push(cachePartitionFromCursor(paths.cacheDir, cursor))
  }
  return partitions
}

/**
 * @param {QueryScope} scope
 * @returns {CachePartition[]}
 */
export function discoverGascityPartitions(scope) {
  if (scope.gatewayId && scope.gatewayId !== GASCITY_GATEWAY_ID) return []
  const root = defaultGascityRoot()
  if (!isDirectory(root)) return []
  /** @type {CachePartition[]} */
  const out = []
  for (const dateEntry of safeReadDir(root)) {
    const dateMatch = DATE_PARTITION_PATTERN.exec(dateEntry)
    if (!dateMatch) continue
    const date = dateMatch[1]
    if (!dateMatchesScope(date, scope)) continue
    const dateDir = path.join(root, dateEntry)
    if (!isDirectory(dateDir)) continue
    for (const cityEntry of safeReadDir(dateDir)) {
      const cityMatch = CITY_PARTITION_PATTERN.exec(cityEntry)
      if (!cityMatch) continue
      const cityDir = path.join(dateDir, cityEntry)
      if (!isDirectory(cityDir)) continue
      for (const file of safeReadDir(cityDir)) {
        if (!GASCITY_PART_FILE_PATTERN.test(file)) continue
        const parquetPath = path.join(cityDir, file)
        const stat = safeStat(parquetPath)
        if (!stat || !stat.isFile()) continue
        out.push({
          dataset: 'gascity_messages',
          gatewayId: GASCITY_GATEWAY_ID,
          date,
          jsonlPath: parquetPath,
          sourceSize: stat.size,
          sourceMtimeMs: stat.mtimeMs,
          cachePath: parquetPath,
          cursorPath: '',
          tablePath: parquetPath,
          tableUrl: '',
        })
      }
    }
  }
  return out
}

/**
 * @param {CachePartition} partition
 * @returns {CachePartitionState}
 */
export function inspectCachePartition(partition) {
  if (partition.dataset === 'gascity_messages') {
    if (!isFile(partition.cachePath)) return { partition, status: 'missing', reason: 'parquet part file is missing' }
    return { partition, status: 'fresh' }
  }

  const cursor = readCacheCursor(partition.cursorPath)
  const sourceExists = isFile(partition.jsonlPath)
  if (!cursor) return { partition, status: 'missing', reason: 'cache cursor is missing' }
  if (cursor.kind !== 'builtin') return { partition, status: 'stale', reason: 'cache cursor kind does not match partition' }
  const identityReason = builtinCursorIdentityReason(partition, cursor)
  if (identityReason) return { partition, status: 'stale', meta: cursor, reason: identityReason }
  if (!queryCacheTableExists(cursor.table_path)) {
    return { partition, status: 'stale', meta: cursor, reason: 'cache table is missing' }
  }
  if (!sourceExists) return { partition, status: 'fresh', meta: cursor }
  if (partition.sourceSize < cursor.byte_offset) {
    return { partition, status: 'stale', meta: cursor, reason: 'source was truncated' }
  }
  if (partition.sourceSize > cursor.byte_offset) {
    return { partition, status: 'stale', meta: cursor, reason: 'source size changed' }
  }
  return { partition, status: 'fresh', meta: cursor }
}

/**
 * @param {CachePartition[]} partitions
 * @returns {CachePartitionState[]}
 */
export function inspectCachePartitions(partitions) {
  return partitions.map((partition) => inspectCachePartition(partition))
}

/**
 * @param {CachePartitionState[]} states
 * @returns {boolean}
 */
export function hasUnfreshPartitions(states) {
  return states.some((state) => state.status !== 'fresh')
}

/**
 * @param {string} cacheDir
 * @param {QueryScope} scope
 * @returns {BuiltinCacheCursor[]}
 */
export function listBuiltinCacheCursors(cacheDir, scope) {
  const requestedDatasets = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  const datasets = requestedDatasets ? requestedDatasets.filter(isQueryDataset) : QUERY_DATASETS
  const sourcePaths = sourcePathFilter(scope)
  /** @type {BuiltinCacheCursor[]} */
  const out = []
  for (const dataset of datasets) {
    if (dataset === 'gascity_messages') continue
    const datasetDir = path.join(cacheDir, 'datasets', dataset)
    for (const gatewayEntry of safeReadDir(datasetDir)) {
      const gatewayMatch = GATEWAY_PARTITION_PATTERN.exec(gatewayEntry)
      if (!gatewayMatch) continue
      const gatewayId = gatewayMatch[1]
      if (scope.gatewayId && gatewayId !== scope.gatewayId) continue
      const gatewayDir = path.join(datasetDir, gatewayEntry)
      for (const dateEntry of safeReadDir(gatewayDir)) {
        const dateMatch = DATE_PARTITION_PATTERN.exec(dateEntry)
        if (!dateMatch) continue
        const date = dateMatch[1]
        if (!dateMatchesScope(date, scope)) continue
        const cursor = readCacheCursor(path.join(gatewayDir, dateEntry, 'cursor.json'))
        if (!cursor || cursor.kind !== 'builtin') continue
        if (sourcePaths && !sourcePaths.has(path.resolve(cursor.source_path))) continue
        out.push(cursor)
      }
    }
  }
  out.sort(compareCursors)
  return out
}

/**
 * @param {CachePartition} partition
 * @param {BuiltinCacheCursor} cursor
 * @returns {string | undefined}
 */
function builtinCursorIdentityReason(partition, cursor) {
  if (cursor.cache_schema_version !== QUERY_CACHE_SCHEMA_VERSION) return 'cache schema version changed'
  if (cursor.dataset !== partition.dataset) return 'cache cursor dataset does not match partition'
  if (cursor.gateway_id !== partition.gatewayId) return 'cache cursor gateway_id does not match partition'
  if (cursor.date !== partition.date) return 'cache cursor date does not match partition'
  if (path.resolve(cursor.source_path) !== path.resolve(partition.jsonlPath)) return 'cache cursor source path does not match source'
}

/**
 * @param {CachePartition} partition
 * @returns {string}
 */
function partitionKey(partition) {
  return `${partition.dataset}\0${partition.gatewayId}\0${partition.date}`
}

/**
 * @param {string} cacheDir
 * @param {QueryDataset} dataset
 * @param {string} gatewayId
 * @param {string} date
 * @returns {{ cachePath: string, cursorPath: string, tablePath: string, tableUrl: string, sourceId: string }}
 */
export function nextBuiltinCacheLocation(cacheDir, dataset, gatewayId, date) {
  const cachePath = builtinPartitionDir(cacheDir, dataset, gatewayId, date)
  const cursorPath = path.join(cachePath, 'cursor.json')
  const existing = readCacheCursor(cursorPath)
  const epoch = existing?.kind === 'builtin' ? existing.source_epoch + 1 : 0
  const tablePath = path.join(cachePath, `epoch=${epoch}`)
  return {
    cachePath,
    cursorPath,
    tablePath,
    tableUrl: queryCacheTableUrl(tablePath),
    sourceId: stableId(`${dataset}\0${gatewayId}\0${date}`),
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
 * @param {string} p
 * @returns {boolean}
 */
function isDirectory(p) {
  return safeStat(p)?.isDirectory() ?? false
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isFile(p) {
  return safeStat(p)?.isFile() ?? false
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
 * @param {string} date
 * @param {QueryScope} scope
 * @returns {boolean}
 */
function dateMatchesScope(date, scope) {
  if (scope.date && date !== scope.date) return false
  if (scope.dates && !scope.dates.includes(date)) return false
  return true
}

/**
 * @param {SourceFile} a
 * @param {SourceFile} b
 * @returns {number}
 */
function compareSourceFiles(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.gatewayId !== b.gatewayId) return a.gatewayId < b.gatewayId ? -1 : 1
  if (a.signal !== b.signal) return a.signal < b.signal ? -1 : 1
  return 0
}

/**
 * @param {BuiltinCacheCursor} a
 * @param {BuiltinCacheCursor} b
 * @returns {number}
 */
function compareCursors(a, b) {
  if (a.dataset !== b.dataset) return a.dataset < b.dataset ? -1 : 1
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.gateway_id !== b.gateway_id) return a.gateway_id < b.gateway_id ? -1 : 1
  return 0
}

/**
 * @returns {string}
 */
export function defaultHomeConfigPath() {
  return path.join(os.homedir(), '.hyp', 'collectivus.json')
}
