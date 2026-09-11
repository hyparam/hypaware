// @ts-check

import fs from 'node:fs'
import path from 'node:path'
import { noteProductPipeline } from '../product_telemetry/client.js'

import { Attr, getKernelInstruments, getLogger, withSpan } from '../observability/index.js'
import { readFirstSyncDeadline } from '../usage-policy/first_sync_hold.js'

/**
 * @import { DatasetRegistration, ExportResult, QueryPartition } from '../../../hypaware-plugin-kernel-types.js'
 * @import { Span } from '../observability/runtime.js'
 * @import { ExtendedSinkHandle } from '../../../src/core/registry/types.js'
 * @import { DriverOptions, TickOptions, TickReport } from '../../../src/core/sinks/types.js'
 */

/**
 * Build the kernel sink driver. The driver iterates sink handles on
 * each `tick({ now })`, evaluates each sink's cron expression against
 * `now`, computes the set of currently-discoverable cache partitions
 * for the sink's datasets, and asks the sink to export them. Each call
 * is wrapped in a `sink.export_batch` span carrying
 * `hyp_sink_instance`, `partitions_count`, `bytes_written`, and
 * `status`. Failed batches land in
 * `<state>/sinks/<instance>/outbox/<batchId>.json` and tick the
 * `hyp_sink_export_failures_total` counter.
 *
 * @param {DriverOptions} opts
 */
