// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { executeQuerySql } from '../../src/core/query/sql.js'

// T1 (LLP 0059) signal threading: executeQuerySql must construct an AbortSignal
// from the caller's `signal`/`timeoutMs` and forward it into the engine so the
// operators' existing `context.signal` checks become reachable. These tests
// drive a fake AsyncDataSource whose `scan()` honors `hints.signal` the way the
// real leaf parquet scan does (throws on abort), and prove the abort propagates.

/** Storage stub; partitions carry no tablePath, so pendingInfo is never hit. */
const storage = { cacheRoot: '/tmp/hypaware-test', pendingInfo: async () => ({ pending: false }) }

/**
 * Build a registry whose single dataset `t` returns the given data source.
 * @param {any} source
 */
function makeRegistry(source) {
  return {
    getDataset: (/** @type {string} */ name) =>
      name === 't'
        ? { discoverPartitions: async () => [{}], createDataSource: () => source }
        : null,
    listDatasets: () => ['t'],
  }
}

/** @param {number} i */
const row = (i) => ({ columns: ['n'], cells: { n: () => Promise.resolve(i) }, resolved: { n: i } })

/**
 * A finite source that yields `count` rows and never aborts on its own. Used
 * for the backward-compatible (no-signal) path.
 * @param {number} count
 */
function finiteSource(count) {
  return {
    columns: ['n'],
    numRows: count,
    scan(/** @type {any} */ hints) {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (let i = 0; i < count; i++) {
            if (hints.signal?.aborted) throw new Error('scan aborted by signal')
            yield row(i)
          }
        },
      }
    },
  }
}

/**
 * An unbounded source that only ever stops by throwing once its scan sees the
 * threaded signal aborted. `onRow(i)` runs after each yield so a test can abort
 * deterministically mid-scan.
 * @param {(i: number) => void} [onRow]
 */
function unboundedSource(onRow) {
  return {
    columns: ['n'],
    numRows: undefined,
    scan(/** @type {any} */ hints) {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (let i = 0; ; i++) {
            if (hints.signal?.aborted) throw new Error('scan aborted by signal')
            yield row(i)
            if (onRow) onRow(i)
            // Yield to the event loop so a scheduled abort (timer) can fire.
            await new Promise((r) => setImmediate(r))
          }
        },
      }
    },
  }
}

test('a caller-aborted signal tears down a running query mid-scan', async () => {
  const controller = new AbortController()
  let produced = 0
  const source = unboundedSource((i) => {
    produced = i + 1
    // After a few rows the caller aborts; the next scan iteration must throw
    // rather than run the unbounded source to completion.
    if (produced === 3) controller.abort()
  })

  await assert.rejects(
    executeQuerySql({
      query: 'SELECT * FROM t',
      registry: /** @type {any} */ (makeRegistry(source)),
      storage: /** @type {any} */ (storage),
      signal: controller.signal,
    }),
    /aborted/
  )
  assert.ok(produced >= 3, `expected rows to flow before the abort, produced=${produced}`)
})

test('an already-aborted signal stops the query before it completes', async () => {
  const source = unboundedSource()
  await assert.rejects(
    executeQuerySql({
      query: 'SELECT * FROM t',
      registry: /** @type {any} */ (makeRegistry(source)),
      storage: /** @type {any} */ (storage),
      signal: AbortSignal.abort(),
    }),
    /aborted/
  )
})

test('a timeoutMs deadline aborts a slow query', async () => {
  // The source delays each row, so the 5ms deadline trips mid-scan and the
  // composed AbortSignal.timeout aborts the otherwise-unbounded scan.
  const source = {
    columns: ['n'],
    numRows: undefined,
    scan(/** @type {any} */ hints) {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (let i = 0; ; i++) {
            if (hints.signal?.aborted) throw new Error('scan aborted by signal')
            yield row(i)
            await new Promise((r) => setTimeout(r, 1))
          }
        },
      }
    },
  }
  await assert.rejects(
    executeQuerySql({
      query: 'SELECT * FROM t',
      registry: /** @type {any} */ (makeRegistry(source)),
      storage: /** @type {any} */ (storage),
      timeoutMs: 5,
    }),
    /aborted/
  )
})

test('a normal query with no signal still returns all rows (backward compatible)', async () => {
  const result = await executeQuerySql({
    query: 'SELECT * FROM t',
    registry: /** @type {any} */ (makeRegistry(finiteSource(3))),
    storage: /** @type {any} */ (storage),
  })
  assert.deepEqual(result.columns, ['n'])
  assert.equal(result.rows.length, 3)
  assert.deepEqual(
    result.rows.map((r) => r.n),
    [0, 1, 2]
  )
})
