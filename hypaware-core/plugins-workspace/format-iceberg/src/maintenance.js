// @ts-check

import {
  fileCatalog,
  icebergExpireSnapshots,
  loadLatestFileCatalogMetadata,
} from 'icebird'
import { fileCatalogCommit } from 'icebird/src/write/commit.js'
import { icebergStageRewrite } from 'icebird/src/write/rewrite.js'

import { SNAPSHOT_RETENTION_DEFAULTS } from '../../../../src/core/cache/maintenance.js'
import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { createBlobStoreIO, tableUrlForBlobPrefix } from './blob-io.js'

/**
 * @import { BlobStore } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { Span } from '../../../../src/core/observability/runtime.js'
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
 * @ref LLP 0022#compaction: this is the *out-of-band* rewrite the spec
 * reserves: it must only run from an explicit, manual invocation
 * (`hyp sink maintain --compact`), never from the daemon loop or the
 * sink tick, because a full read-rewrite in the daemon process is the
 * OOM/blocking failure mode already seen with the parquet encoder.
 *
 * The rewrite is skipped while the table's live data-file count is below
 * `compactFileCount` - for a day-partitioned archive the files are
 * already large, so most tables never reach the threshold - and when the
 * current snapshot's `total-files-size` exceeds `compactMaxBytes`
 * (icebird's rewrite holds every live row in memory; see DEFAULTS).
 *
 * A rewrite commit is intentionally NOT retried on a concurrent-commit
 * conflict: it only rewrote the rows it read, so a blind retry could drop
 * rows another writer appended in the meantime. On a failed commit the
 * latest metadata is re-loaded BEFORE any cleanup: a timeout after the
 * conditional PUT durably landed, or an SDK-internal retry of its own
 * successful write surfacing 412, both leave the staged rewrite as the
 * table's current snapshot. Deleting its data files then would corrupt
 * the export. Only when the reload confirms the staged snapshot did not
 * land is a conflict's staged output deleted best-effort (icebird's
 * `icebergRewrite` leaves it orphaned, which is why this stages and
 * commits explicitly); an unverifiable outcome leaves the bounded
 * orphans in place and says so in the error.
 *
 * Every non-compaction outcome is discriminated by `reason` so the CLI
 * can tell an idle table from a failed rewrite (a swallowed failure here
 * would misreport as "below threshold" - the one manual compaction tool
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
export async function compactExportTable(opts) {
  // The rewrite makes corruption-relevant decisions (verify-then-delete
  // of staged files, generation-sized deletes); every outcome must be
  // attributable from telemetry alone, not just the CLI report.
  return withSpan(
    'sink.export.compact',
    {
      [Attr.COMPONENT]: 'plugin',
      [Attr.OPERATION]: 'sink.export.compact',
      table_url: opts.tableUrl,
      dry_run: opts.dryRun === true,
      status: 'ok',
    },
    async (span) => {
      const result = await compactExportTableInner(opts, span)
      span.setAttribute('compacted', result.compacted)
      span.setAttribute('data_files_before', result.dataFilesBefore)
      span.setAttribute('data_files_after', result.dataFilesAfter)
      if (result.reason) span.setAttribute('reason', result.reason)
      if (result.reason === 'error' || result.reason === 'conflict') {
        span.setAttribute('status', 'error')
        span.setAttribute(
          Attr.ERROR_KIND,
          result.reason === 'conflict' ? 'iceberg_commit_conflict' : 'export_compact_failed'
        )
        if (result.error) span.setAttribute('error_message', result.error)
      }
      return result
    },
    { component: 'plugin' }
  )
}

/**
 * @param {{
 *   tableUrl: string
 *   resolver: Resolver
 *   lister: Lister
 *   compactFileCount: number
 *   compactMaxBytes?: number
 *   dryRun?: boolean
 * }} opts
 * @param {Span} span
 * @returns {Promise<ExportCompactionResult>}
 */
