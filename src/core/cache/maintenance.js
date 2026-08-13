// @ts-check

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

import {
  fileCatalog,
  icebergExpireSnapshots,
  loadLatestFileCatalogMetadata,
} from 'icebird'

import { Attr, getActiveSpan, getMeter, withSpan } from '../observability/index.js'
import { inferColumnType } from './migrate.js'
import { discoverCachePartitions, readCursorSync, tryReadCursorSync, writeCursor } from './partition.js'
import { datasetsRoot } from './paths.js'
import { createLocalIcebergIO, tableUrlForDir } from './iceberg/resolver.js'
import { columnsFromIcebergSchema } from './iceberg/schema.js'
import { appendRowsToTable, currentPartitionSpec, currentSchema, scanRowsFromTable, sortColumnsFromMetadata, tableExists } from './iceberg/store.js'
import { openStreamingAppend } from './iceberg/stream_append.js'
import { isPlainObject } from '../util/json_util.js'

/**
 * @import {
 *   CacheStatusPartition,
 *   CacheStatusReport,
 *   MaintenanceConfig,
 *   MaintenanceOptions,
 *   MaintenancePartitionReport,
 *   MaintenanceReport,
 *   PartitionCursor,
 *   AppendOptions,
 *   SettleContext,
 *   StreamingTableAppend,
 * } from '../../../src/core/cache/types.js'
 * @import { ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 * @import { PartitionSpec, TableMetadata } from 'icebird/src/types.js'
 * @import { Dirent } from 'node:fs'
 */

export const SNAPSHOT_RETENTION_DEFAULTS = Object.freeze({
  min_snapshots_to_keep: 10,
  max_snapshot_age_hours: 24,
})

/** @type {MaintenanceConfig} */
const DEFAULTS = {
  enabled: true,
  interval_minutes: 60,
  target_file_bytes: 128 * 1024 * 1024,
  ...SNAPSHOT_RETENTION_DEFAULTS,
  compact_file_count: 32,
  compact_avg_file_bytes: 32 * 1024 * 1024,
  compact_batch_bytes: 32 * 1024 * 1024,
  max_tick_ms: 30_000,
}

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000

/**
 * How long an unreferenced (cursor-orphaned) table generation must sit
 * untouched before the orphan sweep reclaims it. Long enough that an
 * in-flight compaction writing a new generation is never mistaken for
 * garbage; short enough that a crashed compaction's leak is reclaimed
 * on the next maintenance tick that finds it stale.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000

/**
 * Which compaction writer produced the outcome a cursor records.
 *
 * Bump this when the rewrite gains the ability to shrink a partition it
 * previously could not: a recorded "this rewrite achieved nothing"
 * verdict is only binding for the writer that reached it, so a bump is
 * what buys every frozen partition one honest retry.
 *
 * 1 - one output file per flushed batch (before LLP 0209). A 32 MB
 *     in-memory batch landed as a ~200 KB file, so a rewrite reproduced
 *     the file count it started with.
 * 2 - row groups stream into a file that closes on bytes written
 *     (LLP 0209#row-groups), so a rewrite converges toward
 *     `target_file_bytes` per partition tuple.
 *
 * Cursors written before this field existed carry no generation and are
 * therefore never equal to the running one, which is the correct reading:
 * their verdict was reached by a writer this build cannot identify.
 *
 * @ref LLP 0217#retry-on-writer-change [implements]: the stamp that makes an ineffective verdict retryable exactly once.
 */
const COMPACTION_WRITER_GENERATION = 2

/**
 * @param {Partial<MaintenanceConfig> | undefined} config
 * @returns {MaintenanceConfig}
 */
export function normalizeMaintenanceConfig(config) {
  return {
    enabled: config?.enabled ?? DEFAULTS.enabled,
    interval_minutes: config?.interval_minutes ?? DEFAULTS.interval_minutes,
    target_file_bytes: config?.target_file_bytes ?? DEFAULTS.target_file_bytes,
    min_snapshots_to_keep: config?.min_snapshots_to_keep ?? DEFAULTS.min_snapshots_to_keep,
    max_snapshot_age_hours: config?.max_snapshot_age_hours ?? DEFAULTS.max_snapshot_age_hours,
    compact_file_count: config?.compact_file_count ?? DEFAULTS.compact_file_count,
    compact_avg_file_bytes: config?.compact_avg_file_bytes ?? DEFAULTS.compact_avg_file_bytes,
    compact_batch_bytes: config?.compact_batch_bytes ?? DEFAULTS.compact_batch_bytes,
    max_tick_ms: config?.max_tick_ms ?? DEFAULTS.max_tick_ms,
  }
}

/**
 * Run cache maintenance: snapshot expiration and compaction.
 *
 * @param {MaintenanceOptions} opts
 * @returns {Promise<MaintenanceReport>}
 */
