// @ts-check

import v8 from 'node:v8'
import vm from 'node:vm'

import { collect, executeSql as squirrelExecuteSql, extractTables, parseSql } from 'squirreling'

import { Attr, getKernelInstruments, withSpan } from '../observability/index.js'
import { QUERY_FLUSH_DEBOUNCE_MS } from '../cache/spool.js'
import { normalizeScanColumn } from './scan-column.js'

/**
 * @import { HypAwareV2Config, PluginLogger, QueryRegistry, QueryScope } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../src/core/cache/types.js'
 * @import { ExecuteSqlOptions, ExecuteSqlResult, RefreshMode } from '../../../src/core/query/types.js'
 * @import { AsyncDataSource } from 'squirreling'
 */

/**
 * Default per-query heap-growth budget. Sized from the LLP 0057 Phase 0
 * measurement pass (2026-07-10, ~202k-row / 931MB ai_gateway_messages):
 * every well-formed query in the measured set peaks under ~500MB of
 * process heap growth, while the issue-#9 crasher class (unbounded wide
 * ORDER BY) grows past 4GB before dying. 1GiB refuses the crasher class
 * with roomy headroom for legitimate queries.
 */
const DEFAULT_MAX_HEAP_GROWTH_BYTES = 1024 * 1024 * 1024

/** How often the watchdog samples heap growth while a query runs. */
const HEAP_WATCH_INTERVAL_MS = 100

/**
 * Typed refusal for a query whose execution outgrew its heap budget.
 * Refusal, not truncation: a partial sort or partial aggregate would be a
 * silently wrong answer. Callers render it as actionable guidance and map
 * it to a 4xx (server) or non-zero exit (CLI).
 *
 * @ref LLP 0056 [implements]: over-budget queries refuse with a distinct typed error carrying the limit that was hit
 */
export class QueryExecutionBudgetError extends Error {
  /**
   * @param {number} limitBytes
   * @param {number} observedBytes
   * @param {{ site: string, rawBytes: number, baselineBytes: number, gcMode: 'confirmed' | 'unavailable' }} [diagnostics]
   */
  constructor(limitBytes, observedBytes, diagnostics) {
    const limitMb = Math.round(limitBytes / 1048576)
    const observedMb = Math.round(observedBytes / 1048576)
    let message =
      `query exceeded its execution memory budget (${observedMb}MB used of ${limitMb}MB) - ` +
      'add a WHERE/date filter, a LIMIT, or aggregate instead of selecting raw rows ' +
      '(raise the budget with HYP_QUERY_MAX_HEAP_MB if this query truly needs more)'
    // The suffix is the refusal's own diagnosis, and it matters most when
    // the refusal happens on a machine the investigator cannot inspect (a
    // remote daemon surfacing this message through MCP): which check site
    // tripped, how much of the raw delta survived the confirming GC, and
    // whether a GC handle was available at all.
    if (diagnostics) {
      const rawMb = Math.round(diagnostics.rawBytes / 1048576)
      const baselineMb = Math.round(diagnostics.baselineBytes / 1048576)
      message += ` [site=${diagnostics.site} raw=${rawMb}MB gc=${diagnostics.gcMode} baseline=${baselineMb}MB]`
    }
    super(message)
    this.name = 'QueryExecutionBudgetError'
    this.code = 'query_budget_exceeded'
    this.limitBytes = limitBytes
    this.observedBytes = observedBytes
    this.diagnostics = diagnostics
  }
}

/**
 * Resolve the effective heap-growth budget: explicit option, then the
 * HYP_QUERY_MAX_HEAP_MB operator override, then the measured default.
 * 0 (or a non-positive override) disables the watchdog entirely.
 *
 * @param {number | undefined} optionBytes
 * @returns {number}
 */
export function resolveHeapBudgetBytes(optionBytes) {
  if (optionBytes !== undefined) return optionBytes
  // A set-but-blank var (`export HYP_QUERY_MAX_HEAP_MB=`, how many config
  // systems render an unset optional) must NOT silently disable the guard:
  // Number('') and Number('  ') are 0 (finite), which reads as "disabled".
  // Only a non-empty value counts as an override; anything else (unset or
  // blank) falls through to the measured default.
  const raw = process.env.HYP_QUERY_MAX_HEAP_MB?.trim()
  if (raw) {
    const env = Number(raw)
    if (Number.isFinite(env)) return env * 1024 * 1024
  }
  return DEFAULT_MAX_HEAP_GROWTH_BYTES
}

/** Rows between inline heap checks on a row scan. */
const BUDGET_CHECK_ROW_STRIDE = 4096

