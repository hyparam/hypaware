// @ts-check

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

import {
  fileCatalog,
  icebergExpireSnapshots,
  loadLatestFileCatalogMetadata,
} from 'icebird'

import { Attr, getMeter, withSpan } from '../observability/index.js'
import { inferColumnType } from './migrate.js'
import { discoverCachePartitions, readCursorSync, writeCursor } from './partition.js'
import { datasetsRoot } from './paths.js'
import { createLocalIcebergIO, tableUrlForDir } from './iceberg/resolver.js'
import { columnsFromIcebergSchema } from './iceberg/schema.js'
import { appendRowsToTable, currentPartitionSpec, currentSchema, scanRowsFromTable, tableExists } from './iceberg/store.js'

/**
 * @import { QueryCacheMaintenanceConfig } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import {
 *   CachePartitionMeta,
 *   CacheStatusPartition,
 *   CacheStatusReport,
 *   MaintenanceConfig,
 *   MaintenanceOptions,
 *   MaintenancePartitionReport,
 *   MaintenanceReport,
 *   PartitionCursor,
 *   AppendOptions,
 * } from './types.d.ts'
 * @import { ColumnSpec } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { PartitionSpec, TableMetadata } from 'icebird/src/types.js'
 * @import { Dirent } from 'node:fs'
 */

export const SNAPSHOT_RETENTION_DEFAULTS = Object.freeze({
  min_snapshots_to_keep: 10,
  max_snapshot_age_hours: 24,
})

/** @type {MaintenanceConfig} */
const DEFAULTS = {
  enabled: true,
  interval_minutes: 60,
  target_file_bytes: 128 * 1024 * 1024,
  ...SNAPSHOT_RETENTION_DEFAULTS,
  compact_file_count: 32,
  compact_avg_file_bytes: 32 * 1024 * 1024,
  compact_batch_bytes: 32 * 1024 * 1024,
  max_tick_ms: 30_000,
}

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000

/**
 * How long an unreferenced (cursor-orphaned) table generation must sit
 * untouched before the orphan sweep reclaims it. Long enough that an
 * in-flight compaction writing a new generation is never mistaken for
 * garbage; short enough that a crashed compaction's leak is reclaimed
 * on the next maintenance tick that finds it stale.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000

/**
 * @param {Partial<MaintenanceConfig> | undefined} config
 * @returns {MaintenanceConfig}
 */
export function normalizeMaintenanceConfig(config) {
  return {
    enabled: config?.enabled ?? DEFAULTS.enabled,
    interval_minutes: config?.interval_minutes ?? DEFAULTS.interval_minutes,
    target_file_bytes: config?.target_file_bytes ?? DEFAULTS.target_file_bytes,
    min_snapshots_to_keep: config?.min_snapshots_to_keep ?? DEFAULTS.min_snapshots_to_keep,
    max_snapshot_age_hours: config?.max_snapshot_age_hours ?? DEFAULTS.max_snapshot_age_hours,
    compact_file_count: config?.compact_file_count ?? DEFAULTS.compact_file_count,
    compact_avg_file_bytes: config?.compact_avg_file_bytes ?? DEFAULTS.compact_avg_file_bytes,
    compact_batch_bytes: config?.compact_batch_bytes ?? DEFAULTS.compact_batch_bytes,
    max_tick_ms: config?.max_tick_ms ?? DEFAULTS.max_tick_ms,
  }
}

/**
 * Run cache maintenance: snapshot expiration and compaction.
 *
 * @param {MaintenanceOptions} opts
 * @returns {Promise<MaintenanceReport>}
 */
