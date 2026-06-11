// @ts-check

import {
  fileCatalog,
  icebergExpireSnapshots,
  icebergRewrite,
  loadLatestFileCatalogMetadata,
} from 'icebird'

import { SNAPSHOT_RETENTION_DEFAULTS } from '../../../../src/core/cache/maintenance.js'
import { createBlobStoreIO, tableUrlForBlobPrefix } from './blob-io.js'

/**
 * @import { BlobStore } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { Resolver, Lister, TableMetadata } from 'icebird/src/types.js'
 * @import { ExportRetentionConfig, ExportMaintenanceDatasetReport, ExportMaintenanceReport } from './types.d.ts'
 */

/** @type {ExportRetentionConfig} */
const DEFAULTS = Object.freeze({
  ...SNAPSHOT_RETENTION_DEFAULTS,
  // Mirrors the local-cache `compact_file_count` trigger: rewrite once a
  // table's live data-file count crosses this threshold.
  compact_file_count: 32,
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
 * already large, so most tables never reach the threshold.
 *
 * A rewrite commit is intentionally NOT retried on a concurrent-commit
 * conflict: it only rewrote the rows it read, so a blind retry could drop
 * rows another writer appended in the meantime. On conflict we report
 * `compacted: false` and let the next manual run start from fresh
 * metadata.
 *
 * @param {{
 *   tableUrl: string
 *   resolver: Resolver
 *   lister: Lister
 *   compactFileCount: number
 *   dryRun?: boolean
 * }} opts
 * @returns {Promise<{ compacted: boolean, dataFilesBefore: number, dataFilesAfter: number }>}
 */
export async function compactExportTable({ tableUrl, resolver, lister, compactFileCount, dryRun }) {
  /** @type {TableMetadata} */
  let metadata
  try {
    const loaded = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
    metadata = loaded.metadata
  } catch {
    return { compacted: false, dataFilesBefore: 0, dataFilesAfter: 0 }
  }

  const dataFilesBefore = currentDataFileCount(metadata)
  if (dataFilesBefore < compactFileCount) {
    return { compacted: false, dataFilesBefore, dataFilesAfter: dataFilesBefore }
  }
  if (dryRun) {
    return { compacted: true, dataFilesBefore, dataFilesAfter: dataFilesBefore }
  }

  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })
  try {
    const post = await icebergRewrite({ catalog, tableUrl, resolver })
    return { compacted: true, dataFilesBefore, dataFilesAfter: currentDataFileCount(post) }
  } catch {
    return { compacted: false, dataFilesBefore, dataFilesAfter: dataFilesBefore }
  }
}

/**
 * Live data-file count from the current snapshot's summary.
 *
 * @param {TableMetadata} metadata
 * @returns {number}
 */
function currentDataFileCount(metadata) {
  const currentId = metadata['current-snapshot-id']
  if (currentId === undefined) return 0
  const snapshot = metadata.snapshots?.find((s) => String(s['snapshot-id']) === String(currentId))
  const raw = snapshot?.summary?.['total-data-files']
  const value = raw === undefined ? 0 : Number(raw)
  return Number.isFinite(value) ? value : 0
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
        dryRun,
      })
      report.compacted = compaction.compacted
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
