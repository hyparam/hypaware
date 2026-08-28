// @ts-check

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

import { parquetReadObjects } from 'hyparquet'
import {
  fileCatalog,
  icebergExpireSnapshots,
  icebergRewrite,
  loadLatestFileCatalogMetadata,
} from 'icebird'
import { fetchAvroRecords } from 'icebird/src/fetch.js'

import { Attr, getActiveSpan, getMeter, withSpan } from '../observability/index.js'
import { MAINTENANCE_DEFAULTS } from './maintenance_defaults.js'
import { isGatewayFallbackRow } from './gateway_fallback.js'
import { inferColumnType } from './migrate.js'
import { discoverCachePartitions, readCursorSync, tryReadCursorSync, withPartitionMutationLock, writeCursor } from './partition.js'
import { datasetsRoot } from './paths.js'
import { createLocalIcebergIO, isStagedWriteName, tableUrlForDir } from './iceberg/resolver.js'
import { columnsFromIcebergSchema } from './iceberg/schema.js'
import { appendRowsToTable, currentPartitionSpec, currentSchema, listLiveDataFiles, scanRowsFromTable, sortColumnsFromMetadata, tableExists } from './iceberg/store.js'
import { partitionSpecForDeclaration, partitionSpecMigrationDue, sortColumnsForDeclaration } from '../iceberg/partition-spec.js'
import { openStreamingAppend } from './iceberg/stream_append.js'
import { buildSidecarsForTable, sweepIndexScratch } from '../search/sidecar_build.js'
import { GREP_DATASET, sidecarPathFor } from '../search/searchable_columns.js'
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
 * @import { CachePartitioningDeclaration } from '../../../src/core/iceberg/types.js'
 * @import { PartitionSpec, Resolver, TableMetadata } from 'icebird/src/types.js'
 * @import { Dirent } from 'node:fs'
 */

/** @type {Readonly<MaintenanceConfig>} */
const DEFAULTS = MAINTENANCE_DEFAULTS

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000

/**
 * How many failed partitions the budget guard tolerates before it breaks
 * the walk even though nothing has been maintained yet.
 *
 * The guard's job is "always work one partition before the budget can cut
 * the tick short" (see below), and a partition that threw did no work, so
 * it must not be the one that satisfies that guarantee - a first partition
 * that fails slowly would otherwise starve every partition behind it, on
 * every tick, which is #737 by another route. But gating the break on
 * "maintained > 0" alone means a cache where every partition fails walks
 * past `budgetMs` without bound, which trades one unbounded-tick risk for
 * another. Four is deliberately small: it is bigger than the "one bad
 * partition" case this whole PR is about, small enough that a tick spent
 * entirely on failures is still bounded to roughly four partitions' worth
 * of failure latency rather than the whole cache, and it does not require
 * reading a config value that does not otherwise exist for this guard.
 */
export const MAX_FAILURES_BEFORE_BUDGET_BREAK = 4

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
 * 3 - routine dueness is served by an in-place subset rewrite that merges
 *     only fragmented partition tuples (LLP 0310), so a verdict reached by
 *     the whole-generation writer describes work this writer no longer
 *     performs; every frozen partition is owed one cheap reassessment.
 *
 * Cursors written before this field existed carry no generation and are
 * therefore never equal to the running one, which is the correct reading:
 * their verdict was reached by a writer this build cannot identify.
 *
 * @ref LLP 0217#retry-on-writer-change [implements]: the stamp that makes an ineffective verdict retryable exactly once.
 */
const COMPACTION_WRITER_GENERATION = 3

/**
 * How long a seeding scan that could not read its table waits before
 * another tick may attempt it again.
 *
 * The legacy scan is paid at most once per partition because its verdict
 * is cached, and a scan that could not look caches nothing (LLP 0027): the
 * partition is classified again next tick. That is right per tick and
 * unbounded in time - a partition whose data files are permanently
 * unreadable has no re-settle baseline to converge onto either, so the
 * growth gate never closes and the whole-table `attributes` decode is
 * re-paid on every tick, forever, which is the cost the cursor count
 * exists to retire.
 *
 * Six default maintenance intervals: enough to cut that retry rate by
 * most of an order of magnitude at any plausible tick cadence, short
 * enough that a partition whose files become readable again is swept the
 * same day. Nothing is lost by waiting - while the table is unreadable
 * the rewrite the scan would force cannot run either.
 *
 * @ref LLP 0319#cool-the-retry-down [implements]: the retry is delayed, never cancelled.
 */
const RESETTLE_SCAN_COOLDOWN_MS = 6 * 60 * 60 * 1000

/**
 * The most in-place merge rounds one maintenance tick may run on one
 * partition. Each round is bounded by `compact_batch_bytes` of victim
 * data (the rewrite materializes the victims' rows in memory), so the
 * cap bounds a first pass over a deeply fragmented backlog without
 * letting it consume the tick. Fragmentation left after the last round
 * drains on later ticks, once new flushes make the partition due again.
 *
 * A ceiling, not the cap itself: see {@link inPlaceRoundCap}, which lowers
 * it to fit the configured snapshot retention.
 */
const MAX_INPLACE_COMPACT_ROUNDS = 8

/**
 * How many rounds THIS config may spend on one partition.
 *
 * Every round commits a snapshot, and snapshot retention is the
 * reader-safety window (LLP 0310#unreferenced-sweep): the sweep only
 * reclaims a file once expiry has released every snapshot that could read
 * it. So a tick that commits as many snapshots as retention keeps hands
 * the next tick's expiry a metadata list holding nothing but this tick's
 * own commits, and a reader that opened the table before the tick loses
 * the snapshot it is reading out from under it. Spending strictly fewer
 * than `min_snapshots_to_keep` keeps at least one older snapshot alive
 * across every tick, so the window a reader gets is never shorter than a
 * maintenance interval regardless of how the two knobs are set.
 *
 * Floor of one: a config that retains nothing has no window to protect,
 * and a cap of zero would stall compaction outright rather than slow it.
 *
 * @ref LLP 0312#round-cap-under-retention [implements]: one tick may never spend the whole retention window.
 * @param {MaintenanceConfig} cfg
 * @returns {number}
 */
export function inPlaceRoundCap(cfg) {
  return Math.max(1, Math.min(MAX_INPLACE_COMPACT_ROUNDS, cfg.min_snapshots_to_keep - 1))
}

/**
 * How many `vN.metadata.json` versions the unreferenced-file sweep keeps.
 * In-place commits stopped retiring whole generation directories, so old
 * metadata versions no longer die with their directory; without a trim
 * they accumulate one per commit forever. The kept window is for
 * debugging a recent commit; nothing reads versions behind the hint.
 */
const METADATA_VERSIONS_KEPT = 20

/**
 * The most of one maintenance tick's budget the grep sidecar build may
 * spend on any one partition. Indexing is seconds of CPU per file and the
 * pass runs inside the per-partition loop, so without a share of its own it
 * would spend the tick's whole remaining tail on the first grep partition
 * and starve every partition behind it. LLP 0199's neediest-first walk puts
 * the busiest partition first, which is exactly the one with the most to
 * index, so the tail is what it would take.
 *
 * The deadline this makes is ABSOLUTE and measured from the tick's start
 * (`startMs + budgetMs * share`), not from each partition's own arrival, so
 * it is one window near the front of the tick rather than an allowance
 * handed out per partition. A grep partition the walk reaches after that
 * window has closed still indexes its first missing file (the
 * always-attempt-one guarantee in `buildSidecarsForTable`) and defers the
 * rest to a later tick; the loop's own budget break above is what bounds
 * the total. Reading this as a per-partition allowance would be reading a
 * larger bound than the code holds, in the safe direction.
 */
