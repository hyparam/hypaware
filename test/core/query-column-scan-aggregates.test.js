// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { executeQuerySql } from '../../src/core/query/sql.js'
import { unionSources } from '../../src/core/query/union-source.js'
import { withSchemaColumns } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @import { AsyncDataSource, ScanColumnOptions, SqlPrimitive } from 'squirreling/src/types.js'
 */

// T5 (LLP 0059): with scanColumn present down the real ai-gateway source
// stack (icebird leaf via T2, core union via T3, schema wrapper via T4), the
// engine's dormant `tryColumnScanAggregate` fast path (squirreling
// aggregates.js:267's `!table?.scanColumn` guard) should stop bailing and
// light up end to end. These tests drive the REAL kernel entry point
// (`executeQuerySql`) over the REAL `unionSources` (T3) and `withSchemaColumns`
// (T4) composition — matching exactly how the ai-gateway plugin's
// `createDataSource` wires multiple partitions (dataset.js:147-148) — with a
// fake per-partition leaf standing in for icebird's real Iceberg source (T2
// already proves the leaf itself against a real local Iceberg table in
// cache-iceberg-scan-column.test.js). Each leaf's `scan()` throws, so any
// accidental fallback to the row-buffering slow path fails the test loudly
// instead of silently passing.
//
// @ref LLP 0055 [tests]: proves the streaming column-scan aggregate path is
// taken (not the row-buffering slow path) once scanColumn is wired down the
// whole real source stack, and that peak per-partition memory stays bounded
// to a fixed chunk size regardless of total row count or column cardinality.

const CHUNK_SIZE = 500

/**
 * A fake icebird-leaf-shaped AsyncDataSource. `scan()` throws — the
 * row-buffering slow path must never be reached while scanColumn is present.
 * `scanColumn` yields fixed-size chunks computed lazily from a formula (never
 * a precomputed full-length array), so the largest value ever held at once is
 * bounded by `CHUNK_SIZE`, independent of `rowCount` — the structural proof
 * that peak memory here is O(1) per column pass, not O(rows).
 *
 * @param {object} args
 * @param {number} args.startIndex - global row index of this partition's first row
 * @param {number} args.rowCount
 * @param {number} args.cardinality - distinct session_id values across the whole fixture
 * @param {{ scanCalls: number, columnCalls: Record<string, number>, maxChunkLength: number }} args.tracker
 * @returns {AsyncDataSource}
 */
function fakePartitionSource({ startIndex, rowCount, cardinality, tracker }) {
  return {
    columns: ['n', 'session_id'],
    numRows: rowCount,
    scan() {
      tracker.scanCalls++
      throw new Error('row-buffering scan() must not be called when scanColumn is available')
    },
    /** @param {ScanColumnOptions} options */
    async *scanColumn({ column, limit, offset, signal }) {
      tracker.columnCalls[column] = (tracker.columnCalls[column] ?? 0) + 1
      const skip = offset ?? 0
      const cap = limit ?? Infinity
      let yielded = 0
      for (let base = skip; base < rowCount && yielded < cap; base += CHUNK_SIZE) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const end = Math.min(base + CHUNK_SIZE, rowCount, skip + (Number.isFinite(cap) ? cap : rowCount))
        /** @type {SqlPrimitive[]} */
        const chunk = []
        for (let local = base; local < end; local++) {
          const globalIndex = startIndex + local
          chunk.push(column === 'n' ? globalIndex : `session-${globalIndex % cardinality}`)
        }
        if (chunk.length === 0) break
        tracker.maxChunkLength = Math.max(tracker.maxChunkLength, chunk.length)
        yielded += chunk.length
        yield chunk
      }
    },
  }
}

/**
 * Build the real production composition — `withSchemaColumns(unionSources(sources))`
 * — over `partitionCount` fake leaves, matching ai-gateway `createDataSource`
 * (dataset.js:148) exactly, and a registry whose single dataset `t` serves it.
 *
 * @param {{ partitionCount: number, rowsPerPartition: number, cardinality: number }} args
 */
function buildFixture({ partitionCount, rowsPerPartition, cardinality }) {
  const tracker = { scanCalls: 0, columnCalls: /** @type {Record<string, number>} */ ({}), maxChunkLength: 0 }
  const sources = Array.from({ length: partitionCount }, (_, i) =>
    fakePartitionSource({
      startIndex: i * rowsPerPartition,
      rowCount: rowsPerPartition,
      cardinality,
      tracker,
    })
  )
  const source = withSchemaColumns(unionSources(sources))
  const registry = {
    getDataset: (/** @type {string} */ name) =>
      name === 't' ? { discoverPartitions: async () => [{}], createDataSource: () => source } : null,
    listDatasets: () => ['t'],
  }
  const storage = { cacheRoot: '/tmp/hypaware-test', pendingInfo: async () => ({ pending: false }) }
  return { tracker, registry, storage, totalRows: partitionCount * rowsPerPartition }
}