export async function maintainCache(opts) {
  const cfg = normalizeMaintenanceConfig(opts.config)
  const startMs = Date.now()
  const budgetMs = opts.budgetMs ?? Infinity
  const meter = getMeter('cache')
  const snapshotsExpiredCounter = meter.createCounter('hyp_snapshots_expired', {
    description: 'Iceberg snapshots expired by maintenance',
  })
  const compactionsCounter = meter.createCounter('hyp_compactions', {
    description: 'Partitions compacted by maintenance',
  })
  const rebaselinesCounter = meter.createCounter('hyp_rebaselines', {
    description: 'Partitions recognized as foreign-sorted-replace converged and rebaselined without a rewrite',
  })

  const scope = opts.dataset ? { datasets: [opts.dataset] } : {}
  const discovered = await discoverCachePartitions(opts.cacheRoot, scope)
  // @ref LLP 0199#neediest-first [implements]: walk partitions in descending
  // live data-file order, so a max_tick_ms cutoff postpones the healthiest
  // partitions instead of starving the same directory-order tail every tick.
  const partitions = discovered
    .map((part) => ({ part, liveFiles: liveDataFileCount(part.path) }))
    .sort((a, b) => b.liveFiles - a.liveFiles)
    .map((entry) => entry.part)

  /** @type {MaintenancePartitionReport[]} */
  const reports = []
  let totalSnapshotsExpired = 0
  let totalCompacted = 0
  let totalRebaselined = 0

  for (const part of partitions) {
    // Always work one partition before the budget can cut the tick short:
    // the ranking pass above is itself unbudgeted, so on a large enough
    // cache a bare cutoff here would break at iteration 0 every tick and
    // maintenance would never run at all.
    if (reports.length > 0 && Date.now() - startMs > budgetMs) break

    const report = await withSpan(
      'maintenance.partition',
      {
        [Attr.COMPONENT]: 'cache',
        [Attr.OPERATION]: 'maintenance.partition',
        [Attr.DATASET]: part.dataset,
        partition: JSON.stringify(part.partition),
        status: 'ok',
      },
      async (span) => {
        /** @type {MaintenancePartitionReport} */
        const r = {
          dataset: part.dataset,
          partition: part.partition,
          path: part.path,
          snapshotsExpired: 0,
          compacted: false,
          rowCount: part.rowCount,
          dataFilesBefore: 0,
          dataFilesAfter: 0,
        }

        const cursor = readCursorSync(part.path)
        const settle = resolveSettleContext(opts, part.dataset)

        const done = await maintainGeneration(
          r, cursor, cfg, opts, settle, snapshotsExpiredCounter, compactionsCounter, rebaselinesCounter
        )
        // A compaction that "converged" is only healthy if it also shrank
        // the file count; publish both sides of that so a run that rewrites
        // a partition into the same fragmentation is visible in the trace
        // rather than only in a later disk audit.
        span.setAttribute('compacted', done.compacted)
        span.setAttribute('data_files_before', done.dataFilesBefore)
        span.setAttribute('data_files_after', done.dataFilesAfter)
        span.setAttribute('rows', done.rowCount)
        if (done.compactedBytesWritten !== undefined) {
          span.setAttribute('bytes_written', done.compactedBytesWritten)
        }
        return done
      },
      { component: 'cache' }
    )
    reports.push(report)
    totalSnapshotsExpired += report.snapshotsExpired
    if (report.compacted) totalCompacted++
    if (report.rebaselined) totalRebaselined++
  }

  if (!opts.dryRun) {
    await cleanRetiredEpochs(opts.cacheRoot)
  }

  return {
    partitions: reports,
    totalSnapshotsExpired,
    totalCompacted,
    totalRebaselined,
    dryRun: opts.dryRun ?? false,
    elapsedMs: Date.now() - startMs,
  }
}

/**
 * The five spots where the source-table and legacy epoch layouts differ.
 * Everything else in maintenance, compaction, and status is
 * layout-agnostic and shares one code path.
 *
 * @typedef {object} GenerationLayout
 * @property {'source-table' | 'epoch'} kind
 * @property {string} liveDir  name of the generation dir the cursor points at
 * @property {() => string} nextDirName  fresh name for the replacement generation
 * @property {boolean} commitEmpty  commit a rewrite that found no columns (source-table) or abort it (legacy)
 * @property {number} [newEpoch]  epoch the legacy layout advances to, reported after compaction
 * @property {(nextDir: string, rowCount: number, outcome: { dataFilesBefore: number, dataFilesAfter: number }) => PartitionCursor} cursorAfter  cursor to write once the generation swap commits
 */

/**
 * @param {PartitionCursor} cursor
 * @returns {GenerationLayout}
 */
function generationLayout(cursor) {
  if (cursor.layout === 'source-table') {
    const liveDir = cursor.tableDir ?? 'table'
    return {
      kind: 'source-table',
      liveDir,
      // Iceberg metadata stores absolute `file://` URLs, so a rewrite
      // cannot rename directories after writing: pick a fresh name and
      // point the cursor at it.
      nextDirName: () => `table-${Date.now()}`,
      commitEmpty: true,
      cursorAfter: (nextDir, rowCount, outcome) => ({
        epoch: cursor.epoch,
        rowCount,
        compaction: {
          previousTableDir: liveDir,
          compactedAt: new Date().toISOString(),
          ...compactionOutcomeRecord(outcome),
        },
        layout: 'source-table',
        tableDir: nextDir,
        retention: cursor.retention,
      }),
    }
  }
  const newEpoch = cursor.epoch + 1
  return {
    kind: 'epoch',
    liveDir: `epoch=${cursor.epoch}`,
    nextDirName: () => `epoch=${newEpoch}`,
    commitEmpty: false,
    newEpoch,
    cursorAfter: (_nextDir, rowCount, outcome) => ({
      epoch: newEpoch,
      rowCount,
      compaction: {
        previousEpoch: cursor.epoch,
        compactedAt: new Date().toISOString(),
        ...compactionOutcomeRecord(outcome),
      },
    }),
  }
}

/**
 * Maintain one partition generation: expire snapshots and compact into
 * a fresh generation directory when due. Layout differences live in
 * {@link generationLayout}.
 *
 * @param {MaintenancePartitionReport} r
 * @param {PartitionCursor} cursor
 * @param {MaintenanceConfig} cfg
 * @param {MaintenanceOptions} opts
 * @param {SettleContext | null} settle
 * @param {{ add(value: number, attributes?: Record<string, unknown>): void }} snapshotsExpiredCounter
 * @param {{ add(value: number, attributes?: Record<string, unknown>): void }} compactionsCounter
 * @param {{ add(value: number, attributes?: Record<string, unknown>): void }} rebaselinesCounter
 * @returns {Promise<MaintenancePartitionReport>}
 */