export async function maintainCache(opts) {
  const cfg = normalizeMaintenanceConfig(opts.config)
  const startMs = Date.now()
  const budgetMs = opts.budgetMs ?? Infinity
  const meter = getMeter('cache')
  const snapshotsExpiredCounter = meter.createCounter('hyp_snapshots_expired', {
    description: 'Iceberg snapshots expired by maintenance',
  })
  const compactionsCounter = meter.createCounter('hyp_compactions', {
    description: 'Partitions compacted by maintenance',
  })

  const scope = opts.dataset ? { datasets: [opts.dataset] } : {}
  const partitions = await discoverCachePartitions(opts.cacheRoot, scope)

  /** @type {MaintenancePartitionReport[]} */
  const reports = []
  let totalSnapshotsExpired = 0
  let totalCompacted = 0

  for (const part of partitions) {
    if (Date.now() - startMs > budgetMs) break

    const report = await withSpan(
      'maintenance.partition',
      {
        [Attr.COMPONENT]: 'cache',
        [Attr.OPERATION]: 'maintenance.partition',
        [Attr.DATASET]: part.dataset,
        partition: JSON.stringify(part.partition),
        status: 'ok',
      },
      async () => {
        /** @type {MaintenancePartitionReport} */
        const r = {
          dataset: part.dataset,
          partition: part.partition,
          path: part.path,
          snapshotsExpired: 0,
          compacted: false,
          rowCount: part.rowCount,
          dataFilesBefore: 0,
          dataFilesAfter: 0,
        }

        const cursor = readCursorSync(part.path)

        if (cursor.layout === 'source-table') {
          return await maintainSourceTable(r, cursor, cfg, opts, snapshotsExpiredCounter, compactionsCounter)
        }

        return await maintainLegacyPartition(r, part, cursor, cfg, opts, snapshotsExpiredCounter, compactionsCounter)
      },
      { component: 'cache' }
    )
    reports.push(report)
    totalSnapshotsExpired += report.snapshotsExpired
    if (report.compacted) totalCompacted++
  }

  if (!opts.dryRun) {
    await cleanRetiredEpochs(opts.cacheRoot)
  }

  return {
    partitions: reports,
    totalSnapshotsExpired,
    totalCompacted,
    dryRun: opts.dryRun ?? false,
    elapsedMs: Date.now() - startMs,
  }
}

/**
 * Maintain a source-table layout partition: expire snapshots and
 * compact inside the `table/` directory without advancing epochs.
 *
 * @param {MaintenancePartitionReport} r
 * @param {PartitionCursor} cursor
 * @param {MaintenanceConfig} cfg
 * @param {MaintenanceOptions} opts
 * @param {{ add(value: number, attributes?: Record<string, unknown>): void }} snapshotsExpiredCounter
 * @param {{ add(value: number, attributes?: Record<string, unknown>): void }} compactionsCounter
 * @returns {Promise<MaintenancePartitionReport>}
 */
async function maintainSourceTable(r, cursor, cfg, opts, snapshotsExpiredCounter, compactionsCounter) {
  const tableDir = path.join(r.path, cursor.tableDir ?? 'table')
  if (!tableExists(tableDir)) return r

  const dataFilesBefore = countDataFiles(tableDir)
  r.dataFilesBefore = dataFilesBefore
  r.dataFilesAfter = dataFilesBefore

  if (!opts.compactOnly) {
    const expired = await expireSnapshots(tableDir, cfg, opts)
    r.snapshotsExpired = expired
    if (expired > 0) {
      snapshotsExpiredCounter.add(expired, { [Attr.DATASET]: r.dataset })
    }
  }

  if (!opts.expireOnly) {
    const shouldCompact = opts.force || needsCompaction(tableDir, cfg)
    if (shouldCompact && !opts.dryRun) {
      const result = await compactSourceTable(r.path, cursor, cfg)
      if (result) {
        r.compacted = true
        r.rowCount = result.rowCount
        r.dataFilesAfter = result.dataFiles
        compactionsCounter.add(1, { [Attr.DATASET]: r.dataset })
      }
    } else if (shouldCompact && opts.dryRun) {
      r.compacted = true
    }
  }

  return r
}