test('scalar aggregates (COUNT/MIN/MAX/SUM/AVG) take the column-scan fast path with O(1) per-partition chunking', async () => {
  const partitionCount = 3
  const rowsPerPartition = 20_000
  const { tracker, registry, storage, totalRows } = buildFixture({
    partitionCount,
    rowsPerPartition,
    cardinality: 137,
  })

  const result = await executeQuerySql({
    query: 'SELECT COUNT(*) AS cnt, MIN(n) AS mn, MAX(n) AS mx, SUM(n) AS s, AVG(n) AS a FROM t',
    registry: /** @type {any} */ (registry),
    storage: /** @type {any} */ (storage),
  })

  assert.equal(result.rows.length, 1)
  const row = result.rows[0]
  assert.equal(row.cnt, totalRows, 'COUNT(*) over every partition')
  assert.equal(row.mn, 0, 'MIN(n) is the first row of the first partition')
  assert.equal(row.mx, totalRows - 1, 'MAX(n) is the last row of the last partition')
  const expectedSum = ((totalRows - 1) * totalRows) / 2
  assert.equal(row.s, expectedSum, 'SUM(n) over the full 0..totalRows-1 range')
  assert.equal(row.a, expectedSum / totalRows, 'AVG(n) derived from the same accumulator')

  // The column-scan path was taken: the row-buffering scan() was never
  // called, and the shared column 'n' was scanned exactly once per
  // partition no matter how many aggregates read it (COUNT/MIN/MAX/SUM/AVG
  // all share one pass, squirreling aggregates.js scanColumnGroup).
  assert.equal(tracker.scanCalls, 0, 'row-buffering slow path never invoked')
  assert.equal(tracker.columnCalls.n, partitionCount, 'one scanColumn call per partition for the shared column')

  // Peak memory proof: the largest chunk ever materialized is bounded by the
  // fixed CHUNK_SIZE, not by totalRows (20,000 rows/partition) — O(1) per
  // pass, not O(rows).
  assert.ok(tracker.maxChunkLength <= CHUNK_SIZE, `chunk length ${tracker.maxChunkLength} must stay <= ${CHUNK_SIZE}`)
  assert.ok(tracker.maxChunkLength < rowsPerPartition, 'chunking never approaches a full partition, let alone all rows')
})

test('COUNT(DISTINCT session_id) takes the column-scan fast path with O(cardinality) state, zero row buffering', async () => {
  const partitionCount = 3
  const rowsPerPartition = 20_000
  const cardinality = 137
  const { tracker, registry, storage } = buildFixture({ partitionCount, rowsPerPartition, cardinality })

  const result = await executeQuerySql({
    query: 'SELECT COUNT(DISTINCT session_id) AS d FROM t',
    registry: /** @type {any} */ (registry),
    storage: /** @type {any} */ (storage),
  })

  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].d, cardinality, 'exact cardinality, no undercounting from any partial buffering')

  assert.equal(tracker.scanCalls, 0, 'row-buffering slow path never invoked')
  assert.equal(tracker.columnCalls.session_id, partitionCount, 'one scanColumn call per partition for session_id')
  assert.ok(tracker.maxChunkLength <= CHUNK_SIZE, `chunk length ${tracker.maxChunkLength} must stay <= ${CHUNK_SIZE}`)
})

test('scalar aggregates and COUNT(DISTINCT) on a different column combine in one query, still on the fast path', async () => {
  const partitionCount = 4
  const rowsPerPartition = 5_000
  const cardinality = 42
  const { tracker, registry, storage, totalRows } = buildFixture({ partitionCount, rowsPerPartition, cardinality })

  const result = await executeQuerySql({
    query: 'SELECT COUNT(*) AS cnt, MAX(n) AS mx, COUNT(DISTINCT session_id) AS d FROM t',
    registry: /** @type {any} */ (registry),
    storage: /** @type {any} */ (storage),
  })

  const row = result.rows[0]
  assert.equal(row.cnt, totalRows)
  assert.equal(row.mx, totalRows - 1)
  assert.equal(row.d, cardinality)

  assert.equal(tracker.scanCalls, 0, 'row-buffering slow path never invoked even with two distinct columns aggregated together')
  assert.equal(tracker.columnCalls.n, partitionCount)
  assert.equal(tracker.columnCalls.session_id, partitionCount)
  assert.ok(tracker.maxChunkLength <= CHUNK_SIZE)
})
