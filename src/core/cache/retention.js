// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { parquetReadObjects } from 'hyparquet'
import {
  fileCatalog,
  icebergDelete,
  loadLatestFileCatalogMetadata,
} from 'icebird'
import { deleteFileAppliesToDataEntry } from 'icebird/src/delete.js'
import { fetchAvroRecords, fetchDeleteMaps } from 'icebird/src/fetch.js'
import { findDataFileEntries, loadManifestEntries } from 'icebird/src/write/stage-position-delete.js'

import { Attr, getKernelInstruments, getMeter, withSpan } from '../observability/index.js'
import { discoverCachePartitions, readCursorSync, writeCursor } from './partition.js'
import { datasetsRoot } from './paths.js'
import { createLocalIcebergIO, tableUrlForDir } from './iceberg/resolver.js'
import { readRowsFromTable, scanRowsFromTable, tableExists } from './iceberg/store.js'

/**
 * @import { DatasetRegistration } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { CachePartitionMeta, PartitionCursor, RetentionConfig, RetentionResult, RetentionSourceTableResult } from './types.d.ts'
 * @import { Manifest, ManifestEntry, Resolver, TableMetadata } from 'icebird/src/types.js'
 */

export const DEFAULT_RETENTION_DAYS = 30
const DELETE_BATCH_SIZE = 5000
const DEFAULT_TIMESTAMP_COLUMNS = ['timestamp', 'created_at', 'recorded_at', 'date']

/**
 * @param {{ cacheRoot: string, config: RetentionConfig | undefined, getDataset?: (dataset: string) => Pick<DatasetRegistration, 'primaryTimestampColumn' | 'fallbackTimestampColumns'> | undefined }} args
 * @ref LLP 0013#retention-is-the-central-tradeoff [implements] — per-dataset window; rows past it are deleted permanently
 */