/**
 * Maintain a legacy epoch-layout partition.
 *
 * @param {MaintenancePartitionReport} r
 * @param {CachePartitionMeta} part
 * @param {PartitionCursor} cursor
 * @param {MaintenanceConfig} cfg
 * @param {MaintenanceOptions} opts
 * @param {{ add(value: number, attributes?: Record<string, unknown>): void }} snapshotsExpiredCounter
 * @param {{ add(value: number, attributes?: Record<string, unknown>): void }} compactionsCounter
 * @returns {Promise<MaintenancePartitionReport>}
 */
async function maintainLegacyPartition(r, part, cursor, cfg, opts, snapshotsExpiredCounter, compactionsCounter) {
  const epochDir = path.join(part.path, `epoch=${cursor.epoch}`)
  if (!tableExists(epochDir)) return r

  const dataFilesBefore = countDataFiles(epochDir)
  r.dataFilesBefore = dataFilesBefore
  r.dataFilesAfter = dataFilesBefore

  if (!opts.compactOnly) {
    const expired = await expireSnapshots(epochDir, cfg, opts)
    r.snapshotsExpired = expired
    if (expired > 0) {
      snapshotsExpiredCounter.add(expired, { [Attr.DATASET]: r.dataset })
    }
  }

  if (!opts.expireOnly) {
    const shouldCompact = opts.force || needsCompaction(epochDir, cfg)
    if (shouldCompact && !opts.dryRun) {
      const result = await compactPartition(part.path, cursor, cfg)
      if (result) {
        r.compacted = true
        r.newEpoch = result.newEpoch
        r.rowCount = result.rowCount
        r.dataFilesAfter = result.dataFiles
        compactionsCounter.add(1, { [Attr.DATASET]: r.dataset })
      }
    } else if (shouldCompact && opts.dryRun) {
      r.compacted = true
    }
  }

  return r
}

/**
 * Collect status information about cache partitions.
 *
 * @param {{ cacheRoot: string }} opts
 * @returns {Promise<CacheStatusReport>}
 */
export async function cacheStatus({ cacheRoot }) {
  const partitions = await discoverCachePartitions(cacheRoot)
  let pendingSpoolBytes = 0
  /** @type {CacheStatusPartition[]} */
  const statusPartitions = []

  for (const part of partitions) {
    const cursor = readCursorSync(part.path)
    const spoolDir = path.join(part.path, '_hypaware_spool')
    pendingSpoolBytes += measureDir(spoolDir)

    if (cursor.layout === 'source-table') {
      const tableDir = path.join(part.path, cursor.tableDir ?? 'table')
      const dataFileCount = countDataFiles(tableDir)
      const metadataBytes = measureMetadataDir(tableDir)
      const snapshotCount = countSnapshots(tableDir)
      const deleteFileCount = countDeleteFiles(tableDir)

      statusPartitions.push({
        dataset: part.dataset,
        partition: part.partition,
        epoch: cursor.epoch,
        rowCount: part.rowCount,
        dataFileCount,
        metadataBytes,
        snapshotCount,
        source: part.partition.source,
        deleteFileCount,
        lastRetentionCutoffDate: cursor.retention?.lastCutoffDate,
        layout: 'source-table',
      })
    } else {
      const epochDir = path.join(part.path, `epoch=${cursor.epoch}`)
      const dataFileCount = countDataFiles(epochDir)
      const metadataBytes = measureMetadataDir(epochDir)
      const snapshotCount = countSnapshots(epochDir)

      statusPartitions.push({
        dataset: part.dataset,
        partition: part.partition,
        epoch: cursor.epoch,
        rowCount: part.rowCount,
        dataFileCount,
        metadataBytes,
        snapshotCount,
        layout: cursor.epoch > 0 || cursor.rowCount > 0 ? 'epoch' : undefined,
      })
    }
  }

  return { cacheRoot, pendingSpoolBytes, partitions: statusPartitions }
}

/**
 * @param {string} tableDir
 * @param {MaintenanceConfig} cfg
 * @param {MaintenanceOptions} opts
 * @returns {Promise<number>}
 */
