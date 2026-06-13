/**
 * Plugin-local types for `@hypaware/vector-search`. The capability
 * surface (`VectorSearchCapability` and friends) lives in the kernel
 * types file; these shapes cover config, shard bookkeeping, and the
 * refresh/search internals.
 */

import type {
  CachePartitionMeta,
  EmbedderCapability,
  PluginActivationContext,
  PluginLogger,
} from '../../../../collectivus-plugin-kernel-types.d.ts'
import type { ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'
import type { searchVectors, writeVectors } from 'hypvector'
import type { fileWriter } from 'hyparquet-writer'

export interface VectorIndexDeclaration {
  /** Dataset to index (resolved through the dataset registry at refresh time). */
  dataset: string
  /** Column whose text is embedded. */
  column: string
  /** Index name; defaults to `<dataset>.<column>`. */
  name: string
  /**
   * Column providing the shard row id. Absent means the id is a hash of
   * the text content, which also deduplicates identical texts before
   * embedding (bounding API spend on denormalized columns).
   */
  id_column?: string
}

export interface VectorRefreshConfig {
  enabled: boolean
  /** Daemon timer cadence. Deliberately longer than cache maintenance's 60. */
  interval_minutes: number
  /** Wall-clock budget per daemon tick (soft: checked before each shard). */
  max_tick_ms: number
  /** Embedding row budget per daemon tick (soft: checked before each shard). */
  max_rows_per_tick: number
}

export interface VectorSearchConfig {
  indexes: VectorIndexDeclaration[]
  refresh: VectorRefreshConfig
}

export interface VectorConfigError {
  pointer: string
  message: string
  errorKind: 'vector_config_invalid'
}

export type VectorConfigResult =
  | { ok: true, config: VectorSearchConfig }
  | { ok: false, errors: VectorConfigError[] }

/** Sidecar JSON written next to each shard parquet file. */
export interface ShardMeta {
  schema_version: 1
  index: string
  dataset: string
  column: string
  /** Row-id column the shard was built with; absent for content-hash ids. */
  id_column?: string
  partition: Record<string, string>
  /** Embedder model the vectors were produced with. */
  model: string
  dimension: number
  /** Embedded (deduplicated) vector count. */
  row_count: number
  /** Cache partition row count at build time — the staleness signal. */
  source_row_count: number
  built_at: string
}

export type ShardStateKind = 'fresh' | 'stale_rows' | 'stale_model' | 'stale_dimension' | 'stale_config' | 'missing' | 'orphan'

export interface ShardState {
  /** Filename-safe partition rendering; shard file base name. */
  fileBase: string
  state: ShardStateKind
  /** Cache partition backing the shard; absent for orphans. */
  partition?: CachePartitionMeta
  /** Sidecar meta; absent for missing shards. */
  meta?: ShardMeta
}

export interface RefreshBudget {
  /** Epoch ms after which no further shard build starts. */
  deadlineMs?: number
  /** Max rows embedded this run; checked before each shard build. */
  maxRows?: number
}

export interface ShardBuildReport {
  index: string
  fileBase: string
  rowsEmbedded: number
  dimension: number
}

export interface RefreshReport {
  shardsBuilt: number
  shardsSkipped: number
  orphansSwept: number
  rowsEmbedded: number
  /** True when missing/stale shards remain because a budget ran out. */
  budgetExhausted: boolean
}

export interface VectorSearchRuntime {
  ctx: PluginActivationContext
  config: VectorSearchConfig
  embedder: EmbedderCapability
  storage: ExtendedQueryStorageService
  log: PluginLogger
  /** Root for shard files: `<plugin stateDir>/indexes`. */
  indexesDir: string
}

export interface HypvectorModule {
  ok: true
  searchVectors: typeof searchVectors
  writeVectors: typeof writeVectors
  fileWriter: typeof fileWriter
}

export type HypvectorLoadResult = HypvectorModule | { ok: false, message: string }

export interface RawShardHit {
  id: string
  score: number
}
