// @ts-check

import fs from 'node:fs'
import path from 'node:path'

import { Attr, getKernelInstruments, getLogger, withSpan } from '../observability/index.js'
import { isPickPending } from '../usage-policy/pick_pending.js'

/**
 * @import { ExportBatch, ExportResult, QueryPartition, QueryRegistry, QueryStorageService } from '../../../hypaware-plugin-kernel-types.js'
 * @import { Span } from '../observability/runtime.js'
 * @import { ExtendedSinkHandle, ExtendedSinkRegistry } from '../../../src/core/registry/types.js'
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
    // An enrolling login's local-only pick is pending: hold the whole tick so
    // the daemon's first backfill cannot forward rows from a directory the
    // user is about to withhold (the one-time window LLP 0069's #281 note
    // deferred). Held rows stay in the cache and export on the first tick
    // after the pick lands; the marker is TTL-bounded, so an abandoned login
    // can never stall exports indefinitely. The hold is driver-wide (every
    // sink, not just off-machine ones): the driver cannot know which sinks
    // leave the machine without a new registration concept, and briefly
    // deferring a local sink is harmless where a missed forward hold is not.
    // @ref LLP 0093 [implements]: pick-pending marker holds sink ticks, bounded by TTL
    if (await isPickPending({ stateDir: stateRoot, now: now.getTime() })) {
      log.info('sink.tick_held_pick_pending', {
        [Attr.COMPONENT]: 'sinks',
        [Attr.OPERATION]: 'sink.tick',
        hyp_reason: 'local_only_pick_pending',
        source,
      })
      return { sinks: [], held: 'pick_pending' }
    }
    const handles = sinkRegistry.listHandles()
    /** @type {TickReport['sinks']} */
    const sinks = []
    for (const handle of handles) {
      if (tickOpts.sinkInstance && handle.instanceName !== tickOpts.sinkInstance) continue
      const schedule = typeof handle.config?.schedule === 'string' ? handle.config.schedule : '* * * * *'
      const isDue = tickOpts.force === true || cronMatches(schedule, now)
      if (!isDue) continue
      const report = await runSink(handle, schedule, now)
      sinks.push(report)
    }
    return { sinks }
  }

  /**
   * @param {ExtendedSinkHandle} handle
   * @param {string} schedule
   * @param {Date} now
   * @returns {Promise<TickReport['sinks'][number]>}
   */
  async function runSink(handle, schedule, now) {
    const instance = handle.instanceName
    const batchId = nextBatchId(now, instance)
    const partitions = await discoverReadyPartitions(handle)
    const format = handle.encoder?.format ?? 'native'
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
          result = await handle.sink.exportBatch(
            { batchId, partitions },
            { format, schedule }
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          /** @type {ExportResult} */
          const failed = { status: 'failed', partitionsExported: 0, retryPartitions: partitions, error: message }
          await persistOutbox(handle, batchId, partitions, message)
          recordFailure(handle, batchId, partitions.length, message, span)
          return summarize(instance, failed)
        }
        const status = normalizeStatus(result)
        const exported = typeof result.partitionsExported === 'number' ? result.partitionsExported : 0
        const bytesWritten = typeof result.bytesWritten === 'number' ? result.bytesWritten : 0
        span.setAttribute('partitions_exported', exported)
        span.setAttribute('bytes_written', bytesWritten)
        if (status === 'exported') {
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
          const retryParts = Array.isArray(result.retryPartitions)
            ? result.retryPartitions
            : partitions
          const message = result.error ?? 'sink reported non-ok status'
          await persistOutbox(handle, batchId, retryParts, message)
          recordFailure(handle, batchId, retryParts.length, message, span)
          span.setAttribute('status', status === 'partial' ? 'degraded' : 'failed')
        }
        return summarize(instance, { ...result, status })
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
      if (!part.tablePath) { all.push(part); return }
      if (seen.has(part.tablePath) || !storage.tableExists(part.tablePath)) return
      seen.add(part.tablePath)
      all.push(part)
    }
    for (const dataset of datasets) {
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
          if (part.tablePath && storage.hasPendingSync(part.tablePath)) {
            // Isolate per partition: a flush failure on one partition must
            // not strand its siblings' pending rows for this tick.
            try {
              await storage.flushTable(part.tablePath, { reason: 'sink_discover' })
              flushedAny = true
            } catch (err) {
              log.warn('sink.flush_partition_failed', {
                [Attr.SINK_INSTANCE]: handle.instanceName,
                [Attr.DATASET]: dataset.name,
                tablePath: part.tablePath,
                message: err instanceof Error ? err.message : String(err),
              })
            }
          }
        }
        if (flushedAny) {
          for (const part of (await discover()) ?? []) keep(part)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('sink.discover_partitions_failed', {
          [Attr.SINK_INSTANCE]: handle.instanceName,
          [Attr.DATASET]: dataset.name,
          message,
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
      const message = err instanceof Error ? err.message : String(err)
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
 * @param {string} instance
 * @param {ExportResult} result
 * @returns {{ instance: string, status: ExportResult['status'], partitionsExported: number, bytesWritten: number, error?: string }}
 */
function summarize(instance, result) {
  return {
    instance,
    status: result.status,
    partitionsExported: typeof result.partitionsExported === 'number' ? result.partitionsExported : 0,
    bytesWritten: typeof result.bytesWritten === 'number' ? result.bytesWritten : 0,
    error: result.error,
  }
}

/**
 * @param {ExportResult} result
 * @returns {ExportResult['status']}
 */
function normalizeStatus(result) {
  if (!result || typeof result !== 'object') return 'failed'
  const s = result.status
  if (s === 'exported') return 'exported'
  if (s === 'partial') return 'partial'
  return 'failed'
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
