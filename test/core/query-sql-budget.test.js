// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { asyncRow } from 'squirreling'
import { executeQuerySql, QueryExecutionBudgetError, resolveHeapBudgetBytes } from '../../src/core/query/sql.js'

/**
 * @import { AsyncDataSource, SqlPrimitive } from 'squirreling/src/types.js'
 */

/**
 * A memory-backed AsyncDataSource over `rows`, with an optional recording
 * scanColumn hook so tests can prove the streaming-aggregate fast path
 * stays reachable through the kernel's budget decoration.
 *
 * @param {Record<string, SqlPrimitive>[]} rows
 * @param {{ scanColumnCalls?: string[] }} [opts]
 * @returns {AsyncDataSource}
 */
function memorySource(rows, opts = {}) {
  const columns = Object.keys(rows[0] ?? {})
  /** @type {AsyncDataSource} */
  const source = {
    columns,
    numRows: rows.length,
    scan(options) {
      const rowColumns = options?.columns ?? columns
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (const row of rows) yield asyncRow(row, rowColumns)
        },
      }
    },
  }
  if (opts.scanColumnCalls) {
    const calls = opts.scanColumnCalls
    source.scanColumn = ({ column, limit, offset }) => ({
      async *[Symbol.asyncIterator]() {
        calls.push(column)
        const start = offset ?? 0
        const end = limit === undefined ? rows.length : Math.min(rows.length, start + limit)
        if (end > start) yield rows.slice(start, end).map((r) => r[column] ?? null)
      },
    })
  }
  return source
}

/** @param {AsyncDataSource} source */
function registryFor(source) {
  const dataset = {
    discoverPartitions: async () => [],
    createDataSource: async () => source,
  }
  return /** @type {any} */ ({ getDataset: () => dataset, listDatasets: () => [] })
}

const storage = /** @type {any} */ ({
  cacheRoot: '/tmp/hypaware-test',
  pendingInfo: async () => ({ pending: false }),
})

test('a query whose heap growth exceeds the execution budget refuses with the typed error', async () => {
  // More rows than the inline check stride, so the guard samples mid-scan.
  const rows = Array.from({ length: 6000 }, (_, i) => ({ a: `value-${i}` }))
  await assert.rejects(
    executeQuerySql({
      query: 'SELECT a FROM t ORDER BY a',
      registry: registryFor(memorySource(rows)),
      storage,
      maxHeapBytes: 1,
    }),
    (err) => {
      assert.ok(err instanceof QueryExecutionBudgetError, 'typed refusal, not a generic error')
      assert.equal(err.code, 'query_budget_exceeded')
      assert.equal(err.limitBytes, 1)
      assert.ok(err.observedBytes > 1)
      assert.match(err.message, /execution memory budget/)
      assert.match(err.message, /WHERE|LIMIT|aggregate/, 'message carries actionable guidance')
      return true
    }
  )
})

test('resolveHeapBudgetBytes resolves the effective ceiling and never disables on a blank env', () => {
  const DEFAULT = 1024 * 1024 * 1024
  const prev = process.env.HYP_QUERY_MAX_HEAP_MB
  const withEnv = (/** @type {string | undefined} */ v, /** @type {() => void} */ body) => {
    if (v === undefined) delete process.env.HYP_QUERY_MAX_HEAP_MB
    else process.env.HYP_QUERY_MAX_HEAP_MB = v
    body()
  }
  try {
    // Explicit option always wins, including 0 (disable).
    assert.equal(resolveHeapBudgetBytes(0), 0)
    assert.equal(resolveHeapBudgetBytes(5 * 1024 * 1024), 5 * 1024 * 1024)
    // Blank / whitespace-only must NOT resolve to 0 and disable the guard.
    withEnv('', () => assert.equal(resolveHeapBudgetBytes(undefined), DEFAULT))
    withEnv('   ', () => assert.equal(resolveHeapBudgetBytes(undefined), DEFAULT))
    // Unset falls to the default.
    withEnv(undefined, () => assert.equal(resolveHeapBudgetBytes(undefined), DEFAULT))
    // Garbage falls to the default (NaN is not finite).
    withEnv('512mb', () => assert.equal(resolveHeapBudgetBytes(undefined), DEFAULT))
    // A real numeric override is honored, and an explicit 0 still disables.
    withEnv('256', () => assert.equal(resolveHeapBudgetBytes(undefined), 256 * 1024 * 1024))
    withEnv('0', () => assert.equal(resolveHeapBudgetBytes(undefined), 0))
  } finally {
    if (prev === undefined) delete process.env.HYP_QUERY_MAX_HEAP_MB
    else process.env.HYP_QUERY_MAX_HEAP_MB = prev
  }
})

