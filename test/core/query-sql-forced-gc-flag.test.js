// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import { asyncRow } from 'squirreling'
import { executeQuerySql, QueryExecutionBudgetError } from '../../src/core/query/sql.js'

/**
 * @import { AsyncDataSource, SqlPrimitive } from 'squirreling/src/types.js'
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SQL_MODULE = new URL('../../src/core/query/sql.js', import.meta.url).href

/**
 * Rows padded so the raw heap delta of a scan is unambiguously above the
 * one-byte budget these tests use, whatever the ambient heap does between
 * the baseline sample and the first check. A one-byte budget is the
 * cheapest way to make the guard reach its GC-handle resolve on every host.
 *
 * @returns {Record<string, SqlPrimitive>[]}
 */
function paddedRows() {
  return Array.from({ length: 20000 }, (_, i) => ({ a: `value-${i}-${'x'.repeat(1000)}` }))
}

/**
 * @param {Record<string, SqlPrimitive>[]} rows
 * @returns {AsyncDataSource}
 */
function memorySource(rows) {
  const columns = Object.keys(rows[0] ?? {})
  return {
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
}

/**
 * @param {AsyncDataSource} source
 */
function registryFor(source) {
  const dataset = { discoverPartitions: async () => [], createDataSource: async () => source }
  return /** @type {any} */ ({ getDataset: () => dataset, listDatasets: () => [] })
}

const storage = /** @type {any} */ ({
  cacheRoot: '/tmp/hypaware-test',
  pendingInfo: async () => ({ pending: false }),
})

/**
 * Source for a child process that runs one budget-tripping query with
 * `v8.setFlagsFromString`, `vm.runInNewContext` and `globalThis.gc` spied
 * on, and prints what the guard's GC-handle resolve did. The resolve is
 * cached for the life of a process, so each path through it needs a process
 * of its own; the `--expose-gc` path additionally needs a launch flag.
 */
const CHILD_PROBE = `
  import v8 from 'node:v8'
  import vm from 'node:vm'
  const realSetFlags = v8.setFlagsFromString
  const flagCalls = []
  v8.setFlagsFromString = (flags) => {
    flagCalls.push(flags)
    return realSetFlags.call(v8, flags)
  }
  const realRunInNewContext = vm.runInNewContext
  const contextSources = []
  vm.runInNewContext = (code, ...rest) => {
    contextSources.push(code)
    return realRunInNewContext(code, ...rest)
  }
  let gcCalls = 0
  const realGc = globalThis.gc
  if (typeof realGc === 'function') {
    globalThis.gc = () => {
      gcCalls += 1
      return realGc()
    }
  }
  const { asyncRow } = await import('squirreling')
  const { executeQuerySql } = await import(process.env.HYP_TEST_SQL_MODULE)
  const rows = Array.from({ length: 20000 }, (_, i) => ({ a: 'value-' + i + '-' + 'x'.repeat(1000) }))
  const columns = ['a']
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
  const dataset = { discoverPartitions: async () => [], createDataSource: async () => source }
  let outcome = 'completed'
  let gcMode = null
  try {
    await executeQuerySql({
      query: 'SELECT a FROM t ORDER BY a',
      registry: { getDataset: () => dataset, listDatasets: () => [] },
      storage: { cacheRoot: '/tmp/hypaware-test', pendingInfo: async () => ({ pending: false }) },
      maxHeapBytes: 1,
    })
  } catch (err) {
    outcome = err && err.code === 'query_budget_exceeded' ? 'refused' : 'error:' + (err && err.message)
    gcMode = err && err.diagnostics ? err.diagnostics.gcMode : null
  }
  console.log('HYP_PROBE ' + JSON.stringify({
    gcFlagCalls: flagCalls.filter((flag) => flag.includes('expose-gc')),
    gcSourceEvals: contextSources.filter((code) => code === 'gc'),
    gcCalls,
    outcome,
    gcMode,
    exposedAfter: realRunInNewContext('typeof gc'),
  }))
`

/**
 * @param {string[]} nodeArgs
 * @returns {any}
 */
function runChildProbe(nodeArgs) {
  const out = execFileSync(
    process.execPath,
    [...nodeArgs, '--input-type=module', '-e', CHILD_PROBE],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, HYP_TEST_SQL_MODULE: SQL_MODULE } }
  )
  const line = out.split('\n').find((candidate) => candidate.startsWith('HYP_PROBE '))
  assert.ok(line, `child probe printed no report: ${out}`)
  return JSON.parse(line.slice('HYP_PROBE '.length))
}