async function maintainGeneration(r, cursor, cfg, opts, settle, snapshotsExpiredCounter, compactionsCounter, rebaselinesCounter) {
  const layout = generationLayout(cursor)
  const liveDir = path.join(r.path, layout.liveDir)
  if (!tableExists(liveDir)) return r

  const dataFilesBefore = countDataFiles(liveDir)
  r.dataFilesBefore = dataFilesBefore
  r.dataFilesAfter = dataFilesBefore

  if (!opts.compactOnly) {
    const expired = await expireSnapshots(liveDir, cfg, opts)
    r.snapshotsExpired = expired
    if (expired > 0) {
      snapshotsExpiredCounter.add(expired, { [Attr.DATASET]: r.dataset })
    }
  }

  if (!opts.expireOnly) {
    // @ref LLP 0199#baseline-gate [implements]: a live data-file count still
    // sitting on the post-rewrite baseline means nothing has flushed since
    // the last compaction, so a rewrite would reproduce the same generation.
    // Without this gate the avg-file-size heuristic re-flags every compacted
    // partition forever (rewritten files come out far smaller than
    // compact_avg_file_bytes), and the tick budget is burned rewriting the
    // same partitions while the rest of the walk starves.
    const grewSinceCompaction = dataFilesBefore !== resettleBaselineFiles(cursor)
    // @ref LLP 0217#retry-on-writer-change [implements]: the gate above
    // reads "live count equals baseline" as convergence, which holds only
    // while the writer that produced that baseline is the one running. A
    // partition whose recorded rewrite achieved no reduction (or whose
    // cursor predates the record) is owed one attempt under a new writer
    // generation, or a partition frozen at 1,521 files by a writer that
    // could not shrink it stays frozen after the writer is fixed (#723).
    const verdictStale = !grewSinceCompaction && compactionVerdictStale(cursor)
    // Cheap dueness check first: file-count and byte-size heuristics only,
    // no metadata load and no row scan. A foreign sorted replace almost
    // always lands here (its baseline mismatch alone doesn't imply the
    // size heuristics fire), so gating the expensive re-settle scan behind
    // this check means the common "recognized, nothing to scan for" tick
    // never pays for one.
    const compactionDue = opts.force || ((grewSinceCompaction || verdictStale) && needsCompaction(liveDir, cfg))
    // @ref LLP 0027#re-settle-sweep: a partition holding a committed
    // fallback row may carry a split twin pair the flush-time settle
    // never collapsed; force a rewrite so the sweep can re-settle it even
    // when the file-count heuristics say compaction isn't due. Sharing the
    // baseline gate keeps an unmatchable fallback: one whose transcript
    // line never lands (harness aux, wire-only reminders) - from forcing a
    // full rewrite every tick, and skips the attributes scan entirely when
    // nothing new has flushed.
    // @ref LLP 0207#outranks-resettle [constrained-by]: when the cheap check
    // above already made compaction due, the scan's answer can never
    // change the outcome (recognition, tested below, still outranks it),
    // so skip it: only run the scan when it might be the sole reason to
    // compact.
    const hasResettle = !compactionDue && settle
      ? grewSinceCompaction && await hasResettleCandidate(liveDir)
      : false
    const shouldCompact = compactionDue || hasResettle
    if (!shouldCompact && compactionKnownIneffective(cursor)) {
      // Skipped for a stated reason rather than by the baseline
      // coincidence: this writer has already rewritten this partition and
      // produced the same fragmentation. Read from the cursor, so saying
      // so costs nothing; re-checking `needsCompaction` here would stat
      // every data file of every converged partition, every tick.
      r.compactionIneffective = true
      getActiveSpan()?.setAttribute('compaction_ineffective', true)
    }
    if (shouldCompact) {
      const tableInfo = await loadCompactionTableInfo(liveDir)
      // @ref LLP 0207#foreign-replace [implements]: a baseline mismatch whose
      // current snapshot is a `replace` committed under the table's declared
      // default sort order is a foreign sorted rewrite (the server's
      // export-time day compaction), not growth. Rewriting it would shred
      // the sorted big-file layout back into per-batch files, so record the
      // live count as the new baseline and skip. Recognition outranks the
      // re-settle force: a leftover unmatchable fallback row must not undo
      // the sorted layout every night. An explicit --force still rewrites.
      if (!opts.force && foreignSortedReplace(tableInfo)) {
        r.rebaselined = true
        // The counter proves a rebaseline happened at all, but it carries
        // only the dataset; tagging the enclosing maintenance.partition span
        // names the partition, so a trace query finds which day re-baselined
        // without cross-referencing the counter.
        getActiveSpan()?.setAttribute('rebaselined', true)
        if (!opts.dryRun) {
          await writeCursor(r.path, rebaselineCursor(cursor, dataFilesBefore))
          rebaselinesCounter.add(1, { [Attr.DATASET]: r.dataset })
        }
      } else if (opts.dryRun) {
        r.compacted = true
      } else {
        const result = await compactGeneration(r.path, layout, cfg, settle, tableInfo)
        if (result) {
          r.compacted = true
          if (result.newEpoch !== undefined) r.newEpoch = result.newEpoch
          r.rowCount = result.rowCount
          r.dataFilesAfter = result.dataFiles
          r.compactedBytesWritten = result.bytesWritten
          // @ref LLP 0217#record-effectiveness [implements]: a rewrite that
          // reproduced its own file count reports that, so the run is
          // legible as work that achieved nothing instead of surfacing
          // only as a later disk audit.
          if (result.dataFilesBefore > 0 && result.dataFiles >= result.dataFilesBefore) {
            r.compactionIneffective = true
          }
          compactionsCounter.add(1, { [Attr.DATASET]: r.dataset })
        }
      }
    }
  }

  return r
}

/**
 * Collect status information about cache partitions.
 *
 * @param {{ cacheRoot: string }} opts
 * @returns {Promise<CacheStatusReport>}
 */
export async function cacheStatus({ cacheRoot }) {
  const partitions = await discoverCachePartitions(cacheRoot)
  let pendingSpoolBytes = 0
  /** @type {CacheStatusPartition[]} */
  const statusPartitions = []

  for (const part of partitions) {
    const cursor = readCursorSync(part.path)
    const spoolDir = path.join(part.path, '_hypaware_spool')
    pendingSpoolBytes += measureDir(spoolDir)

    const layout = generationLayout(cursor)
    const liveDir = path.join(part.path, layout.liveDir)

    /** @type {CacheStatusPartition} */
    const status = {
      dataset: part.dataset,
      partition: part.partition,
      epoch: cursor.epoch,
      rowCount: part.rowCount,
      dataFileCount: countDataFiles(liveDir),
      metadataBytes: measureMetadataDir(liveDir),
      snapshotCount: countSnapshots(liveDir),
    }
    if (layout.kind === 'source-table') {
      status.source = part.partition.source
      status.deleteFileCount = countDeleteFiles(liveDir)
      status.lastRetentionCutoffDate = cursor.retention?.lastCutoffDate
      status.layout = 'source-table'
    } else {
      status.layout = cursor.epoch > 0 || cursor.rowCount > 0 ? 'epoch' : undefined
    }
    statusPartitions.push(status)
  }

  return { cacheRoot, pendingSpoolBytes, partitions: statusPartitions }
}

/**
 * @param {string} tableDir
 * @param {MaintenanceConfig} cfg
 * @param {MaintenanceOptions} opts
 * @returns {Promise<number>}
 */
