import type { ColumnSpec } from '../../upload/upload.d.ts'
import type { QueryDataset } from '../types.d.ts'

export type QueryCacheKind = 'builtin' | 'collection'

export interface QueryCacheCursorBase {
  cache_schema_version: number
  kind: QueryCacheKind
  source_id: string
  source_path: string
  source_epoch: number
  table_path: string
  table_url: string
  source_size: number
  source_mtime_ms: number
  byte_offset: number
  line_number: number
  row_count: number
  schema_fingerprint: string
  refreshed_at: string
}

export interface BuiltinCacheCursor extends QueryCacheCursorBase {
  kind: 'builtin'
  dataset: QueryDataset
  gateway_id: string
  date: string
}

export interface CollectionCacheCursor extends QueryCacheCursorBase {
  kind: 'collection'
  table: string
  name: string
  columns: CollectionColumnMeta[]
  timestamp_column?: string
}

export type QueryCacheCursor = BuiltinCacheCursor | CollectionCacheCursor

export interface CollectionColumnMeta {
  name: string
  source_field?: string
  type: ColumnSpec['type']
  nullable: boolean
}

export interface JsonlEntry {
  lineNumber: number
  byteOffset: number
  nextByteOffset: number
  raw: Record<string, unknown>
}

export interface JsonlReadResult {
  entries: JsonlEntry[]
  nextByteOffset: number
  nextLineNumber: number
  fileSize: number
  fileMtimeMs: number
}

export interface JsonlReadOptions {
  startByteOffset?: number
  startLineNumber?: number
  endByteOffset?: number
  batchRows?: number
  batchBytes?: number
}

export type JsonlEntryBatch = JsonlReadResult