test('a host that refuses gc does not leave --expose-gc set process-wide', async () => {
  assert.equal(
    typeof (/** @type {any} */ (globalThis).gc),
    'undefined',
    'precondition: this test process was not launched with --expose-gc'
  )
  const realRunInNewContext = vm.runInNewContext
  assert.equal(
    realRunInNewContext('typeof gc'),
    'undefined',
    'precondition: a fresh context has no gc before the budget guard resolves one'
  )

  // Stand in for the build or host that refuses to expose `gc`: the flag is
  // accepted, but reading the binding out of a fresh context throws. That is
  // the live fallback path the guard's gcMode=unavailable branch exists for,
  // and the only path on which the reset can be skipped.
  let refusals = 0
  const vmModule = /** @type {any} */ (vm)
  vmModule.runInNewContext = (/** @type {string} */ code, /** @type {any[]} */ ...rest) => {
    if (code === 'gc') {
      refusals += 1
      throw new ReferenceError('gc is not defined')
    }
    return realRunInNewContext(code, ...rest)
  }

  /** @type {string} */
  let exposedAfter
  try {
    await assert.rejects(
      executeQuerySql({
        query: 'SELECT a FROM t ORDER BY a',
        registry: registryFor(memorySource(paddedRows())),
        storage,
        maxHeapBytes: 1,
      }),
      (err) => {
        assert.ok(err instanceof QueryExecutionBudgetError, 'typed refusal, not a generic error')
        // Proves the stub drove the guard rather than a real handle: with no
        // GC handle the guard refuses on the raw delta and says so.
        assert.equal(err.diagnostics?.gcMode, 'unavailable', 'the guard ran without a GC handle')
        return true
      }
    )
  } finally {
    vmModule.runInNewContext = realRunInNewContext
    // Sample before cleaning up, then clean up unconditionally so a failing
    // assertion below does not hand the leaked flag to the rest of the file.
    exposedAfter = realRunInNewContext('typeof gc')
    v8.setFlagsFromString('--no-expose-gc')
  }

  assert.equal(refusals, 1, 'the guard reached vm.runInNewContext("gc") exactly once')
  assert.equal(
    exposedAfter,
    'undefined',
    'the guard left --expose-gc enabled process-wide: after a refused gc handle, every context created for the rest of this daemon or CLI invocation gets a gc binding'
  )
})

test('a host that hands out gc still gets a working handle, and the flag is still reset', () => {
  // The path the fallback shares with the throwing one: the flip must still
  // happen, the captured handle must still work after the flip back, and
  // the flag must not outlive the resolve.
  const report = runChildProbe([])
  assert.deepEqual(report.gcSourceEvals, ['gc'], 'the guard read gc out of one fresh context')
  assert.deepEqual(
    report.gcFlagCalls,
    ['--expose-gc', '--no-expose-gc'],
    'the flag is set for the resolve and cleared straight after it'
  )
  assert.equal(report.exposedAfter, 'undefined', 'no context created after the resolve gets a gc binding')
  assert.ok(
    report.outcome === 'refused' || report.outcome === 'completed',
    `the captured handle still works after the reset, so the query settles normally (got ${report.outcome})`
  )
  if (report.outcome === 'refused') assert.equal(report.gcMode, 'confirmed', 'the refusal was confirmed by a real GC')
})

test('a process launched with --expose-gc never touches the flag at all', () => {
  // The already-exposed early return has to short-circuit before the try,
  // so the reset added for the refusing host cannot clear a flag the caller
  // set deliberately.
  const report = runChildProbe(['--expose-gc'])
  assert.ok(report.gcCalls >= 1, 'the guard used the gc the launcher exposed')
  assert.deepEqual(report.gcFlagCalls, [], 'the already-exposed path sets no V8 flag, so it clears none either')
  assert.deepEqual(report.gcSourceEvals, [], 'the already-exposed path never reads gc out of a fresh context')
  assert.equal(report.exposedAfter, 'function', 'the flag the launcher set is still in force after the query')
})