async function compactExportTableInner({ tableUrl, resolver, lister, compactFileCount, compactMaxBytes, dryRun }, span) {
  /** @type {Awaited<ReturnType<typeof loadLatestFileCatalogMetadata>>} */
  let loaded
  try {
    loaded = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  } catch (err) {
    if (isMissingTableError(err)) {
      return { compacted: false, reason: 'no-table', dataFilesBefore: 0, dataFilesAfter: 0 }
    }
    return {
      compacted: false,
      reason: 'error',
      error: describeError(err),
      dataFilesBefore: 0,
      dataFilesAfter: 0,
    }
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
  //
  // The stage phase itself writes data files, a manifest, and a
  // manifest list one by one, and icebird only reports `writtenFiles`
  // on a StagedUpdate that completed. A failure after the first
  // write would leak everything written before it. Track every path
  // whose write finished through a wrapped resolver and reclaim them
  // when staging dies mid-flight.
  /** @type {string[]} */
  const stagedPaths = []
  // `Resolver.writer` is optional; a resolver without one can't stage
  // anything, so there's nothing to track. Let icebergStageRewrite
  // surface its own failure through the catch below.
  const baseWriter = resolver.writer
  /** @type {Resolver} */
  const trackingResolver = baseWriter === undefined ? resolver : {
    ...resolver,
    writer(url, options) {
      const writer = baseWriter(url, options)
      const finish = writer.finish.bind(writer)
      writer.finish = async () => {
        await finish()
        stagedPaths.push(url)
      }
      return writer
    },
  }
  /** @type {Awaited<ReturnType<typeof icebergStageRewrite>>} */
  let staged
  try {
    staged = await icebergStageRewrite({ tableUrl, metadata, resolver: trackingResolver })
  } catch (err) {
    span.setAttribute('staged_files_reclaimed', stagedPaths.length)
    await deleteFilesBestEffort(resolver, stagedPaths)
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
    // The thrown error alone cannot prove the commit missed: a timeout
    // after the conditional PUT durably landed, or an SDK-internal
    // retry of its own successful write surfacing 412, both leave the
    // staged rewrite committed and referencing the files this catch
    // would delete. Re-load and check before any cleanup.
    /** @type {'landed' | 'lost' | 'unknown'} */
    let outcome = 'unknown'
    /** @type {TableMetadata | undefined} */
    let postMetadata
    try {
      const reloaded = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
      const stagedId = staged.snapshot['snapshot-id']
      const present = (reloaded.metadata.snapshots ?? []).some(
        (s) => String(s['snapshot-id']) === String(stagedId)
      )
      outcome = present ? 'landed' : 'lost'
      postMetadata = reloaded.metadata
    } catch {
      // Reload failed: the commit outcome is unverifiable. Fall through
      // to the conservative no-delete path below.
    }
    span.setAttribute('commit_outcome', outcome)
    if (outcome === 'landed' && postMetadata) {
      return { compacted: true, dataFilesBefore, dataFilesAfter: currentDataFileCount(postMetadata) }
    }
    // A 412 means the conditional write was rejected, so once the reload
    // confirms the staged snapshot is absent the staged files are safe
    // to reclaim. Any other shape (network error, reload failure) could
    // still be an in-flight commit: leave the bounded orphans rather
    // than risk deleting data files a landed commit references.
    if (outcome === 'lost' && isCommitConflict(err)) {
      span.setAttribute('staged_files_reclaimed', staged.writtenFiles.length)
      await deleteFilesBestEffort(resolver, staged.writtenFiles)
      return {
        compacted: false,
        reason: 'conflict',
        error: describeError(err),
        dataFilesBefore,
        dataFilesAfter: dataFilesBefore,
      }
    }
    return {
      compacted: false,
      reason: 'error',
      error:
        `${describeError(err)}; commit outcome unverified - ` +
        `${staged.writtenFiles.length} staged rewrite file(s) left under the table ` +
        '(deleting them could corrupt the table if the commit actually landed)',
      dataFilesBefore,
      dataFilesAfter: dataFilesBefore,
    }
  }
}

/**
 * Best-effort reclamation of staged rewrite output. Failures are
 * swallowed: the caller is already on an error path and a stuck delete
 * must not mask the original failure.
 *
 * @param {Resolver} resolver
 * @param {string[]} paths
 */
async function deleteFilesBestEffort(resolver, paths) {
  if (!resolver.deleter || paths.length === 0) return
  const { deleter } = resolver
  await Promise.allSettled(paths.map((p) => deleter(p)))
}

/**
 * True when a metadata-load failure means "this table does not exist"
 * rather than "the load itself failed". Local-fs surfaces a missing
 * table as ENOENT; a blob lister returns an empty listing for a
 * missing prefix, which icebird reports as 'no metadata files found'.
 * Anything else (auth, corrupt metadata, transient IO) must NOT fold
 * into `no-table`: the CLI exits 0 for a missing table but nonzero
 * for a failed load.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissingTableError(err) {
  if (!err || typeof err !== 'object') return false
  const record = /** @type {Record<string, unknown>} */ (err)
  if (record.code === 'ENOENT' || record.code === 'NoSuchKey') return true
  return err instanceof Error && err.message.includes('no metadata files found')
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
 * expiration per dataset, plus (only when `compact` is set) the
 * out-of-band data-file rewrite ({@link compactExportTable}).
 *
 * @ref LLP 0022#compaction: `compact` defaults to false; the daemon
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
