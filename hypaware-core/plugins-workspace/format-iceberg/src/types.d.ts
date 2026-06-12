import type { ColumnSpec } from '../../../../collectivus-plugin-kernel-types.d.ts'
import type { TableMetadata, Resolver, Lister, PartitionSpec, SortOrder } from 'icebird/src/types.js'
import type { CachePartitioningDeclaration } from '../../../../src/core/iceberg/types.d.ts'

export interface TableState {
  /** True when at least one metadata file is visible. */
  exists: boolean
  metadata: TableMetadata | null
  currentSnapshotId: string | undefined
}

/**
 * Writer-owned export layout for one dataset (LLP 0022): a day-grain partition
 * derived from `primaryTimestampColumn`, plus a within-partition sort on the
 * dataset's declared identity (lookup) columns.
 */
export interface DatasetPartitioning {
  /** Synthesized day-grain declaration — kept for the on-append drift check. */
  declaration: CachePartitioningDeclaration
  /** Iceberg partition spec passed to `icebergCreateTable`. */
  partitionSpec: PartitionSpec
  /** Within-partition sort order; an empty order means unsorted (no-op). */
  sortOrder: SortOrder
  /** Span label, e.g. `day(message_created_at)`. */
  partitionSpecLabel: string
  /** Span label, e.g. `conversation_id,cwd,date` (empty when unsorted). */
  sortOrderLabel: string
}

export interface CommitInput {
  /** Table URL the resolver understands. */
  tableUrl: string
  /** Dataset column schema. */
  columns: readonly ColumnSpec[]
  /** Coerced records. */
  rows: readonly Record<string, unknown>[]
  resolver: Resolver
  lister: Lister
  /** Day-grain partition + sort layout; absent ⇒ unpartitioned table. */
  partitioning?: DatasetPartitioning | null
}

export interface CommitResult {
  snapshotId: string
  metadataVersion: string
  dataFiles: string[]
  bytesWritten: number
  rowCount: number
  metadata: TableMetadata
}

export interface ExportMarker {
  dataset: string
  batchId: string
  partition: Record<string, string>
  rowCount: number
  bytesWritten: number
  /** Iceberg-relative or BlobStore-key data file paths. */
  dataFiles: string[]
  /** `current-snapshot-id` after the commit (stringified bigint or number). */
  snapshotId: string
  /** e.g. `v3`. */
  metadataVersion: string
  /** ISO timestamp. */
  committedAt: string
}

export interface ProbeStateLike {
  currentSnapshotId: string | undefined
  metadata?: TableMetadata | null
}

export interface BlobIOWriteEvent {
  /** BlobStore key the write landed on. */
  key: string
  /** Server-returned ETag (S3) or undefined (local-fs). */
  etag: string | undefined
  /** The conditional-write token that was sent, if any. */
  ifNoneMatch: string | undefined
}

export type BlobIOWriteObserver = (event: BlobIOWriteEvent) => void

export interface ExportRetentionConfig {
  min_snapshots_to_keep: number
  max_snapshot_age_hours: number
  /**
   * Rewrite a table once its live data-file count reaches this threshold.
   * Only consulted by the out-of-band compaction path (LLP 0022).
   */
  compact_file_count: number
  /**
   * Skip the rewrite when the current snapshot's `total-files-size`
   * exceeds this many bytes: icebird's rewrite materializes every live
   * row in memory, so an unbounded table would OOM the manual CLI run.
   */
  compact_max_bytes: number
}

/**
 * Why a requested compaction did not commit a rewrite.
 * - `no-table`: the table verifiably does not exist (no metadata files).
 * - `below-threshold`: live data-file count under `compact_file_count`.
 * - `above-byte-cap`: `total-files-size` over `compact_max_bytes`; raise the
 *   cap (and the heap) to rewrite anyway.
 * - `conflict`: another writer's commit was confirmed to have won the race;
 *   staged files were cleaned up, re-run to retry from fresh metadata.
 * - `error`: the metadata load or the rewrite failed (IO, auth, ...); see
 *   `error`. A failed commit whose outcome could not be verified also lands
 *   here, with its staged files deliberately left in place (deleting them
 *   could corrupt the table if the commit actually landed).
 */
export type ExportCompactionSkipReason =
  | 'no-table'
  | 'below-threshold'
  | 'above-byte-cap'
  | 'conflict'
  | 'error'

export interface ExportCompactionResult {
  compacted: boolean
  /** Present iff `compacted` is false. */
  reason?: ExportCompactionSkipReason
  /** Error message when `reason` is 'conflict' or 'error'. */
  error?: string
  /** Current snapshot's `total-files-size`, when the byte cap rejected it. */
  totalBytes?: number
  dataFilesBefore: number
  dataFilesAfter: number
}

export interface ExportMaintenanceDatasetReport {
  dataset: string
  snapshotsExpired: number
  snapshotsBefore: number
  /** icebird >= 0.8.9 exposes `icebergRewrite`; out-of-band only (LLP 0022). */
  compactionSupported: true
  /** True when an opt-in rewrite committed (or would have, under dryRun). */
  compacted: boolean
  /** Present when compaction was requested but did not commit. */
  compactionReason?: ExportCompactionSkipReason
  /** Present when the rewrite conflicted or failed. */
  compactionError?: string
  /** Present only when compaction was requested. */
  dataFilesBefore?: number
  /** Present only when compaction was requested. */
  dataFilesAfter?: number
}

export interface ExportMaintenanceReport {
  datasets: ExportMaintenanceDatasetReport[]
  totalSnapshotsExpired: number
  totalTablesCompacted: number
  compactionSupported: true
  dryRun: boolean
  elapsedMs: number
}