async function expireSnapshots(tableDir, cfg, opts) {
  if (!tableExists(tableDir)) return 0
  const url = tableUrlForDir(tableDir)
  const { resolver, lister } = await createLocalIcebergIO()

  /** @type {TableMetadata} */
  let metadata
  try {
    const loaded = await loadLatestFileCatalogMetadata({ tableUrl: url, resolver, lister })
    metadata = loaded.metadata
  } catch {
    return 0
  }

  const snapshots = metadata.snapshots ?? []
  if (snapshots.length <= cfg.min_snapshots_to_keep) return 0

  const currentId = metadata['current-snapshot-id']
  const cutoffMs = Date.now() - cfg.max_snapshot_age_hours * 60 * 60 * 1000

  const sorted = [...snapshots].sort((a, b) => b['timestamp-ms'] - a['timestamp-ms'])
  /** @type {number[]} */
  const toExpire = []
  for (let i = 0; i < sorted.length; i++) {
    const snap = sorted[i]
    const id = snap['snapshot-id']
    if (currentId !== undefined && BigInt(id) === BigInt(currentId)) continue
    if (i < cfg.min_snapshots_to_keep) continue
    if (snap['timestamp-ms'] >= cutoffMs) continue
    toExpire.push(Number(id))
  }

  if (toExpire.length === 0) return 0
  if (opts.dryRun) return toExpire.length

  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })
  try {
    await icebergExpireSnapshots({ catalog, tableUrl: url, snapshotIds: toExpire })
  } catch {
    return 0
  }
  return toExpire.length
}

/**
 * @param {string} tableDir
 * @param {MaintenanceConfig} cfg
 * @returns {boolean}
 */
function needsCompaction(tableDir, cfg) {
  const dataFiles = countDataFiles(tableDir)
  if (dataFiles > cfg.compact_file_count) return true

  const totalDataBytes = measureDataDir(tableDir)
  if (dataFiles > 0 && totalDataBytes / dataFiles < cfg.compact_avg_file_bytes) return true

  const metadataBytes = measureMetadataDir(tableDir)
  if (metadataBytes > 64 * 1024 * 1024) return true

  return false
}

const COMPACT_BATCH_SIZE = 10_000

/**
 * Cheap, allocation-free estimate of a row's in-memory footprint in
 * bytes. Used only to bound how much a compaction batch accumulates
 * before flushing, so precision matters less than never under-counting
 * a fat blob. Walks nested structures without building strings.
 *
 * @param {unknown} value
 * @returns {number}
 */
function estimateValueBytes(value) {
  if (value === null || value === undefined) return 0
  switch (typeof value) {
    case 'string':
      // JS strings are UTF-16 internally; 2 bytes/char is the honest upper bound.
      return value.length * 2
    case 'number':
      return 8
    case 'bigint':
      return 16
    case 'boolean':
      return 4
    case 'object': {
      if (value instanceof Date) return 8
      if (value instanceof Uint8Array) return value.byteLength
      let total = 0
      if (Array.isArray(value)) {
        for (const item of value) total += estimateValueBytes(item)
        return total
      }
      for (const [k, v] of Object.entries(value)) {
        total += k.length * 2 + estimateValueBytes(v)
      }
      return total
    }
    default:
      return 0
  }
}

/**
 * @param {Record<string, unknown>} row
 * @returns {number}
 */
function estimateRowBytes(row) {
  let total = 0
  for (const value of Object.values(row)) total += estimateValueBytes(value)
  return total
}

/**
 * Compact a source-table partition by rewriting into a fresh table
 * directory. Iceberg metadata stores absolute `file://` URLs, so we
 * cannot rename directories after writing — we write to a new dir
 * name and update the cursor to point to it.
 *
 * Rows are flushed to a data file whenever the batch reaches either
 * `COMPACT_BATCH_SIZE` rows or `cfg.compact_batch_bytes` estimated
 * bytes, whichever comes first. The byte cap keeps peak heap bounded
 * regardless of per-row payload size — without it, a fat denormalized
 * column (e.g. tool definitions repeated on every row) pushes a
 * 10k-row batch into the gigabytes and OOMs the daemon mid-compaction.
 *
 * @param {string} partitionDir
 * @param {PartitionCursor} cursor
 * @param {MaintenanceConfig} cfg
 * @returns {Promise<{ rowCount: number, dataFiles: number } | null>}
 */
