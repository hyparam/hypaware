/**
 * @param {Partial<ExportRetentionConfig> | undefined} config
 * @returns {ExportRetentionConfig}
 */
export function normalizeExportRetentionConfig(config: Partial<ExportRetentionConfig> | undefined): ExportRetentionConfig;
/**
 * Expire old snapshots on a blob-store-backed Iceberg export table.
 * Retention logic mirrors `src/core/cache/maintenance.js#expireSnapshots`:
 * keep the current snapshot, at least `min_snapshots_to_keep` recent
 * ones, and nothing older than `max_snapshot_age_hours`.
 *
 * @param {{
 *   tableUrl: string
 *   resolver: Resolver
 *   lister: Lister
 *   config: ExportRetentionConfig
 *   dryRun?: boolean
 * }} opts
 * @returns {Promise<{ expired: number, snapshotsBefore: number }>}
 */
export function expireExportSnapshots({ tableUrl, resolver, lister, config, dryRun }: {
    tableUrl: string;
    resolver: Resolver;
    lister: Lister;
    config: ExportRetentionConfig;
    dryRun?: boolean;
}): Promise<{
    expired: number;
    snapshotsBefore: number;
}>;
/**
 * Discover dataset names under a blob-store export prefix by listing
 * metadata directories.  Each dataset lives at `<prefix>/<dataset>/metadata/`.
 *
 * @param {BlobStore} blobStore
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
export function discoverExportDatasets(blobStore: BlobStore, prefix: string): Promise<string[]>;
/**
 * Compact a blob-store-backed Iceberg export table by rewriting its live
 * rows into consolidated, sorted data files (icebird `icebergRewrite`;
 * 0.8.10 preserves v3 row lineage across the rewrite, which matters
 * because export tables are created with `formatVersion: 3`).
 *
 * @ref LLP 0022#compaction — this is the *out-of-band* rewrite the spec
 * reserves: it must only run from an explicit, manual invocation
 * (`hyp sink maintain --compact`), never from the daemon loop or the
 * sink tick, because a full read-rewrite in the daemon process is the
 * OOM/blocking failure mode already seen with the parquet encoder.
 *
 * The rewrite is skipped while the table's live data-file count is below
 * `compactFileCount` — for a day-partitioned archive the files are
 * already large, so most tables never reach the threshold — and when the
 * current snapshot's `total-files-size` exceeds `compactMaxBytes`
 * (icebird's rewrite holds every live row in memory; see DEFAULTS).
 *
 * A rewrite commit is intentionally NOT retried on a concurrent-commit
 * conflict: it only rewrote the rows it read, so a blind retry could drop
 * rows another writer appended in the meantime. On a failed commit the
 * latest metadata is re-loaded BEFORE any cleanup: a timeout after the
 * conditional PUT durably landed, or an SDK-internal retry of its own
 * successful write surfacing 412, both leave the staged rewrite as the
 * table's current snapshot — deleting its data files then would corrupt
 * the export. Only when the reload confirms the staged snapshot did not
 * land is a conflict's staged output deleted best-effort (icebird's
 * `icebergRewrite` leaves it orphaned, which is why this stages and
 * commits explicitly); an unverifiable outcome leaves the bounded
 * orphans in place and says so in the error.
 *
 * Every non-compaction outcome is discriminated by `reason` so the CLI
 * can tell an idle table from a failed rewrite (a swallowed failure here
 * would misreport as "below threshold" — the one manual compaction tool
 * misdiagnosing itself). A metadata *load* failure is only reported as
 * `no-table` when the table verifiably does not exist; auth/IO failures
 * surface as `error` so the CLI exits nonzero instead of printing an
 * idle-table skip.
 *
 * @param {{
 *   tableUrl: string
 *   resolver: Resolver
 *   lister: Lister
 *   compactFileCount: number
 *   compactMaxBytes?: number
 *   dryRun?: boolean
 * }} opts
 * @returns {Promise<ExportCompactionResult>}
 */
export function compactExportTable(opts: {
    tableUrl: string;
    resolver: Resolver;
    lister: Lister;
    compactFileCount: number;
    compactMaxBytes?: number;
    dryRun?: boolean;
}): Promise<ExportCompactionResult>;
/**
 * Run export maintenance on all datasets under a prefix: snapshot
 * expiration per dataset, plus — only when `compact` is set — the
 * out-of-band data-file rewrite ({@link compactExportTable}).
 *
 * @ref LLP 0022#compaction — `compact` defaults to false; the daemon
 * and the sink tick never set it. Only the manual CLI path
 * (`hyp sink maintain --compact`) opts in.
 *
 * @param {{
 *   blobStore: BlobStore
 *   prefix: string
 *   datasets?: string[]
 *   config?: Partial<ExportRetentionConfig>
 *   compact?: boolean
 *   dryRun?: boolean
 * }} opts
 * @returns {Promise<ExportMaintenanceReport>}
 */
export function maintainExportTables(opts: {
    blobStore: BlobStore;
    prefix: string;
    datasets?: string[];
    config?: Partial<ExportRetentionConfig>;
    compact?: boolean;
    dryRun?: boolean;
}): Promise<ExportMaintenanceReport>;
import type { ExportRetentionConfig } from './types.d.ts';
import type { Resolver } from 'icebird/src/types.js';
import type { Lister } from 'icebird/src/types.js';
import type { BlobStore } from '../../../../collectivus-plugin-kernel-types.d.ts';
import type { ExportCompactionResult } from './types.d.ts';
import type { ExportMaintenanceReport } from './types.d.ts';