export function createRetentionEnforcer({ cacheRoot, config, getDataset }) {
  const cfg = normalizeConfig(config)
  const meter = getMeter('cache')
  const rowsEvicted = meter.createCounter('hyp_rows_evicted', {
    description: 'Rows evicted from the local cache by the retention enforcer',
  })

  return {
    /**
     * @param {{ now?: Date }} [opts]
     * @returns {Promise<RetentionResult>}
     */
    async tick(opts = {}) {
      const now = opts.now ?? new Date()

      /** @type {Array<{ dataset: string, partition: string, rowCount: number }>} */
      const evicted = []
      /** @type {RetentionSourceTableResult[]} */
      const sourceTableResults = []

      const partitions = await discoverCachePartitions(cacheRoot)

      for (const part of partitions) {
        const retentionDays = cfg.datasets[part.dataset] ?? cfg.default_days
        if (retentionDays <= 0) continue

        const cursor = readCursorSync(part.path)

        if (cursor.layout === 'source-table') {
          const timestampColumns = retentionTimestampColumns(part.dataset)
          const result = await purgeSourceTable(
            part, cursor, retentionDays, now, timestampColumns, rowsEvicted
          )
          if (result) sourceTableResults.push(result)
        } else {
          const result = await evictLegacyPartition(
            part, retentionDays, now, rowsEvicted
          )
          if (result) evicted.push(result)
        }
      }

      getKernelInstruments()
      return { evicted, sourceTableResults }
    },
    config: cfg,
  }

  /**
   * Row-level purge for source-table layout partitions.
   *
   * @param {CachePartitionMeta} part
   * @param {PartitionCursor} cursor
   * @param {number} retentionDays
   * @param {Date} now
   * @param {string[]} timestampColumns
   * @param {{ add(value: number, attributes?: Record<string, unknown>): void }} counter
   * @returns {Promise<RetentionSourceTableResult | null>}
   */
  async function purgeSourceTable(part, cursor, retentionDays, now, timestampColumns, counter) {
    const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
    const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10)
    const source = part.partition.source ?? 'unknown'
    const tableDir = path.join(part.path, cursor.tableDir ?? 'table')

    if (!tableExists(tableDir)) return null

    const { resolver, lister } = await createLocalIcebergIO()
    const url = tableUrlForDir(tableDir)

    /** @type {TableMetadata} */
    let metadata
    try {
      const loaded = await loadLatestFileCatalogMetadata({ tableUrl: url, resolver, lister })
      metadata = loaded.metadata
    } catch {
      return null
    }

    if (metadata['current-snapshot-id'] === undefined || !metadata.snapshots?.length) {
      return null
    }

    const currentSnapshotId = String(metadata['current-snapshot-id'])

    if (
      cursor.retention?.lastSnapshotId === currentSnapshotId &&
      typeof cursor.retention.lastCutoffMs === 'number' &&
      cursor.retention.lastCutoffMs >= cutoffMs
    ) {
      return {
        dataset: part.dataset,
        source,
        cutoffDate,
        rowsDeleted: 0,
        batchCount: 0,
        candidateFileCount: 0,
      }
    }

    const dataFileMap = await findDataFileEntries(metadata, resolver)
    if (dataFileMap.size === 0) return null
    const tableTimestampColumns = timestampColumnsInSchema(metadata, timestampColumns)
    if (tableTimestampColumns.length === 0) {
      return evictSourceTableByMtime(part, cursor, tableDir, cutoffMs, cutoffDate, now, counter)
    }
    const deletedPositions = await loadDeletedPositions(metadata, resolver, dataFileMap)

    return withSpan(
      'retention.plan_deletes',
      {
        [Attr.COMPONENT]: 'cache',
        [Attr.OPERATION]: 'retention.plan_deletes',
        [Attr.DATASET]: part.dataset,
        source,
        cutoff_date: cutoffDate,
        timestamp_columns: tableTimestampColumns.join(','),
        candidate_file_count: dataFileMap.size,
        status: 'ok',
      },
      async () => {
        /** @type {{ file_path: string, pos: number }[]} */
        let pendingDeletes = []
        let totalDeleted = 0
        let batchCount = 0
        let candidateFileCount = 0

        const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })

        for (const [filePath] of dataFileMap) {
          const positions = await scanFileForExpiredRows(
            filePath, cutoffMs, resolver, tableTimestampColumns, deletedPositions.get(filePath)
          )
          if (positions.length === 0) continue
          candidateFileCount++
          pendingDeletes.push(...positions.map(pos => ({ file_path: filePath, pos })))

          while (pendingDeletes.length >= DELETE_BATCH_SIZE) {
            const batch = pendingDeletes.splice(0, DELETE_BATCH_SIZE)
            await commitDeleteBatch(catalog, url, batch, part.dataset, source, cutoffDate)
            totalDeleted += batch.length
            batchCount++
          }
        }

        if (pendingDeletes.length > 0) {
          await commitDeleteBatch(catalog, url, pendingDeletes, part.dataset, source, cutoffDate)
          totalDeleted += pendingDeletes.length
          batchCount++
        }

        // Reload metadata to capture the post-delete snapshot ID stored
        // alongside cutoff state for future retention planning.
        let postSnapshotId = currentSnapshotId
        let newRowCount = Math.max(0, cursor.rowCount - totalDeleted)
        if (totalDeleted > 0) {
          try {
            const reloaded = await loadLatestFileCatalogMetadata({ tableUrl: url, resolver, lister })
            postSnapshotId = String(reloaded.metadata['current-snapshot-id'])
          } catch {
            // Fall back to pre-delete snapshot; next tick will re-scan
            // but loadDeletedPositions prevents re-planning committed deletes.
          }
          // Count actual visible rows to avoid drift from re-scanning
          // positions that were already deleted in prior retention passes.
          try {
            let count = 0
            for await (const _ of scanRowsFromTable(tableDir)) {
              count++
            }
            newRowCount = count
          } catch {
            // Fall back to decrement if scan fails
          }
        }

        counter.add(totalDeleted, {
          [Attr.DATASET]: part.dataset,
          source,
        })
        await writeCursor(part.path, {
          ...cursor,
          rowCount: newRowCount,
          retention: {
            lastCutoffDate: cutoffDate,
            lastCutoffMs: cutoffMs,
            lastDeletedAt: now.toISOString(),
            rowsDeleted: totalDeleted,
            lastSnapshotId: postSnapshotId,
          },
        })

        return {
          dataset: part.dataset,
          source,
          cutoffDate,
          rowsDeleted: totalDeleted,
          batchCount,
          candidateFileCount,
        }
      },
      { component: 'cache' }
    )
  }

  /**
   * Whole-partition fallback used only when a source table has no
   * registered or conventional timestamp column in its Iceberg schema.
   *
   * @param {CachePartitionMeta} part
   * @param {PartitionCursor} cursor
   * @param {string} tableDir
   * @param {number} cutoffMs
   * @param {string} cutoffDate
   * @param {Date} now
   * @param {{ add(value: number, attributes?: Record<string, unknown>): void }} counter
   * @returns {Promise<RetentionSourceTableResult | null>}
   */
  async function evictSourceTableByMtime(part, cursor, tableDir, cutoffMs, cutoffDate, now, counter) {
    const source = part.partition.source ?? 'unknown'
    if (partitionMtime(tableDir) > cutoffMs) {
      await writeCursor(part.path, {
        ...cursor,
        retention: {
          ...cursor.retention,
          lastCutoffDate: cutoffDate,
          lastCutoffMs: cutoffMs,
          lastDeletedAt: now.toISOString(),
          rowsDeleted: 0,
        },
      })
      return {
        dataset: part.dataset,
        source,
        cutoffDate,
        rowsDeleted: 0,
        batchCount: 0,
        candidateFileCount: 0,
      }
    }

    const rowCount = cursor.rowCount
    await withSpan(
      'retention.evict_source_table',
      {
        [Attr.COMPONENT]: 'cache',
        [Attr.OPERATION]: 'retention.evict_source_table',
        [Attr.DATASET]: part.dataset,
        source,
        cutoff_date: cutoffDate,
        rows_evicted: rowCount,
        status: 'ok',
      },
      async () => {
        await fs.promises.rm(part.path, { recursive: true, force: true })
        if (rowCount > 0) {
          counter.add(rowCount, {
            [Attr.DATASET]: part.dataset,
            source,
          })
        }
      },
      { component: 'cache' }
    )

    return {
      dataset: part.dataset,
      source,
      cutoffDate,
      rowsDeleted: rowCount,
      batchCount: 0,
      candidateFileCount: 0,
    }
  }

  /**
   * @param {ReturnType<typeof fileCatalog>} catalog
   * @param {string} tableUrl
   * @param {{ file_path: string, pos: number }[]} deletes
   * @param {string} dataset
   * @param {string} source
   * @param {string} cutoffDate
   */
  async function commitDeleteBatch(catalog, tableUrl, deletes, dataset, source, cutoffDate) {
    await withSpan(
      'retention.iceberg_delete',
      {
        [Attr.COMPONENT]: 'cache',
        [Attr.OPERATION]: 'retention.iceberg_delete',
        [Attr.DATASET]: dataset,
        source,
        cutoff_date: cutoffDate,
        delete_count: deletes.length,
        status: 'ok',
      },
      () => icebergDelete({ catalog, tableUrl, deletes }),
      { component: 'cache' }
    )
  }

  /**
   * Legacy directory eviction for epoch-layout partitions.
   *
   * @param {CachePartitionMeta} part
   * @param {number} retentionDays
   * @param {Date} now
   * @param {{ add(value: number, attributes?: Record<string, unknown>): void }} counter
   * @returns {Promise<{ dataset: string, partition: string, rowCount: number } | null>}
   */
  async function evictLegacyPartition(part, retentionDays, now, counter) {
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
    const partitionDir = part.path
    const epochDir = path.join(partitionDir, `epoch=${part.epoch}`)
    if (!tableExists(epochDir) && !tableExists(partitionDir)) return null

    const targetDir = tableExists(epochDir) ? epochDir : partitionDir
    const mtime = partitionMtime(targetDir)
    if (mtime > cutoff) return null

    const rowCount = await countRows(targetDir)
    const partitionKey = Object.entries(part.partition).map(([k, v]) => `${k}=${v}`).join('/')

    await withSpan(
      'retention.evict',
      {
        [Attr.COMPONENT]: 'cache',
        [Attr.OPERATION]: 'retention.evict',
        [Attr.DATASET]: part.dataset,
        partition: partitionKey,
        rows_evicted: rowCount,
        status: 'ok',
      },
      async () => {
        fs.rmSync(partitionDir, { recursive: true, force: true })
        if (rowCount > 0) {
          counter.add(rowCount, {
            [Attr.DATASET]: part.dataset,
            partition: partitionKey,
          })
        }
      },
      { component: 'cache' }
    )

    return { dataset: part.dataset, partition: partitionKey, rowCount }
  }

  /**
   * @param {string} dataset
   * @returns {string[]}
   */
  function retentionTimestampColumns(dataset) {
    const registration = getDataset?.(dataset)
    /** @type {string[]} */
    const columns = []
    if (registration?.primaryTimestampColumn) columns.push(registration.primaryTimestampColumn)
    for (const column of registration?.fallbackTimestampColumns ?? []) {
      columns.push(column)
    }
    if (columns.length === 0) columns.push(...DEFAULT_TIMESTAMP_COLUMNS)
    return Array.from(new Set(columns.filter((column) => typeof column === 'string' && column.length > 0)))
  }
}

