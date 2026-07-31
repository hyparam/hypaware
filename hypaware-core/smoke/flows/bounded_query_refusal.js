// @ts-check

import process from 'node:process'

import {
  Attr,
  installObservability,
  getLogger,
  runRoot,
} from '../../../src/core/observability/index.js'
import { DEFAULT_EXECUTION_BUDGET, executeQuerySql } from '../../../src/core/query/sql.js'
import { QueryBudgetExceededError } from '../../../src/core/query/index.js'
import { unionSources } from '../../../src/core/query/union-source.js'
import { DATASET_NAME, withSchemaColumns } from '../../plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @import { AsyncDataSource, ScanColumnOptions, SqlPrimitive } from 'squirreling/src/types.js'
 */

// The end-to-end memory-invariant gate for bounded query execution (LLP 0059
// T9). Alongside the `installed_daemon_idle_soak` family (CLAUDE.md's
// acceptance-tier candidates), this is the first realized acceptance smoke:
// unlike the unit/kernel-integration tests in `test/**` (T5's
// query-column-scan-aggregates.test.js, T7's query-sql-budget.test.js), which
// use tiny synthetic ceilings for speed, this drives the REAL, unconfigured
// host-default execution budget (`DEFAULT_EXECUTION_BUDGET`, T7) over a
// dataset shaped and sized like the actual crasher from
// hyparam/hypaware-server#9 (a ~495k-row `ai_gateway_messages` dataset), and
// asserts the observable, caller-facing contract: a clean typed refusal
// instead of the daemon OOM-crashing mid-request (which, over a real HTTP
// socket, is what surfaces as a truncated/zero-byte response), plus the T8
// budget/refusal telemetry that proves the internal path taken, not just the
// process behavior.
//
// It still runs through the same `hyp smoke <name>` harness as every other
// flow here (this repo has no separate installed-daemon acceptance runner
// yet); what makes it acceptance-shaped is what it exercises (the real
// default budget, at real crasher scale), not the harness underneath it.
//
// @ref LLP 0054#memory-invariant [tests]: peak execution memory is a function
//   of the declared budget and schema width, not of the scanned row count,
//   proved uniformly through the one public `executeQuerySql` entry point
//   every caller (CLI, MCP, HypAware Server) shares
// @ref LLP 0059 [tests]: implements plan task T9 (the end-to-end gate)

/** The real, unconfigured host-default row ceiling (T7, LLP 0054 #execution-budget). */
const ROW_CEILING = DEFAULT_EXECUTION_BUDGET.maxBufferedRows ?? 0

// Sized to match the LLP 0054 spec's cited "~495k-row ai_gateway_messages
// dataset" crash scale (hyparam/hypaware-server#9), spread over several
// partitions the way a real multi-day cache would be. Rows are generated
// lazily by formula (never a precomputed array) so the FIXTURE itself never
// buffers unboundedly regardless of what the query engine does with it.
const PARTITION_COUNT = 5
const ROWS_PER_PARTITION = 99_000
const TOTAL_ROWS = PARTITION_COUNT * ROWS_PER_PARTITION
// Realistic low-cardinality session fan-out (many messages per session), the
// shape `COUNT(DISTINCT session_id)` is meant to stream over cheaply.
const SESSION_CARDINALITY = 300
// A generous, deliberately loose bound: buffering only up to the row ceiling
// costs tens of MB here; buffering the full 495k-row scan (what the bug let
// happen) would need several times that. This is a coarse secondary safety
// net, not the primary proof - the deterministic proof is the budget error's
// `observed` high-water mark asserted below, which never depends on GC timing.
const HEAP_GROWTH_BOUND_BYTES = 200 * 1024 * 1024
const SCAN_CHUNK_SIZE = 2_000

/** @param {number} globalIndex */
function sessionIdFor(globalIndex) {
  return `session-${globalIndex % SESSION_CARDINALITY}`
}

/** @param {number} globalIndex */
function contentTextFor(globalIndex) {
  // Unique per row (high-cardinality, like real assistant/user message
  // bodies) but short enough that the byte ceiling never trips before the
  // row ceiling does - keeps the refusal's `limitKind` deterministic.
  return `gateway response chunk ${globalIndex} lorem ipsum dolor`
}

