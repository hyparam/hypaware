import type { ColumnSpec, QueryScope, QueryStorageService } from '../../../hypaware-plugin-kernel-types.d.ts'
import type { PartitionSpec } from 'icebird/src/types.js'
import type { AsyncDataSource } from 'squirreling'
import type { UsagePolicyResolver } from '../usage-policy/types.d.ts'
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

// A `hyp purge` target: what to delete from the local cache (LLP 0104).
// `subtree` and `session` carry the raw target; `ignored` carries the shared
// usage-policy resolver so the sweep classes each row's `cwd` at scan time;
// `all` is wholesale.
export type PurgeTarget =
  | { kind: 'subtree'; path: string }
  | { kind: 'session'; id: string }
  | { kind: 'ignored'; resolver: UsagePolicyResolver }
  | { kind: 'all' }

// The result of a `hyp purge` run: how many rows were position-deleted, how
// many partitions were touched, and the distinct absolute `cwd`s among the
// deleted rows (so the caller can warn when a purged subtree still resolves
// `full` and would be re-imported by the next backfill, LLP 0104).
//
// `retainedAliasRows` / `retainedAliasCwds` are the other half of the honest
// answer, and are only ever non-empty for a `subtree` target: rows whose `cwd`
// is spelled as though it were inside the target (a Unicode or case respelling
// of it) which this filesystem does *not* report as the target directory, so
// they were correctly left in place. Purge widens onto a respelling only when
// `dev`/`ino` proves the two spellings are one directory; when it cannot -
// because they really are two directories, because the respelling is no longer
// on disk to be `stat`ed at all, or because the `stat` could not be taken (an
// `EACCES` on an ancestor, an `ELOOP`, an `ENOTDIR`: `sameDirectoryOnDisk`
// answers `false` for every error, not only `ENOENT`) - retaining is the safe
// direction, and saying so is what keeps the run distinguishable from "that
// directory had nothing cached" (LLP 0104 #spellings). A caller rendering these
// must not claim the filesystem adjudicated, and must not claim the spelling is
// absent either: only the first reason is a verdict, and only the second is a
// statement that the directory is gone.
export interface PurgeSummary {
  rowsDeleted: number
  partitionsAffected: number
  purgedCwds: string[]
  retainedAliasRows: number
  retainedAliasCwds: string[]
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
}

export interface FlushChunk {
  columns: readonly ColumnSpec[]
  rows: Record<string, unknown>[]
}

export interface ProgressState {
  byteOffset: number
  updatedAt: string
}

/**
 * Crash-safe, never-regressing monotonic int64 allocator for the
 * `_hyp_ingest_seq` column. `next()` reserves seq blocks durably
 * (reserve-before-stamp) so a resumed flush never re-issues a seq `<=` one
 * already stamped. See `createIngestSeqAllocator`.
 */
export interface IngestSeqAllocator {
  next(): Promise<bigint>
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
  /**
   * Storage handle the re-settle sweep (LLP 0027) needs so the dataset's
   * `settleBatch` can dedupe an upgraded fallback row against committed
   * `part_id`s. Absent when the caller wires no settlement (every existing
   * test/CLI path stays a pure compaction).
   */
  storage?: QueryStorageService
  /**
   * Resolve the flush-time settlement hook for a dataset, if any. Threaded
   * through from the runtime that built the cache so compaction can re-run
   * the same upgrade-and-dedupe over already-committed fallback rows: the
   * backstop for a fallback row that flushed before its uuid twin arrived
   * (LLP 0027 "Re-settle sweep").
   */
  getSettleHook?: (dataset: string) => DatasetSettleHook | undefined
}

/**
 * The dataset's flush-time settlement pass, re-used by the maintenance
 * re-settle sweep. Upgrades provisional fallback rows to native identity
 * and drops any whose `part_id` already exists in a committed partition.
 */
export type DatasetSettleHook = (
  rows: Record<string, unknown>[],
  ctx: { storage: QueryStorageService },
) => Promise<Record<string, unknown>[]>

/**
 * Resolved re-settle context for one partition rewrite: the dataset's
 * settle hook plus the storage handle its committed-`part_id` dedupe
 * scans against. Built once per partition in {@link MaintenanceOptions}.
 */
export interface SettleContext {
  settle: DatasetSettleHook
  storage: QueryStorageService
}

