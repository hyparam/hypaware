// @ts-check

import {
  fileCatalog,
  icebergExpireSnapshots,
  loadLatestFileCatalogMetadata,
} from 'icebird'
import { fileCatalogCommit } from 'icebird/src/write/commit.js'
import { icebergStageRewrite } from 'icebird/src/write/rewrite.js'

import { SNAPSHOT_RETENTION_DEFAULTS } from '../../../../src/core/cache/maintenance.js'
import { createBlobStoreIO, tableUrlForBlobPrefix } from './blob-io.js'

/**
 * @import { BlobStore } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { Resolver, Lister, TableMetadata } from 'icebird/src/types.js'
 * @import { ExportCompactionResult, ExportRetentionConfig, ExportMaintenanceDatasetReport, ExportMaintenanceReport } from './types.d.ts'
 */

/** @type {ExportRetentionConfig} */
const DEFAULTS = Object.freeze({
  ...SNAPSHOT_RETENTION_DEFAULTS,
  // Mirrors the local-cache `compact_file_count` trigger: rewrite once a
  // table's live data-file count crosses this threshold.
  compact_file_count: 32,
  // icebird's rewrite materializes every live row in memory before writing
  // (no streaming path yet), so an unbounded table would re-create the
  // parquet-encoder OOM this repo already hit twice (#82 local cache,
  // #90 parquet exports). Skip the rewrite when the current snapshot's
  // `total-files-size` exceeds this. 128 MB matches the cache's
  // `target_file_bytes`: compressed parquet expands ~10x into JS objects,
  // keeping the rewrite around a gigabyte of heap under a default node heap.
  compact_max_bytes: 128 * 1024 * 1024,
})

/**
 * @param {Partial<ExportRetentionConfig> | undefined} config
 * @returns {ExportRetentionConfig}
 */
export function normalizeExportRetentionConfig(config) {
  return {
    min_snapshots_to_keep: config?.min_snapshots_to_keep ?? DEFAULTS.min_snapshots_to_keep,
    max_snapshot_age_hours: config?.max_snapshot_age_hours ?? DEFAULTS.max_snapshot_age_hours,
    compact_file_count: config?.compact_file_count ?? DEFAULTS.compact_file_count,
    compact_max_bytes: config?.compact_max_bytes ?? DEFAULTS.compact_max_bytes,
  }
}

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
export async function expireExportSnapshots({ tableUrl, resolver, lister, config, dryRun }) {
  /** @type {TableMetadata} */
  let metadata
  try {
    const loaded = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
    metadata = loaded.metadata
  } catch {
    return { expired: 0, snapshotsBefore: 0 }
  }

  const snapshots = metadata.snapshots ?? []
  if (snapshots.length <= config.min_snapshots_to_keep) {
    return { expired: 0, snapshotsBefore: snapshots.length }
  }

  const currentId = metadata['current-snapshot-id']
  const cutoffMs = Date.now() - config.max_snapshot_age_hours * 60 * 60 * 1000

  const sorted = [...snapshots].sort((a, b) => b['timestamp-ms'] - a['timestamp-ms'])
  /** @type {number[]} */
  const toExpire = []
  for (let i = 0; i < sorted.length; i++) {
    const snap = sorted[i]
    const id = snap['snapshot-id']
    if (currentId !== undefined && BigInt(id) === BigInt(currentId)) continue
    if (i < config.min_snapshots_to_keep) continue
    if (snap['timestamp-ms'] >= cutoffMs) continue
    toExpire.push(Number(id))
  }

  if (toExpire.length === 0) return { expired: 0, snapshotsBefore: snapshots.length }
  if (dryRun) return { expired: toExpire.length, snapshotsBefore: snapshots.length }

  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })
  try {
    await icebergExpireSnapshots({ catalog, tableUrl, snapshotIds: toExpire })
  } catch {
    return { expired: 0, snapshotsBefore: snapshots.length }
  }
  return { expired: toExpire.length, snapshotsBefore: snapshots.length }
}