async function compactSourceTable(partitionDir, cursor, cfg) {
  const oldTableDirName = cursor.tableDir ?? 'table'
  const oldTableDir = path.join(partitionDir, oldTableDirName)
  if (!tableExists(oldTableDir)) return null

  /** @type {PartitionSpec | undefined} */
  let existingSpec
  /** @type {ColumnSpec[] | null} */
  let schemaColumns = null
  try {
    const { resolver, lister } = await createLocalIcebergIO()
    const url = tableUrlForDir(oldTableDir)
    const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: url, resolver, lister })
    const schema = currentSchema(metadata)
    if (schema) schemaColumns = columnsFromIcebergSchema(schema)
    existingSpec = currentPartitionSpec(metadata)
  } catch {
    // Fall back to inference if metadata is unreadable
  }

  const seq = Date.now()
  const newTableDirName = `table-${seq}`
  const newTableDir = path.join(partitionDir, newTableDirName)

  const seen = new Set()
  /** @type {ColumnSpec[] | null} */
  let columns = schemaColumns
  /** @type {Record<string, unknown>[]} */
  let batch = []
  let batchBytes = 0
  let totalRows = 0
  const maxBatchBytes = cfg.compact_batch_bytes
  /** @type {AppendOptions | undefined} */
  const appendOpts = existingSpec ? { partitionSpec: existingSpec } : undefined

  for await (const row of scanRowsFromTable(oldTableDir)) {
    if (!columns) {
      columns = Object.keys(row).map((name) => ({
        name,
        type: inferColumnType(row[name]),
        nullable: true,
      }))
    }
    const rowId = row._hyp_cache_row_id
    if (typeof rowId === 'string' && seen.has(rowId)) continue
    if (typeof rowId === 'string') seen.add(rowId)
    batch.push(row)
    batchBytes += estimateRowBytes(row)

    if (batch.length >= COMPACT_BATCH_SIZE || batchBytes >= maxBatchBytes) {
      await appendRowsToTable(newTableDir, columns, batch, appendOpts)
      totalRows += batch.length
      batch = []
      batchBytes = 0
    }
  }

  if (batch.length > 0 && columns) {
    await appendRowsToTable(newTableDir, columns, batch, appendOpts)
    totalRows += batch.length
    batch = []
    batchBytes = 0
  }

  if (!columns) {
    await writeCursor(partitionDir, {
      epoch: cursor.epoch,
      rowCount: 0,
      compaction: {
        previousTableDir: oldTableDirName,
        compactedAt: new Date().toISOString(),
      },
      layout: 'source-table',
      tableDir: newTableDirName,
      retention: cursor.retention,
    })
    const retiredMarker = path.join(oldTableDir, '.retired')
    await fsPromises.writeFile(retiredMarker, new Date().toISOString(), 'utf8')
    return {
      rowCount: 0,
      dataFiles: 0,
    }
  }
  if (totalRows === 0) {
    // Keep table directory progression deterministic even when dedup filters out all rows.
    await appendRowsToTable(newTableDir, columns, [], appendOpts)
  }

  await writeCursor(partitionDir, {
    epoch: cursor.epoch,
    rowCount: totalRows,
    compaction: {
      previousTableDir: oldTableDirName,
      compactedAt: new Date().toISOString(),
    },
    layout: 'source-table',
    tableDir: newTableDirName,
    retention: cursor.retention,
  })

  const retiredMarker = path.join(oldTableDir, '.retired')
  await fsPromises.writeFile(retiredMarker, new Date().toISOString(), 'utf8')

  return {
    rowCount: totalRows,
    dataFiles: countDataFiles(newTableDir),
  }
}

