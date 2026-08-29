import type { ColumnSpec, QueryScope, QueryStorageService, ScannableDataSource } from '../../../hypaware-plugin-kernel-types.d.ts'
import type { ParquetWriter } from 'hyparquet-writer'
import type { Writer } from 'hyparquet-writer/src/types.js'
import type { PartitionSpec } from 'icebird/src/types.js'
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
  // Committed rows still carrying the gateway provisional-identity marker
  // (`attributes.gateway.identity_source === 'gateway_fallback'`, LLP 0027).
  // Incremented by the flush path as marker rows land and reset to the exact
  // remainder by each generation rewrite, so maintenance gates the re-settle
  // sweep on this field instead of scanning the table's attributes column
  // every tick. Absent means unknown (a cursor written before the field
  // existed): maintenance answers with one legacy scan and writes the
  // verdict back, so the scan runs at most once per partition.
  pendingFallbacks?: number
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
  /**
   * When this table's last flush attempt threw, if one is recorded and
   * readable. A pacing record for the automatic query gate, never a verdict
   * about what the spool or the cache holds (LLP 0322#what-the-stamp-is-not).
   * Optional so a storage stub that predates the stamp still satisfies the
   * shape, and read as "no recent failure" when absent.
   */
  flushFailedAtMs?: number | null
}