test('maxHeapBytes 0 disables the budget entirely', async () => {
  const rows = Array.from({ length: 6000 }, (_, i) => ({ a: i }))
  const result = await executeQuerySql({
    query: 'SELECT COUNT(*) AS n FROM t',
    registry: registryFor(memorySource(rows)),
    storage,
    maxHeapBytes: 0,
  })
  assert.equal(result.rows[0].n, 6000)
})

test('a pre-aborted caller signal aborts execution before rows flow', async () => {
  const rows = [{ a: 1 }]
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    executeQuerySql({
      query: 'SELECT a FROM t',
      registry: registryFor(memorySource(rows)),
      storage,
      signal: controller.signal,
    }),
    (err) => {
      assert.equal(/** @type {Error} */ (err).name, 'AbortError')
      return true
    }
  )
})

test('the streaming-aggregate scanColumn fast path stays lit through the budget decoration', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ a: `s${i % 7}` }))
  /** @type {string[]} */
  const scanColumnCalls = []
  const result = await executeQuerySql({
    query: 'SELECT COUNT(DISTINCT a) AS n FROM t',
    registry: registryFor(memorySource(rows, { scanColumnCalls })),
    storage,
  })
  assert.equal(result.rows[0].n, 7)
  assert.deepEqual(scanColumnCalls, ['a'], 'the engine consumed the column stream, not buffered rows')
})

test('transient scan garbage does not trip the budget; only retained growth refuses', async () => {
  // The guard confirms a crossing with a forced GC before refusing (LLP
  // 0097#confirm-with-gc). Each chunk allocates ~25MB, holds it long
  // enough for scavenges to promote it, then drops the reference before
  // yielding: at the wrapper's per-chunk check the raw heapUsed delta is
  // far over the 8MB budget, but none of it survives collection, so the
  // query must complete. (The companion refusal test above proves memory
  // that IS retained, the ORDER BY buffer, still refuses.)
  // MIN, not COUNT(*): an unfiltered COUNT takes the numRows metadata
  // shortcut and would never pull the column stream (or check the guard).
  const rows = Array.from({ length: 4 }, (_, i) => ({ a: i + 1 }))
  const source = memorySource(rows)
  let chunksYielded = 0
  source.scanColumn = ({ column }) => ({
    appliedWhere: true,
    appliedLimitOffset: true,
    async *chunks() {
      for (const row of rows) {
        let hold = Array.from({ length: 200000 }, (_, i) => `transient-${i}-${'x'.repeat(100)}`)
        assert.ok(hold.length > 0)
        hold = []
        chunksYielded++
        yield [row[column] ?? null]
      }
    },
  })
  const result = await executeQuerySql({
    query: 'SELECT MIN(a) AS n FROM t',
    registry: registryFor(source),
    storage,
    maxHeapBytes: 8 * 1024 * 1024,
  })
  assert.equal(result.rows[0].n, 1)
  assert.equal(chunksYielded, 4, 'the guard was checked against every chunk of the garbage-heavy stream')
})

test('the budget decoration forwards WHERE to scanColumn and preserves the applied flags', async () => {
  // A deliberately "lying" source is the only observable probe here: the
  // engine's re-filter of correctly filtered values is idempotent, so a
  // dropped appliedWhere flag would be invisible with an honest source.
  // This source claims the predicate applied while yielding values that
  // VIOLATE it; the count comes out 3 only if the flag survived the budget
  // wrapper and the engine trusted the stream.
  const rows = [{ a: 1 }]
  /** @type {{ column: string, hasWhere: boolean }[]} */
  const calls = []
  const source = memorySource(rows)
  source.scanColumn = ({ column, where }) => {
    calls.push({ column, hasWhere: where !== undefined })
    return {
      appliedWhere: true,
      appliedLimitOffset: false,
      async *chunks() {
        yield [101, 102, 103]
      },
    }
  }
  const result = await executeQuerySql({
    query: 'SELECT COUNT(*) AS n FROM t WHERE a < 10',
    registry: registryFor(source),
    storage,
  })
  assert.equal(result.rows[0].n, 3, 'appliedWhere passed through, so the engine did not re-filter')
  assert.deepEqual(calls, [{ column: 'a', hasWhere: true }], 'the predicate reached scanColumn through the budget wrapper')
})