async function expireSnapshots(tableDir, cfg, opts) {
  if (!tableExists(tableDir)) return 0
  const url = tableUrlForDir(tableDir)
  const { resolver, lister } = await createLocalIcebergIO()

  /** @type {TableMetadata} */
  let metadata
  try {
    const loaded = await loadLatestFileCatalogMetadata({ tableUrl: url, resolver, lister })
    metadata = loaded.metadata
  } catch {
    return 0
  }

  const snapshots = metadata.snapshots ?? []
  if (snapshots.length <= cfg.min_snapshots_to_keep) return 0

  const currentId = metadata['current-snapshot-id']
  const cutoffMs = Date.now() - cfg.max_snapshot_age_hours * 60 * 60 * 1000

  const sorted = [...snapshots].sort((a, b) => b['timestamp-ms'] - a['timestamp-ms'])
  /** @type {number[]} */
  const toExpire = []
  for (let i = 0; i < sorted.length; i++) {
    const snap = sorted[i]
    const id = snap['snapshot-id']
    if (currentId !== undefined && BigInt(id) === BigInt(currentId)) continue
    if (i < cfg.min_snapshots_to_keep) continue
    if (snap['timestamp-ms'] >= cutoffMs) continue
    toExpire.push(Number(id))
  }

  if (toExpire.length === 0) return 0
  if (opts.dryRun) return toExpire.length

  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })
  try {
    await icebergExpireSnapshots({ catalog, tableUrl: url, snapshotIds: toExpire })
  } catch {
    return 0
  }
  return toExpire.length
}

/**
 * @param {string} tableDir
 * @param {MaintenanceConfig} cfg
 * @returns {boolean}
 */
function needsCompaction(tableDir, cfg) {
  const dataFiles = countDataFiles(tableDir)
  if (dataFiles > cfg.compact_file_count) return true

  const totalDataBytes = measureDataDir(tableDir)
  if (dataFiles > 0 && totalDataBytes / dataFiles < cfg.compact_avg_file_bytes) return true

  const metadataBytes = measureMetadataDir(tableDir)
  if (metadataBytes > 64 * 1024 * 1024) return true

  return false
}

/**
 * Load the live table metadata that the compaction decision and the
 * rewrite share: the current schema and partition spec (carried into the
 * replacement generation), the declared default sort order, and the raw
 * metadata for snapshot inspection. Loaded once per compaction-due
 * partition; null when the metadata is unreadable, in which case the
 * rewrite falls back to inferring the schema from scanned rows.
 *
 * @param {string} tableDir
 * @returns {Promise<{
 *   metadata: TableMetadata,
 *   schemaColumns: ColumnSpec[] | null,
 *   partitionSpec: PartitionSpec | undefined,
 *   sortColumns: { column: string, direction: 'asc' | 'desc' }[] | undefined,
 * } | null>}
 */
async function loadCompactionTableInfo(tableDir) {
  try {
    const { resolver, lister } = await createLocalIcebergIO()
    const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: tableUrlForDir(tableDir), resolver, lister })
    const schema = currentSchema(metadata)
    return {
      metadata,
      schemaColumns: schema ? columnsFromIcebergSchema(schema) : null,
      partitionSpec: currentPartitionSpec(metadata),
      sortColumns: sortColumnsFromMetadata(metadata),
    }
  } catch {
    return null
  }
}

/**
 * Is the table's current snapshot a `replace` committed under its
 * declared default sort order? That combination identifies a deliberate
 * foreign sorted rewrite (the central server's export-time day
 * compaction commits exactly this shape), and the `replace` still being
 * current means nothing has been appended since - a later append flips
 * the current snapshot's operation and makes the partition genuinely
 * due again. A replace on a table with no declared sort order is not
 * blessed: only a rewrite that carries the layout declaration counts as
 * convergence.
 *
 * @ref LLP 0207#foreign-replace [implements]: the recognition test, the
 * kernel-side mirror of the server day compactor's alreadyCompacted +
 * sortOrderDeclared skip.
 * @param {Awaited<ReturnType<typeof loadCompactionTableInfo>>} tableInfo
 * @returns {boolean}
 */
function foreignSortedReplace(tableInfo) {
  if (!tableInfo?.sortColumns?.length) return false
  const { metadata } = tableInfo
  const currentId = metadata['current-snapshot-id']
  if (currentId === undefined || currentId === null || Number(currentId) === -1) return false
  const snapshot = (metadata.snapshots ?? []).find((s) => BigInt(s['snapshot-id']) === BigInt(currentId))
  return snapshot?.summary?.operation === 'replace'
}

const COMPACT_BATCH_SIZE = 10_000

/**
 * Cheap, allocation-free estimate of a row's in-memory footprint in
 * bytes. Used only to bound how much a compaction batch accumulates
 * before flushing, so precision matters less than never under-counting
 * a fat blob. Walks nested structures without building strings.
 *
 * @param {unknown} value
 * @returns {number}
 */
function estimateValueBytes(value) {
  if (value === null || value === undefined) return 0
  switch (typeof value) {
    case 'string':
      // JS strings are UTF-16 internally; 2 bytes/char is the honest upper bound.
      return value.length * 2
    case 'number':
      return 8
    case 'bigint':
      return 16
    case 'boolean':
      return 4
    case 'object': {
      if (value instanceof Date) return 8
      if (value instanceof Uint8Array) return value.byteLength
      let total = 0
      if (Array.isArray(value)) {
        for (const item of value) total += estimateValueBytes(item)
        return total
      }
      for (const [k, v] of Object.entries(value)) {
        total += k.length * 2 + estimateValueBytes(v)
      }
      return total
    }
    default:
      return 0
  }
}

/**
 * @param {Record<string, unknown>} row
 * @returns {number}
 */
function estimateRowBytes(row) {
  let total = 0
  for (const value of Object.values(row)) total += estimateValueBytes(value)
  return total
}