/** @type {(() => void) | null | undefined} */
let cachedForcedGc

/**
 * Resolve a synchronous full-GC handle without requiring the process to be
 * launched with --expose-gc: flip the flag at runtime just long enough to
 * read `gc` out of a fresh context, then flip it back. Resolved once and
 * cached; `null` means the runtime refused and the guard falls back to
 * refusing on raw growth.
 *
 * @returns {(() => void) | null}
 */
function resolveForcedGc() {
  if (cachedForcedGc !== undefined) return cachedForcedGc
  /** @type {(() => void) | null} */
  let resolved = null
  const globalGc = /** @type {(() => void) | undefined} */ (/** @type {any} */ (globalThis).gc)
  if (typeof globalGc === 'function') {
    resolved = globalGc
  } else {
    try {
      v8.setFlagsFromString('--expose-gc')
      const gc = vm.runInNewContext('gc')
      v8.setFlagsFromString('--no-expose-gc')
      if (typeof gc === 'function') resolved = gc
    } catch {
      resolved = null
    }
  }
  cachedForcedGc = resolved
  return resolved
}

/**
 * Decorate a data source so its scans enforce the query's heap budget
 * INLINE, from within the row loop itself. A timer-based watchdog alone is
 * not enough: a query whose reads resolve without real I/O (warm cache,
 * synchronous resolvers) can hold the event loop for its entire run, so a
 * setInterval callback never fires while a blocking operator's buffer
 * grows. The stride keeps the memoryUsage() sample cost far below one
 * sample per row. All sources of one query share `guard`, so growth is
 * judged per query, not per table.
 *
 * @param {AsyncDataSource} source
 * @param {{ check: (site: string) => void }} guard
 * @returns {AsyncDataSource}
 */
function withHeapBudget(source, guard) {
  /** @type {AsyncDataSource} */
  const bounded = {
    numRows: source.numRows,
    columns: source.columns,
    scan(options) {
      const inner = source.scan(options)
      return {
        appliedWhere: inner.appliedWhere,
        appliedLimitOffset: inner.appliedLimitOffset,
        async *rows() {
          let sinceCheck = 0
          for await (const row of inner.rows()) {
            if (++sinceCheck >= BUDGET_CHECK_ROW_STRIDE) {
              sinceCheck = 0
              guard.check('row_scan')
            }
            yield row
          }
        },
      }
    },
  }
  if (typeof source.scanColumn === 'function') {
    const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (source.scanColumn)
    // @ref LLP 0098#wrapper-duties [implements]: the budget decoration must pass appliedWhere/appliedLimitOffset through untouched, or the engine re-slices a filtered stream
    bounded.scanColumn = (options) => {
      const inner = normalizeScanColumn(scanColumn(options), options)
      return {
        appliedWhere: inner.appliedWhere,
        appliedLimitOffset: inner.appliedLimitOffset,
        async *chunks() {
          for await (const chunk of inner.chunks()) {
            guard.check('column_chunk')
            yield chunk
          }
        },
      }
    }
  }
  return bounded
}

/**
 * Run a read-only SELECT against the kernel's dataset registry. The
 * caller (the `hyp query sql` command or a future server endpoint)
 * supplies the registry and storage; this function never reads from
 * disk directly; every byte of cache IO goes through the storage
 * service so spans and metrics are attributed correctly.
 *
 * Wraps the entire run in a `query.execute_sql` span and emits one
 * `query.scan_dataset` child per referenced dataset, matching the
 * Phase 4 smoke contract.
 *
 * @param {ExecuteSqlOptions} args
 * @returns {Promise<ExecuteSqlResult>}
 * @ref LLP 0015#query-is-intrinsic [implements]: core-owned read-only SQL over the registry; IO only via the storage service
 */