/**
 * Legacy epoch-based compaction.
 *
 * @param {string} partitionDir
 * @param {PartitionCursor} cursor
 * @param {MaintenanceConfig} cfg
 * @returns {Promise<{ newEpoch: number, rowCount: number, dataFiles: number } | null>}
 */
async function compactPartition(partitionDir, cursor, cfg) {
  const oldEpochDir = path.join(partitionDir, `epoch=${cursor.epoch}`)
  if (!tableExists(oldEpochDir)) return null

  /** @type {PartitionSpec | undefined} */
  let existingSpec
  /** @type {ColumnSpec[] | null} */
  let schemaColumns = null
  try {
    const { resolver, lister } = await createLocalIcebergIO()
    const url = tableUrlForDir(oldEpochDir)
    const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: url, resolver, lister })
    const schema = currentSchema(metadata)
    if (schema) schemaColumns = columnsFromIcebergSchema(schema)
    existingSpec = currentPartitionSpec(metadata)
  } catch {
    // Fall back to inference if metadata is unreadable
  }

  const newEpoch = cursor.epoch + 1
  const newEpochDir = path.join(partitionDir, `epoch=${newEpoch}`)

  const seen = new Set()
  /** @type {ColumnSpec[] | null} */
  let columns = schemaColumns
  /** @type {Record<string, unknown>[]} */
  let batch = []
  let batchBytes = 0
  let totalRows = 0
  const maxBatchBytes = cfg.compact_batch_bytes
  /** @type {AppendOptions | undefined} */
  const appendOpts = existingSpec ? { partitionSpec: existingSpec } : undefined

  for await (const row of scanRowsFromTable(oldEpochDir)) {
    if (!columns) {
      columns = Object.keys(row).map((name) => ({
        name,
        type: inferColumnType(row[name]),
        nullable: true,
      }))
    }
    const rowId = row._hyp_cache_row_id
    if (typeof rowId === 'string' && seen.has(rowId)) continue
    if (typeof rowId === 'string') seen.add(rowId)
    batch.push(row)
    batchBytes += estimateRowBytes(row)

    if (batch.length >= COMPACT_BATCH_SIZE || batchBytes >= maxBatchBytes) {
      await appendRowsToTable(newEpochDir, columns, batch, appendOpts)
      totalRows += batch.length
      batch = []
      batchBytes = 0
    }
  }

  if (batch.length > 0 && columns) {
    await appendRowsToTable(newEpochDir, columns, batch, appendOpts)
    totalRows += batch.length
  }

  if (!columns) return null
  if (totalRows === 0) {
    // Keep epoch progression deterministic even when dedup filters out all rows.
    await appendRowsToTable(newEpochDir, columns, [], appendOpts)
  }

  await writeCursor(partitionDir, {
    epoch: newEpoch,
    rowCount: totalRows,
    compaction: {
      previousEpoch: cursor.epoch,
      compactedAt: new Date().toISOString(),
    },
  })

  const retiredMarker = path.join(oldEpochDir, '.retired')
  await fsPromises.writeFile(retiredMarker, new Date().toISOString(), 'utf8')

  return {
    newEpoch,
    rowCount: totalRows,
    dataFiles: countDataFiles(newEpochDir),
  }
}

/**
 * @param {string} cacheRoot
 */
async function cleanRetiredEpochs(cacheRoot) {
  const root = datasetsRoot(cacheRoot)
  try {
    await fsPromises.access(root)
  } catch {
    return
  }
  await walkForRetired(root)
}

