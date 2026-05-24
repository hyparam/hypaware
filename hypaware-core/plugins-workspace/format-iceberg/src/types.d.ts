import type { ColumnSpec } from '../../../../collectivus-plugin-kernel-types.d.ts'
import type { IcebergType, TableMetadata, Resolver, Lister } from 'icebird/src/types.js'

export interface TableState {
  /** True when at least one metadata file is visible. */
  exists: boolean
  metadata: TableMetadata | null
  currentSnapshotId: string | undefined
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
}

export interface CommitResult {
  snapshotId: string
  metadataVersion: string
  dataFiles: string[]
  bytesWritten: number
  rowCount: number
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

export interface IcebergField {
  id: number
  name: string
  required: boolean
  type: IcebergType
}