/**
 * Scan a single Iceberg data file and return row positions for rows
 * older than the cutoff timestamp.
 *
 * @param {string} filePath
 * @param {number} cutoffMs
 * @param {Resolver} resolver
 * @param {string[]} timestampColumns
 * @param {Set<bigint>} [deletedPositions]
 * @returns {Promise<number[]>}
 */
async function scanFileForExpiredRows(filePath, cutoffMs, resolver, timestampColumns, deletedPositions) {
  /** @type {number[]} */
  const positions = []
  try {
    const file = await Promise.resolve(resolver.reader(filePath))
    const rows = /** @type {Record<string, unknown>[]} */ (
      await parquetReadObjects({ file, columns: timestampColumns })
    )
    for (let i = 0; i < rows.length; i++) {
      if (deletedPositions?.has(BigInt(i))) continue
      const ts = extractTimestampMs(rows[i], timestampColumns)
      if (ts !== null && ts < cutoffMs) {
        positions.push(i)
      }
    }
  } catch {
    // unreadable file — skip rather than block retention
  }
  return positions
}

/**
 * Extract a millisecond timestamp from common timestamp fields.
 *
 * @param {Record<string, unknown>} row
 * @param {string[]} timestampColumns
 * @returns {number | null}
 */
function extractTimestampMs(row, timestampColumns) {
  let raw
  for (const column of timestampColumns) {
    raw = row[column]
    if (raw !== undefined && raw !== null) break
  }
  if (raw === undefined || raw === null) return null
  if (raw instanceof Date) return raw.getTime()
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'bigint') return Number(raw)
  if (typeof raw === 'string') {
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  }
  return null
}