/**
 * Recursively reclaim retired and orphaned table generations.
 *
 * Two cases are removed:
 *  1. A generation that carries a `.retired` marker older than the grace
 *     period — the normal "compaction succeeded, the previous generation
 *     can go" path.
 *  2. A generation that is NOT the live one named by the partition cursor
 *     and is older than {@link ORPHAN_GRACE_MS}, even without a `.retired`
 *     marker. A compaction that OOMs (or is killed) part-way leaves a
 *     half-written `table-<seq>` dir with no marker; case 1 never reclaims
 *     it, so it leaks forever. Case 2 sweeps it once it is safely stale.
 *
 * Orphan reclamation (case 2) only runs for partition dirs that actually
 * have a `cursor.json`, so we always know which generation is live before
 * deleting any of its siblings. The mtime grace keeps an in-flight
 * compaction's freshly created (not-yet-committed) dir safe.
 *
 * @param {string} dir
 */
async function walkForRetired(dir) {
  /** @type {Dirent[]} */
  let entries
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  const hasCursor = entries.some((e) => e.isFile() && e.name === 'cursor.json')
  const liveDirName = hasCursor ? liveGenerationDir(readCursorSync(dir)) : null

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = path.join(dir, entry.name)
    if (entry.name.startsWith('epoch=') || entry.name.startsWith('table')) {
      if (entry.name === liveDirName) continue

      const retiredMarker = path.join(full, '.retired')
      let removed = false
      try {
        const content = await fsPromises.readFile(retiredMarker, 'utf8')
        const retiredAt = new Date(content.trim()).getTime()
        if (Date.now() - retiredAt > GRACE_PERIOD_MS) {
          fs.rmSync(full, { recursive: true, force: true })
          removed = true
        }
      } catch {
        // no .retired marker or parse error — fall through to orphan check
      }

      // Orphan sweep: a generation the cursor does not reference and that
      // has aged past the grace window is garbage regardless of markers.
      if (!removed && liveDirName !== null) {
        try {
          const { mtimeMs } = fs.statSync(full)
          if (Date.now() - mtimeMs > ORPHAN_GRACE_MS) {
            fs.rmSync(full, { recursive: true, force: true })
          }
        } catch {
          // stat/remove race — skip, a later tick will retry
        }
      }
    } else {
      await walkForRetired(full)
    }
  }
}

/**
 * Name of the table/epoch directory the cursor currently points at, or
 * null when it cannot be determined.
 *
 * @param {PartitionCursor} cursor
 * @returns {string | null}
 */
function liveGenerationDir(cursor) {
  if (cursor.tableDir) return cursor.tableDir
  if (typeof cursor.epoch === 'number') return `epoch=${cursor.epoch}`
  return null
}

/**
 * @param {string} tableDir
 * @returns {number}
 */
function countDataFiles(tableDir) {
  const dataDir = path.join(tableDir, 'data')
  try {
    return fs.readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.parquet'))
      .length
  } catch {
    return 0
  }
}

/**
 * @param {string} tableDir
 * @returns {number}
 */
function countDeleteFiles(tableDir) {
  const dataDir = path.join(tableDir, 'data')
  try {
    return fs.readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isFile() && (e.name.endsWith('-deletes.parquet') || e.name.endsWith('.puffin')))
      .length
  } catch {
    return 0
  }
}

/**
 * @param {string} tableDir
 * @returns {number}
 */
function countSnapshots(tableDir) {
  if (!tableExists(tableDir)) return 0
  const metadataDir = path.join(tableDir, 'metadata')
  try {
    return fs.readdirSync(metadataDir)
      .filter((name) => /\.metadata\.json$/.test(name))
      .length
  } catch {
    return 0
  }
}

/**
 * @param {string} tableDir
 * @returns {number}
 */
function measureMetadataDir(tableDir) {
  return measureDir(path.join(tableDir, 'metadata'))
}

/**
 * @param {string} tableDir
 * @returns {number}
 */
function measureDataDir(tableDir) {
  return measureDir(path.join(tableDir, 'data'))
}

/**
 * @param {string} dir
 * @returns {number}
 */
function measureDir(dir) {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      try {
        total += fs.statSync(path.join(dir, entry.name)).size
      } catch { /* skip */ }
    }
  } catch { /* no dir */ }
  return total
}