export interface MaintenancePartitionReport {
  dataset: string
  partition: Record<string, string>
  path: string
  snapshotsExpired: number
  compacted: boolean
  // The partition was converged by a foreign sorted replace snapshot: the
  // cursor baseline was moved to the live file count instead of rewriting
  // (LLP 0207). Mutually exclusive with `compacted`.
  rebaselined?: boolean
  newEpoch?: number
  rowCount: number
  dataFilesBefore: number
  dataFilesAfter: number
}

export interface MaintenanceReport {
  partitions: MaintenancePartitionReport[]
  totalSnapshotsExpired: number
  totalCompacted: number
  totalRebaselined: number
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

/**
 * Export-seam source-scoped withholding (LLP 0188): a second, optional
 * `readRowsSince` resolver alongside `UsagePolicyResolver`. Where
 * `UsagePolicyResolver` reads a row's own `cwd`, this one reads a
 * dataset-declared **attribution column** (`PluginDatasetManifest.attribution_column`,
 * e.g. `client_name` for `ai_gateway_messages`) and withholds rows
 * attributed to an opted-out picker source (the machine-local client-sync
 * store, LLP 0188 #opt-out) on a machine with a central layer: on an
 * enrolled machine every source syncs by default, and a source the user
 * keeps local never leaves it, even though it stays fully queryable
 * locally.
 *
 * Built at boot (`createSourceWithholdResolver`, `src/core/cache/source-withhold.js`)
 * over a live (TTL-re-read) withheld set, and threaded through
 * `createQueryStorageService` the same way `usagePolicyResolver` already
 * is.
 */
export interface SourceWithholdResolver {
  /**
   * The attribution column `readRowsSince` should force into the scan for
   * `dataset`, or `undefined` when the dataset declared no
   * `attribution_column`, the conservative default, matching `local-only`'s
   * original design: a dataset with no declared attribution column is never
   * subject to per-row source-scoped withholding (see
   * `shouldWithholdDataset` for the dataset-scoped rule).
   */
  attributionColumnFor(dataset: string): string | undefined
  /**
   * True when a row's own attribution-column value names a withheld picker
   * source id: drop-but-advance (the row is withheld from the payload but
   * still moves the watermark past it, mirroring the `cwd` filter's
   * continuation semantics).
   */
  shouldWithhold(attributionValue: unknown): boolean
  /**
   * True when `dataset` has no attribution column, has at least one
   * contributing picker source, and every such source is withheld: the
   * whole dataset is then withheld (LLP 0188 #enforcement-scope), covering
   * single-owner datasets (the otel signals) that per-row withholding can
   * never reach. Optional so a hand-built test resolver without the
   * dataset-ownership map behaves as before (nothing dataset-withheld).
   */
  shouldWithholdDataset?(dataset: string): boolean
  /**
   * Fail-closed rule for rows whose attribution value is unusable (not a
   * non-empty string) in a dataset that DOES declare an attribution
   * column: true when any picker source whose plugin declares this dataset
   * (`contributes.datasets`) is withheld, since an unlabeled row cannot be
   * proven to belong to a synced source (LLP 0192 #fail-closed). A plugin
   * that only projects rows into the dataset, without declaring it, is not
   * in that set. Optional for the same hand-built-resolver reason as
   * `shouldWithholdDataset`.
   */
  shouldWithholdUnattributed?(dataset: string): boolean
}

export type ExtendedQueryStorageService = QueryStorageService & {
  dataSourceForTable(tablePath: string): Promise<AsyncDataSource | null>
  flushTable(tablePath: string, opts?: { reason?: string; force?: boolean }): Promise<FlushResult>
  flushAll(opts?: { reason?: string; force?: boolean }): Promise<FlushResult>
  pendingInfo(tablePath: string): Promise<PendingInfo>
  /** Whether `tablePath` has rows spooled but not yet flushed to Iceberg. */
  hasPendingSync(tablePath: string): boolean
  appendRowsToPartition(
    dataset: string,
    partitionSegments: string[],
    columns: readonly ColumnSpec[],
    rows: Record<string, unknown>[],
  ): Promise<void>
  discoverCachePartitions(scope?: Partial<QueryScope>): Promise<CachePartitionMeta[]>
  /**
   * Yield rows currently pending in the spool for every table belonging
   * to `dataset`: rows captured live but not yet flushed to Iceberg, so
   * invisible to `discoverCachePartitions`/`readRows`. Read-only; degrades
   * to an empty stream on any error.
   */
  readSpooledRows(dataset: string, columns?: string[]): AsyncGenerator<Record<string, unknown>>
}