/**
 * Compact a partition by rewriting the live generation into a fresh
 * directory named by the layout, then swap the cursor to point at it.
 *
 * Rows are flushed out of the batch whenever it reaches either
 * `COMPACT_BATCH_SIZE` rows or `cfg.compact_batch_bytes` estimated
 * bytes, whichever comes first. The byte cap keeps peak heap bounded
 * regardless of per-row payload size: without it, a fat denormalized
 * column (e.g. tool definitions repeated on every row) pushes a
 * 10k-row batch into the gigabytes and OOMs the daemon mid-compaction.
 *
 * A flush is a parquet ROW GROUP, not a data file. Successive row groups
 * stream into the same open file until the bytes actually written reach
 * `cfg.target_file_bytes`. Tying the file boundary to the in-memory
 * estimate instead made every flush its own file, and a column that
 * compresses 70x turned a 32 MB batch into a 0.5 MB data file, so
 * `target_file_bytes` was unreachable by construction (LLP 0209).
 *
 * Holding a file open is not free: peak heap is the batch, plus one row
 * group of encoded bytes, PLUS the row-group metadata every open parquet
 * writer pins until its footer is written (two raw column values per row
 * group per column). That third term grows with `target_file_bytes`, so
 * `openStreamingAppend` budgets it and rolls a file early when it binds
 * before the byte target does.
 *
 * @ref LLP 0209#decision [implements]: heap bounds the batch, written
 *   bytes bound the file.
 * @ref LLP 0209#retained-metadata [constrained-by]: a bigger file target
 *   costs retained row-group metadata, which is separately bounded.
 * @param {string} partitionDir
 * @param {GenerationLayout} layout
 * @param {MaintenanceConfig} cfg
 * @param {SettleContext | null} [settle]
 * @param {Awaited<ReturnType<typeof loadCompactionTableInfo>>} [tableInfo]  metadata bundle loaded by the caller; null falls back to schema inference
 * @returns {Promise<{ newEpoch?: number, rowCount: number, dataFilesBefore: number, dataFiles: number, bytesWritten?: number } | null>}
 */
async function compactGeneration(partitionDir, layout, cfg, settle, tableInfo) {
  const oldDir = path.join(partitionDir, layout.liveDir)
  if (!tableExists(oldDir)) return null

  // Counted here rather than taken from the caller: this is the count the
  // rewrite about to run is measured against, and it goes into the cursor
  // beside the count that rewrite produces.
  const dataFilesBefore = countDataFiles(oldDir)

  const existingSpec = tableInfo?.partitionSpec
  const schemaColumns = tableInfo?.schemaColumns ?? null
  // Carry the table's declared sort order into the replacement
  // generation, or the swap would silently drop it.
  const sortColumns = tableInfo?.sortColumns

  const newDirName = layout.nextDirName()
  const newDir = path.join(partitionDir, newDirName)

  const seen = new Set()
  /** @type {ColumnSpec[] | null} */
  let columns = schemaColumns
  /** @type {Record<string, unknown>[]} */
  let batch = []
  let batchBytes = 0
  let totalRows = 0
  const maxBatchBytes = cfg.compact_batch_bytes
  /** @type {AppendOptions | undefined} */
  const appendOpts = existingSpec || sortColumns
    ? { partitionSpec: existingSpec, sortOrder: sortColumns }
    : undefined

  // Buffer committed fallback rows so the re-settle sweep can upgrade them
  // after the full partition has been seen (a fallback row may stream
  // before its native twin). Non-fallback rows emit immediately to keep
  // peak heap bounded: settlement is rare and only touches the buffer.
  /** @type {Record<string, unknown>[]} */
  const fallbackBuffer = []
  const emittedPartIds = settle ? new Set() : null

  /** @type {{ current: StreamingTableAppend | null }} */
  const sink = { current: null }
  const flushBatch = async () => {
    if (!columns || batch.length === 0) return
    if (!sink.current) {
      sink.current = await openStreamingAppend({
        tableDir: newDir,
        columns,
        targetFileBytes: cfg.target_file_bytes,
        appendOptions: appendOpts,
      })
    }
    await sink.current.write(batch)
    totalRows += batch.length
    batch = []
    batchBytes = 0
  }

  const emit = async (/** @type {Record<string, unknown>} */ row) => {
    const rowId = row._hyp_cache_row_id
    if (typeof rowId === 'string' && seen.has(rowId)) return
    if (typeof rowId === 'string') seen.add(rowId)
    if (emittedPartIds) {
      const key = rowPartId(row)
      if (key !== undefined) emittedPartIds.add(key)
    }
    batch.push(row)
    batchBytes += estimateRowBytes(row)
    if (columns && (batch.length >= COMPACT_BATCH_SIZE || batchBytes >= maxBatchBytes)) {
      await flushBatch()
    }
  }

  // The sink holds one file descriptor and one `.tmp.*` file per open
  // output file until it is closed. A throw anywhere in the rewrite - a bad
  // row mid-scan, a settle hook, a failed roll - used to leave all of them
  // behind, and maintenance retries the same partition every tick, so a
  // reliably failing partition leaked descriptors until the daemon died.
  /** @type {Awaited<ReturnType<StreamingTableAppend['close']>> | null} */
  let streamed = null
  try {
    for await (const row of scanRowsFromTable(oldDir)) {
      if (!columns) {
        columns = Object.keys(row).map((name) => ({
          name,
          type: inferColumnType(row[name]),
          nullable: true,
        }))
      }
      // @ref LLP 0027#re-settle-sweep: hold provisional fallback rows back.
      // Emit only after the sweep upgrades and de-twins them at end-of-scan.
      if (settle && isGatewayFallbackRow(row)) {
        fallbackBuffer.push(row)
        continue
      }
      await emit(row)
    }

    if (settle && emittedPartIds && fallbackBuffer.length > 0) {
      for (const row of await resettleFallbackRows(fallbackBuffer, settle, emittedPartIds)) {
        await emit(row)
      }
    }

    await flushBatch()
    streamed = sink.current ? await sink.current.close() : null
  } finally {
    // `close` resolving is the only proof every file landed. Anything else,
    // including a `close` that threw part-way, leaves the rest to abort.
    if (!streamed && sink.current) await sink.current.abort()
  }

  if (!columns) {
    if (!layout.commitEmpty) return null
    await writeCursor(partitionDir, layout.cursorAfter(newDirName, 0, { dataFilesBefore, dataFilesAfter: 0 }))
    const retiredMarker = path.join(oldDir, '.retired')
    await fsPromises.writeFile(retiredMarker, new Date().toISOString(), 'utf8')
    return {
      rowCount: 0,
      dataFilesBefore,
      dataFiles: 0,
    }
  }
  if (totalRows === 0) {
    // Keep generation progression deterministic even when dedup filters out all rows.
    await appendRowsToTable(newDir, columns, [], appendOpts)
  }

  // Record the post-rewrite data-file count as the re-settle baseline: the
  // next tick only forces another re-settle sweep once new data flushes past
  // this count, so an unmatchable fallback does not loop (LLP 0027). The
  // pre-rewrite count rides along, so a later tick can tell a rewrite that
  // converged from one that reproduced its own fragmentation (LLP 0217).
  const newDataFiles = countDataFiles(newDir)
  await writeCursor(
    partitionDir,
    layout.cursorAfter(newDirName, totalRows, { dataFilesBefore, dataFilesAfter: newDataFiles })
  )

  const retiredMarker = path.join(oldDir, '.retired')
  await fsPromises.writeFile(retiredMarker, new Date().toISOString(), 'utf8')

  return {
    newEpoch: layout.newEpoch,
    rowCount: totalRows,
    dataFilesBefore,
    dataFiles: newDataFiles,
    bytesWritten: streamed?.bytesWritten ?? 0,
  }
}

