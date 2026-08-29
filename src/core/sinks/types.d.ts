import type {
  ExportResult,
  HypAwareV2Config,
  QueryRegistry,
  SinkContinuation,
} from '../../../hypaware-plugin-kernel-types.d.ts'
import type { ExtendedQueryStorageService } from '../cache/types.d.ts'
import type { ExtendedSinkHandle, ExtendedSinkRegistry } from '../registry/types.d.ts'

/**
 * A single-use, self-tracking incremental row stream for a blob destination,
 * returned by `openIncrementalRows`. `rows` is fed straight into the unchanged
 * `encoder.encodePartition` contract; `rowCount` and `lastAfter` are final once
 * the encoder has drained `rows`.
 */
export interface IncrementalRowReader {
  /**
   * True when there is no PAYLOAD row to encode since the watermark: the sink
   * writes no blob. A partition of only `local-only` (dropped) rows is `empty`
   * yet still exposes `droppedRowCount > 0` and an advanced `lastAfter`, so the
   * caller checkpoints past the withheld tail instead of re-scanning it.
   */
  empty: boolean
  /** Incoming watermark seq (decimal string; `'0'` when none): the range lower bound. */
  sinceSeq: string
  /** Clean (internal-stripped) rows to feed the encoder. Single-use; do not re-iterate. */
  rows: AsyncIterable<Record<string, unknown>>
  /** Rows yielded so far; final once `rows` is fully drained. */
  readonly rowCount: number
  /**
   * Rows the export seam withheld as `local-only` (LLP 0070): never encoded, but
   * each advanced `lastAfter`. Final once `rows` is drained (or, when `empty`,
   * after the leading-drop peek). A drop-only tick (`empty && droppedRowCount > 0`)
   * still checkpoints so the withheld tail is durably passed.
   */
  readonly droppedRowCount: number
  /**
   * Monotonic high-water continuation; final once `rows` is drained. Advance the
   * watermark to this only after the blob is durably PUT.
   */
  readonly lastAfter: SinkContinuation
}

/**
 * Stable logical identity of a partition for watermark storage: the partition's
 * directory relative to `<cacheRoot>/datasets/`, split into the dataset and the
 * (sanitized, `/`-joined) partition path, never the physical `tableDir`.
 */
export interface SinkWatermarkKey {
  dataset: string
  partitionKey: string
}

/**
 * On-disk per-`(sink instance, partition)` incremental-read watermark.
 * `continuation` is the highest `_hyp_ingest_seq` durably exported.
 */
export interface SinkWatermarkRecord {
  v: 1
  continuation: SinkContinuation
  exportedRowCount: number
  updatedAt: string
}

/**
 * Persisted watermark store scoped to one sink instance via its `stateDir`.
 * Files live at `<stateDir>/watermarks/<dataset>/<partition-key>.json`; `write`
 * is atomic write-rename.
 */
export interface SinkWatermarkStore {
  keyFor(cacheRoot: string, tablePath: string): SinkWatermarkKey
  filePath(key: SinkWatermarkKey): string
  read(key: SinkWatermarkKey): Promise<SinkWatermarkRecord | null>
  write(
    key: SinkWatermarkKey,
    update: { continuation: SinkContinuation; exportedRowCount?: number },
  ): Promise<SinkWatermarkRecord>
}

/**
 * How much data one destination would send right now, read off the same
 * watermark + `readRowsSince` seam the export uses. Produced by
 * `previewPendingRows` for the `hyp sync` consent summary.
 */
export interface PendingVolume {
  /**
   * `counted` - `rows` is the total.
   * `partial` - `rows` is a **floor**; the scan stopped early or could not see
   * everything, so the caller must render it as "at least N".
   * `unknown` - no usable count. Never render this as zero.
   */
  status: 'counted' | 'partial' | 'unknown'
  /** Payload rows that would be sent. A floor when `status` is `partial`. */
  rows: number
  /**
   * Rows the export seam withholds (a `local-only` directory, an opted-out
   * source). Reported apart from `rows` and never added to it: they advance the
   * cursor but never ship.
   *
   * A floor when `status` is `partial`, for the same reason `rows` is: one scan
   * produces both tallies, so whatever cut it short cut both short. Render it
   * as "at least N" on every `partial` volume, including the one where `rows`
   * is 0 and the payload line stands down to "not fully counted": there the
   * withheld tally is the only number on screen, so it is the branch that most
   * needs the mark. An exact-looking withheld number beside an admittedly
   * incomplete payload count claims a precision the count never had, on the one
   * line that says policy is working at all.
   */
  withheldRows: number
  /**
   * How far back the pending range reaches. `since` carries the oldest resume
   * point across the destination's partitions; `beginning` means at least one
   * partition has no durable cursor, so the range is the whole local history;
   * `unknown` means no cursor timestamp was readable.
   */
  resume: { kind: 'beginning' } | { kind: 'unknown' } | { kind: 'since'; at: string }
  /** Why the count is `partial` or `unknown`. Short enough to print. */
  reason?: string
}

export interface PendingPreviewOptions {
  /** Rows one destination may scan before reporting a floor. */
  rowLimit?: number
  /** Wall-clock budget for the whole preview, shared across destinations. */
  budgetMs?: number
  /** Clock seam (tests). */
  now?: () => number
}

export interface DriverOptions {
  sinkRegistry: ExtendedSinkRegistry
  queryRegistry: QueryRegistry
  storage: ExtendedQueryStorageService
  /** Kernel state root (e.g. `<HYP_HOME>/hypaware`). */
  stateRoot: string
  config?: HypAwareV2Config
}

export interface TickOptions {
  now?: Date
  /** Only fire one sink (test/manual use). */
  sinkInstance?: string
  /** Ignore cron-due check and fire every sink (test use). */
  force?: boolean
  /** Tag the tick metric so daemon vs. manual ticks split cleanly. Default `manual`. */
  source?: 'daemon' | 'manual'
}

export interface TickReport {
  sinks: Array<{
    instance: string
    status: ExportResult['status']
    partitionsExported: number
    bytesWritten: number
    error?: string
  }>
  /**
   * Present when the whole tick was skipped: an enrolling login's first-sync
   * review window is still open (the `usage-policy/first-sync-hold.json`
   * marker carries a future deadline), so no sink exported this tick
   * (LLP 0101).
   */
  held?: 'first_sync_hold'
}

export interface MaterializeResult {
  handles: ExtendedSinkHandle[]
  errors: MaterializeError[]
}

export interface MaterializeError {
  instance: string
  errorKind: string
  message: string
}