/**
 * Discover dataset names under a blob-store export prefix by listing
 * metadata directories.  Each dataset lives at `<prefix>/<dataset>/metadata/`.
 *
 * @param {BlobStore} blobStore
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
export async function discoverExportDatasets(blobStore, prefix) {
  const normalized = prefix.replace(/^\/+/, '').replace(/\/+$/, '')
  const listPrefix = normalized.length > 0 ? `${normalized}/` : ''

  /** @type {Set<string>} */
  const datasets = new Set()
  try {
    for await (const entry of blobStore.listObjects({ prefix: listPrefix })) {
      const rel = entry.key.startsWith(listPrefix) ? entry.key.slice(listPrefix.length) : entry.key
      // Pattern: <dataset>/metadata/v*.metadata.json
      const match = rel.match(/^([^/]+)\/metadata\//)
      if (match && match[1] !== 'state') datasets.add(match[1])
    }
  } catch {
    return []
  }
  return Array.from(datasets).sort()
}

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
 * rows another writer appended in the meantime. On conflict the staged
 * data/manifest files are deleted best-effort (icebird's `icebergRewrite`
 * leaves them orphaned, which is why this stages and commits explicitly),
 * the result carries `reason: 'conflict'`, and the next manual run starts
 * from fresh metadata.
 *
 * Every non-compaction outcome is discriminated by `reason` so the CLI
 * can tell an idle table from a failed rewrite (a swallowed failure here
 * would misreport as "below threshold" — the one manual compaction tool
 * misdiagnosing itself).
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
export async function compactExportTable({ tableUrl, resolver, lister, compactFileCount, compactMaxBytes, dryRun }) {
  /** @type {Awaited<ReturnType<typeof loadLatestFileCatalogMetadata>>} */
  let loaded
  try {
    loaded = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  } catch {
    return { compacted: false, reason: 'no-table', dataFilesBefore: 0, dataFilesAfter: 0 }
  }
  const metadata = loaded.metadata

  const dataFilesBefore = currentDataFileCount(metadata)
  if (dataFilesBefore < compactFileCount) {
    return { compacted: false, reason: 'below-threshold', dataFilesBefore, dataFilesAfter: dataFilesBefore }
  }
  const totalBytes = currentSummaryNumber(metadata, 'total-files-size')
  if (compactMaxBytes !== undefined && totalBytes !== undefined && totalBytes > compactMaxBytes) {
    return {
      compacted: false,
      reason: 'above-byte-cap',
      totalBytes,
      dataFilesBefore,
      dataFilesAfter: dataFilesBefore,
    }
  }
  if (dryRun) {
    return { compacted: true, dataFilesBefore, dataFilesAfter: dataFilesBefore }
  }

  // Stage and commit explicitly (the same load → stage → single-attempt
  // commit `icebergRewrite` performs for a conditional-commit file
  // catalog) so a failed commit can clean up `staged.writtenFiles`
  // instead of leaving a full rewritten copy of the table orphaned in
  // the blob store on every lost race.
  /** @type {Awaited<ReturnType<typeof icebergStageRewrite>>} */
  let staged
  try {
    staged = await icebergStageRewrite({ tableUrl, metadata, resolver })
  } catch (err) {
    return {
      compacted: false,
      reason: 'error',
      error: describeError(err),
      dataFilesBefore,
      dataFilesAfter: dataFilesBefore,
    }
  }
  try {
    const post = await fileCatalogCommit({
      tableUrl,
      metadata,
      metadataFileName: loaded.metadataFileName,
      currentVersion: loaded.version,
      staged,
      resolver,
      conditionalCommits: true,
    })
    return { compacted: true, dataFilesBefore, dataFilesAfter: currentDataFileCount(post) }
  } catch (err) {
    if (resolver.deleter) {
      const { deleter } = resolver
      await Promise.allSettled(staged.writtenFiles.map((p) => deleter(p)))
    }
    return {
      compacted: false,
      reason: isCommitConflict(err) ? 'conflict' : 'error',
      error: describeError(err),
      dataFilesBefore,
      dataFilesAfter: dataFilesBefore,
    }
  }
}