/* ----- Re-settle sweep (LLP 0027 "Re-settle sweep") -----
 *
 * Flush-time settlement (LLP 0027 "Decision") only collapses a
 * fallback/uuid twin pair when both rows land in the same flush batch. A
 * fallback row that flushed alone: its transcript line not yet on disk,
 * its uuid twin still in a later flush: commits unsettled, and the flush
 * path can never revisit it. The twins share the Iceberg partition key
 * (`conversation_id`/`cwd`/`date`), so they always live in the SAME
 * partition; a single-partition compaction rewrite is therefore enough to
 * collapse them after the fact. This sweep re-runs the dataset's own
 * `settleBatch` over the committed fallback rows during that rewrite,
 * reusing the exact transcript-match-and-dedupe the flush path uses. */

/**
 * Resolve the per-partition settle context. Returns null unless the
 * caller threaded both a storage handle and a settle hook for this
 * dataset, so every existing maintenance path (CLI, tests) stays a pure
 * compaction with no behavioural change.
 *
 * @ref LLP 0027#re-settle-sweep: compaction-time settle became acceptable
 * once the registry/storage handle is threaded in (LLP 0027 option B's
 * blocker).
 * @param {MaintenanceOptions} opts
 * @param {string} dataset
 * @returns {SettleContext | null}
 */
function resolveSettleContext(opts, dataset) {
  const storage = opts.storage
  const settle = opts.getSettleHook?.(dataset)
  if (!storage || typeof settle !== 'function') return null
  return { settle, storage }
}

/**
 * Re-settle a partition's committed fallback rows and return the survivors
 * to emit into the rewrite.
 *
 * Two stages, both safe-by-construction:
 *
 *  1. **Upgrade.** The dataset's re-settle hook upgrades each fallback row
 *     it can match to its native transcript identity (re-stamping
 *     `message_id`/`part_id`, clearing the fallback marker), leaving the
 *     rest as provisional fallbacks. The hook NEVER drops a row, so an
 *     enricher miss or failure degrades safely: the row survives
 *     unchanged for a later sweep.
 *
 *  2. **De-twin within the rewrite set.** A fallback that upgraded onto a
 *     `part_id` already emitted from this same partition (its native twin,
 *     which streamed as a normal non-fallback row) is the duplicate the
 *     race left behind: drop it. The native twin wins. The twins share
 *     the partition key (`conversation_id`/`cwd`/`date`), so the twin is
 *     guaranteed to be in this rewrite set: no committed-partition scan is
 *     needed, and a row whose identity did NOT change can never collide
 *     with itself (its committed copy was buffered, not emitted). This is
 *     why the sweep cannot reuse `settleBatch`'s committed-scan dedupe,
 *     which would match a non-upgraded fallback against its own committed
 *     copy and wrongly drop it.
 *
 * Conservative and idempotent: only an upgraded fallback whose `part_id`
 * collides is dropped, and a second pass is a no-op because the survivor
 * is no longer a fallback.
 *
 * @ref LLP 0027#re-settle-sweep: reuse the flush enricher. De-twin within the partition rewrite.
 * @param {Record<string, unknown>[]} fallbackRows
 * @param {SettleContext} settle
 * @param {Set<unknown>} emittedPartIds  part_ids already emitted from this partition rewrite
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function resettleFallbackRows(fallbackRows, settle, emittedPartIds) {
  /** @type {Record<string, unknown>[]} */
  let upgraded
  try {
    const out = await settle.settle(fallbackRows, { storage: settle.storage })
    upgraded = Array.isArray(out) && out.length === fallbackRows.length ? out : fallbackRows
  } catch {
    // Degrade safely: leave the fallback rows as committed. The next
    // sweep (transcript now present, or the bug fixed) can retry.
    return fallbackRows
  }

  /** @type {Record<string, unknown>[]} */
  const survivors = []
  for (let i = 0; i < upgraded.length; i++) {
    const row = upgraded[i]
    const wasUpgraded = row !== fallbackRows[i]
    const key = rowPartId(row)
    // Only an UPGRADED row may collapse: its native part_id now matches a
    // twin already emitted (or an earlier survivor in this buffer). A row
    // whose identity is unchanged is never dropped.
    if (wasUpgraded && key !== undefined && emittedPartIds.has(key)) continue
    if (key !== undefined) emittedPartIds.add(key)
    survivors.push(row)
  }
  return survivors
}

/**
 * The deterministic dedupe key for a row: its `part_id`, or the recomposed
 * `<message_id>#<part_index>` for transitional rows that predate `part_id`.
 * Returns undefined when neither identity is available (never deduped).
 *
 * @param {Record<string, unknown>} row
 * @returns {string | undefined}
 */
function rowPartId(row) {
  const partId = row.part_id
  if (typeof partId === 'string' && partId.length > 0) return partId
  const messageId = row.message_id
  const partIndex = row.part_index
  if (
    typeof messageId === 'string' &&
    messageId.length > 0 &&
    (typeof partIndex === 'number' || typeof partIndex === 'bigint')
  ) {
    return `${messageId}#${partIndex}`
  }
  return undefined
}

/**
 * Does the table hold at least one committed gateway fallback row? Used
 * to force a compaction rewrite even when the file-count heuristics say
 * compaction isn't due: otherwise a split twin pair in a small,
 * never-compacted partition would never get re-settled. Scans only the
 * `attributes` column and short-circuits on the first hit, so the cost is
 * bounded and paid only for settle-eligible datasets.
 *
 * @ref LLP 0027#re-settle-sweep: gate the sweep on a cheap fallback scan.
 * @param {string} tableDir
 * @returns {Promise<boolean>}
 */