/**
 * @param {TableMetadata} metadata
 * @param {string[]} timestampColumns
 * @returns {string[]}
 */
function timestampColumnsInSchema(metadata, timestampColumns) {
  const schemaId = metadata['current-schema-id']
  const schema = metadata.schemas?.find(s => s['schema-id'] === schemaId) ?? metadata.schemas?.at(-1)
  const fields = new Set(schema?.fields.map(f => f.name) ?? [])
  return timestampColumns.filter(column => fields.has(column))
}

/**
 * @param {TableMetadata} metadata
 * @param {Resolver} resolver
 * @param {Map<string, { entry: ManifestEntry }>} dataFileMap
 * @returns {Promise<Map<string, Set<bigint>>>}
 */
async function loadDeletedPositions(metadata, resolver, dataFileMap) {
  const snapshotId = metadata['current-snapshot-id']
  const snapshot = metadata.snapshots?.find(s => String(s['snapshot-id']) === String(snapshotId))
  if (!snapshot?.['manifest-list']) return new Map()
  const manifests = /** @type {Manifest[]} */ (await fetchAvroRecords(snapshot['manifest-list'], resolver))
  /** @type {ManifestEntry[]} */
  const deleteEntries = []
  await Promise.all(manifests.map(async (manifest) => {
    if (manifest.content !== 1) return
    const entries = await loadManifestEntries(manifest, resolver)
    for (const entry of entries) {
      if (entry.status === 2) continue
      if (entry.data_file.content !== 1) continue
      deleteEntries.push(entry)
    }
  }))
  if (deleteEntries.length === 0) return new Map()
  const { positionDeletesMap } = await fetchDeleteMaps(deleteEntries, resolver)
  /** @type {Map<string, Set<bigint>>} */
  const out = new Map()
  for (const [filePath, groups] of positionDeletesMap) {
    const found = dataFileMap.get(filePath)
    if (!found) continue
    /** @type {Set<bigint>} */
    const positions = new Set()
    for (const group of groups) {
      if (!deleteFileAppliesToDataEntry(found.entry, group.deleteEntry, metadata, 'position')) continue
      for (const pos of group.positions) positions.add(pos)
    }
    if (positions.size > 0) out.set(filePath, positions)
  }
  return out
}

/**
 * @param {RetentionConfig | undefined} config
 * @returns {Required<Pick<RetentionConfig, 'default_days'>> & { datasets: Record<string, number>, wait_for_sink_ack: boolean }}
 * @ref LLP 0013#open-question [explains] — wait_for_sink_ack is the parsed-but-unwired evict-on-ack vs evict-on-retention knob
 */
function normalizeConfig(config) {
  const default_days =
    typeof config?.default_days === 'number' && Number.isFinite(config.default_days)
      ? config.default_days
      : DEFAULT_RETENTION_DAYS
  const datasets = config?.datasets && typeof config.datasets === 'object' ? config.datasets : {}
  const wait_for_sink_ack = Boolean(config?.wait_for_sink_ack)
  return { default_days, datasets, wait_for_sink_ack }
}

/**
 * @param {string} dir
 * @returns {number}
 */
function partitionMtime(dir) {
  const dataDir = path.join(dir, 'data')
  let newest = 0
  try {
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const mtime = fs.statSync(path.join(dataDir, entry.name)).mtimeMs
      if (mtime > newest) newest = mtime
    }
  } catch {
    /* no data dir yet */
  }
  if (newest > 0) return newest
  try {
    return fs.statSync(dir).mtimeMs
  } catch {
    return Date.now()
  }
}

/**
 * @param {string} tableDir
 * @returns {Promise<number>}
 */
async function countRows(tableDir) {
  try {
    const rows = await readRowsFromTable(tableDir)
    return rows.length
  } catch {
    return 0
  }
}