/**
 * A fake `ai_gateway_messages` partition, standing in for icebird's real leaf
 * source the same way T5's query-column-scan-aggregates.test.js does: `scan()`
 * for the row-buffering path (what `ORDER BY` always takes) and `scanColumn()`
 * for the streaming column-scan path (T5, LLP 0055) - both compute every
 * value lazily from `startIndex`, so the fixture's own memory footprint never
 * scales with `rowCount`.
 *
 * @param {{ startIndex: number, rowCount: number }} args
 * @returns {AsyncDataSource}
 */
function fakePartitionSource({ startIndex, rowCount }) {
  return {
    columns: ['session_id', 'content_text'],
    numRows: rowCount,
    scan(hints) {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (let local = 0; local < rowCount; local++) {
            if (hints?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
            const globalIndex = startIndex + local
            const session_id = sessionIdFor(globalIndex)
            const content_text = contentTextFor(globalIndex)
            yield {
              columns: ['session_id', 'content_text'],
              cells: {
                session_id: () => Promise.resolve(session_id),
                content_text: () => Promise.resolve(content_text),
              },
              resolved: { session_id, content_text },
            }
          }
        },
      }
    },
    /** @param {ScanColumnOptions} options */
    async *scanColumn({ column, limit, offset, signal }) {
      const skip = offset ?? 0
      const cap = limit ?? Infinity
      let yielded = 0
      for (let base = skip; base < rowCount && yielded < cap; base += SCAN_CHUNK_SIZE) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const end = Math.min(base + SCAN_CHUNK_SIZE, rowCount, skip + (Number.isFinite(cap) ? cap : rowCount))
        /** @type {SqlPrimitive[]} */
        const chunk = []
        for (let local = base; local < end; local++) {
          const globalIndex = startIndex + local
          chunk.push(column === 'session_id' ? sessionIdFor(globalIndex) : contentTextFor(globalIndex))
        }
        if (chunk.length === 0) break
        yielded += chunk.length
        yield chunk
      }
    },
  }
}

/**
 * Build the real production composition (`withSchemaColumns(unionSources(...))`,
 * `hypaware-core/plugins-workspace/ai-gateway/src/dataset.js:147-148`) over
 * `PARTITION_COUNT` fake leaves, registered as the real dataset name so the
 * query text below reads exactly like the issue's reproduction.
 */
function buildAiGatewayMessagesRegistry() {
  const sources = Array.from({ length: PARTITION_COUNT }, (_, i) =>
    fakePartitionSource({ startIndex: i * ROWS_PER_PARTITION, rowCount: ROWS_PER_PARTITION })
  )
  const source = withSchemaColumns(unionSources(sources))
  const registry = {
    getDataset: (/** @type {string} */ name) =>
      name === DATASET_NAME
        ? { discoverPartitions: async () => [{}], createDataSource: () => source }
        : null,
    listDatasets: () => [DATASET_NAME],
  }
  const storage = { cacheRoot: '/tmp/hypaware-smoke-bqr', pendingInfo: async () => ({ pending: false }) }
  return { registry, storage }
}

/**
 * @param {{ harness: any, expect: any }} args
 */
