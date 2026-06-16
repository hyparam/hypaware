import type { ColumnSpec, QueryScope, QueryStorageService } from '../../../collectivus-plugin-kernel-types.d.ts'
import type { PartitionSpec } from 'icebird/src/types.js'
import type { AsyncDataSource } from 'squirreling'
// Partitioning declaration promoted to a neutral core home
// (LLP 0003 / LLP 0022#shared-core-helpers). Re-exported here so existing
// cache importers keep their `../types.d.ts` path.
import type { CachePartitioningDeclaration, CachePartitionField } from '../iceberg/types.d.ts'
export type { CachePartitioningDeclaration, CachePartitionField }

export interface PartitionCursor {
  epoch: number
  rowCount: number
  compaction: unknown | null
  layout?: 'epoch' | 'source-table'
  tableDir?: string
  retention?: {
    lastCutoffDate?: string
    lastCutoffMs?: number
    lastDeletedAt?: string
    rowsDeleted?: number
    lastSnapshotId?: string
  }
}

export interface CachePartitionMeta {
  dataset: string
  partition: Record<string, string>
  path: string
  epoch: number
  rowCount: number
  legacy?: boolean
}

export interface RetentionConfig {
  default_days: number
  datasets?: Record<string, number>
  /** Reserved feature flag (see "open question" in plan §Phase 4); not implemented at V1. */
  wait_for_sink_ack?: boolean
}

export interface FlushChunk {
  columns: readonly ColumnSpec[]
  rows: Record<string, unknown>[]
}

export interface ProgressState {
  byteOffset: number
  updatedAt: string
}

export interface SpoolAppendResult {
  bytesWritten: number
  pendingBytes: number
}

export interface FlushResult {
  flushed: boolean
  rowCount: number
  chunkCount: number
  bytesWritten: number
  pendingBytes: number
  malformedCount: number
  droppedCount: number
  reason: string
}

export interface PendingInfo {
  pending: boolean
  pendingBytes: number
  lastFlushAtMs: number | null
}

export interface CacheSpool {
  append(
    tablePath: string,
    columns: readonly ColumnSpec[],
    rows: Record<string, unknown>[],
  ): Promise<SpoolAppendResult>
  flushTable(tablePath: string, opts?: { reason?: string; force?: boolean }): Promise<FlushResult>
  flushAll(opts?: { reason?: string; force?: boolean }): Promise<FlushResult>
  pendingInfo(tablePath: string): Promise<PendingInfo>
  hasPendingSync(tablePath: string): boolean
  /**
   * Read-only view of rows currently pending in a table's spool (written
   * by `append`, not yet committed by `flushTable`). Never mutates spool
   * state; degrades to an empty stream on any error.
   */
  readSpooledRows(tablePath: string): AsyncGenerator<Record<string, unknown>>
}

export interface AppendOptions {
  declaration?: CachePartitioningDeclaration
  partitionSpec?: PartitionSpec
  /**
   * Declarative write sort order, applied when the table is created.
   * icebird (>= 0.8.9) sorts every appended/rewritten data file by the
   * table's default sort order, so this makes the table self-sorting.
   * Ignored for tables that already exist.
   */
  sortOrder?: readonly { column: string, direction?: 'asc' | 'desc' }[]
}

export interface MaintenanceConfig {
  enabled: boolean
  interval_minutes: number
  target_file_bytes: number
  min_snapshots_to_keep: number
  max_snapshot_age_hours: number
  compact_file_count: number
  compact_avg_file_bytes: number
  /**
   * Upper bound on the estimated in-memory bytes a single compaction
   * batch may accumulate before it is flushed to a data file. Caps peak
   * heap during compaction so a fat per-row column (e.g. denormalized
   * tool definitions) cannot push a 10k-row batch to gigabytes and OOM
   * the daemon. Within-batch dedup still collapses repeated values.
   */
  compact_batch_bytes: number
  max_tick_ms: number
}

export interface MaintenanceOptions {
  cacheRoot: string
  dataset?: string
  force?: boolean
  dryRun?: boolean
  compactOnly?: boolean
  expireOnly?: boolean
  budgetMs?: number
  config?: Partial<MaintenanceConfig>
}

export interface MaintenancePartitionReport {
  dataset: string
  partition: Record<string, string>
  path: string
  snapshotsExpired: number
  compacted: boolean
  newEpoch?: number
  rowCount: number
  dataFilesBefore: number
  dataFilesAfter: number
}

export interface MaintenanceReport {
  partitions: MaintenancePartitionReport[]
  totalSnapshotsExpired: number
  totalCompacted: number
  dryRun: boolean
  elapsedMs: number
}

export interface CacheStatusPartition {
  dataset: string
  partition: Record<string, string>
  epoch: number
  rowCount: number
  dataFileCount: number
  metadataBytes: number
  snapshotCount: number
  source?: string
  deleteFileCount?: number
  lastRetentionCutoffDate?: string
  layout?: 'epoch' | 'source-table'
}

export interface CacheStatusReport {
  cacheRoot: string
  pendingSpoolBytes: number
  partitions: CacheStatusPartition[]
}

export interface RetentionSourceTableResult {
  dataset: string
  source: string
  cutoffDate: string
  rowsDeleted: number
  batchCount: number
  candidateFileCount: number
}

export interface RetentionResult {
  evicted: Array<{ dataset: string, partition: string, rowCount: number }>
  sourceTableResults: RetentionSourceTableResult[]
}

export type ExtendedQueryStorageService = QueryStorageService & {
  dataSourceForTable(tablePath: string): Promise<AsyncDataSource | null>
  flushTable(tablePath: string, opts?: { reason?: string; force?: boolean }): Promise<FlushResult>
  flushAll(opts?: { reason?: string; force?: boolean }): Promise<FlushResult>
  pendingInfo(tablePath: string): Promise<PendingInfo>
  appendRowsToPartition(
    dataset: string,
    partitionSegments: string[],
    columns: readonly ColumnSpec[],
    rows: Record<string, unknown>[],
  ): Promise<void>
  discoverCachePartitions(scope?: Partial<QueryScope>): Promise<CachePartitionMeta[]>
  /**
   * Yield rows currently pending in the spool for every table belonging
   * to `dataset` — rows captured live but not yet flushed to Iceberg, so
   * invisible to `discoverCachePartitions`/`readRows`. Read-only; degrades
   * to an empty stream on any error.
   */
  readSpooledRows(dataset: string, columns?: string[]): AsyncGenerator<Record<string, unknown>>
}