async function hasResettleCandidate(tableDir) {
  if (!tableExists(tableDir)) return false
  try {
    for await (const row of scanRowsFromTable(tableDir, ['attributes'])) {
      if (isGatewayFallbackRow(row)) return true
    }
  } catch {
    return false
  }
  return false
}

/**
 * A committed row is a re-settle candidate when it carries the gateway's
 * provisional-identity marker. This is the documented contract
 * (`attributes.gateway.identity_source === 'gateway_fallback'`, LLP 0027
 * "Decision") - a dataset-agnostic predicate, so the marker is the only
 * coupling between core compaction and the gateway plugin. Tolerates the
 * `attributes` column whether stored as an object or a JSON string.
 *
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
function isGatewayFallbackRow(row) {
  const attrs = row?.attributes
  const parsed = typeof attrs === 'string' ? safeParseJson(attrs) : attrs
  if (!isPlainObject(parsed)) return false
  const gateway = parsed.gateway
  return isPlainObject(gateway) && gateway.identity_source === 'gateway_fallback'
}

/**
 * The data-file count recorded the last time compaction rewrote this
 * partition (the "re-settle baseline", LLP 0027#re-settle-sweep). A live
 * data-file count equal to this means no new data has flushed since the
 * last rewrite, so both the forced re-settle sweep and the general
 * compaction heuristics skip the partition until the count moves; a
 * rewrite would only reproduce the same generation. Undefined for a
 * partition never compacted (always eligible).
 * @ref LLP 0199#baseline-gate: the baseline is the convergence signal for all compaction dueness
 *
 * @param {PartitionCursor} cursor
 * @returns {number | undefined}
 */
function resettleBaselineFiles(cursor) {
  const c = cursor.compaction
  if (isPlainObject(c) && typeof c.resettleBaselineFiles === 'number') return c.resettleBaselineFiles
  return undefined
}

/**
 * What a rewrite achieved, as the cursor records it: the file count it
 * started from beside the count it produced (the baseline), stamped with
 * the writer generation that reached that outcome.
 *
 * `resettleBaselineFiles` alone cannot answer "did the last compaction
 * accomplish anything?", and the LLP 0199 gate reads a live count sitting
 * on the baseline as convergence either way. Recording the before count
 * makes a rewrite that reproduced its own fragmentation legible.
 *
 * @ref LLP 0217#record-effectiveness [implements]: store the pre-rewrite count beside the post-rewrite one.
 * @param {{ dataFilesBefore: number, dataFilesAfter: number }} outcome
 * @returns {Record<string, unknown>}
 */
function compactionOutcomeRecord(outcome) {
  return {
    resettleBaselineFiles: outcome.dataFilesAfter,
    dataFilesBefore: outcome.dataFilesBefore,
    writerGeneration: COMPACTION_WRITER_GENERATION,
  }
}

/**
 * Did the compaction this cursor records reduce the partition's data-file
 * count? Undefined when the cursor predates the effectiveness record, in
 * which case what the rewrite achieved is unknown rather than known bad.
 *
 * Any reduction counts. A rewrite that shaves one file off is progress,
 * and the baseline gate still requires the live count to move before the
 * next attempt, so a marginal gain cannot become a rewrite loop.
 *
 * @param {PartitionCursor} cursor
 * @returns {boolean | undefined}
 */
function compactionReducedFiles(cursor) {
  const c = cursor.compaction
  if (!isPlainObject(c)) return undefined
  const before = c.dataFilesBefore
  const after = c.resettleBaselineFiles
  if (typeof before !== 'number' || typeof after !== 'number') return undefined
  // A rewrite of a partition that held no data files had nothing to
  // reduce, so its outcome is evidence about neither the writer nor the
  // partition.
  if (before <= 0) return undefined
  return after < before
}

/**
 * Is the partition known to be unshrinkable by the writer running now?
 * True when its last rewrite is recorded as having achieved no reduction
 * and that verdict was reached by this same writer generation. Such a
 * partition is skipped for a stated reason: rewriting it again would
 * reproduce the same generation, exactly as the LLP 0199 gate assumes.
 *
 * @param {PartitionCursor} cursor
 * @returns {boolean}
 */
function compactionKnownIneffective(cursor) {
  const c = cursor.compaction
  if (!isPlainObject(c)) return false
  if (compactionReducedFiles(cursor) !== false) return false
  return c.writerGeneration === COMPACTION_WRITER_GENERATION
}

/**
 * Has the recorded verdict stopped binding? A partition sitting on its
 * baseline is skipped because a rewrite would reproduce the same
 * generation - which is only true while the writer is the one that
 * produced it. When the last rewrite is not recorded as a reduction (it
 * achieved nothing, or it predates the effectiveness record entirely) and
 * a different writer generation is now running, the partition is owed one
 * attempt under the new writer. The attempt re-stamps the cursor, so it
 * happens once per generation and not once per tick.
 *
 * A partition that was successfully shrunk is never retried on this path,
 * whatever its stamp: the convergence LLP 0199 protects is the whole
 * point of the gate.
 *
 * @ref LLP 0217#retry-on-writer-change [implements]: the frozen partition thaws when, and only when, the writer under it changes.
 * @param {PartitionCursor} cursor
 * @returns {boolean}
 */
function compactionVerdictStale(cursor) {
  const c = cursor.compaction
  if (!isPlainObject(c) || typeof c.resettleBaselineFiles !== 'number') return false
  if (compactionReducedFiles(cursor) === true) return false
  return c.writerGeneration !== COMPACTION_WRITER_GENERATION
}

/**
 * Cursor for a partition converged by a foreign sorted rewrite: same
 * generation, same rows, only the re-settle baseline moves to the live
 * data-file count so the LLP 0199 gate reads the partition as converged.
 * Everything else is preserved - in particular `compactedAt` still names
 * the kernel's own last rewrite, because this is a recognition, not a
 * compaction.
 *
 * The recognition also carries this build's writer generation, and drops
 * whatever effectiveness a previous kernel rewrite recorded: the layout
 * on disk is the foreign compactor's, so no verdict about the kernel's
 * own writer applies to it. Without the stamp a recognized partition
 * would read as owing a retry on every tick and pay a metadata load and
 * a cursor write for it, forever.
 *
 * @ref LLP 0207#re-baseline [implements]: the cursor write without a
 * rewrite; the whole point is to keep the foreign layout.
 * @ref LLP 0217#retry-on-writer-change [constrained-by]: recognition is a verdict of its own, so the retry stamp is settled here too.
 * @param {PartitionCursor} cursor
 * @param {number} liveDataFiles
 * @returns {PartitionCursor}
 */