export function createSinkDriver(opts) {
  const { sinkRegistry, queryRegistry, storage, stateRoot, config } = opts
  if (!sinkRegistry) throw new Error('createSinkDriver: sinkRegistry required')
  if (!queryRegistry) throw new Error('createSinkDriver: queryRegistry required')
  if (!storage) throw new Error('createSinkDriver: storage required')
  if (!stateRoot) throw new Error('createSinkDriver: stateRoot required')
  const log = getLogger('sink-driver')
  const instruments = getKernelInstruments()

  let batchSeq = 0

  /**
   * @param {TickOptions} [tickOpts]
   * @returns {Promise<TickReport>}
   */
  async function tick(tickOpts = {}) {
    const now = tickOpts.now ?? new Date()
    const source = tickOpts.source ?? 'manual'
    instruments.sinkTicksTotal.add(1, { source })
    // An enrolling login's first-sync review window is open: hold the whole
    // tick so the daemon's first backfill cannot forward rows the user is
    // still reviewing (the one-time window LLP 0069's #281 note deferred).
    // Held rows stay in the cache and export on the first tick after the
    // deadline passes; the deadline is absolute and bounded, so a machine can
    // never stall exports indefinitely. The hold is driver-wide (every sink,
    // not just off-machine ones): the driver cannot know which sinks leave the
    // machine without a new registration concept, and briefly deferring a
    // local sink is harmless where a missed forward hold is not.
    // @ref LLP 0101#hold [implements]: exports nothing while now < the marker's absolute deadline
    const firstSyncDeadline = await readFirstSyncDeadline({ stateDir: stateRoot, now: now.getTime() })
    if (firstSyncDeadline !== null && now.getTime() < firstSyncDeadline) {
      log.info('sink.tick_held_first_sync', {
        [Attr.COMPONENT]: 'sinks',
        [Attr.OPERATION]: 'sink.tick',
        hyp_reason: 'first_sync_hold',
        hyp_deadline: new Date(firstSyncDeadline).toISOString(),
        source,
      })
      return { sinks: [], held: 'first_sync_hold' }
    }
    const handles = sinkRegistry.listHandles()
    /** @type {TickReport['sinks']} */
    const sinks = []
    for (const handle of handles) {
      if (tickOpts.sinkInstance && handle.instanceName !== tickOpts.sinkInstance) continue
      const schedule = typeof handle.config?.schedule === 'string' ? handle.config.schedule : '* * * * *'
      const isDue = tickOpts.force === true || cronMatches(schedule, now)
      if (!isDue) continue
      tickOpts.onProgress?.(handle.instanceName)
      const report = await runSink(handle, schedule, now, tickOpts.onProgress)
      sinks.push(report)
    }
    return { sinks }
  }

  /**
   * @param {ExtendedSinkHandle} handle
   * @param {string} schedule
   * @param {Date} now
   * @param {TickOptions['onProgress']} onProgress
   * @returns {Promise<TickReport['sinks'][number]>}
   */
  async function runSink(handle, schedule, now, onProgress) {
    const instance = handle.instanceName
    const batchId = nextBatchId(now, instance)
    const partitions = await discoverReadyPartitions(handle)
    return withSpan(
      'sink.export_batch',
      {
        [Attr.COMPONENT]: 'sinks',
        [Attr.OPERATION]: 'sink.export_batch',
        [Attr.PLUGIN]: handle.plugin,
        [Attr.SINK_INSTANCE]: instance,
        hyp_sink_kind: handle.kind,
        hyp_batch_id: batchId,
        hyp_sink_schedule: schedule,
        partitions_count: partitions.length,
        status: 'ok',
      },
      async (span) => {
        /** @type {ExportResult} */
        let result
        try {
          // `handle.encoder` is the writer plugin's own object and `format` is
          // the one field on it `instantiate` does not validate, so this read is
          // a call into plugin code on every tick. It belongs inside the try
          // that already guards `exportBatch`: an encoder the kernel cannot read
          // is this batch failing, not the tick, which the daemon swallows as
          // `daemon.tick_failed` - stopping every sink's export for the daemon's
          // life while `hyp status` still reads healthy (issue #1514).
          const format = handle.encoder?.format ?? 'native'
          const reported = await handle.sink.exportBatch(
            { batchId, partitions },
            { format, schedule, ...(onProgress ? { onProgress: (progress) => onProgress(instance, progress) } : {}) }
          )
          result = readExportResult(reported, partitions)
        } catch (err) {
          const message = describeThrown(err)
          /** @type {ExportResult} */
          const failed = { status: 'failed', partitionsExported: 0, retryPartitions: partitions, error: message }
          await persistOutbox(handle, batchId, partitions, message)
          recordFailure(handle, batchId, partitions.length, message, span)
          return summarize(instance, failed)
        }
        const status = result.status
        const exported = result.partitionsExported
        const bytesWritten = result.bytesWritten ?? 0
        span.setAttribute('partitions_exported', exported)
        span.setAttribute('bytes_written', bytesWritten)
        if (status === 'exported') {
          noteProductPipeline('export', { bytes: bytesWritten })
          instruments.sinkExportsTotal.add(1, {
            [Attr.SINK_INSTANCE]: instance,
            [Attr.STATUS]: 'ok',
          })
          if (bytesWritten > 0) {
            instruments.sinkExportBytes.add(bytesWritten, { [Attr.SINK_INSTANCE]: instance })
          }
          span.setAttribute('status', 'ok')
          log.info('sink.export_batch.ok', {
            [Attr.SINK_INSTANCE]: instance,
            hyp_batch_id: batchId,
            partitions_count: partitions.length,
            partitions_exported: exported,
            bytes_written: bytesWritten,
          })
        } else {
          const retryParts = result.retryPartitions ?? partitions
          const message = result.error ?? 'sink reported non-ok status'
          await persistOutbox(handle, batchId, retryParts, message)
          recordFailure(handle, batchId, retryParts.length, message, span)
          span.setAttribute('status', status === 'partial' ? 'degraded' : 'failed')
        }
        return summarize(instance, result)
      },
      { component: 'sinks' }
    )
  }

  /**
   * @param {ExtendedSinkHandle} handle
   * @returns {Promise<QueryPartition[]>}
   */
  async function discoverReadyPartitions(handle) {
    const datasets = queryRegistry.listDatasets()
    /** @type {QueryPartition[]} */
    const all = []
    /** @type {Set<string>} */
    const seen = new Set()
    // Keep a partition if it is exportable now: either it has no backing
    // table path, or a table/pending-spool exists at it. Dedup by path so
    // the pre- and post-flush discovery passes don't double-list one.
    const keep = (/** @type {QueryPartition} */ part) => {
      // One read, like `readDatasetName` below: `part` is the plugin's own
      // object, so `tablePath` is free to answer differently each time it is
      // asked, and this single value has to be the dedup key, the subject of
      // the existence check, and what gets recorded as seen. Read four times, a
      // partition could pass `tableExists` on one path and be filed under
      // another, so the dedup this exists for stopped holding and the same
      // partition was handed to the sink once per discovery pass.
      const tablePath = part.tablePath
      if (!tablePath) { all.push(part); return }
      if (seen.has(tablePath) || !storage.tableExists(tablePath)) return
      seen.add(tablePath)
      all.push(part)
    }
    for (const dataset of datasets) {
      const datasetName = readDatasetName(dataset)
      try {
        const discover = () => dataset.discoverPartitions({
          config: config ?? { version: 2 },
          scope: { limit: 1000 },
          cacheDir: storage.cacheRoot,
        })
        const parts = await discover()
        // Keep everything exportable right now, including spool-pending
        // partitions a sink reads directly.
        for (const part of parts ?? []) keep(part)
        // Then flush any pending spool and re-discover. A dataset with no
        // `cachePartitioning` declaration spools under one label (e.g.
        // `<dataset>/all`) but commits under `source=<client>` on flush,
        // so its rows would otherwise stay invisible to discovery, and a
        // low-traffic source that never trips the spool's size threshold
        // would never be exported at all. Flushing surfaces the committed
        // `source=` partitions; `keep` adds the ones not already listed.
        let flushedAny = false
        for (const part of parts ?? []) {
          // Read once, before the guard, and flush and report the same string.
          // Asked separately, the plugin's accessor could answer one path to
          // `hasPendingSync` and another to `flushTable`, which is the kernel
          // flushing a table the plugin named at that instant rather than the
          // one it had just said had rows waiting. The last of those reads was
          // the `tablePath` on the record below, inside the catch, where a
          // raise lands in the per-dataset catch and costs the re-discovery:
          // exactly what `describeThrown` is there to stop the message doing.
          const tablePath = part.tablePath
          if (tablePath && storage.hasPendingSync(tablePath)) {
            // Isolate per partition: a flush failure on one partition must
            // not strand its siblings' pending rows for this tick.
            try {
              await storage.flushTable(tablePath, { reason: 'sink_discover' })
              flushedAny = true
            } catch (err) {
              // `describeThrown`, not the bare idiom: `flushTable` runs the
              // owning dataset's `settleBatch` hook (`getSettleHook` in
              // `src/core/cache/storage.js`), so the value here is
              // plugin-owned too. A raise from `String()` lands in the
              // per-dataset catch below, which reports it as a discovery
              // failure and skips the post-flush re-discovery, so the
              // partitions the flushes above did commit go unexported for as
              // long as one sibling partition keeps failing.
              log.warn('sink.flush_partition_failed', {
                [Attr.SINK_INSTANCE]: handle.instanceName,
                [Attr.DATASET]: datasetName,
                tablePath,
                message: describeThrown(err),
              })
            }
          }
        }
        if (flushedAny) {
          for (const part of (await discover()) ?? []) keep(part)
        }
      } catch (err) {
        log.warn('sink.discover_partitions_failed', {
          [Attr.SINK_INSTANCE]: handle.instanceName,
          [Attr.DATASET]: datasetName,
          message: describeThrown(err),
        })
      }
    }
    return all
  }

  /**
   * @param {ExtendedSinkHandle} handle
   * @param {string} batchId
   * @param {QueryPartition[]} partitions
   * @param {string} error
   */
  async function persistOutbox(handle, batchId, partitions, error) {
    try {
      const dir = path.join(stateRoot, 'sinks', handle.instanceName, 'outbox')
      fs.mkdirSync(dir, { recursive: true })
      const filePath = path.join(dir, `${batchId}.json`)
      const payload = {
        batchId,
        sinkInstance: handle.instanceName,
        plugin: handle.plugin,
        recordedAt: new Date().toISOString(),
        error,
        partitions: partitions.map((p) => ({
          dataset: p.dataset,
          partition: p.partition,
          tablePath: p.tablePath,
        })),
      }
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2))
    } catch (err) {
      // `describeThrown` for the same reason the two catches above use it:
      // everything this catch guards reads a plugin's own partition objects,
      // both the `p.dataset` / `p.partition` / `p.tablePath` reads and every
      // getter and `toJSON` that `JSON.stringify` walks below them, so a
      // plugin's thrown value arrives here. A raise from `String()` escapes
      // into the caller, and both callers are inside `runSink`, one of them its
      // export catch, so it leaves the tick the daemon swallows as
      // `daemon.tick_failed`: no sink exports again for the daemon's life
      // while `hyp status` still reads healthy.
      const message = describeThrown(err)
      log.error('sink.outbox_write_failed', {
        [Attr.SINK_INSTANCE]: handle.instanceName,
        hyp_batch_id: batchId,
        message,
      })
    }
  }

  /**
   * @param {ExtendedSinkHandle} handle
   * @param {string} batchId
   * @param {number} partitionsCount
   * @param {string} message
   * @param {Span} span
   */
  function recordFailure(handle, batchId, partitionsCount, message, span) {
    noteProductPipeline('export', { failures: 1 })
    instruments.sinkExportFailuresTotal.add(1, {
      [Attr.SINK_INSTANCE]: handle.instanceName,
      [Attr.PLUGIN]: handle.plugin,
    })
    instruments.sinkExportsTotal.add(1, {
      [Attr.SINK_INSTANCE]: handle.instanceName,
      [Attr.STATUS]: 'failed',
    })
    span.setAttribute(Attr.ERROR_KIND, 'sink_export_failed')
    log.error('sink.export_batch.failed', {
      [Attr.SINK_INSTANCE]: handle.instanceName,
      hyp_batch_id: batchId,
      partitions_count: partitionsCount,
      message,
    })
  }

  /**
   * @param {Date} now
   * @param {string} instance
   */
  function nextBatchId(now, instance) {
    batchSeq += 1
    return `${instance}-${now.toISOString()}-${batchSeq}`
  }

  return { tick }
}