const GREP_INDEX_TICK_SHARE = 0.25

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
  let totalFailed = 0
  // A partition that threw did no work, so `reports.length > 0` cannot be
  // what proves the budget guard's "always work one partition" guarantee -
  // see MAX_FAILURES_BEFORE_BUDGET_BREAK.
  let maintained = 0

  for (const part of partitions) {
    // Always work one partition before the budget can cut the tick short:
    // the ranking pass above is itself unbudgeted, so on a large enough
    // cache a bare cutoff here would break at iteration 0 every tick and
    // maintenance would never run at all. Gated on `maintained`, not on
    // `reports.length`, so a first partition that fails (possibly slowly)
    // cannot itself satisfy the guarantee and starve the walk behind it.
    // The failure-count disjunct is the bounded escape hatch for the
    // opposite case, a cache where every partition fails.
    if (
      Date.now() - startMs > budgetMs &&
      (maintained > 0 || totalFailed >= MAX_FAILURES_BEFORE_BUDGET_BREAK)
    ) break

    // Built out here rather than inside the span callback so the catch
    // below still has it: a partition that threw part-way keeps whatever
    // the run had already established about it (its live file count, any
    // snapshots expired before compaction reached the error) instead of
    // being reported as a bare failure with zeroed counts.
    /** @type {MaintenancePartitionReport} */
    const report = {
      dataset: part.dataset,
      partition: part.partition,
      path: part.path,
      snapshotsExpired: 0,
      compacted: false,
      rowCount: part.rowCount,
      dataFilesBefore: 0,
      dataFilesAfter: 0,
    }

    try {
      await withSpan(
        'maintenance.partition',
        {
          [Attr.COMPONENT]: 'cache',
          [Attr.OPERATION]: 'maintenance.partition',
          [Attr.DATASET]: part.dataset,
          partition: JSON.stringify(part.partition),
          status: 'ok',
        },
        async (span) => {
          const cursor = readCursorSync(part.path)
          const settle = resolveSettleContext(opts, part.dataset)

          const done = await maintainGeneration(
            report, cursor, cfg, opts, settle, snapshotsExpiredCounter, compactionsCounter, rebaselinesCounter
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
        },
        { component: 'cache' }
      )
    } catch (err) {
      // @ref LLP 0220#walk-survives-a-partition [implements]: one partition's
      // error ends that partition's work, not the tick's. Outside `withSpan`
      // on purpose: the helper rethrows after recording the exception and an
      // ERROR status on `maintenance.partition`, so catching here keeps the
      // span honest about the partition while the walk moves on. Catching
      // inside the callback would hand every reader of the trace an `ok`
      // span for a partition that failed. Everything the failure path itself
      // has to do - LLP 0217's writer-generation stamp above all - already
      // ran inside `maintainGeneration`, on the way out.
      report.failed = true
      report.errorKind = errorKindOf(err)
      report.errorMessage = err instanceof Error ? err.message : String(err)
      totalFailed++
    }
    // The grep sidecar build. Compaction is where a generation's files are
    // minted, so a rewrite that just committed always leaves work here, but
    // gating on that alone strands a partition already at the compaction
    // floor: it never rewrites, so its files never get indexed, every grep
    // brute-scans them forever, and `hyp query status` advises a compaction
    // that will not run (hyparam/hypaware#984 review). Coverage is the
    // honest gate instead, and it is cheap: one `readdir` of the live data
    // directory, the same cost profile as the file counters beside it, and
    // it reads zero-work whenever every file already has its sidecar. A
    // committed data file never changes its rows, so indexing one the
    // compactor has not touched is as valid as indexing one it just wrote;
    // what compaction buys is that the index is built once over merged
    // files rather than repeatedly over the fragments it will replace,
    // which is a cost argument, not a correctness one.
    //
    // Isolated from the partition's own verdict: an index that cannot be
    // built costs speed, never the tick, and never correctness (the scan
    // tier serves whatever has no sidecar). Bounded by the tick's own
    // deadline for the same reason the walk above is, and resumable across
    // ticks because sidecar existence is the marker.
    // @ref LLP 0264#lifecycle [constrained-by]: sidecar existence is the idempotency marker and an unindexed file is brute-scanned; both are what let this run on coverage
    // @ref LLP 0302#build-site [implements]: the build pass runs on missing coverage under the tick budget, not only behind a committed compaction
    if (!opts.dryRun && !report.failed && part.dataset === GREP_DATASET) {
      try {
        const cursorAfter = readCursorSync(part.path)
        const liveDir = path.join(part.path, generationLayout(cursorAfter).liveDir)
        // Before the coverage gate, and outside it. A build killed between
        // its write and its rename leaves the sidecar unpublished, so the
        // NEXT tick rebuilds it and coverage goes complete again - inside
        // the sweep's own grace window, and therefore before the abandoned
        // scratch is old enough to reclaim. Behind the gate the sweep would
        // then never run again for that generation and the leak would last
        // its whole life, which is the opposite of what the grace window is
        // for. Costs one `readdir` of a directory `countIndexCoverage` reads
        // anyway.
        // @ref LLP 0304#scratch-sweep-site [implements]: the sweep is not gated on missing coverage, because a republished sidecar is what hides the scratch
        sweepIndexScratch(liveDir)
        const coverage = countIndexCoverage(liveDir)
        if (coverage.indexed < coverage.indexable) {
          await withSpan(
            'maintenance.grep_index',
            {
              [Attr.COMPONENT]: 'cache',
              [Attr.OPERATION]: 'maintenance.grep_index',
              [Attr.DATASET]: part.dataset,
              status: 'ok',
            },
            async (span) => {
              // A SHARE of the tick, never its tail. Handing the pass the
              // tick's own deadline let it run until the tick was spent,
              // and the partition walk is neediest-first, so the busiest
              // grep partition comes first, arrives at a freshly compacted
              // generation with zero coverage, and spends the rest of the
              // tick indexing it. Every partition behind it - the other
              // sources, and logs/traces/metrics - then got no snapshot
              // expiry and no compaction, that tick and every tick after,
              // because the busy partition keeps taking writes. Nothing
              // else in the loop has that shape: compaction is gated on a
              // due verdict, so a healthy partition costs nearly nothing.
              //
              // A fraction bounds the damage without stalling coverage:
              // the pass still always attempts its first missing file (see
              // `buildSidecarsForTable`), so a partition indexes at least
              // one file per tick even on an already-spent budget, and an
              // absent `budgetMs` is `Infinity`, which makes the deadline
              // unreachable rather than needing a second shape.
              // @ref LLP 0199#neediest-first [constrained-by]: the walk postpones the healthiest partitions, so per-partition work appended to the loop must not be able to consume the tick
              // @ref LLP 0303#build-share [implements]: a share of the tick per partition, never its tail
              const built = await buildSidecarsForTable({
                tableDir: liveDir,
                deadlineMs: startMs + budgetMs * GREP_INDEX_TICK_SHARE,
              })
              report.sidecarsBuilt = built.built
              // `failed` only: `quarantined` counts files SKIPPED without a
              // build, so folding them in made a partition holding one
              // poisoned file report a fresh failure on every later tick
              // when nothing was attempted at all.
              report.sidecarsFailed = built.failed
              report.sidecarsQuarantined = built.quarantined
              report.sidecarsDeferred = built.deferred
              span.setAttribute('sidecars_built', built.built)
              span.setAttribute('sidecars_present', built.present)
              span.setAttribute('sidecars_failed', built.failed)
              span.setAttribute('sidecars_quarantined', built.quarantined)
              span.setAttribute('sidecars_deferred', built.deferred)
            },
            { component: 'cache' }
          )
        }
      } catch (err) {
        // Index absence is served by the scan tier, so a build-pass throw
        // is a warning on the report, never a failed partition.
        report.sidecarsFailed = (report.sidecarsFailed ?? 0) + 1
        report.sidecarError = err instanceof Error ? err.message : String(err)
      }
    }
    reports.push(report)
    if (!report.failed) maintained++
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
    totalFailed,
    dryRun: opts.dryRun ?? false,
    elapsedMs: Date.now() - startMs,
  }
}

/**
 * The error's own kind when it carries one (the convention sink
 * materialization already uses for the same per-unit catch), else a kind
 * naming where it was caught. Never the exception's class: what an
 * operator needs off a maintenance report is which step of the tick gave
 * up, and the message beside it carries the rest.
 *
 * @param {unknown} err
 * @returns {string}
 */