function rebaselineCursor(cursor, liveDataFiles) {
  const compaction = isPlainObject(cursor.compaction) ? cursor.compaction : {}
  /** @type {Record<string, unknown>} */
  const next = {
    ...compaction,
    resettleBaselineFiles: liveDataFiles,
    writerGeneration: COMPACTION_WRITER_GENERATION,
  }
  delete next.dataFilesBefore
  return { ...cursor, compaction: next }
}

/** @param {string} value */
function safeParseJson(value) {
  try { return JSON.parse(value) } catch { return undefined }
}

/**
 * @param {string} cacheRoot
 */
async function cleanRetiredEpochs(cacheRoot) {
  const root = datasetsRoot(cacheRoot)
  try {
    await fsPromises.access(root)
  } catch {
    return
  }
  await walkForRetired(root)
}

/**
 * Recursively reclaim retired and orphaned table generations.
 *
 * Two cases are removed:
 *  1. A generation that carries a `.retired` marker older than the grace
 *     period: the normal "compaction succeeded, the previous generation
 *     can go" path.
 *  2. A generation that is NOT the live one named by the partition cursor
 *     and is older than {@link ORPHAN_GRACE_MS}, even without a `.retired`
 *     marker. A compaction that OOMs (or is killed) part-way leaves a
 *     half-written `table-<seq>` dir with no marker; case 1 never reclaims
 *     it, so it leaks forever. Case 2 sweeps it once it is safely stale.
 *
 * Orphan reclamation (case 2) only runs for partition dirs that actually
 * have a `cursor.json`, so we always know which generation is live before
 * deleting any of its siblings. The mtime grace keeps an in-flight
 * compaction's freshly created (not-yet-committed) dir safe.
 *
 * @param {string} dir
 */
async function walkForRetired(dir) {
  /** @type {Dirent[]} */
  let entries
  try {
    entries = await fsPromises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  // Use the strict reader: a missing OR unreadable cursor yields null, so
  // we never synthesize a default live generation and orphan-delete the
  // real one. The orphan branch below only runs when liveDirName is known.
  const cursor = tryReadCursorSync(dir)
  const liveDirName = cursor ? liveGenerationDir(cursor) : null

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = path.join(dir, entry.name)
    if (entry.name.startsWith('epoch=') || entry.name.startsWith('table')) {
      if (entry.name === liveDirName) continue

      const retiredMarker = path.join(full, '.retired')
      let removed = false
      try {
        const content = await fsPromises.readFile(retiredMarker, 'utf8')
        const retiredAt = new Date(content.trim()).getTime()
        if (Date.now() - retiredAt > GRACE_PERIOD_MS) {
          fs.rmSync(full, { recursive: true, force: true })
          removed = true
        }
      } catch {
        // no .retired marker or parse error: fall through to orphan check
      }

      // Orphan sweep: a generation the cursor does not reference and that
      // has aged past the grace window is garbage regardless of markers.
      if (!removed && liveDirName !== null) {
        try {
          const { mtimeMs } = fs.statSync(full)
          if (Date.now() - mtimeMs > ORPHAN_GRACE_MS) {
            fs.rmSync(full, { recursive: true, force: true })
          }
        } catch {
          // stat/remove race: skip, a later tick will retry
        }
      }
    } else {
      await walkForRetired(full)
    }
  }
}

/**
 * Name of the table/epoch directory the cursor currently points at, or
 * null when it cannot be determined.
 *
 * @param {PartitionCursor} cursor
 * @returns {string | null}
 */
function liveGenerationDir(cursor) {
  if (cursor.tableDir) return cursor.tableDir
  // A source-table cursor without an explicit tableDir lives in `table`;
  // never fall through to an `epoch=*` name for source-table layout.
  if (cursor.layout === 'source-table') return 'table'
  if (typeof cursor.epoch === 'number') return `epoch=${cursor.epoch}`
  return null
}

/**
 * Live data-file count for a partition dir, resolved through its cursor to
 * the generation the cursor points at. Zero when the live generation does
 * not exist (e.g. legacy tables maintenance already skips).
 *
 * @param {string} partitionDir
 * @returns {number}
 */
function liveDataFileCount(partitionDir) {
  const cursor = readCursorSync(partitionDir)
  return countDataFiles(path.join(partitionDir, generationLayout(cursor).liveDir))
}

/**
 * @param {string} tableDir
 * @returns {number}
 */
function countDataFiles(tableDir) {
  const dataDir = path.join(tableDir, 'data')
  try {
    return fs.readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.parquet'))
      .length
  } catch {
    return 0
  }
}

/**
 * @param {string} tableDir
 * @returns {number}
 */
function countDeleteFiles(tableDir) {
  const dataDir = path.join(tableDir, 'data')
  try {
    return fs.readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isFile() && (e.name.endsWith('-deletes.parquet') || e.name.endsWith('.puffin')))
      .length
  } catch {
    return 0
  }
}

/**
 * @param {string} tableDir
 * @returns {number}
 */
function countSnapshots(tableDir) {
  if (!tableExists(tableDir)) return 0
  const metadataDir = path.join(tableDir, 'metadata')
  try {
    return fs.readdirSync(metadataDir)
      .filter((name) => /\.metadata\.json$/.test(name))
      .length
  } catch {
    return 0
  }
}

/**
 * @param {string} tableDir
 * @returns {number}
 */
function measureMetadataDir(tableDir) {
  return measureDir(path.join(tableDir, 'metadata'))
}

/**
 * @param {string} tableDir
 * @returns {number}
 */
function measureDataDir(tableDir) {
  return measureDir(path.join(tableDir, 'data'))
}

/**
 * @param {string} dir
 * @returns {number}
 */
function measureDir(dir) {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      try {
        total += fs.statSync(path.join(dir, entry.name)).size
      } catch { /* skip */ }
    }
  } catch { /* no dir */ }
  return total
}