/**
 * Rebuild a sink's `exportBatch` answer as an `ExportResult` the kernel owns.
 *
 * `exportBatch` is plugin code, so resolving an answer is not the same as
 * being able to read one: any field is free to be an accessor that throws.
 * Every read of the plugin's object happens here, called from inside the try
 * that already contains the plugin's promise, so an unreadable answer is the
 * same recorded `failed` batch a throwing `exportBatch` is. Read after that
 * try, it is instead a throw on the daemon's tick path, swallowed as
 * `daemon.tick_failed` and costing the backfill sweep and every sink snapshot
 * behind it (issue #1510).
 *
 * The partitions inside `retryPartitions` are the exception, passed through by
 * reference rather than rebuilt: they are read again only inside
 * `persistOutbox`'s own try, and rebuilding them is the nested-value hazard
 * tracked as issue #1505 rather than this one. The array itself is copied, so
 * what the driver counts and iterates is a kernel-owned list.
 *
 * @param {ExportResult | null | undefined} reported
 * @param {QueryPartition[]} partitions
 * @returns {ExportResult}
 */
function readExportResult(reported, partitions) {
  const status = reported?.status
  return {
    status: status === 'exported' || status === 'partial' ? status : 'failed',
    partitionsExported: typeof reported?.partitionsExported === 'number' ? reported.partitionsExported : 0,
    bytesWritten: typeof reported?.bytesWritten === 'number' ? reported.bytesWritten : 0,
    retryPartitions: Array.isArray(reported?.retryPartitions) ? reported.retryPartitions.slice() : partitions,
    error: typeof reported?.error === 'string' ? reported.error : undefined,
  }
}

