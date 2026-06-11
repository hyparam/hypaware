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
}

export interface ExportMaintenanceDatasetReport {
  dataset: string
  snapshotsExpired: number
  snapshotsBefore: number
  /** icebird >= 0.8.9 exposes `icebergRewrite`; out-of-band only (LLP 0022). */
  compactionSupported: true
  /** True when an opt-in rewrite committed (or would have, under dryRun). */
  compacted: boolean
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