export async function run({ harness, expect }) {
  const obs = installObservability()
  if (!obs.tracer.provider) {
    throw new Error('bounded_query_refusal: tracer provider not installed - expected HYP_DEV_TELEMETRY=1')
  }
  const log = getLogger('smoke')

  /**
   * Stable `smoke_step` attribute bag for a phase, per the repo's
   * log-driven-development convention (stable smoke_name/smoke_step/DEV_RUN_ID).
   * @param {string} name
   * @returns {Record<string, string>}
   */
  const stepBag = (name) => ({
    [Attr.COMPONENT]: 'smoke',
    [Attr.OPERATION]: 'step',
    [Attr.SMOKE_NAME]: harness.smokeName,
    [Attr.SMOKE_STEP]: name,
    [Attr.DEV_RUN_ID]: harness.devRunId,
    status: 'ok',
  })

  /**
   * Run one phase under a `smoke_step`-tagged root span so a failure names
   * the broken step.
   * @template T
   * @param {string} name
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const step = (name, fn) =>
    runRoot(`smoke.step.${name}`, stepBag(name), async () => {
      log.info(`smoke step ${name}`, stepBag(name))
      return fn()
    })

  const { registry, storage } = buildAiGatewayMessagesRegistry()

  // ----- smoke_step: order_by_refusal -----
  // Issue #9 crasher #1: `ORDER BY` always buffers its whole input before it
  // can emit a row (sort.js), so a sort over the full ~495k-row dataset must
  // refuse against the real, UNCONFIGURED host-default budget rather than
  // buffer every row and OOM the process.
  const orderByOutcome = await step('order_by_refusal', async () => {
    const heapBefore = process.memoryUsage().heapUsed
    /** @type {unknown} */
    let caught
    try {
      await executeQuerySql({
        query: 'SELECT session_id, content_text FROM ai_gateway_messages ORDER BY content_text',
        registry: /** @type {any} */ (registry),
        storage: /** @type {any} */ (storage),
      })
    } catch (err) {
      caught = err
    }
    const heapAfter = process.memoryUsage().heapUsed
    return { caught, heapDelta: heapAfter - heapBefore }
  })

  expect.that(
    'order_by: refuses with a typed QueryBudgetExceededError (a clean refusal, not an OOM crash or a silent partial result)',
    orderByOutcome.caught,
    (e) => e instanceof QueryBudgetExceededError
  )
  const orderByError = /** @type {InstanceType<typeof QueryBudgetExceededError>} */ (orderByOutcome.caught)
  expect.that('order_by: the refusing operator is ORDER BY', orderByError?.operator, (v) => v === 'ORDER BY')
  expect.that(
    'order_by: the error carries a well-formed, non-empty message (not a zero-byte/truncated response)',
    orderByError?.message,
    (v) => typeof v === 'string' && v.length > 20
  )
  expect.that(
    'order_by: high-water mark trips at the row ceiling, never approaching the full 495k-row scan (bounded heap, not O(rows))',
    orderByError?.observed,
    (v) => typeof v === 'number' && v > ROW_CEILING && v < TOTAL_ROWS / 2
  )
  expect.that(
    'order_by: the configured ceiling is the real, unconfigured host default',
    orderByError?.limit,
    (v) => v === ROW_CEILING
  )
  expect.that(
    'order_by: measured heap growth stays well under what buffering the full 495k-row scan would need',
    orderByOutcome.heapDelta,
    (v) => typeof v === 'number' && v < HEAP_GROWTH_BOUND_BYTES
  )

  // ----- smoke_step: count_distinct_high_card_refusal -----
  // Issue #9 crasher #2: `COUNT(DISTINCT content_text)` is high-cardinality
  // (every row's content is distinct), so even on the streaming column-scan
  // fast path (T5, LLP 0055) its dedup set grows one entry per row and must
  // still refuse against the real host-default budget (squirreling
  // aggregates.js `scanColumnGroup`, LLP 0056) rather than grow unbounded.
  const distinctHighCardOutcome = await step('count_distinct_high_card_refusal', async () => {
    const heapBefore = process.memoryUsage().heapUsed
    /** @type {unknown} */
    let caught
    try {
      await executeQuerySql({
        query: 'SELECT COUNT(DISTINCT content_text) AS d FROM ai_gateway_messages',
        registry: /** @type {any} */ (registry),
        storage: /** @type {any} */ (storage),
      })
    } catch (err) {
      caught = err
    }
    const heapAfter = process.memoryUsage().heapUsed
    return { caught, heapDelta: heapAfter - heapBefore }
  })

  expect.that(
    'count_distinct(content_text): refuses with a typed QueryBudgetExceededError',
    distinctHighCardOutcome.caught,
    (e) => e instanceof QueryBudgetExceededError
  )
  const distinctHighCardError = /** @type {InstanceType<typeof QueryBudgetExceededError>} */ (
    distinctHighCardOutcome.caught
  )
  expect.that(
    'count_distinct(content_text): the refusing operator is COUNT(DISTINCT)',
    distinctHighCardError?.operator,
    (v) => v === 'COUNT(DISTINCT)'
  )
  expect.that(
    'count_distinct(content_text): high-water mark trips at the ceiling, not the full 495k-row scan',
    distinctHighCardError?.observed,
    (v) => typeof v === 'number' && v > ROW_CEILING && v < TOTAL_ROWS / 2
  )
  expect.that(
    'count_distinct(content_text): measured heap growth stays bounded',
    distinctHighCardOutcome.heapDelta,
    (v) => typeof v === 'number' && v < HEAP_GROWTH_BOUND_BYTES
  )

  // ----- smoke_step: count_distinct_streaming_success -----
  // The now-streaming counterpart (T5): `session_id` is low-cardinality, so
  // this completes over the FULL 495k-row dataset - never refusing - while
  // holding only an O(cardinality) dedup set, proving peak memory here is a
  // function of cardinality, not of the rows scanned.
  const streamingOutcome = await step('count_distinct_streaming_success', async () => {
    const heapBefore = process.memoryUsage().heapUsed
    const result = await executeQuerySql({
      query: 'SELECT COUNT(DISTINCT session_id) AS d FROM ai_gateway_messages',
      registry: /** @type {any} */ (registry),
      storage: /** @type {any} */ (storage),
    })
    const heapAfter = process.memoryUsage().heapUsed
    return { result, heapDelta: heapAfter - heapBefore }
  })

  expect.that(
    'count_distinct(session_id): completes with the exact cardinality over the full 495k-row scan (no refusal)',
    streamingOutcome.result.rows[0]?.d,
    (v) => v === SESSION_CARDINALITY
  )
  expect.that(
    'count_distinct(session_id): measured heap growth stays bounded despite scanning every row (O(cardinality), not O(rows))',
    streamingOutcome.heapDelta,
    (v) => typeof v === 'number' && v < HEAP_GROWTH_BOUND_BYTES
  )

  await obs.shutdown()

  // ----- smoke_step: assert_telemetry -----
  // Prove the INTERNAL path, not just the process exit/return behavior: the
  // T8 budget/refusal telemetry (LLP 0054 #uniform-surface) is what every
  // caller (CLI, MCP, and eventually HypAware Server) actually greps for.
  await step('assert_telemetry', async () => {
    const logs = await expect.logs()
    const budgetExceededLogs = logs.filter((/** @type {any} */ l) => l.body === 'query.budget_exceeded')
    expect.that(
      'logs: exactly one query.budget_exceeded record per refusal (ORDER BY, COUNT(DISTINCT))',
      budgetExceededLogs,
      (v) => Array.isArray(v) && v.length === 2
    )
    expect.that(
      'logs: every budget_exceeded record carries error_kind=budget_exceeded',
      budgetExceededLogs,
      (v) => Array.isArray(v) && v.every((/** @type {any} */ l) => l.attributes?.error_kind === 'budget_exceeded')
    )
    expect.that(
      'logs: the ORDER BY refusal is present with its high-water mark',
      budgetExceededLogs.filter((/** @type {any} */ l) => l.attributes?.operator === 'ORDER BY'),
      (v) => Array.isArray(v) && v.length === 1 &&
        typeof v[0].attributes?.limit === 'number' && typeof v[0].attributes?.observed === 'number' &&
        v[0].attributes.observed > v[0].attributes.limit
    )
    expect.that(
      'logs: the COUNT(DISTINCT) refusal is present with its high-water mark',
      budgetExceededLogs.filter((/** @type {any} */ l) => l.attributes?.operator === 'COUNT(DISTINCT)'),
      (v) => Array.isArray(v) && v.length === 1 &&
        typeof v[0].attributes?.limit === 'number' && typeof v[0].attributes?.observed === 'number' &&
        v[0].attributes.observed > v[0].attributes.limit
    )

    const traces = await expect.traces()
    const execSpans = traces.filter((/** @type {any} */ t) => t.name === 'query.execute_sql')
    expect.that('traces: all three query.execute_sql runs recorded', execSpans, (v) => Array.isArray(v) && v.length === 3)
    expect.that(
      'traces: two failed (the refusals) and one ok (the streaming success)',
      execSpans,
      (v) =>
        v.filter((/** @type {any} */ s) => s.status === 'failed').length === 2 &&
        v.filter((/** @type {any} */ s) => s.status === 'ok').length === 1
    )
  })
}