export interface CacheSpool {
  /**
   * Write one batch into the table's spool, to be committed by a later
   * `flushTable`. All-or-nothing as far as the caller is concerned: it
   * resolves once the record is in the spool, and rejects when the record
   * is not there and no flush will find it. That is what lets a caller
   * treat a rejection as "nothing landed" and replay the rows without
   * writing them twice.
   *
   * The rollback behind that is best effort, so the guarantee is not
   * absolute: a torn write whose tail cannot be read back, and a spool
   * file another process appended to between this append's size probe and
   * its rollback, can both reject with bytes still in the file. A caller
   * that must not double-write under a failing device or a shared spool
   * still needs its own identity check.
   */
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

/**
 * A `hyparquet-writer` Writer that can also be discarded without being
 * finished. `finish()` is the only thing that closes the local writer's
 * file descriptor and renames its temp file into place, which is fine for
 * a one-shot append but not for a writer held open across many row
 * groups: an append that fails part-way has no `finish()` coming.
 *
 * `park()` is the other half of that: it hands the descriptor and the
 * buffer back while keeping the half-written file, so a writer can stay
 * logically open without costing a descriptor. A writer that does not
 * implement it can only be retired by closing the file.
 */
export interface AbortableWriter extends Writer {
  abort?(): void
  park?(): void
}

/**
 * One data file a streaming compaction currently has open: the parquet
 * writer accumulating row groups into it, plus the per-file Iceberg
 * metrics accumulated so far. Bounds are held as the raw minimum and
 * maximum seen; serialization happens once, at file close.
 */
export interface OpenCompactionFile {
  dataPath: string
  writer: AbortableWriter
  parquet: ParquetWriter
  partition: Record<string, unknown>
  rowGroups: number
  rows: bigint
  /**
   * Upper bound on the row-group metadata `ParquetWriter` is pinning for
   * this file (raw min/max values plus per-chunk overhead), charged
   * against the append's global stats budget.
   */
  statsBytes: number
  valueCounts: Record<number, bigint>
  nullCounts: Record<number, bigint>
  nanCounts: Record<number, bigint>
  mins: Record<number, unknown>
  maxes: Record<number, unknown>
}

export interface StreamingAppendResult {
  rowCount: number
  dataFiles: number
  bytesWritten: number
}

/**
 * A multi-batch append that decides its own file boundaries. Each `write`
 * lands one bounded batch as a parquet row group; `close` commits every
 * file the append produced in a single snapshot.
 */
export interface StreamingTableAppend {
  write(rows: Record<string, unknown>[]): Promise<void>
  close(): Promise<StreamingAppendResult>
  /**
   * Discard the append without committing. Releases the file descriptors
   * and temp files of every still-open output file. Safe to call after a
   * failed `close`, and a no-op once everything is closed.
   */
  abort(): Promise<void>
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
  /**
   * Resolve a dataset's current `cachePartitioning` declaration, so the
   * tick can detect a table whose recorded partition spec still carries a
   * column the declaration has demoted to sortOnly, and run the one-time
   * generation-swap re-partition (LLP 0311). Absent when the caller has no
   * registry (tests, bare CLI paths); no migration runs without it.
   */
  getDeclaration?: (dataset: string) => CachePartitioningDeclaration | undefined
}

/**
 * The dataset's flush-time settlement pass, re-used by the maintenance
 * re-settle sweep. Upgrades provisional fallback rows to native identity
 * and drops any whose `part_id` already exists in a committed partition.
 *
 * Maintenance resolves this from the dataset's `resettleBatch`, and calls it
 * both for real (inside a rewrite) and speculatively (`victimFallbacksSettleable`,
 * which discards the rows it gets back). The hook must therefore be pure and
 * idempotent, per the contract stated on `resettleBatch` in
 * `hypaware-plugin-kernel-types.d.ts`.
 *
 * @ref LLP 0312#settle-purity [constrained-by]: the probe calls this and throws the answer away.
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
  // The compaction was the one-time re-partition migration: the generation
  // swap wrote the new generation under the declaration's partition spec
  // and sort order instead of carrying the recorded ones (LLP 0311).
  repartitioned?: boolean
  // The re-partition was due but its target layout could not be derived
  // from the table's metadata, so this tick deferred it. The partition
  // still compacts in place under its recorded spec; the layout has not
  // moved and the mismatch stands until a tick can read the metadata.
  repartitionDeferred?: boolean
  newEpoch?: number
  rowCount: number
  dataFilesBefore: number
  dataFilesAfter: number
  /** Bytes the compaction rewrite actually wrote; absent when it did not run. */
  compactedBytesWritten?: number
  /** Grep sidecars built for the live generation; absent when the build pass did not run. */
  sidecarsBuilt?: number
  /** Files whose sidecar build failed on THIS pass; the scan tier serves them. */
  sidecarsFailed?: number
  /**
   * Files skipped without a build because the per-file attempt budget is
   * spent. Separate from `sidecarsFailed`, which counts work this pass
   * actually attempted: a quarantined file costs nothing and would
   * otherwise report a fresh failure on every later tick.
   */
  sidecarsQuarantined?: number
  /**
   * Files still missing a sidecar when the tick's budget ran out. They are
   * built by a later tick: the pass is resumable because sidecar existence
   * is its only completion marker.
   */
  sidecarsDeferred?: number
  /** The build pass's own error, when the pass itself threw (never fails the partition). */
  sidecarError?: string
  // Compaction of this partition is known not to reduce its data-file
  // count under the writer running now: either this run's rewrite
  // reproduced the count it started from, or a previous one did and the
  // cursor still records that verdict (LLP 0217). Set with `compacted`
  // for the first case and without it for the second, where it is the
  // reason the partition was skipped.
  compactionIneffective?: boolean
  // The data-file count the rewrite behind that verdict started from,
  // which is the recorded count and not necessarily the live one. Set
  // whenever `compactionIneffective` is.
  compactionIneffectiveFiles?: number
  // The partition is skipped because the one retry its writer generation
  // owed it was spent by a rewrite that threw (LLP 0218). Never set with
  // `compacted`, and never with `compactionIneffective`: a failed attempt
  // records no verdict about the partition, so where a verdict exists that
  // is the reason reported instead.
  compactionAttemptFailed?: boolean
  // When that attempt failed, as the cursor records it. Set whenever
  // `compactionAttemptFailed` is.
  compactionAttemptFailedAt?: string
  // Files of the live generation released by the unreferenced-file sweep
  // (LLP 0310): superseded by an in-place compaction or by snapshot
  // expiry and no longer named by any retained snapshot, plus the staged
  // metadata names a crashed publish stranded (LLP 0316), which the sweep
  // reclaims in a pass that runs ahead of the referenced-set walk.
  // Absent when the sweep removed nothing or did not run. Present does
  // NOT mean the sweep finished: the staging pass answers to no
  // referenced set, so a walk that failed after it still reports what the
  // pass had already released, and what the walk did not reach is swept
  // next tick.
  unreferencedFilesRemoved?: number
  // THIS tick's work on the partition ended in an error and the walk moved
  // on (LLP 0220). Distinct from `compactionAttemptFailed`, which is read
  // off the cursor and says an EARLIER tick's attempt failed and nothing
  // has been attempted since: the two never appear together, because a
  // tick that attempted a rewrite is not a tick that skipped one.
  failed?: boolean
  // The error's own `errorKind` when it carries one, else
  // `maintenance_partition_failed`. Set whenever `failed` is.
  errorKind?: string
  // The error's message. Set whenever `failed` is.
  errorMessage?: string
}

export interface MaintenanceReport {
  partitions: MaintenancePartitionReport[]
  totalSnapshotsExpired: number
  totalCompacted: number
  totalRebaselined: number
  // Partitions whose work threw during this tick. Non-zero means the walk
  // completed but the tick is degraded: it did not maintain everything it
  // set out to, and its callers report that rather than a clean run
  // (LLP 0220#tick-reports-degraded).
  totalFailed: number
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
  /** Data files with a grep sidecar beside them; present only on the grep dataset's partitions. */
  indexedFileCount?: number
  /**
   * Data files a sidecar could be built beside, the honest denominator for
   * `indexedFileCount`. Not `dataFileCount`: position-delete files live in
   * the same `data/` directory and that counter includes them, while no
   * sidecar is ever built for one.
   */
  indexableFileCount?: number
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
  dataSourceForTable(tablePath: string): Promise<ScannableDataSource | null>
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