/**
 * One dataset's name as a string this driver owns, or a placeholder when the
 * plugin's object will not give one up.
 *
 * `registerDataset` validated `name` once and stored the registration by
 * reference, so this is a fresh call into plugin code. The driver wants it only
 * for two log records, and one of them is the catch that exists to report a
 * failed `discoverPartitions`: reading the live property there throws a second
 * time from the handler containing the first throw, out of the daemon tick,
 * which swallows it as `daemon.tick_failed` and stops every sink's export for
 * the daemon's life while `hyp status` still reads healthy (issue #1524, the
 * shape #1509 closed for the backfill sweep). Read once, here, so a name that
 * cannot be read costs the two records their precision and nothing else.
 *
 * @param {DatasetRegistration} dataset
 * @returns {string}
 */
function readDatasetName(dataset) {
  try {
    const name = dataset.name
    return typeof name === 'string' ? name : '<unreadable>'
  } catch {
    return '<unreadable>'
  }
}

/**
 * The message for a throw that came from a plugin, rendered so that reporting
 * one failure cannot become a second one.
 *
 * `err` is the last plugin-owned value left in each of these catches - a
 * sink's `exportBatch`, a dataset's `discoverPartitions`, the `settleBatch`
 * hook `flushTable` runs, and the partition fields `persistOutbox` reads and
 * serializes - and a thrown object carries whatever `message` getter its author
 * wrote, while `String()` raises on its own for anything with no primitive
 * conversion, a null-prototype object being the easy case. Every one of them
 * sits on the daemon's tick path, where an escape is swallowed as
 * `daemon.tick_failed` and costs every sink its export, so a raise from here
 * would defeat the guard it is reporting from. The bare idiom stays as it is
 * elsewhere in the tree; it is load-bearing only where the catch is the last
 * thing between a plugin and the process, so this stays file-local like its
 * twin in `src/core/daemon/backfill_sweep.js`.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeThrown(err) {
  try {
    return String(err instanceof Error ? err.message : err)
  } catch {
    return 'unreadable error'
  }
}

/**
 * @param {string} instance
 * @param {ExportResult} result
 * @returns {{ instance: string, status: ExportResult['status'], partitionsExported: number, bytesWritten: number, error?: string }}
 */
