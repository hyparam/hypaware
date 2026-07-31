// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { querySqlVerb } from '../../src/core/query/verb.js'
import { verbToCommand } from '../../src/core/cli/verb_command.js'
import { DEFAULT_EXECUTION_BUDGET } from '../../src/core/query/sql.js'

// T8 (LLP 0059): `hyp query sql` passes no explicit `budget`, so it runs
// under `executeQuerySql`'s host-default execution budget (LLP 0054
// #execution-budget); a refusal must reach the CLI caller as a stderr
// message plus a non-zero exit rather than a silent empty/partial result
// (LLP 0054 #uniform-surface).

const cmd = verbToCommand(querySqlVerb)

/** Storage stub; the fake partition carries no tablePath, so pendingInfo is never hit. */
const storage = { cacheRoot: '/tmp/hypaware-test', pendingInfo: async () => ({ pending: false }) }

/** @param {number} i */
const row = (i) => ({ columns: ['n'], cells: { n: () => Promise.resolve(i) }, resolved: { n: i } })

/**
 * A finite source with no `scanColumn`, so `ORDER BY` takes the buffering
 * sort path, which is what the (un-configured) host-default row ceiling
 * bounds. One row over the ceiling is enough to trip the refusal without
 * materializing a large fixture.
 * @param {number} count
 */
function finiteSource(count) {
  return {
    columns: ['n'],
    numRows: count,
    scan(/** @type {any} */ _hints) {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (let i = 0; i < count; i++) yield row(i)
        },
      }
    },
  }
}

/** @param {object} source */
function ctxWith(source) {
  /** @type {string[]} */ const out = []
  /** @type {string[]} */ const err = []
  const registry = {
    getDataset: (/** @type {string} */ name) =>
      name === 't'
        ? { discoverPartitions: async () => [{}], createDataSource: () => source }
        : null,
    listDatasets: () => ['t'],
  }
  const ctx = /** @type {any} */ ({
    env: {},
    config: { version: 2 },
    query: registry,
    storage,
    stdout: { write: (/** @type {string} */ s) => out.push(s) },
    stderr: { write: (/** @type {string} */ s) => err.push(s) },
  })
  return { ctx, out, err }
}

test('a query over the host-default row ceiling refuses to stderr with a non-zero exit', async () => {
  const overCeiling = (DEFAULT_EXECUTION_BUDGET.maxBufferedRows ?? 0) + 1
  const { ctx, out, err } = ctxWith(finiteSource(overCeiling))
  const code = await cmd.run(['SELECT * FROM t ORDER BY n'], ctx)
  assert.equal(code, 1)
  assert.match(err.join(''), /hyp query sql: Query execution budget exceeded: ORDER BY buffered \d+ rows, over the rows ceiling of \d+/)
  assert.equal(out.join(''), '')
})

test('a query safely under the ceiling still succeeds through the same CLI path', async () => {
  const { ctx, out, err } = ctxWith(finiteSource(3))
  const code = await cmd.run(['SELECT * FROM t ORDER BY n', '--format', 'json'], ctx)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out.join('')).map((/** @type {any} */ r) => r.n), [0, 1, 2])
  assert.equal(err.join(''), '')
})
