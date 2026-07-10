// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { asyncRow } from 'squirreling'
import { executeQuerySql, QueryExecutionBudgetError } from '../../src/core/query/sql.js'

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
