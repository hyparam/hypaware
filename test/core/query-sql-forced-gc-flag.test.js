// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const SQL_MODULE = new URL('../../src/core/query/sql.js', import.meta.url).href

/**
 * Source for a child process that runs one budget-tripping query with
 * `v8.setFlagsFromString`, `vm.runInNewContext` and `globalThis.gc` spied
 * on, and prints what the guard's GC-handle resolve did. The resolve is
 * cached for the life of a process, so each path through it needs a process
 * of its own; the `--expose-gc` path additionally needs a launch flag, and
 * the refusing path needs `HYP_TEST_REFUSE_GC`.
 *
 * Every assertion in this file is about V8 flag state, which is a property
 * of a whole process rather than of a test: run in-process, an ambient
 * `--expose-gc` would put the runner itself on the guard's already-exposed
 * early return and no assertion could then tell a leak from the launcher's
 * own flag. Probing from a child whose exposure `runChildProbe` decides is
 * what keeps these tests reading the mechanism instead of the environment.
 *
 * Rows are padded so the raw heap delta of the scan is unambiguously above
 * the one-byte budget, whatever the ambient heap does between the baseline
 * sample and the first check. A one-byte budget is the cheapest way to make
 * the guard reach its GC-handle resolve on every host.
 */
const CHILD_PROBE = `
  import v8 from 'node:v8'
  import vm from 'node:vm'
  const throwOnReset = process.env.HYP_TEST_THROW_ON_RESET === '1'
  const realSetFlags = v8.setFlagsFromString
  const flagCalls = []
  v8.setFlagsFromString = (flags) => {
    flagCalls.push(flags)
    // Stand in for a runtime whose setFlagsFromString is unavailable or
    // refuses: a hardened embedding, or a 'node:v8' shim.
    if (throwOnReset && flags === '--no-expose-gc') throw new TypeError('setFlagsFromString is not available')
    return realSetFlags.call(v8, flags)
  }
  const refuseGc = process.env.HYP_TEST_REFUSE_GC === '1'
  const realRunInNewContext = vm.runInNewContext
  const contextSources = []
  vm.runInNewContext = (code, ...rest) => {
    contextSources.push(code)
    // Stand in for the build or host that refuses to expose 'gc': the flag
    // is accepted, but reading the binding out of a fresh context throws.
    if (refuseGc && code === 'gc') throw new ReferenceError('gc is not defined')
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
  let errorName = null
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
    errorName = err && err.name
    gcMode = err && err.diagnostics ? err.diagnostics.gcMode : null
  }
  console.log('HYP_PROBE ' + JSON.stringify({
    gcFlagCalls: flagCalls.filter((flag) => flag.includes('expose-gc') || flag.includes('expose_gc')),
    gcSourceEvals: contextSources.filter((code) => code === 'gc'),
    gcCalls,
    outcome,
    errorName,
    gcMode,
    exposedAfter: realRunInNewContext('typeof gc'),
  }))
`

/**
 * The child's gc exposure has to come from `nodeArgs` alone, so the ambient
 * NODE_OPTIONS is stripped of the exposing flag on the way in. Someone
 * chasing a heap problem in this very guard is exactly the person likely to
 * have it set, and it would otherwise push an unexposed probe onto the
 * guard's already-exposed early return: the run would then fail on an opaque
 * flag-call diff instead of exercising the path the test is named for.
 *
 * The match is on the flag's normalized form because V8 treats `_` and `-`
 * as the same separator and Node honours `NODE_OPTIONS=--expose_gc` exactly
 * as it honours `--expose-gc`; matching the hyphenated spelling alone would
 * leave the underscore one to slip through and reintroduce that failure.
 * Every other inherited option is preserved.
 *
 * @param {string[]} nodeArgs
 * @param {Record<string, string>} [extraEnv]
 * @returns {any}
 */
function runChildProbe(nodeArgs, extraEnv = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, ...extraEnv, HYP_TEST_SQL_MODULE: SQL_MODULE }
  const inherited = env.NODE_OPTIONS
  if (inherited) {
    env.NODE_OPTIONS = inherited
      .split(/\s+/)
      .filter((opt) => opt.replace(/_/g, '-') !== '--expose-gc')
      .join(' ')
  }
  const out = execFileSync(
    process.execPath,
    [...nodeArgs, '--input-type=module', '-e', CHILD_PROBE],
    { cwd: REPO_ROOT, encoding: 'utf8', env }
  )
  const line = out.split('\n').find((candidate) => candidate.startsWith('HYP_PROBE '))
  assert.ok(line, `child probe printed no report: ${out}`)
  return JSON.parse(line.slice('HYP_PROBE '.length))
}

test('a host that refuses gc does not leave --expose-gc set process-wide', () => {
  // The live fallback path the guard's gcMode=unavailable branch exists for,
  // and the only path on which the reset can be skipped.
  const report = runChildProbe([], { HYP_TEST_REFUSE_GC: '1' })
  assert.deepEqual(report.gcSourceEvals, ['gc'], 'the guard reached vm.runInNewContext("gc") exactly once')
  // Proves the refusal stub drove the guard rather than a real handle: with
  // no GC handle the guard refuses on the raw delta and says so.
  assert.equal(report.outcome, 'refused', `the budget guard refused, so it really ran (got ${report.outcome})`)
  assert.equal(report.errorName, 'QueryExecutionBudgetError', 'typed refusal, not a generic error')
  assert.equal(report.gcMode, 'unavailable', 'the guard ran without a GC handle')
  assert.deepEqual(
    report.gcFlagCalls,
    ['--expose-gc', '--no-expose-gc'],
    'the reset ran even though reading gc threw'
  )
  assert.equal(
    report.exposedAfter,
    'undefined',
    'the guard left --expose-gc enabled process-wide: after a refused gc handle, every context created for the rest of this daemon or CLI invocation gets a gc binding'
  )
})

test('a reset the runtime refuses degrades the guard, it does not abort the query', () => {
  // A `finally` is outside the reach of its sibling `catch`, so moving the
  // reset there put it beyond the swallow that used to cover it. On a
  // runtime whose setFlagsFromString throws, an unswallowed reset escapes
  // resolveForcedGc from inside guard.check and refuses an otherwise valid
  // query with a raw V8 error instead of falling back to gcMode=unavailable.
  const report = runChildProbe([], { HYP_TEST_REFUSE_GC: '1', HYP_TEST_THROW_ON_RESET: '1' })
  assert.deepEqual(
    report.gcFlagCalls,
    ['--expose-gc', '--no-expose-gc'],
    'the reset was attempted, so the throw this test is about really happened'
  )
  assert.equal(report.outcome, 'refused', `the query settled on the budget, not on the reset's error (got ${report.outcome})`)
  assert.equal(report.errorName, 'QueryExecutionBudgetError', 'the typed budget refusal, not the runtime error')
  assert.equal(report.gcMode, 'unavailable', 'a resolve that cannot complete degrades the guard rather than failing it')
  // exposedAfter is deliberately not asserted here: the flag stays set
  // because the runtime refused to clear it, which is that runtime's
  // behaviour and not something the guard can do anything about.
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
