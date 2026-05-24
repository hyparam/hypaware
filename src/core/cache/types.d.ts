import type { ColumnSpec, QueryStorageService } from '../../../collectivus-plugin-kernel-types.d.ts'
import type { AsyncDataSource } from 'squirreling'

export interface RetentionConfig {
  default_days: number
  datasets?: Record<string, number>
  /** Reserved feature flag (see "open question" in plan §Phase 4); not implemented at V1. */
  wait_for_sink_ack?: boolean
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
}

export type ExtendedQueryStorageService = QueryStorageService & {
  dataSourceForTable(tablePath: string): Promise<AsyncDataSource | null>
  flushTable(tablePath: string, opts?: { reason?: string; force?: boolean }): Promise<FlushResult>
  flushAll(opts?: { reason?: string; force?: boolean }): Promise<FlushResult>
  pendingInfo(tablePath: string): Promise<PendingInfo>
}
