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

import { Attr, getMeter, withSpan } from '../observability/index.js'
import { clearEscapeReport, discoverCachePartitions, tryReadCursorSync, withPartitionMutationLock, writeCursor } from './partition.js'
import { datasetsRoot, isConfirmedSymlink } from './paths.js'
import { pendingSpoolMtimeSync } from './spool.js'
import { reportPlantedSweepPath } from './sweep_guard.js'
import { createLocalIcebergIO, tableUrlForDir } from './iceberg/resolver.js'
import { physicalProjection, readRowsFromTable, scanRowsFromTable, tableExists } from './iceberg/store.js'

/**
 * @import { DatasetRegistration } from '../../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitionMeta, PartitionCursor, RetentionConfig, RetentionResult, RetentionSourceTableResult } from '../../../src/core/cache/types.js'
 * @import { Manifest, ManifestEntry, Resolver, TableMetadata } from 'icebird/src/types.js'
 */

export const DEFAULT_RETENTION_DAYS = 90
const DELETE_BATCH_SIZE = 5000
const DEFAULT_TIMESTAMP_COLUMNS = ['timestamp', 'created_at', 'recorded_at', 'date']

/**
 * @param {{ cacheRoot: string, config: RetentionConfig | undefined, getDataset?: (dataset: string) => Pick<DatasetRegistration, 'primaryTimestampColumn' | 'fallbackTimestampColumns'> | undefined }} args
 * @ref LLP 0013#retention-is-the-central-tradeoff [implements]: per-dataset window; rows past it are deleted permanently
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

      // @ref LLP 0331#guard-travels-with-the-delete [implements]: this pass
      // walks `datasets/` and `rm -rf`s directories under it, so the
      // containment check is written here rather than left to whoever
      // constructs the enforcer. `datasets/` is the one component the walk
      // opens without having descended a `Dirent` first - a symlinked child
      // is already not a directory to `walk` - and nothing the cache writes
      // mints a symlink at that name, so a confirmed one means this is not a
      // tree to delete from. Every component above it (a relocated
      // `query.cache.dir`, a `$HYP_HOME` on another volume) is a path the
      // cache did not choose and stays legitimate (LLP 0326#positive-evidence).
      const walkRoot = path.resolve(datasetsRoot(cacheRoot))
      if (isConfirmedSymlink(walkRoot)) {
        reportPlantedSweepPath(walkRoot, 'retention.tick', 'datasets')
        return { evicted, sourceTableResults }
      }

      const partitions = await discoverCachePartitions(cacheRoot)

      for (const part of partitions) {
        const retentionDays = cfg.datasets[part.dataset] ?? cfg.default_days
        if (retentionDays <= 0) continue

        // @ref LLP 0323#one-gate [constrained-by]: a destructive pass reads
        // the cursor through the gate that can answer "unreadable", never
        // through the one that answers epoch 0 on its behalf. A partition
        // whose `cursor.json` exists but does not read is not a partition at
        // epoch 0: on the synthesized default a source-table or
        // higher-epoch partition falls through to `evictLegacyPartition`,
        // which weighs a RETIRED `epoch=0` generation's mtime and then
        // `rm -rf`s the whole partition directory, live generation and rows
        // written today included. `part.legacy` is discovery's record that
        // no cursor file was there at all, which is the legitimate
        // table-without-a-cursor shape and still gets the epoch-0 default.
        const readCursor = tryReadCursorSync(part.path)
        if (readCursor === null && !part.legacy) continue
        const cursor = readCursor ?? { epoch: 0, rowCount: 0, compaction: null }

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
        await rewriteCursorUnderLock(part.path, cursor, (current) => ({
          ...current,
          rowCount: newRowCount,
          retention: {
            lastCutoffDate: cutoffDate,
            lastCutoffMs: cutoffMs,
            lastDeletedAt: now.toISOString(),
            rowsDeleted: totalDeleted,
            lastSnapshotId: postSnapshotId,
          },
        }))

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
    if (partitionActivityMtime(part.path, tableDir) > cutoffMs) {
      await rewriteCursorUnderLock(part.path, cursor, (current) => ({
        ...current,
        retention: {
          ...current.retention,
          lastCutoffDate: cutoffDate,
          lastCutoffMs: cutoffMs,
          lastDeletedAt: now.toISOString(),
          rowsDeleted: 0,
        },
      }))
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
        await withPartitionMutationLock(part.path, () =>
          fs.promises.rm(part.path, { recursive: true, force: true })
        )
        // The directory is gone, so no later read of it can clear the
        // cursor-escape report keyed on this path. Doing it here is free:
        // the path is in hand and the delete just happened
        // (LLP 0334#eviction-clears).
        clearEscapeReport(part.path)
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
      evictedPartition: true,
    }
  }

  /**
   * Rewrite a partition's cursor from the value on disk RIGHT NOW, under the
   * lock every other cursor mutator in the tree holds.
   *
   * A retention pass over one partition spans a metadata load, a parquet scan
   * of every data file, one commit per delete batch and a full rescan, and
   * live ingest appends to the same partition throughout. Spreading the
   * snapshot taken before all that writes stale values back over whatever
   * landed in between: `rowCount` (cosmetic), and `pendingFallbacks` (not),
   * whose lost increment strands provisional rows against the settle sweep.
   * That is the same defect `maintenance.js`'s rebaseline write was brought
   * under this lock for, and the append path holds it across its own
   * read-modify-write, so re-reading without taking it only narrows the
   * window. Retention was the last cursor mutator outside it, harmlessly
   * while it had no non-test caller and not once LLP 0336 gave it one.
   *
   * `fallback` is the snapshot the caller already read, used only when the
   * cursor has become unreadable under the pass - there is still a retention
   * stamp to record, and refusing to record it would re-run the whole scan
   * next tick.
   *
   * @ref LLP 0331#guard-travels-with-the-delete [implements]: serialization is
   *   part of what bounds this mutation, so it travels with it rather than
   *   being left to whoever constructs the enforcer.
   * @param {string} partitionDir
   * @param {PartitionCursor} fallback
   * @param {(current: PartitionCursor) => PartitionCursor} rewrite
   * @returns {Promise<void>}
   */
  async function rewriteCursorUnderLock(partitionDir, fallback, rewrite) {
    await withPartitionMutationLock(partitionDir, async () => {
      await writeCursor(partitionDir, rewrite(tryReadCursorSync(partitionDir) ?? fallback))
    })
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
    const mtime = partitionActivityMtime(partitionDir, targetDir)
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
        await withPartitionMutationLock(partitionDir, async () => {
          fs.rmSync(partitionDir, { recursive: true, force: true })
        })
        // The directory is gone, so no later read of it can clear the
        // cursor-escape report keyed on this path. Doing it here is free:
        // the path is in hand and the delete just happened
        // (LLP 0334#eviction-clears).
        clearEscapeReport(partitionDir)
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
    // `timestampColumns` is a candidate list (`extractTimestampMs` takes the
    // first one the row carries) already narrowed to the TABLE schema, so a
    // file written before one of them was added still has to be narrowed
    // again: since hyparquet 1.29 an absent projected name throws, and the
    // catch below would read that as an unreadable file and silently stop
    // expiring its rows.
    const rows = /** @type {Record<string, unknown>[]} */ (
      await parquetReadObjects({ file, ...await physicalProjection(file, timestampColumns) })
    )
    for (let i = 0; i < rows.length; i++) {
      if (deletedPositions?.has(BigInt(i))) continue
      const ts = extractTimestampMs(rows[i], timestampColumns)
      if (ts !== null && ts < cutoffMs) {
        positions.push(i)
      }
    }
  } catch {
    // unreadable file: skip rather than block retention
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
 * @returns {Required<Pick<RetentionConfig, 'default_days'>> & { datasets: Record<string, number> }}
 */
function normalizeConfig(config) {
  const default_days =
    typeof config?.default_days === 'number' && Number.isFinite(config.default_days)
      ? config.default_days
      : DEFAULT_RETENTION_DAYS
  const datasets = config?.datasets && typeof config.datasets === 'object' ? config.datasets : {}
  return { default_days, datasets }
}

/**
 * The newest write anywhere in a partition the removal below would take:
 * committed data files AND the capture spool sitting beside them.
 *
 * The two whole-directory paths in this file remove `part.path`, and
 * `<part.path>/_hypaware_spool` is inside it. `partitionMtime` reads only
 * `<generation>/data`, so on that number alone a partition whose committed
 * files date to March and whose source resumed this morning is "untouched
 * since March", and the removal destroys rows captured minutes ago that no
 * snapshot, manifest or `cursor.rowCount` ever counted - so `rowsDeleted`
 * does not even report them. Rows past the window are what LLP 0013 says may
 * go; rows captured today are not, whichever half of the partition they are
 * still sitting in.
 *
 * It is the age decision rather than a refusal because a refusal is the other
 * failure: a spool stranded behind a failing flush would stop that partition
 * reclaiming forever. A spool whose newest captured row is itself past the
 * window is as evictable as the data files beside it.
 *
 * @ref LLP 0013#retention-is-the-central-tradeoff [constrained-by]: the window is about how old the rows are, not which half of the partition holds them.
 * @param {string} partitionDir
 * @param {string} generationDir
 * @returns {number}
 */
function partitionActivityMtime(partitionDir, generationDir) {
  return Math.max(partitionMtime(generationDir), pendingSpoolMtimeSync(partitionDir))
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