function errorKindOf(err) {
  if (err && typeof err === 'object' && 'errorKind' in err) {
    return String(/** @type {{ errorKind: unknown }} */ (err).errorKind)
  }
  return 'maintenance_partition_failed'
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
        // Carried over as the default; a settle-bearing rewrite overrides
        // this with the exact remainder it counted (compactGeneration).
        ...(cursor.pendingFallbacks !== undefined ? { pendingFallbacks: cursor.pendingFallbacks } : {}),
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
      ...(cursor.pendingFallbacks !== undefined ? { pendingFallbacks: cursor.pendingFallbacks } : {}),
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

  // Live counts from the current snapshot's summary where the table keeps
  // one, not from the directory. In-place compaction (LLP 0310) leaves
  // superseded data files on disk until snapshot retention releases them,
  // so a directory count over-reads a freshly compacted partition and the
  // unreferenced-file sweep would move it back down later - the baseline
  // gate below would read both moves as growth and re-flag the partition.
  // The summary tracks exactly the live file set, so the gate, the dueness
  // heuristics, and the recorded verdicts all move only when data does.
  // @ref LLP 0310#live-count-units [implements]: gate and verdicts measure live files, not directory entries.
  const liveStats = layout.kind === 'source-table' ? await liveTableStats(liveDir) : null
  const dataFilesBefore = liveStats?.dataFiles ?? countDataFiles(liveDir)
  r.dataFilesBefore = dataFilesBefore
  r.dataFilesAfter = dataFilesBefore

  // @ref LLP 0311#migration [implements]: a recorded spec still partitioning
  // on a column the declaration has demoted to sortOnly awaits its one-time
  // re-partition. The check is a set comparison over metadata already loaded
  // for the live counts, so a migrated (or never-mismatched) partition pays
  // nothing for it.
  const declaration = opts.getDeclaration?.(r.dataset)
  const repartitionDue = Boolean(
    declaration && liveStats?.partitionSpec &&
    partitionSpecMigrationDue(declaration, liveStats.partitionSpec)
  )

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
    // A due re-partition outranks the baseline gate and the recorded
    // verdict: both say "a rewrite would reproduce this layout", which is
    // exactly what the migration exists to change.
    const compactionDue = opts.force || repartitionDue ||
      ((grewSinceCompaction || verdictStale) && needsCompaction(liveDir, cfg, liveStats, layout.kind))
    // @ref LLP 0027#re-settle-sweep: a partition holding a committed
    // fallback row may carry a split twin pair the flush-time settle
    // never collapsed; force a rewrite so the sweep can re-settle it even
    // when the file-count heuristics say compaction isn't due. Sharing the
    // baseline gate keeps an unmatchable fallback: one whose transcript
    // line never lands (harness aux, wire-only reminders) - from forcing a
    // full rewrite every tick, and skips the attributes scan entirely when
    // nothing new has flushed.
    // @ref LLP 0207#outranks-resettle [constrained-by]: when the cheap check
    // above already made compaction due, the answer can never change the
    // outcome (recognition, tested below, still outranks it), so skip it:
    // only ask when it might be the sole reason to compact. The answer
    // itself is a cursor read - the flush path counts marker rows as they
    // land - with one legacy full scan for a cursor from before the count
    // existed (`hasPendingFallbacks`).
    const hasResettle = !compactionDue && settle
      ? grewSinceCompaction && await hasPendingFallbacks(r.path, cursor, liveDir, opts.dryRun === true)
      : false
    const shouldCompact = compactionDue || hasResettle
    if (!shouldCompact && compactionKnownIneffective(cursor)) {
      // Skipped for a stated reason rather than by the baseline
      // coincidence: this writer has already rewritten this partition and
      // produced the same fragmentation. Read from the cursor, so saying
      // so costs nothing; re-checking `needsCompaction` here would stat
      // every data file of every converged partition, every tick.
      r.compactionIneffective = true
      // The count the recorded rewrite ran over, not the live one. They
      // diverge whenever the partition changed without becoming due again
      // (retention deleting files, say), and the message describes the
      // record, so a partition now holding 5 files must not be reported as
      // one whose last rewrite of 5 files reduced nothing when that rewrite
      // read 40.
      r.compactionIneffectiveFiles = compactionFilesBefore(cursor)
      getActiveSpan()?.setAttribute('compaction_ineffective', true)
    } else if (!shouldCompact) {
      // @ref LLP 0218#report-the-spent-attempt [implements]: the other way a
      // partition stops being compacted. The retry a writer change granted
      // was spent by an attempt that threw, and that attempt recorded no
      // effectiveness (it proved nothing), so the branch above cannot speak
      // for it. Without this one the failing tick's `daemon.maintenance_failed`
      // is the only evidence there ever is, while the partition stays
      // fragmented and is skipped in silence from here on.
      const failedAt = compactionAttemptFailedAt(cursor)
      if (failedAt !== undefined) {
        r.compactionAttemptFailed = true
        r.compactionAttemptFailedAt = failedAt
        getActiveSpan()?.setAttribute('compaction_attempt_failed', true)
      }
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
      // A due re-partition also outranks the recognition: a foreign sorted
      // replace under the OLD spec is still on the old spec.
      if (!opts.force && !repartitionDue && foreignSortedReplace(tableInfo, cursor)) {
        // The counter proves a rebaseline happened at all, but it carries
        // only the dataset; tagging the enclosing maintenance.partition span
        // names the partition, so a trace query finds which day re-baselined
        // without cross-referencing the counter. Left here rather than moved
        // beside `r.rebaselined` below: the span carries ERROR anyway if the
        // write that follows throws, so the intent is still worth recording.
        getActiveSpan()?.setAttribute('rebaselined', true)
        if (!opts.dryRun) {
          // Re-read rather than spread the cursor this tick opened with, for
          // the same reason the failure stamp below does: that object is a
          // pre-lock snapshot and the file has moved under it.
          // `hasPendingFallbacks` seeds `pendingFallbacks` onto the partition
          // it just classified, and a flush may have incremented it since.
          // Spreading the snapshot writes "unknown" back over that verdict,
          // so the next growth tick pays the whole-table attributes scan
          // again - forever, on exactly the partitions that DO hold a
          // fallback row, which is the hourly decode this gate exists to
          // retire (the compaction paths below all re-read under the lock
          // already; this write did neither).
          // Under the lock for the same reason: re-reading only narrows the
          // window, it does not close it. The append path holds this lock
          // across its own read-modify-write, so an unserialized one here
          // still drops a concurrent flush's increment - and a lost
          // increment is the failure direction that strands provisional
          // rows, where a lost `rowCount` was only cosmetic.
          await withPartitionMutationLock(r.path, async () => {
            await writeCursor(r.path, rebaselineCursor(tryReadCursorSync(r.path) ?? cursor, dataFilesBefore))
          })
          // Set only once the cursor write that persists it has succeeded:
          // a throw here must not leave the report (and `totalRebaselined`)
          // claiming a rebaseline that never landed on disk.
          r.rebaselined = true
          rebaselinesCounter.add(1, { [Attr.DATASET]: r.dataset })
        } else {
          // No write happens in dry-run, so nothing to wait on: this is
          // the preview of what a real run would do, same as `r.compacted`
          // below for the ordinary rewrite path.
          r.rebaselined = true
        }
      } else if (opts.dryRun) {
        r.compacted = true
        // Preview what the real run would actually do, not what it was
        // asked to do: the migration only applies if the target layout can
        // be derived from the metadata already in hand, exactly as below.
        if (repartitionDue && declaration && repartitionTargetLayout(declaration, tableInfo)) {
          r.repartitioned = true
        }
      } else {
        /** @type {Awaited<ReturnType<typeof compactGeneration>> | Awaited<ReturnType<typeof compactLiveFilesInPlace>>} */
        let result
        // Set only when the rewrite really ran under the declaration's new
        // layout: an unreadable schema falls back to carrying the recorded
        // spec, and that swap must not be reported as the migration.
        let repartitionApplied = false
        // Set when the migration was due but its target layout could not be
        // derived, so this tick made no progress on it. Reported, because a
        // deferral that only ever shows up as a span attribute is invisible
        // to anyone who was not tracing when the tick fired.
        let repartitionDeferred = false
        try {
          result = await withPartitionMutationLock(r.path, async () => {
            // Flushes may have appended after the due check and metadata load.
            // Re-derive the live generation only after acquiring the same lock
            // the append path holds through its cursor update.
            const lockedCursor = readCursorSync(r.path)
            const lockedLayout = generationLayout(lockedCursor)
            const lockedLiveDir = path.join(r.path, lockedLayout.liveDir)
            // @ref LLP 0310#in-place-by-default [implements]: routine dueness
            // on a source-table generation is served by an in-place subset
            // rewrite of its fragmented tuples, so cost scales with what
            // fragmented rather than with the table. The generation-swap
            // rewrite remains for --force, for the re-settle sweep (it needs
            // the whole-generation scan to collapse split twins), for the
            // legacy epoch layout, and for victims whose fallback rows the
            // settle hook can actually upgrade.
            // A due re-partition must not merge in place: an in-place commit
            // keeps the table's recorded spec, which is the thing being
            // migrated away from (LLP 0311#migration).
            if (!opts.force && !hasResettle && !repartitionDue && lockedLayout.kind === 'source-table') {
              const inPlace = await compactLiveFilesInPlace(r.path, lockedLiveDir, lockedCursor, cfg, settle)
              if (inPlace !== 'settle-required') return inPlace
            }
            const lockedTableInfo = await loadCompactionTableInfo(lockedLiveDir)
            // Re-derive dueness from the metadata read under the lock, for
            // the same reason the cursor is re-read above: the pre-lock
            // check can be stale. `hyp query maintain` and the daemon tick
            // are separate PROCESSES, so the in-process lock does not
            // serialize them, and a partition another run has already
            // migrated would otherwise be swapped a second time and, worse,
            // reported as `repartitioned` for a swap that moved no layout.
            const lockedRepartitionDue = repartitionDue && declaration && lockedTableInfo?.partitionSpec
              ? partitionSpecMigrationDue(declaration, lockedTableInfo.partitionSpec)
              : repartitionDue
            const targetLayout = lockedRepartitionDue && declaration
              ? repartitionTargetLayout(declaration, lockedTableInfo)
              : undefined
            // @ref LLP 0311#migration [constrained-by]: a due re-partition
            // that cannot derive its target layout (unreadable metadata, so
            // no schema) must not fall through to a swap under the recorded
            // layout. That swap converges nothing the migration wanted, and
            // `repartitionDue` is what made this partition due at all, so it
            // is still due next tick: the partition would pay a whole-
            // generation rewrite every tick, forever, and with no schema in
            // hand the replacement generation is written with no partition
            // spec at all. Defer instead, and let a tick that can read the
            // metadata do it; `--force` still rewrites.
            if (!opts.force && lockedRepartitionDue && declaration && !targetLayout) {
              repartitionDeferred = true
              // Deferring the migration must not also stop the partition
              // compacting. `repartitionDue` suppressed the in-place merge
              // above because an in-place commit keeps the recorded spec,
              // which is the thing being migrated away from - but once the
              // swap is deferred there is no new layout for the merge to
              // undo, and the partition is due on the ordinary heuristics
              // too. Without this the mismatch would disable BOTH paths for
              // as long as it stands: measured on a stubbed-out target
              // layout, the live file count then grows every tick and
              // nothing in the report says why.
              if (!hasResettle && lockedLayout.kind === 'source-table') {
                const inPlace = await compactLiveFilesInPlace(r.path, lockedLiveDir, lockedCursor, cfg, settle)
                if (inPlace !== 'settle-required') return inPlace
              }
              return null
            }
            repartitionApplied = targetLayout !== undefined
            return compactGeneration(r.path, lockedLayout, cfg, settle, lockedTableInfo, targetLayout)
          })
        } catch (err) {
          // @ref LLP 0217#retry-on-writer-change [implements]: the attempt
          // spends the generation's retry, success or not. The rewrite
          // writes its cursor only once it commits, so a throw would
          // otherwise leave the stale verdict standing and this partition
          // would be attempted, and fail, on every tick forever - taking
          // the rest of the walk with it, because the neediest partition
          // (LLP 0199#neediest-first) is both the first one tried and the
          // likeliest to fail. Re-read rather than stamp the cursor read
          // at the top of the tick: a rewrite that threw after committing
          // its cursor must not be rolled back onto the retired generation.
          // `tryReadCursorSync`, because this write is destructive and a
          // cursor that cannot be read back must not be replaced by the
          // epoch-0 default `readCursorSync` would synthesize.
          if (verdictStale) {
            // Best-effort: a cursor write that fails must not displace the
            // rewrite failure that is the actual diagnosis (a decode error
            // masked by an ENOSPC on the stamp sends the operator after the
            // wrong symptom). Unstamped means the next tick attempts the
            // rewrite again, which is the pre-existing behaviour rather than
            // a regression.
            try {
              // Under the lock, as the rebaseline write above: this is a
              // read-modify-write of the same cursor a flush may be
              // incrementing.
              await withPartitionMutationLock(r.path, async () => {
                const stamped = stampWriterGeneration(tryReadCursorSync(r.path) ?? cursor, new Date().toISOString())
                await writeCursor(r.path, stamped)
              })
            } catch { /* see above */ }
          }
          throw err
        }
        if (repartitionDeferred) {
          r.repartitionDeferred = true
          getActiveSpan()?.setAttribute('repartition_deferred', true)
        }
        if (result && 'noop' in result && result.noop) {
          // Due by the heuristics, but nothing is mergeable: every tuple is
          // already at one file (the identity-partitioning floor). The
          // verdict cursor the helper wrote makes the next ticks skip for
          // this stated reason instead of re-listing the table every hour.
          // Reported only above one file, exactly as {@link rewriteReducedFiles}
          // reads the recorded verdict: a lone-file partition is maximally
          // compact, not unshrinkable.
          // @ref LLP 0310#floor-is-a-verdict [implements]: an empty victim set is the ineffectiveness verdict, reached without a rewrite.
          if (result.dataFilesBefore > 1) {
            r.compactionIneffective = true
            r.compactionIneffectiveFiles = result.dataFilesBefore
            getActiveSpan()?.setAttribute('compaction_ineffective', true)
          }
        } else if (result) {
          r.compacted = true
          if (repartitionApplied) {
            r.repartitioned = true
            getActiveSpan()?.setAttribute('repartitioned', true)
          }
          if (result.newEpoch !== undefined) r.newEpoch = result.newEpoch
          r.rowCount = result.rowCount
          r.dataFilesAfter = result.dataFiles
          r.compactedBytesWritten = result.bytesWritten
          // @ref LLP 0217#record-effectiveness [implements]: a rewrite that
          // reproduced its own file count reports that, so the run is
          // legible as work that achieved nothing instead of surfacing
          // only as a later disk audit. A partition already at its floor
          // reduced nothing either, but reports nothing: see
          // {@link rewriteReducedFiles}.
          if (rewriteReducedFiles(result.dataFilesBefore, result.dataFiles) === false) {
            r.compactionIneffective = true
            r.compactionIneffectiveFiles = result.dataFilesBefore
          }
          compactionsCounter.add(1, { [Attr.DATASET]: r.dataset })
        }
      }
    }
  }

  // Release what nothing references any more. In-place compaction and
  // snapshot expiry both stop short of deleting files (a retained snapshot
  // may still read them), so the live generation accumulates superseded
  // data files and metadata until this sweep finds them unreferenced by
  // every retained snapshot. Best-effort by construction: a file missed
  // this tick is caught on a later one, and a sweep failure must not fail
  // the partition's report.
  // @ref LLP 0310#unreferenced-sweep [implements]: snapshot retention is the reader-safety window; the sweep only reclaims what fell out of it.
  //
  // Read the generation off the cursor AGAIN rather than reuse `layout`:
  // when the tick took the generation-swap rewrite (--force, the settle
  // escape, the legacy layout) the directory `liveDir` names is the RETIRED
  // one. Sweeping that is both wrong and expensive - a full metadata and
  // manifest walk, every tick for the whole 24 h retirement grace, of a
  // directory the retirement sweep deletes wholesale - and it would report
  // the retired generation's releases as the live generation's.
  if (!opts.dryRun) {
    const sweptCursor = tryReadCursorSync(r.path) ?? cursor
    const sweptLayout = generationLayout(sweptCursor)
    if (sweptLayout.kind === 'source-table') {
      try {
        const removed = await sweepUnreferencedTableFiles(path.join(r.path, sweptLayout.liveDir))
        if (removed > 0) {
          r.unreferencedFilesRemoved = removed
          getActiveSpan()?.setAttribute('unreferenced_files_removed', removed)
        }
      } catch { /* swept again next tick */ }
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

    // Live count from the snapshot summary where the table keeps one: an
    // in-place compaction's superseded files sit in the directory until
    // snapshot retention releases them, and status must not report them
    // as live fragmentation (LLP 0310#live-count-units).
    const liveStats = layout.kind === 'source-table' ? await liveTableStats(liveDir) : null
    /** @type {CacheStatusPartition} */
    const status = {
      dataset: part.dataset,
      partition: part.partition,
      epoch: cursor.epoch,
      rowCount: part.rowCount,
      dataFileCount: liveStats?.dataFiles ?? countDataFiles(liveDir),
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
    // Grep-index coverage, for the one dataset that carries sidecars: how
    // many of the partition's data files a search serves through an index
    // rather than a brute scan. Reported so "grep is slow on deep history"
    // is diagnosable from `hyp query status` instead of from tracing.
    if (part.dataset === GREP_DATASET) {
      const coverage = countIndexCoverage(liveDir)
      status.indexedFileCount = coverage.indexed
      status.indexableFileCount = coverage.indexable
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
 * Is this generation due for routine compaction?
 *
 * The metadata-size trigger asks a different question from the two data
 * heuristics, and only the generation-swap writer can answer it: it builds
 * a fresh directory, so a bloated metadata history dies with the old one.
 * An in-place merge commits INTO the same directory and can only add
 * versions, so on a source table the trigger names work this path cannot
 * do - the partition would read as due on every growth tick and collect
 * the floor verdict instead of shrinking. Metadata on that layout has its
 * own bound now ({@link METADATA_VERSIONS_KEPT} plus the unreferenced-file
 * sweep, both of which run every tick regardless of dueness), so the
 * trigger is left to the legacy epoch layout, where a rewrite clears it.
 * `--force` still routes a source table to the generation-swap writer.
 *
 * @ref LLP 0312#metadata-dueness [implements]: a dueness condition routine compaction cannot clear is not routine dueness.
 * @param {string} tableDir
 * @param {MaintenanceConfig} cfg
 * @param {{ dataFiles: number | null, dataBytes: number | null } | null} [liveStats] live counts from the snapshot summary; directory counts are the fallback, including when the summary carries no usable totals
 * @param {'source-table' | 'epoch'} [layoutKind] which writer a due verdict would route to
 * @returns {boolean}
 */
function needsCompaction(tableDir, cfg, liveStats, layoutKind) {
  const dataFiles = liveStats?.dataFiles ?? countDataFiles(tableDir)
  if (dataFiles > cfg.compact_file_count) return true

  const totalDataBytes = liveStats?.dataBytes ?? measureDataDir(tableDir)
  if (dataFiles > 0 && totalDataBytes / dataFiles < cfg.compact_avg_file_bytes) return true

  if (layoutKind !== 'source-table') {
    const metadataBytes = measureMetadataDir(tableDir)
    if (metadataBytes > 64 * 1024 * 1024) return true
  }

  return false
}

/**
 * What the current snapshot of a source-table generation says about
 * itself: the live file count and data bytes from its summary, the
 * partition spec it is recorded under, and its own snapshot id.
 *
 * `dataFiles` and `dataBytes` are `null` when the summary carries no
 * usable totals (older snapshots predate them) and callers fall back to
 * directory counts. The spec and the snapshot id come from the metadata
 * itself, so they survive that gap: a due re-partition (LLP 0311) and the
 * "did we commit this replace?" test below must not hinge on an unrelated
 * counter being parseable, which would leave a table silently unmigrated
 * with nothing reporting the standing mismatch.
 *
 * Null only when the table, its metadata, or its current snapshot is
 * missing outright.
 *
 * @param {string} tableDir
 * @returns {Promise<{ dataFiles: number | null, dataBytes: number | null, partitionSpec: PartitionSpec | undefined, snapshotId: string } | null>}
 */
async function liveTableStats(tableDir) {
  if (!tableExists(tableDir)) return null
  try {
    const { resolver, lister } = await createLocalIcebergIO()
    const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: tableUrlForDir(tableDir), resolver, lister })
    const currentId = metadata['current-snapshot-id']
    if (currentId === undefined || currentId === null || Number(currentId) === -1) return null
    const snapshot = (metadata.snapshots ?? []).find((s) => BigInt(s['snapshot-id']) === BigInt(currentId))
    const summary = snapshot?.summary
    const dataFiles = Number(summary?.['total-data-files'])
    const dataBytes = Number(summary?.['total-files-size'])
    const totals = Number.isFinite(dataFiles) && Number.isFinite(dataBytes)
    return {
      dataFiles: totals ? dataFiles : null,
      dataBytes: totals ? dataBytes : null,
      // The spec rides along because the metadata is already in hand: the
      // re-partition dueness check (LLP 0311) runs every tick and must not
      // cost a second metadata load.
      partitionSpec: currentPartitionSpec(metadata),
      snapshotId: String(currentId),
    }
  } catch {
    return null
  }
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
 * The layout a re-partition migration rewrites INTO: the partition spec and
 * sort columns derived from the dataset's current declaration, against the
 * table's current schema. Undefined when the metadata (and so the schema)
 * could not be read; the caller then carries the recorded layout instead of
 * guessing, and the migration stays due for a later tick.
 *
 * @ref LLP 0311#migration [implements]: the generation swap writes under the
 *   declaration's layout, not the recorded one it exists to replace.
 * @param {CachePartitioningDeclaration} declaration
 * @param {Awaited<ReturnType<typeof loadCompactionTableInfo>>} tableInfo
 * @returns {{ partitionSpec: PartitionSpec, sortColumns: { column: string, direction: 'asc' }[] } | undefined}
 */
function repartitionTargetLayout(declaration, tableInfo) {
  const schema = tableInfo ? currentSchema(tableInfo.metadata) : undefined
  if (!schema) return undefined
  const schemaNames = new Set(schema.fields.map((f) => f.name))
  return {
    partitionSpec: partitionSpecForDeclaration(declaration, schema),
    sortColumns: sortColumnsForDeclaration(declaration).filter((c) => schemaNames.has(c.column)),
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
 * FOREIGN is the operative word, and it stopped being implied by the
 * shape alone. Until LLP 0311 no cache table declared a sort order, so
 * "replace + declared sort order" could only be the server's compactor;
 * now the cache table declares one of its own, and LLP 0310's in-place
 * merge commits `replace` on exactly that table. The two are told apart
 * by the cursor: an in-place merge records the snapshot id it committed,
 * so a current snapshot we wrote is ours, not a foreign layout to
 * preserve. Without this the retry a `COMPACTION_WRITER_GENERATION` bump
 * grants (LLP 0217) would be spent on a recognition instead of a rewrite
 * for every partition whose last commit was an in-place merge - which is
 * the frozen-partition failure that decision exists to cure.
 *
 * @ref LLP 0207#foreign-replace [implements]: the recognition test, the
 * kernel-side mirror of the server day compactor's alreadyCompacted +
 * sortOrderDeclared skip.
 * @ref LLP 0217#retry-on-writer-change [constrained-by]: recognition must not swallow the retry a writer change grants.
 * @param {Awaited<ReturnType<typeof loadCompactionTableInfo>>} tableInfo
 * @param {PartitionCursor} cursor
 * @returns {boolean}
 */
function foreignSortedReplace(tableInfo, cursor) {
  if (!tableInfo?.sortColumns?.length) return false
  const { metadata } = tableInfo
  const currentId = metadata['current-snapshot-id']
  if (currentId === undefined || currentId === null || Number(currentId) === -1) return false
  if (String(currentId) === inPlaceSnapshotId(cursor)) return false
  const snapshot = (metadata.snapshots ?? []).find((s) => BigInt(s['snapshot-id']) === BigInt(currentId))
  return snapshot?.summary?.operation === 'replace'
}

/**
 * The snapshot id of the last in-place merge this kernel committed on the
 * live generation, as its cursor records it. Undefined for a cursor
 * written before the id was recorded (or by a generation swap, which
 * leaves no `replace` behind), which reads as "not ours" - the
 * pre-existing behaviour.
 *
 * @param {PartitionCursor} cursor
 * @returns {string | undefined}
 */
function inPlaceSnapshotId(cursor) {
  const c = cursor.compaction
  if (!isPlainObject(c) || typeof c.inPlaceSnapshotId !== 'string' || c.inPlaceSnapshotId === '') return undefined
  return c.inPlaceSnapshotId
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
export function estimateRowBytes(row) {
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
 * @param {ReturnType<typeof repartitionTargetLayout>} [targetLayout]  re-partition migration only: write the new generation under this layout instead of carrying the recorded one
 * @returns {Promise<{ newEpoch?: number, rowCount: number, dataFilesBefore: number, dataFiles: number, bytesWritten?: number } | null>}
 */
async function compactGeneration(partitionDir, layout, cfg, settle, tableInfo, targetLayout) {
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
  const appendOpts = targetLayout
    ? { partitionSpec: targetLayout.partitionSpec, sortOrder: targetLayout.sortColumns.length ? targetLayout.sortColumns : undefined }
    : existingSpec || sortColumns
      ? { partitionSpec: existingSpec, sortOrder: sortColumns }
      : undefined

  // A fallback may stream before its native twin, so de-twinning needs to
  // know every native part_id in the generation. Discover those keys in a
  // narrow first pass instead of retaining every fat fallback row until the
  // full data scan ends. The second pass can settle fallbacks in the same
  // byte-bounded batches used by parquet output.
  // @ref LLP 0301#bounded-resettle [implements]: retain identity keys across
  // the generation, never the full fallback rows.
  const scanOpts = tableInfo?.metadata ? { metadata: tableInfo.metadata } : undefined
  const emittedPartIds = settle ? await scanNativePartIds(oldDir, tableInfo?.metadata) : null
  /** @type {Record<string, unknown>[]} */
  let fallbackBatch = []
  let fallbackBatchBytes = 0
  let remainingFallbacks = 0

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

  // Returns whether the row was accepted (false: dropped as a dedup twin),
  // so the fallback path below can count only rows that actually land in
  // the new generation.
  const emit = async (/** @type {Record<string, unknown>} */ row) => {
    const rowId = row._hyp_cache_row_id
    if (typeof rowId === 'string' && seen.has(rowId)) return false
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
    return true
  }

  const flushFallbackBatch = async () => {
    if (!settle || !emittedPartIds || fallbackBatch.length === 0) return
    const pending = fallbackBatch
    fallbackBatch = []
    fallbackBatchBytes = 0
    for (const row of await resettleFallbackRows(pending, settle, emittedPartIds)) {
      // A row the settle hook could not upgrade still carries the marker;
      // tally it so the cursor this rewrite writes records the exact count
      // of fallbacks left in the new generation.
      if (await emit(row) && isGatewayFallbackRow(row)) remainingFallbacks++
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
    for await (const row of scanRowsFromTable(oldDir, undefined, scanOpts)) {
      if (!columns) {
        columns = Object.keys(row).map((name) => ({
          name,
          type: inferColumnType(row[name]),
          nullable: true,
        }))
      }
      // @ref LLP 0027#re-settle-sweep: hold provisional fallback rows back.
      // The narrow first pass already found native twins that appear later in
      // scan order, so this pass only needs to retain one bounded settle batch.
      if (settle && isGatewayFallbackRow(row)) {
        const rowBytes = estimateRowBytes(row)
        // Flush before crossing the cap. A single row can itself exceed the
        // configured budget; that unavoidable singleton is flushed
        // immediately instead of being combined with another row.
        if (
          fallbackBatch.length > 0 &&
          (fallbackBatch.length >= COMPACT_BATCH_SIZE || fallbackBatchBytes + rowBytes > maxBatchBytes)
        ) {
          await flushFallbackBatch()
        }
        fallbackBatch.push(row)
        fallbackBatchBytes += rowBytes
        if (fallbackBatch.length >= COMPACT_BATCH_SIZE || fallbackBatchBytes >= maxBatchBytes) {
          await flushFallbackBatch()
        }
        continue
      }
      await emit(row)
    }

    await flushFallbackBatch()

    await flushBatch()
    streamed = sink.current ? await sink.current.close() : null
  } finally {
    // `close` resolving is the only proof every file landed. Anything else,
    // including a `close` that threw part-way, leaves the rest to abort.
    if (!streamed && sink.current) await sink.current.abort()
  }

  if (!columns) {
    if (!layout.commitEmpty) return null
    // An empty generation holds no rows at all, so no fallbacks either.
    await writeCursor(partitionDir, {
      ...layout.cursorAfter(newDirName, 0, { dataFilesBefore, dataFilesAfter: 0 }),
      pendingFallbacks: 0,
    })
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
  // A settle-bearing rewrite examined every fallback row, so its remainder
  // count is exact - record it, resetting whatever the flush path had
  // accumulated. Without a settle context no row was classified; the
  // cursorAfter default carries the old count forward unchanged.
  const cursorNext = layout.cursorAfter(newDirName, totalRows, { dataFilesBefore, dataFilesAfter: newDataFiles })
  await writeCursor(
    partitionDir,
    settle ? { ...cursorNext, pendingFallbacks: remainingFallbacks } : cursorNext
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

/* ----- In-place subset compaction (LLP 0310) -----
 *
 * The generation-swap rewrite above reads and rewrites the whole table,
 * so on a large partition every hour of new flushes cost a full-table
 * rewrite. Routine dueness is instead served here: merge only the
 * fragmented partition tuples, committed as a `replace` snapshot into the
 * SAME generation directory through icebird's files-scoped rewrite. Cost
 * scales with what fragmented; converged tuples and the identity-
 * partitioning floor (one file per tuple) are never re-read. */

/**
 * Merge the live generation's fragmented tuples in place.
 *
 * Returns `'settle-required'` when the victims carry committed gateway
 * fallback rows and a settle context exists: only the whole-generation
 * rewrite can collapse a split twin pair (the native twin may live in a
 * file this pass would not read), so the caller falls through to it. A
 * later round can reach that answer after earlier rounds already committed
 * merges: those stand (every path here conserves rows) and the rewrite the
 * caller runs next writes the cursor.
 *
 * A `noop` result means the dueness heuristics fired but no tuple holds
 * two mergeable files - the partition sits on its floor. The verdict
 * cursor is written here so later ticks skip for that stated reason.
 *
 * @param {string} partitionDir
 * @param {string} liveDir
 * @param {PartitionCursor} cursor
 * @param {MaintenanceConfig} cfg
 * @param {SettleContext | null} settle
 * @returns {Promise<{ noop?: boolean, newEpoch?: number, rowCount: number, dataFilesBefore: number, dataFiles: number, bytesWritten?: number } | 'settle-required' | null>}
 */
async function compactLiveFilesInPlace(partitionDir, liveDir, cursor, cfg, settle) {
  if (!tableExists(liveDir)) return null
  const { resolver, lister } = await createLocalIcebergIO()
  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })
  const tableUrl = tableUrlForDir(liveDir)

  const statsBefore = await liveTableStats(liveDir)
  const dataFilesBefore = statsBefore?.dataFiles ?? countDataFiles(liveDir)

  // Files the table already held when this tick started, and the ones the
  // settle probe has looked at. Every round's victims are probed EXCEPT the
  // files this tick's own earlier rounds wrote: those carry rows that were
  // already offered to the hook, and the rewrite that wrote them applied
  // deletes and changed no row content. Probing round 0 alone would not do,
  // because the round budget stops round 0 long before the fragmented set is
  // exhausted, so later rounds routinely select committed files this tick has
  // never read - a settleable fallback row in one of those would be merged in
  // place and its twin left uncollapsed. The escape still fires only for rows
  // the hook can upgrade right now: an unmatchable fallback (its transcript
  // line never lands) must not buy a whole-generation rewrite on every growth
  // tick, which is LLP 0027's own protection restated for this path - measured
  // live, one permanently-unmatchable row re-created the hourly full rewrite
  // this decision exists to retire.
  /** @type {Set<string> | null} */
  let committedBefore = null
  /** @type {Set<string>} */
  const probed = new Set()

  let merged = false
  /** @type {string | undefined} */
  let mergedSnapshotId
  const roundCap = inPlaceRoundCap(cfg)
  for (let round = 0; round < roundCap; round++) {
    const live = await listLiveDataFiles(liveDir)
    const committed = committedBefore ??= new Set(live.map((file) => file.filePath))
    const victims = selectInPlaceVictims(live, cfg)
    if (victims.length === 0) break
    // The probe loads victim files whole to offer their fallback rows to
    // the hook, so a cursor that says the partition holds none
    // (`pendingFallbacks: 0`, maintained by the flush path and reset by
    // every settle-bearing rewrite) skips it outright. An absent count
    // (legacy cursor) still probes: unknown is not zero.
    if (settle && cursor.pendingFallbacks !== 0) {
      const unprobed = victims.filter((file) => committed.has(file) && !probed.has(file))
      for (const file of unprobed) probed.add(file)
      if (unprobed.length > 0 && await victimFallbacksSettleable(unprobed, resolver, settle)) {
        return 'settle-required'
      }
    }
    const rewritten = await icebergRewrite({ catalog, tableUrl, files: victims })
    // The metadata the commit returned is the authority on which snapshot
    // this merge wrote. Reading the id here rather than from the extra
    // `liveTableStats` load below keeps {@link foreignSortedReplace} able to
    // recognize our own `replace` even when that load comes back null: an
    // unclaimed `replace` is read as the server compactor's layout and
    // re-baselined, which is the LLP 0217 frozen-partition symptom.
    mergedSnapshotId = snapshotIdOf(rewritten) ?? mergedSnapshotId
    merged = true
  }

  if (!merged) {
    await writeCursor(partitionDir, inPlaceVerdictCursor(cursor, dataFilesBefore))
    return { noop: true, rowCount: cursor.rowCount, dataFilesBefore, dataFiles: dataFilesBefore }
  }

  const statsAfter = await liveTableStats(liveDir)
  const dataFilesAfter = statsAfter?.dataFiles ?? countDataFiles(liveDir)
  await writeCursor(
    partitionDir,
    inPlaceCompactedCursor(cursor, { dataFilesBefore, dataFilesAfter }, mergedSnapshotId ?? statsAfter?.snapshotId)
  )
  return { rowCount: cursor.rowCount, dataFilesBefore, dataFiles: dataFilesAfter }
}

/**
 * The current snapshot id of a table metadata, as the string form the cursor
 * records. Undefined when the metadata names no current snapshot.
 *
 * @param {TableMetadata | undefined | null} metadata
 * @returns {string | undefined}
 */
function snapshotIdOf(metadata) {
  const id = metadata?.['current-snapshot-id']
  if (id === undefined || id === null || Number(id) === -1) return undefined
  return String(id)
}

/**
 * Pick the data files one in-place merge round rewrites.
 *
 * A file is a merge candidate only when it is small (below half of
 * `target_file_bytes`: two such files still merge to at most the target,
 * and a file past that mark is already big enough that rewriting it buys
 * little) AND shares its partition tuple with another candidate: a data
 * file cannot span tuples (LLP 0209#tuple-bound), so a tuple's lone file
 * is its floor and healthy big files have nothing to gain.
 * A tuple is taken whole where it fits - splitting one costs rewriting the
 * same rows twice - and the round stops adding tuples once
 * `compact_batch_bytes` of victim data is selected, because the rewrite
 * materializes the victims' rows in memory.
 *
 * A tuple whose small files outweigh that budget by themselves is merged a
 * PREFIX at a time, smallest files first, rather than skipped. Skipping it
 * would freeze it: routine dueness no longer reaches the streaming
 * whole-generation rewrite (only `--force` and the settle escape do), so a
 * skipped tuple keeps the partition due, produces an empty victim set, and
 * collects the floor verdict forever while staying fragmented. The prefix
 * rewrites some rows more than once across ticks and in exchange the live
 * file count falls monotonically. When not even the two smallest candidates
 * fit the round's budget, THIS rewrite cannot merge them within its heap
 * bound and the tuple is left alone: the streaming whole-generation rewrite
 * still could (it batches on the way out), but paying a whole-table rewrite
 * for it on every growth tick is the cost this decision retires, so that
 * tuple waits for `--force`.
 *
 * @ref LLP 0310#victim-selection [implements]: small files, whole tuples, byte-bounded rounds.
 * @param {{ filePath: string, partition: Record<string, unknown>, sizeBytes: number }[]} liveFiles
 * @param {MaintenanceConfig} cfg
 * @returns {string[]}
 */
function selectInPlaceVictims(liveFiles, cfg) {
  /** @type {Map<string, { files: { path: string, bytes: number }[], bytes: number }>} */
  const tuples = new Map()
  for (const file of liveFiles) {
    if (file.sizeBytes >= cfg.target_file_bytes / 2) continue
    const key = JSON.stringify(file.partition ?? {}, (_, v) => typeof v === 'bigint' ? String(v) : v)
    const group = tuples.get(key) ?? { files: [], bytes: 0 }
    group.files.push({ path: file.filePath, bytes: file.sizeBytes })
    group.bytes += file.sizeBytes
    tuples.set(key, group)
  }

  /** @type {string[]} */
  const victims = []
  let budget = cfg.compact_batch_bytes
  for (const group of tuples.values()) {
    if (group.files.length < 2) continue
    if (group.bytes <= budget) {
      for (const file of group.files) victims.push(file.path)
      budget -= group.bytes
      continue
    }
    // Past the round's budget: take the smallest candidates that fit
    // rather than skip the tuple, so a tuple heavier than one round's heap
    // bound still converges. See the doc comment above for why skipping it
    // would be permanent.
    const smallestFirst = [...group.files].sort((a, b) => a.bytes - b.bytes)
    /** @type {string[]} */
    const prefix = []
    let taken = 0
    for (const file of smallestFirst) {
      if (taken + file.bytes > budget) break
      prefix.push(file.path)
      taken += file.bytes
    }
    if (prefix.length < 2) continue
    victims.push(...prefix)
    budget -= taken
  }
  return victims
}

/**
 * Do the victim files hold a committed gateway fallback row that the
 * dataset's settle hook can upgrade RIGHT NOW? A cheap `attributes` scan
 * finds candidate files; only those get a full read, and their fallback
 * rows are offered to the settle hook in memory. Following
 * {@link resettleFallbackRows}' convention, an upgraded row comes back as
 * a new object; a hook that returns every row unchanged has no twin to
 * collapse, so the caller merges in place and the rows survive verbatim.
 * Nothing here is committed: the hook's real run happens inside the
 * whole-generation rewrite this answer routes to.
 *
 * A file that cannot be read answers false: the merge that follows will
 * surface the real error, where the failure path records the spent
 * attempt (LLP 0218).
 *
 * Discarding the hook's answer is only safe because the enricher contract
 * requires `settle` to be pure and idempotent: this call is speculative, on
 * rows that may never be committed, and it repeats next tick.
 *
 * @ref LLP 0312#settle-purity [constrained-by]: the probe is a speculative call the hook must not notice.
 * @param {string[]} filePaths
 * @param {Resolver} resolver
 * @param {SettleContext} settle
 * @returns {Promise<boolean>}
 */
async function victimFallbacksSettleable(filePaths, resolver, settle) {
  for (const filePath of filePaths) {
    /** @type {Record<string, unknown>[]} */
    let fallbackRows
    try {
      const probe = await Promise.resolve(resolver.reader(filePath))
      const attrs = /** @type {Record<string, unknown>[]} */ (
        await parquetReadObjects({ file: probe, columns: ['attributes'] })
      )
      if (!attrs.some(isGatewayFallbackRow)) continue
      const file = await Promise.resolve(resolver.reader(filePath))
      const rows = /** @type {Record<string, unknown>[]} */ (
        await parquetReadObjects({ file })
      )
      fallbackRows = rows.filter(isGatewayFallbackRow)
    } catch {
      // Unreadable or attributes-less file: not evidence of a fallback row.
      continue
    }
    if (fallbackRows.length === 0) continue
    try {
      const out = await settle.settle(fallbackRows, { storage: settle.storage })
      if (
        Array.isArray(out) &&
        out.length === fallbackRows.length &&
        out.some((row, i) => row !== fallbackRows[i])
      ) {
        return true
      }
    } catch {
      // A throwing hook settles nothing this tick; degrade to in-place.
    }
  }
  return false
}

/**
 * Cursor after an in-place merge: same generation, same rows, a fresh
 * compaction record in live-count units. No `previousTableDir` - nothing
 * was swapped, so there is nothing for the retirement sweep to reclaim;
 * the superseded files are released by the unreferenced-file sweep once
 * snapshot retention lets go of them.
 *
 * The committed snapshot id rides along so {@link foreignSortedReplace}
 * can tell this `replace` from the server compactor's; see its comment.
 * Omitted, rather than recorded as empty, when the post-merge metadata
 * could not be read: an absent id reads as "not ours", the conservative
 * direction (a recognition, never a rewrite of a foreign layout).
 *
 * @param {PartitionCursor} cursor
 * @param {{ dataFilesBefore: number, dataFilesAfter: number }} outcome
 * @param {string} [snapshotId]  the snapshot the merge committed
 * @returns {PartitionCursor}
 */
function inPlaceCompactedCursor(cursor, outcome, snapshotId) {
  return {
    ...cursor,
    compaction: {
      compactedAt: new Date().toISOString(),
      ...compactionOutcomeRecord(outcome),
      ...(snapshotId ? { inPlaceSnapshotId: snapshotId } : {}),
    },
  }
}

/**
 * Cursor for a partition the dueness heuristics flag but whose every
 * tuple already sits at one file: the ineffectiveness verdict, reached by
 * inspection instead of by a rewrite that reproduces the layout. Records
 * before == after, so {@link compactionKnownIneffective} reports it and
 * the baseline gate skips the partition until new data flushes.
 *
 * @ref LLP 0310#floor-is-a-verdict [implements]: the verdict costs a listing, not a rewrite.
 * @param {PartitionCursor} cursor
 * @param {number} liveDataFiles
 * @returns {PartitionCursor}
 */
function inPlaceVerdictCursor(cursor, liveDataFiles) {
  const compaction = isPlainObject(cursor.compaction) ? cursor.compaction : {}
  /** @type {Record<string, unknown>} */
  const next = {
    ...compaction,
    ...compactionOutcomeRecord({ dataFilesBefore: liveDataFiles, dataFilesAfter: liveDataFiles }),
  }
  // The verdict settles whatever a failed attempt left hanging, exactly as
  // a foreign-replace recognition does (LLP 0218#report-the-spent-attempt).
  delete next.attemptFailedAt
  return { ...cursor, compaction: next }
}

/**
 * Delete the live generation's files that no retained snapshot references.
 *
 * The referenced set is every manifest list, manifest, and data/delete
 * file reachable from ANY snapshot still in the table metadata, so a file
 * is only reclaimed once snapshot expiry has released every snapshot that
 * could read it - retention is the reader-safety window. Two guards on
 * top: nothing younger than {@link ORPHAN_GRACE_MS} is touched (a
 * concurrent append stages its files before its commit references them),
 * and metadata versions keep their newest {@link METADATA_VERSIONS_KEPT}
 * regardless. A data file's grep sidecar dies with it.
 *
 * Metadata staging names a crashed publish left behind are reclaimed here
 * too, in a pass that runs BEFORE the referenced-set walk: nothing
 * references them, so the walk has nothing to say about them and its early
 * returns must not take the one reclaimer they have with them. The grace
 * window is the whole of their safety.
 *
 * @param {string} tableDir
 * @returns {Promise<number>} files removed
 */
async function sweepUnreferencedTableFiles(tableDir) {
  if (!tableExists(tableDir)) return 0

  let removed = 0
  const now = Date.now()
  /** @param {string} filePath */
  const removeStale = (filePath) => {
    try {
      if (now - fs.statSync(filePath).mtimeMs <= ORPHAN_GRACE_MS) return
      fs.rmSync(filePath, { force: true })
      removed++
    } catch { /* stat/remove race: a later tick retries */ }
  }

  const metadataDir = path.join(tableDir, 'metadata')
  /** @type {string[]} */
  let metaNames
  try {
    metaNames = fs.readdirSync(metadataDir)
  } catch {
    metaNames = []
  }

  // A staged write that never got to publish, or published and then lost the
  // race to unlink its own staging name. On the source-table layout no
  // generation directory is ever retired out from under it, so this sweep is
  // the only reclaimer it has, and nothing else in the tree even looks at the
  // name: it survives every clause of the metadata loop below by falling
  // through all of them.
  //
  // It runs HERE, ahead of the referenced-set walk, rather than in that loop.
  // Every other candidate the sweep weighs is a file some snapshot might
  // name, so the walk returns early rather than guess when it cannot build
  // the set. A staging name is unreferenced by construction, so the set has
  // nothing to say about it, and the reachable early return is the ordinary
  // one: a table whose metadata is on disk with no snapshot committed yet
  // never reaches the metadata loop at all.
  //
  // `removeStale`'s grace window is what keeps this off a write still in
  // flight, and it is sufficient HERE and only here: every publish into
  // `metadata/` holds its staged file open for milliseconds. The one writer
  // that stays open across a whole rewrite with a stale mtime (LLP 0209
  // #descriptor-parking) stages under `data/`, which this pass never reads.
  // @ref LLP 0316#staged-writes-are-reclaimed [implements]: the only reclaimer the leak has must not be gated on a referenced set it does not need.
  for (const name of metaNames) {
    if (isStagedWriteName(name)) removeStale(path.join(metadataDir, name))
  }

  const { resolver, lister } = await createLocalIcebergIO()
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: tableUrlForDir(tableDir), resolver, lister })
  const snapshots = metadata.snapshots ?? []
  if (snapshots.length === 0) return removed

  /** @type {Set<string>} */
  const referenced = new Set()
  /** @type {Set<string>} */
  const manifestPathsSeen = new Set()
  for (const snapshot of snapshots) {
    const listPath = snapshot['manifest-list']
    if (!listPath) continue
    referenced.add(path.basename(listPath))
    /** @type {{ manifest_path: string, manifest_length?: number | bigint }[]} */
    let manifests
    try {
      manifests = /** @type {any} */ (await fetchAvroRecords(listPath, resolver))
    } catch {
      // An unreadable manifest list means an unknown referenced set: keep
      // everything rather than delete a file a snapshot may still name.
      // `removed`, not 0: the staging pass above answers to no referenced
      // set and has already run.
      return removed
    }
    for (const manifest of manifests) {
      referenced.add(path.basename(manifest.manifest_path))
      if (manifestPathsSeen.has(manifest.manifest_path)) continue
      manifestPathsSeen.add(manifest.manifest_path)
      /** @type {{ data_file: { file_path: string } }[]} */
      let entries
      try {
        entries = /** @type {any} */ (
          await fetchAvroRecords(manifest.manifest_path, resolver, Number(manifest.manifest_length))
        )
      } catch {
        return removed
      }
      // Every status, including DELETED: an entry that still appears in a
      // retained snapshot's manifest names a file a time-travel read of
      // that snapshot's ancestors may resolve. Conservative is cheap here.
      for (const entry of entries) referenced.add(path.basename(entry.data_file.file_path))
    }
  }

  const dataDir = path.join(tableDir, 'data')
  /** @type {Set<string>} */
  let dataNames
  try {
    dataNames = new Set(fs.readdirSync(dataDir))
  } catch {
    dataNames = new Set()
  }
  for (const name of dataNames) {
    if (name.endsWith('.index.parquet')) {
      // A sidecar lives and dies with its data file.
      const base = name.slice(0, -'.index.parquet'.length) + '.parquet'
      if (!dataNames.has(base)) removeStale(path.join(dataDir, name))
      continue
    }
    if (!name.endsWith('.parquet') && !name.endsWith('.puffin')) continue
    if (referenced.has(name)) continue
    removeStale(path.join(dataDir, name))
    // Only a parquet data file has a sidecar. `sidecarPathFor` rewrites a
    // `.parquet` suffix, so handing it a `.puffin` name returns that name
    // back and the file would be handed to `removeStale` a second time.
    if (!name.endsWith('.parquet')) continue
    const sidecar = sidecarPathFor(name)
    if (dataNames.has(sidecar)) removeStale(path.join(dataDir, sidecar))
  }

  const versions = metaNames
    .map((name) => ({ name, version: /^v(\d+)\.metadata\.json$/.exec(name)?.[1] }))
    .filter((entry) => entry.version !== undefined)
    .sort((a, b) => Number(b.version) - Number(a.version))
  const keptVersions = new Set(versions.slice(0, METADATA_VERSIONS_KEPT).map((entry) => entry.name))
  for (const name of metaNames) {
    if (name === 'version-hint.text') continue
    // Already offered to the sweep above, before the referenced-set walk.
    if (isStagedWriteName(name)) continue
    if (/\.metadata\.json$/.test(name)) {
      if (!/^v\d+\.metadata\.json$/.test(name)) continue
      if (keptVersions.has(name)) continue
      removeStale(path.join(metadataDir, name))
      continue
    }
    if (!name.endsWith('.avro')) continue
    if (referenced.has(name)) continue
    removeStale(path.join(metadataDir, name))
  }

  return removed
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
 * Read only the identity columns needed to recognize every native twin in a
 * generation. Keeping these short keys is bounded by row count; keeping the
 * corresponding gateway rows retained their large content and attributes
 * columns and made daemon compaction heap-sized.
 *
 * @ref LLP 0301#bounded-resettle [implements]: a narrow identity pass makes
 * later fallback batches independent of scan order.
 * @param {string} tableDir
 * @param {TableMetadata | undefined} metadata
 * @returns {Promise<Set<string>>}
 */
async function scanNativePartIds(tableDir, metadata) {
  const partIds = new Set()
  for await (const row of scanRowsFromTable(
    tableDir,
    ['attributes', 'part_id', 'message_id', 'part_index'],
    metadata ? { metadata } : undefined
  )) {
    if (isGatewayFallbackRow(row)) continue
    const key = rowPartId(row)
    if (key !== undefined) partIds.add(key)
  }
  return partIds
}

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
 *     `part_id` found in the narrow identity pass (its native twin) is the
 *     duplicate the race left behind: drop it. The native twin wins. The
 *     twins share
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
 * @param {Set<string>} emittedPartIds  native and already-emitted upgraded part_ids in this partition rewrite
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
 * Does the partition hold at least one committed gateway fallback row?
 * Used to force a compaction rewrite even when the file-count heuristics
 * say compaction isn't due: otherwise a split twin pair in a small,
 * never-compacted partition would never get re-settled.
 *
 * Answered from `cursor.pendingFallbacks` when present: the flush path
 * counts marker rows as they land and every generation rewrite records the
 * exact remainder, so this is a field read - no attributes decode. A
 * cursor from before the count existed pays the legacy full scan
 * ({@link hasResettleCandidate}) ONCE and caches the verdict: a hit seeds
 * the count as "at least one" (the rewrite it triggers restores the exact
 * number), a miss seeds zero so a clean table never re-scans. Measured
 * live, the uncached scan decoded every recorded exchange in the table
 * every tick and OOMed the daemon hourly on a large gateway cache.
 *
 * Only a scan that completed is a verdict. One that could not read the
 * table answers "no sweep this tick" and caches nothing, so a later tick
 * classifies the partition again - after the cooldown its failure stamped
 * on the cursor, because a permanently unreadable partition's growth gate
 * never closes and the unknown answer would otherwise re-pay the whole
 * decode every tick, forever.
 *
 * @ref LLP 0027#re-settle-sweep: gate the sweep on the flush-maintained count.
 * @ref LLP 0319#cool-the-retry-down [implements]: the unknown answer costs one scan per window, not one per tick.
 * @param {string} partitionDir
 * @param {PartitionCursor} cursor
 * @param {string} tableDir
 * @param {boolean} dryRun
 * @returns {Promise<boolean>}
 */
async function hasPendingFallbacks(partitionDir, cursor, tableDir, dryRun) {
  if (typeof cursor.pendingFallbacks === 'number') return cursor.pendingFallbacks > 0
  // A scan this partition already failed, recently. Skip it: it caches
  // nothing either way, and the sweep it might have forced could not run
  // on a table the scan cannot read.
  // @ref LLP 0319#cool-the-retry-down [implements]: the skip is a delay on the retry, never a verdict about the partition.
  if (resettleScanCoolingDown(cursor)) {
    getActiveSpan()?.setAttribute('resettle_scan_cooling_down', true)
    return false
  }
  const found = await hasResettleCandidate(tableDir)
  // The scan could not read the table (an EACCES on a live data file, a
  // half-written parquet). Unknown, not zero: the seed is permanent, so
  // writing one here for a scan that never looked would strand this
  // partition's marker rows until an append happened to flip the count off
  // zero, or a human ran `hyp query maintain --force`. Unknown keeps the
  // conservative direction the rest of this gate takes - it costs another
  // scan, which is the cost the whole field exists to bound, and the stamp
  // below is what keeps that cost from recurring every tick for as long as
  // the table stays unreadable.
  if (found === undefined) {
    getActiveSpan()?.setAttribute('resettle_scan_unreadable', true)
    if (!dryRun) await stampResettleScanFailure(partitionDir)
    return false
  }
  // A dry run reports what a real run WOULD do and writes nothing - the
  // rebaseline and the rewrite are both guarded the same way. A preview
  // that persisted the seed would also make itself unrepeatable: the next
  // run, dry or not, would read the cached verdict instead of classifying
  // the partition, so the preview would have changed what it previewed.
  // The failure stamp above is withheld for the same reason: a preview must
  // not decide when the daemon next looks.
  if (dryRun) return found
  // Seed under the mutation lock, and only if a flush has not concretized
  // the count while the scan ran: a concurrent append's tally must win over
  // this coarse verdict.
  await withPartitionMutationLock(partitionDir, async () => {
    const current = tryReadCursorSync(partitionDir)
    if (!current || typeof current.pendingFallbacks === 'number') return
    await writeCursor(partitionDir, { ...withoutResettleScanStamp(current), pendingFallbacks: found ? 1 : 0 })
  })
  return found
}

/**
 * Is this partition's last failed seeding scan recent enough that the tick
 * should not attempt another?
 *
 * Read off the cursor and nothing else, like every other maintenance skip.
 * Anything the stamp cannot be read as a failure that happened within the
 * window - absent, unparseable, or dated in the future by a clock that
 * moved - answers false and the scan runs: suppressing a scan on state
 * this function cannot interpret is the direction that hides marker rows,
 * and re-scanning is only ever a cost.
 *
 * @ref LLP 0319#cool-the-retry-down [implements]: the window is measured from the recorded failure.
 * @param {PartitionCursor} cursor
 * @returns {boolean}
 */
function resettleScanCoolingDown(cursor) {
  const c = cursor.compaction
  if (!isPlainObject(c) || typeof c.resettleScanFailedAt !== 'string') return false
  const failedMs = Date.parse(c.resettleScanFailedAt)
  if (!Number.isFinite(failedMs)) return false
  const sinceMs = Date.now() - failedMs
  return sinceMs >= 0 && sinceMs < RESETTLE_SCAN_COOLDOWN_MS
}

/**
 * Record that this tick's seeding scan could not read the table.
 *
 * Written into the cursor's `compaction` block beside the re-settle
 * baseline, which is where the sweep's other cursor state lives: an append
 * carries that block through untouched, so ordinary write traffic does not
 * reopen the retry, while every rewrite, recognition, and in-place verdict
 * replaces the block wholesale and so drops the stamp with the record that
 * supersedes it. All three of those prove the table was readable.
 *
 * Skipped when a flush concretized the count while the scan ran, for the
 * same reason the seed below it is: a real tally outranks anything this
 * path knows, and a stamp written over it would be dead state.
 *
 * @ref LLP 0319#cool-the-retry-down [implements]: the failure is stamped where a later success clears it.
 * @param {string} partitionDir
 * @returns {Promise<void>}
 */
async function stampResettleScanFailure(partitionDir) {
  await withPartitionMutationLock(partitionDir, async () => {
    const current = tryReadCursorSync(partitionDir)
    if (!current || typeof current.pendingFallbacks === 'number') return
    const compaction = isPlainObject(current.compaction) ? current.compaction : {}
    await writeCursor(partitionDir, {
      ...current,
      compaction: { ...compaction, resettleScanFailedAt: new Date().toISOString() },
    })
  })
}

/**
 * The same cursor with any scan-failure stamp dropped. A completed scan
 * has said everything there is to say about this partition, so the record
 * of the one that could not is spent.
 *
 * @param {PartitionCursor} cursor
 * @returns {PartitionCursor}
 */
function withoutResettleScanStamp(cursor) {
  if (!isPlainObject(cursor.compaction)) return cursor
  const compaction = { ...cursor.compaction }
  delete compaction.resettleScanFailedAt
  return { ...cursor, compaction }
}

/**
 * Legacy seeding scan behind {@link hasPendingFallbacks}: scans only the
 * `attributes` column and short-circuits on the first hit. Runs at most
 * once per partition, to classify a cursor written before
 * `pendingFallbacks` existed.
 *
 * Three answers, not two: `true` found one, `false` read the whole column
 * and found none, and `undefined` could not read it. The caller caches a
 * verdict forever, so "could not look" must not arrive as "found none".
 *
 * @param {string} tableDir
 * @returns {Promise<boolean | undefined>}
 */
async function hasResettleCandidate(tableDir) {
  if (!tableExists(tableDir)) return false
  try {
    for await (const row of scanRowsFromTable(tableDir, ['attributes'])) {
      if (isGatewayFallbackRow(row)) return true
    }
  } catch (err) {
    // Not rethrown: an unreadable table must not fail the partition's whole
    // tick, and the caller's `undefined` already keeps the verdict uncached.
    // But unknown re-scans, on a cooldown, until the read succeeds, so
    // record WHAT failed - the caller's boolean cannot separate a transient
    // EACCES from a permanently torn data file or a bug in this scan, and
    // only the first of those clears itself. Without this the recurring
    // whole-table decode is the only symptom, with nothing naming its cause.
    // Bounded here because `setAttribute` skips `buildAttrs`, which is what
    // applies the 512-char cap to every other emission. This is the only
    // kernel attribute whose value is authored elsewhere (hyparquet, or the
    // OS on an fs error), so the emitter cannot vouch for its length: a
    // decoder that quotes the bytes it choked on would put recorded
    // exchange content on a span, and the cap is the backstop against that.
    // @ref LLP 0021#the-attribute-contract [constrained-by]: bound the value the helper would have bounded.
    const scanError = err instanceof Error ? err.message : String(err)
    getActiveSpan()?.setAttribute('resettle_scan_error', scanError.slice(0, 512))
    return undefined
  }
  return false
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
 * Did a rewrite from `before` data files to `after` reduce the count?
 *
 * Any reduction counts. A rewrite that shaves one file off is progress,
 * and the baseline gate still requires the live count to move before the
 * next attempt, so a marginal gain cannot become a rewrite loop.
 *
 * Undefined when the partition was already at its floor: no data files, or
 * a single one. A partition holding one file is maximally compact, so the
 * 1 to 1 rewrite every low-volume partition gets on its first tick (the
 * avg-file-size heuristic flags any file under `compact_avg_file_bytes`)
 * reduced nothing because there was nothing to reduce. Treating that as a
 * verdict would report every ordinary small partition as unshrinkable,
 * every tick, and drown the one line that is true.
 *
 * @ref LLP 0217#record-effectiveness [implements]: a rewrite of a partition at its floor is evidence about neither the writer nor the partition.
 * @param {number} before
 * @param {number} after
 * @returns {boolean | undefined}
 */
function rewriteReducedFiles(before, after) {
  if (before <= 1) return undefined
  return after < before
}

/**
 * The data-file count the rewrite this cursor records started from.
 * Undefined for a cursor written before the effectiveness record existed.
 *
 * @param {PartitionCursor} cursor
 * @returns {number | undefined}
 */
function compactionFilesBefore(cursor) {
  const c = cursor.compaction
  if (isPlainObject(c) && typeof c.dataFilesBefore === 'number') return c.dataFilesBefore
  return undefined
}

/**
 * Did the compaction this cursor records reduce the partition's data-file
 * count? Undefined when the cursor predates the effectiveness record, in
 * which case what the rewrite achieved is unknown rather than known bad.
 *
 * @param {PartitionCursor} cursor
 * @returns {boolean | undefined}
 */
function compactionReducedFiles(cursor) {
  const before = compactionFilesBefore(cursor)
  const after = resettleBaselineFiles(cursor)
  if (before === undefined || after === undefined) return undefined
  return rewriteReducedFiles(before, after)
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
 * Cursor carrying this build's writer generation and the moment the attempt
 * that spent it failed: the record of an attempt that was made, without a
 * claim about what it achieved. Written when a retry granted by
 * {@link compactionVerdictStale} fails, so the retry is spent by the
 * attempt rather than by its success. The baseline and any recorded
 * effectiveness are left exactly as they were: a rewrite that threw
 * part-way proves nothing about whether the partition can be shrunk.
 *
 * The timestamp is what makes the spent attempt reportable. Without it the
 * stamp is indistinguishable from the generation a successful rewrite
 * records, so every later tick describes the frozen partition exactly as it
 * describes a converged one.
 *
 * @ref LLP 0217#retry-on-writer-change [implements]: one attempt per writer generation, counted whether or not it succeeded.
 * @ref LLP 0218#report-the-spent-attempt [implements]: the stamp says when the attempt failed, so the skip that follows has a reason to state.
 * @param {PartitionCursor} cursor
 * @param {string} failedAt
 * @returns {PartitionCursor}
 */
function stampWriterGeneration(cursor, failedAt) {
  const compaction = isPlainObject(cursor.compaction) ? cursor.compaction : {}
  return {
    ...cursor,
    compaction: {
      ...compaction,
      writerGeneration: COMPACTION_WRITER_GENERATION,
      attemptFailedAt: failedAt,
    },
  }
}

/**
 * When the compaction attempt this cursor records failed, if it did and if
 * that failure is still the last thing known about the partition.
 *
 * Undefined once the record carries an effectiveness verdict, whether the
 * rewrite that committed it ran before the failing one or threw after
 * committing. A verdict says something about the partition; an error says
 * only that the attempt ended, so the verdict is the better reason to state
 * and {@link compactionKnownIneffective} reports it.
 *
 * Undefined too when the stamp names a writer generation this build does not
 * run: that partition is owed a fresh attempt (see
 * {@link compactionVerdictStale}) rather than being frozen by the old one.
 *
 * @ref LLP 0218#report-the-spent-attempt [implements]: a spent attempt is readable from the cursor alone, like every other skip reason.
 * @param {PartitionCursor} cursor
 * @returns {string | undefined}
 */
function compactionAttemptFailedAt(cursor) {
  const c = cursor.compaction
  if (!isPlainObject(c) || typeof c.attemptFailedAt !== 'string' || c.attemptFailedAt === '') return undefined
  if (c.writerGeneration !== COMPACTION_WRITER_GENERATION) return undefined
  if (compactionReducedFiles(cursor) !== undefined) return undefined
  return c.attemptFailedAt
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
  // A recognition also settles whatever a failed attempt left hanging: the
  // layout on disk is the foreign compactor's and the kernel is not going to
  // rewrite it, so "the last retry failed" has stopped being the reason this
  // partition is skipped (LLP 0218#report-the-spent-attempt).
  delete next.attemptFailedAt
  return { ...cursor, compaction: next }
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
    // Grep sidecars live beside their data files as `<file>.index.parquet`
    // and MUST stay out of this count: it feeds the compaction heuristics
    // and the LLP 0199 baseline gate, so counting sidecars would read a
    // just-compacted-and-indexed partition as "grew since compaction" and
    // rewrite it every tick forever.
    return fs.readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.parquet') && !e.name.endsWith('.index.parquet'))
      .length
  } catch {
    return 0
  }
}

/**
 * How many of the table's data files have a grep sidecar beside them, and
 * how many could. A pure directory scan (no metadata load), matching the
 * cost profile of the other status counters. The pairing rule is not
 * restated here: `sidecarPathFor` owns the naming contract the build pass
 * publishes under and the grep service probes, so a second copy of it would
 * let this counter drift into reporting coverage that does not exist.
 *
 * The denominator is measured here rather than taken from `countDataFiles`,
 * which counts position-delete files too (icebird writes them into the same
 * `data/` directory as `<uuid>-deletes.parquet`). No sidecar is ever built
 * beside a delete file, so borrowing that count would make any partition
 * purged since its last compaction report permanently incomplete coverage,
 * and advise a compaction that cannot close the gap.
 *
 * @param {string} tableDir
 * @returns {{ indexed: number, indexable: number }}
 */
function countIndexCoverage(tableDir) {
  const dataDir = path.join(tableDir, 'data')
  const coverage = { indexed: 0, indexable: 0 }
  try {
    const names = new Set(fs.readdirSync(dataDir))
    for (const name of names) {
      if (!name.endsWith('.parquet')) continue
      if (name.endsWith('.index.parquet') || name.endsWith('-deletes.parquet')) continue
      coverage.indexable += 1
      if (names.has(sidecarPathFor(name))) coverage.indexed += 1
    }
    return coverage
  } catch {
    return { indexed: 0, indexable: 0 }
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
 * Data bytes only: grep sidecars are excluded for the same reason
 * `countDataFiles` excludes them; the avg-file-size heuristic divides
 * these bytes by that count, so the two must see the same file set.
 *
 * The test is `includes`, not `endsWith`, because the build's publish
 * scratch (`<file>.index.parquet.<uuid>.tmp`) is index bytes too, and it
 * is the half of the pair that survives a crash: `countDataFiles` already
 * skips it for want of a `.parquet` suffix, so counting its bytes would
 * break the shared-file-set invariant above in the dangerous direction.
 * The average would read HIGHER than the partition really is, and
 * `needsCompaction` compacts when the average is LOW, so a genuinely
 * fragmented partition would look healthy and go unrewritten until its
 * generation retires.
 *
 * @param {string} tableDir
 * @returns {number}
 */
function measureDataDir(tableDir) {
  return measureDir(path.join(tableDir, 'data'), (name) => !name.includes('.index.parquet'))
}

/**
 * @param {string} dir
 * @param {(name: string) => boolean} [include]
 * @returns {number}
 */
function measureDir(dir, include) {
  let total = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (include && !include(entry.name)) continue
      try {
        total += fs.statSync(path.join(dir, entry.name)).size
      } catch { /* skip */ }
    }
  } catch { /* no dir */ }
  return total
}