export async function executeQuerySql(args) {
  const { query, registry, storage } = args
  const refresh = args.refresh ?? 'auto'
  const scope = args.scope ?? { limit: 1_000_000 }
  const config = args.config ?? { version: 2 }
  const log = args.log

  return withSpan(
    'query.execute_sql',
    {
      [Attr.COMPONENT]: 'query',
      [Attr.OPERATION]: 'query.execute_sql',
      sql_truncated: query.slice(0, 256),
      refresh_mode: refresh,
      status: 'ok',
    },
    async (span) => {
      const instruments = getKernelInstruments()
      const start = Date.now()
      try {
        const trimmed = query.trim()
        if (trimmed.length === 0) throw new Error('SQL query is required')
        // squirreling only parses read-only SELECTs, so its own error message
        // already points at the real problem (syntax error, unknown function,
        // non-SELECT statement). Surface it verbatim rather than wrapping it.
        const statement = parseSql({ query: trimmed })

        const tableNames = uniqueStrings(extractTables(statement))
        span.setAttribute('table_count', tableNames.length)

        /** @type {Record<string, AsyncDataSource>} */
        const tables = {}
        /** @type {string[]} */
        const datasetsUsed = []
        /** @type {string[]} */
        const freshnessMessages = []

        for (const name of tableNames) {
          const dataset = registry.getDataset(name)
          if (!dataset) {
            throw new Error(`SQL query references unknown dataset: ${name}`)
          }
          datasetsUsed.push(name)

          const partitions = await dataset.discoverPartitions({
            config,
            scope,
            cacheDir: storage.cacheRoot,
          })

          if (refresh === 'always' && typeof dataset.refreshPartition === 'function') {
            for (const partition of partitions) {
              await dataset.refreshPartition(partition, {
                cacheDir: storage.cacheRoot,
                force: true,
                log: log ?? noopLogger(),
                storage,
              })
            }
          }

          await settlePendingCacheForQuery({
            partitions,
            storage,
            refresh,
            messages: freshnessMessages,
          })

          const source = await withSpan(
            'query.scan_dataset',
            {
              [Attr.COMPONENT]: 'query',
              [Attr.OPERATION]: 'query.scan_dataset',
              [Attr.DATASET]: name,
              partition_count: partitions.length,
              status: 'ok',
            },
            async () => {
              return dataset.createDataSource(partitions, { scope, storage })
            },
            { component: 'query' }
          )
          tables[name] = source
        }

        // Execution is bounded by a heap-growth watchdog: the engine and
        // every data source already honor an abort signal on their hot
        // loops, so tripping the budget aborts the run mid-stream instead
        // of letting a blocking operator (unbounded ORDER BY / GROUP BY /
        // DISTINCT buffering) grow until the process is OOM-killed. The
        // sampled process-heap growth is a stand-in for the per-operator
        // buffered-byte accounting that belongs upstream in the engine.
        // @ref LLP 0054#signal-threading [implements]: the kernel constructs the signal and forwards it into squirrelExecuteSql, activating the operators' abort checks
        // @ref LLP 0097 [implements]: heap-growth watchdog enforces the execution budget from the kernel while buffered-byte accounting stays an engine follow-up
        const budgetBytes = resolveHeapBudgetBytes(args.maxHeapBytes)
        const controller = new AbortController()
        // Detach the linked-signal listener when the query settles: a
        // long-lived upstream signal (one shared across many queries) would
        // otherwise retain this controller closure per call.
        /** @type {(() => void) | undefined} */
        let removeUpstreamAbort
        if (args.signal) {
          const upstream = args.signal
          if (upstream.aborted) controller.abort(upstream.reason)
          else {
            const onUpstreamAbort = () => controller.abort(upstream.reason)
            upstream.addEventListener('abort', onUpstreamAbort, { once: true })
            removeUpstreamAbort = () => upstream.removeEventListener('abort', onUpstreamAbort)
          }
        }
        const baselineHeap = process.memoryUsage().heapUsed
        /** @type {QueryExecutionBudgetError | undefined} */
        let budgetError
        /** @type {NodeJS.Timeout | undefined} */
        let watchdog
        const trip = (/** @type {{ settled: number, raw: number, gcMode: 'confirmed' | 'unavailable' }} */ crossing, /** @type {string} */ site) => {
          if (!budgetError) {
            budgetError = new QueryExecutionBudgetError(budgetBytes, crossing.settled, {
              site,
              rawBytes: crossing.raw,
              baselineBytes: baselineHeap,
              gcMode: crossing.gcMode,
            })
            span.setAttribute('budget_trip_site', site)
            span.setAttribute('budget_raw_mb', Math.round(crossing.raw / 1048576))
            span.setAttribute('budget_settled_mb', Math.round(crossing.settled / 1048576))
            span.setAttribute('budget_gc', crossing.gcMode)
            controller.abort(budgetError)
          }
          if (watchdog) clearInterval(watchdog)
          return budgetError
        }
        // A raw heapUsed delta counts not-yet-collected garbage as growth,
        // and a streaming column scan allocates per-row garbage faster than
        // V8 collects it on a large-heap host (observed in production:
        // ~3.3GB of sampled "growth" on a 500k-row single-column scan whose
        // live memory fits in under 100MB). Refusing on the raw delta kills
        // exactly the streaming aggregates LLP 0055/0098 exist to keep
        // cheap, so a crossing is confirmed first: force one full GC and
        // re-measure, and only growth that survives collection (memory the
        // query actually retains) refuses. A garbage-heavy but well-bounded
        // query pays one forced GC per budget-width of garbage; a genuinely
        // retaining query pays one GC and then refuses.
        // @ref LLP 0097#confirm-with-gc [implements]: only growth that survives a full GC refuses; raw deltas count garbage
        const confirmGrowth = () => {
          const raw = process.memoryUsage().heapUsed - baselineHeap
          if (raw <= budgetBytes) return undefined
          const forcedGc = resolveForcedGc()
          if (!forcedGc) return { settled: raw, raw, gcMode: /** @type {const} */ ('unavailable') }
          forcedGc()
          const settled = process.memoryUsage().heapUsed - baselineHeap
          if (settled <= budgetBytes) return undefined
          return { settled, raw, gcMode: /** @type {const} */ ('confirmed') }
        }
        const guard = {
          /** @param {string} site */
          check(site) {
            if (budgetBytes <= 0) return
            if (budgetError) throw budgetError
            const crossing = confirmGrowth()
            if (crossing !== undefined) throw trip(crossing, site)
          },
        }
        if (budgetBytes > 0) {
          // Second enforcement layer for execution phases that pull no
          // further source rows (join amplification, output finalization)
          // but do yield to the event loop.
          watchdog = setInterval(() => {
            const crossing = confirmGrowth()
            if (crossing !== undefined) trip(crossing, 'watchdog')
          }, HEAP_WATCH_INTERVAL_MS)
          watchdog.unref()
          for (const name of Object.keys(tables)) {
            tables[name] = withHeapBudget(tables[name], guard)
          }
        }

        try {
          const results = squirrelExecuteSql({ tables, query: trimmed, signal: controller.signal })
          const rows = await collect(results)
          // Terminal budget check: the inline guard only samples every
          // BUDGET_CHECK_ROW_STRIDE rows (and per column chunk), and the
          // interval watchdog cannot fire during a fully synchronous run, so
          // growth concentrated in a sub-stride tail or in finalization would
          // otherwise return a wrongly-successful result. One check after
          // materialization closes that window before we record success.
          guard.check('terminal')
          const columns = results.columns ?? []
          span.setAttribute('row_count', rows.length)

          instruments.queryRunsTotal.add(1, { status: 'ok' })
          instruments.queryDurationMs.record(Date.now() - start, { status: 'ok' })

          return { columns, rows, datasets: datasetsUsed, freshnessMessages }
        } catch (err) {
          // Any abort surfaced while the budget stands tripped maps to the
          // typed refusal, whichever layer's abort check fired first.
          if (budgetError) throw budgetError
          throw err
        } finally {
          if (watchdog) clearInterval(watchdog)
          if (removeUpstreamAbort) removeUpstreamAbort()
        }
      } catch (err) {
        const budgeted = err instanceof QueryExecutionBudgetError
        span.setAttribute('status', 'failed')
        if (budgeted) span.setAttribute('error_kind', 'budget_exceeded')
        instruments.queryRunsTotal.add(1, { status: 'failed', ...(budgeted ? { error_kind: 'budget_exceeded' } : {}) })
        instruments.queryDurationMs.record(Date.now() - start, { status: 'failed' })
        throw err
      }
    },
    { component: 'query' }
  )
}

