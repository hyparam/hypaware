// @ts-check

import {
  fileCatalog,
  icebergExpireSnapshots,
  loadLatestFileCatalogMetadata,
} from 'icebird'

import { SNAPSHOT_RETENTION_DEFAULTS } from '../../../../src/core/cache/maintenance.js'
import { createBlobStoreIO, tableUrlForBlobPrefix } from './blob-io.js'

/**
 * @import { BlobStore } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { Resolver, Lister, TableMetadata } from 'icebird/src/types.js'
 */

/**
 * @typedef {{
 *   min_snapshots_to_keep: number
 *   max_snapshot_age_hours: number
 * }} ExportRetentionConfig
 *
 * @typedef {{
 *   dataset: string
 *   snapshotsExpired: number
 *   snapshotsBefore: number
 *   compactionSupported: false
 * }} ExportMaintenanceDatasetReport
 *
 * @typedef {{
 *   datasets: ExportMaintenanceDatasetReport[]
 *   totalSnapshotsExpired: number
 *   compactionSupported: false
 *   dryRun: boolean
 *   elapsedMs: number
 * }} ExportMaintenanceReport
 */

/** @type {ExportRetentionConfig} */
const DEFAULTS = SNAPSHOT_RETENTION_DEFAULTS

/**
 * @param {Partial<ExportRetentionConfig> | undefined} config
 * @returns {ExportRetentionConfig}
 */
export function normalizeExportRetentionConfig(config) {
  return {
    min_snapshots_to_keep: config?.min_snapshots_to_keep ?? DEFAULTS.min_snapshots_to_keep,
    max_snapshot_age_hours: config?.max_snapshot_age_hours ?? DEFAULTS.max_snapshot_age_hours,
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
 * Run export maintenance on all datasets under a prefix: snapshot
 * expiration per dataset, plus a compaction status report.
 *
 * icebird V1 does not expose `rewrite-data-files` or `delete-data-files`,
 * so compaction is not supported.  The report signals
 * `compactionSupported: false` so the CLI can surface a clear message.
 *
 * @param {{
 *   blobStore: BlobStore
 *   prefix: string
 *   datasets?: string[]
 *   config?: Partial<ExportRetentionConfig>
 *   dryRun?: boolean
 * }} opts
 * @returns {Promise<ExportMaintenanceReport>}
 */
export async function maintainExportTables(opts) {
  const startMs = Date.now()
  const cfg = normalizeExportRetentionConfig(opts.config)
  const dryRun = opts.dryRun ?? false

  const datasets = opts.datasets ?? await discoverExportDatasets(opts.blobStore, opts.prefix)
  const { resolver, lister } = await createBlobStoreIO(opts.blobStore)

  /** @type {ExportMaintenanceDatasetReport[]} */
  const reports = []
  let totalSnapshotsExpired = 0

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
    reports.push({
      dataset,
      snapshotsExpired: result.expired,
      snapshotsBefore: result.snapshotsBefore,
      compactionSupported: false,
    })
  }

  return {
    datasets: reports,
    totalSnapshotsExpired,
    compactionSupported: false,
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
