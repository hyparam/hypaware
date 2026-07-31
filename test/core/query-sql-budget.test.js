// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { executeQuerySql } from '../../src/core/query/sql.js'
import { QueryBudgetExceededError } from '../../src/core/query/index.js'

// T7 (LLP 0059) kernel execution budget: `ExecuteSqlOptions.budget` must flow
// into `squirrelExecuteSql` (over the T1 signal) so the engine's blocking
// operators (ORDER BY here) refuse rather than buffer without bound, and the
// typed `QueryBudgetExceededError` re-exported from `hypaware/core/query`
// (LLP 0054 #execution-budget) is what a caller actually catches.

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
 * A finite source with no `scanColumn`, so ORDER BY takes the buffering
 * `executeSort` path (the operator this budget is meant to bound).
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
            if (hints?.signal?.aborted) throw new Error('scan aborted by signal')
            yield row(i)
          }
        },
      }
    },
  }
}

test('a low buffered-row budget refuses ORDER BY over the ceiling with a typed error', async () => {
  await assert.rejects(
    executeQuerySql({
      query: 'SELECT * FROM t ORDER BY n',
      registry: /** @type {any} */ (makeRegistry(finiteSource(20))),
      storage: /** @type {any} */ (storage),
      budget: { maxBufferedRows: 5 },
    }),
    (err) => {
      assert.ok(err instanceof QueryBudgetExceededError, `expected QueryBudgetExceededError, got ${err}`)
      const budgetErr = /** @type {InstanceType<typeof QueryBudgetExceededError>} */ (err)
      assert.equal(budgetErr.name, 'QueryBudgetExceededError')
      assert.equal(budgetErr.operator, 'ORDER BY')
      assert.equal(budgetErr.limitKind, 'rows')
      assert.equal(budgetErr.limit, 5)
      assert.ok(budgetErr.observed > 5, `expected observed > 5, got ${budgetErr.observed}`)
      return true
    }
  )
})

test('a low buffered-byte budget also refuses, distinctly from the row ceiling', async () => {
  await assert.rejects(
    executeQuerySql({
      query: 'SELECT * FROM t ORDER BY n',
      registry: /** @type {any} */ (makeRegistry(finiteSource(20))),
      storage: /** @type {any} */ (storage),
      budget: { maxBufferedBytes: 1 },
    }),
    (err) => {
      assert.ok(err instanceof QueryBudgetExceededError, `expected QueryBudgetExceededError, got ${err}`)
      const budgetErr = /** @type {InstanceType<typeof QueryBudgetExceededError>} */ (err)
      assert.equal(budgetErr.limitKind, 'bytes')
      assert.equal(budgetErr.limit, 1)
      return true
    }
  )
})

test('a query safely under the budget still returns every row (refusal, not truncation)', async () => {
  const result = await executeQuerySql({
    query: 'SELECT * FROM t ORDER BY n',
    registry: /** @type {any} */ (makeRegistry(finiteSource(3))),
    storage: /** @type {any} */ (storage),
    budget: { maxBufferedRows: 1000 },
  })
  assert.deepEqual(
    result.rows.map((r) => r.n),
    [0, 1, 2]
  )
})

test('an un-configured caller still runs under the kernel default budget (bounded out of the box)', async () => {
  // No `budget` passed: exercises the kernel's own conservative default rather
  // than an explicit test override. A small dataset must stay well under it.
  const result = await executeQuerySql({
    query: 'SELECT * FROM t ORDER BY n',
    registry: /** @type {any} */ (makeRegistry(finiteSource(3))),
    storage: /** @type {any} */ (storage),
  })
  assert.equal(result.rows.length, 3)
})