/**
 * Live data-file count from the current snapshot's summary.
 *
 * @param {TableMetadata} metadata
 * @returns {number}
 */
function currentDataFileCount(metadata) {
  return currentSummaryNumber(metadata, 'total-data-files') ?? 0
}

/**
 * Numeric field from the current snapshot's summary, or undefined when
 * there is no current snapshot or the field is absent/non-numeric.
 *
 * @param {TableMetadata} metadata
 * @param {string} key
 * @returns {number | undefined}
 */
function currentSummaryNumber(metadata, key) {
  const currentId = metadata['current-snapshot-id']
  if (currentId === undefined) return undefined
  const snapshot = metadata.snapshots?.find((s) => String(s['snapshot-id']) === String(currentId))
  const raw = snapshot?.summary?.[key]
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Concurrent-commit conflict detection, mirroring icebird's internal
 * `isCommitConflict`: the blob-io writer surfaces a conditional-write
 * collision as a 412 (and tags it `iceberg_commit_conflict`); REST-shaped
 * catalogs use 409.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isCommitConflict(err) {
  if (!err || typeof err !== 'object') return false
  const record = /** @type {Record<string, unknown>} */ (err)
  if (record.hypErrorKind === 'iceberg_commit_conflict') return true
  const status = record.status ?? record.statusCode
  return status === 412 || status === 409
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (err instanceof Error) return err.message
  return String(err)
}

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
export async function maintainExportTables(opts) {
  const startMs = Date.now()
  const cfg = normalizeExportRetentionConfig(opts.config)
  const dryRun = opts.dryRun ?? false
  const compact = opts.compact ?? false

  const datasets = opts.datasets ?? await discoverExportDatasets(opts.blobStore, opts.prefix)
  const { resolver, lister } = await createBlobStoreIO(opts.blobStore)

  /** @type {ExportMaintenanceDatasetReport[]} */
  const reports = []
  let totalSnapshotsExpired = 0
  let totalTablesCompacted = 0

  for (const dataset of datasets) {
    const blobPrefix = joinKeys(stripSlashes(opts.prefix), dataset)
    const tableUrl = tableUrlForBlobPrefix(blobPrefix)
    const result = await expireExportSnapshots({
      tableUrl,
      resolver,
      lister,
      config: cfg,
      dryRun,
    })
    totalSnapshotsExpired += result.expired
    /** @type {ExportMaintenanceDatasetReport} */
    const report = {
      dataset,
      snapshotsExpired: result.expired,
      snapshotsBefore: result.snapshotsBefore,
      compactionSupported: true,
      compacted: false,
    }
    if (compact) {
      const compaction = await compactExportTable({
        tableUrl,
        resolver,
        lister,
        compactFileCount: cfg.compact_file_count,
        compactMaxBytes: cfg.compact_max_bytes,
        dryRun,
      })
      report.compacted = compaction.compacted
      report.compactionReason = compaction.reason
      report.compactionError = compaction.error
      report.dataFilesBefore = compaction.dataFilesBefore
      report.dataFilesAfter = compaction.dataFilesAfter
      if (compaction.compacted) totalTablesCompacted += 1
    }
    reports.push(report)
  }

  return {
    datasets: reports,
    totalSnapshotsExpired,
    totalTablesCompacted,
    compactionSupported: true,
    dryRun,
    elapsedMs: Date.now() - startMs,
  }
}

/**
 * @param {string} s
 */
function stripSlashes(s) {
  return s.replace(/^\/+/, '').replace(/\/+$/, '')
}

/**
 * @param {...string} parts
 */
function joinKeys(...parts) {
  return parts
    .map((p) => stripSlashes(p))
    .filter((p) => p.length > 0)
    .join('/')
}