function summarize(instance, result) {
  return {
    instance,
    status: result.status,
    partitionsExported: result.partitionsExported,
    bytesWritten: result.bytesWritten ?? 0,
    error: result.error,
  }
}

// ---------------------------------------------------------------------
// Minimal 5-field cron evaluator
// ---------------------------------------------------------------------

const FIELD_RANGES = /** @type {const} */ ([
  [0, 59],   // minute
  [0, 23],   // hour
  [1, 31],   // day-of-month
  [1, 12],   // month
  [0, 6],    // day-of-week (Sunday=0)
])

/**
 * `cronMatches(expr, now)` - true if `now` (UTC) satisfies the 5-field
 * cron expression. Supports `*`, comma lists, ranges (`1-5`), and
 * step values like every-N (`STAR/N`) or `0-10/2`. Day-of-month and
 * day-of-week obey the standard OR-when-both-restricted rule.
 *
 * The kernel only needs evaluation, not iteration: the driver's host
 * is responsible for ticking on a reasonable cadence (typically once
 * per minute). The smoke harness calls `tick({ now })` directly with a
 * `now` that aligns with `"* * * * *"`, so this evaluator is exercised
 * primarily as a guard for tighter schedules like `"0 * * * *"`.
 *
 * @param {string} expr
 * @param {Date} now
 */
export function cronMatches(expr, now) {
  if (typeof expr !== 'string' || expr.trim().length === 0) return true
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`cronMatches: expected 5 fields, got ${parts.length} ('${expr}')`)
  }
  const minute = now.getUTCMinutes()
  const hour = now.getUTCHours()
  const dom = now.getUTCDate()
  const mon = now.getUTCMonth() + 1
  const dow = now.getUTCDay()
  if (!fieldMatches(parts[0], minute, FIELD_RANGES[0])) return false
  if (!fieldMatches(parts[1], hour, FIELD_RANGES[1])) return false
  if (!fieldMatches(parts[3], mon, FIELD_RANGES[3])) return false

  const domMatch = fieldMatches(parts[2], dom, FIELD_RANGES[2])
  const dowMatch = fieldMatches(parts[4], dow, FIELD_RANGES[4])
  const domRestricted = parts[2] !== '*'
  const dowRestricted = parts[4] !== '*'
  if (domRestricted && dowRestricted) {
    return domMatch || dowMatch
  }
  return domMatch && dowMatch
}

/**
 * @param {string} field
 * @param {number} value
 * @param {readonly [number, number]} range
 */
function fieldMatches(field, value, range) {
  for (const piece of field.split(',')) {
    if (matchPiece(piece, value, range)) return true
  }
  return false
}

/**
 * @param {string} piece
 * @param {number} value
 * @param {readonly [number, number]} range
 */
function matchPiece(piece, value, range) {
  let step = 1
  let core = piece
  const slash = piece.indexOf('/')
  if (slash !== -1) {
    step = parseInt(piece.slice(slash + 1), 10)
    if (!Number.isFinite(step) || step <= 0) return false
    core = piece.slice(0, slash)
  }
  /** @type {number} */ let start
  /** @type {number} */ let end
  if (core === '*' || core === '') {
    start = range[0]
    end = range[1]
  } else if (core.includes('-')) {
    const [aStr, bStr] = core.split('-')
    start = parseInt(aStr, 10)
    end = parseInt(bStr, 10)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  } else {
    const n = parseInt(core, 10)
    if (!Number.isFinite(n)) return false
    start = n
    end = n
  }
  if (value < start || value > end) return false
  return (value - start) % step === 0
}