/**
 * @param {{
 *   partitions: Array<{ tablePath?: string }>,
 *   storage: ExtendedQueryStorageService,
 *   refresh: RefreshMode,
 *   messages: string[],
 * }} args
 */
async function settlePendingCacheForQuery(args) {
  const now = Date.now()
  for (const partition of args.partitions) {
    if (!partition.tablePath) continue
    const info = await args.storage.pendingInfo(partition.tablePath)
    if (!info.pending) continue
    if (args.refresh === 'always') {
      await args.storage.flushTable(partition.tablePath, { force: true, reason: 'query_always' })
      continue
    }
    if (args.refresh === 'never') continue
    if (info.lastFlushAtMs === null || now - info.lastFlushAtMs >= QUERY_FLUSH_DEBOUNCE_MS) {
      await args.storage.flushTable(partition.tablePath, { reason: 'query_auto' })
      continue
    }
    args.messages.push(
      `cache: last write to query cache was ${formatAgeMinutes(now - info.lastFlushAtMs)} ago`
    )
  }
}

/** @param {number} ageMs */
function formatAgeMinutes(ageMs) {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000))
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function uniqueStrings(values) {
  /** @type {string[]} */
  const out = []
  const seen = new Set()
  for (const v of values) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/**
 * @returns {PluginLogger}
 */
function noopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }
}
