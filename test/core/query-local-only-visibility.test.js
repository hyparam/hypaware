// @ts-check

// The LLP 0105 query-seam visibility filter: local-only rows are withheld
// from callers whose context is exported, unknown callers fail closed,
// unprovenanced rows in content-declaring datasets are suppressed, the
// --include-local-only override bypasses, and none of the scan fast paths
// (scanColumn, numRows, pushed-down limit/where) can leak around the filter.
//
// @ref LLP 0105 [tests]: lattice truth table, unknown-caller exclusion, count reporting, override plumbing

import test from 'node:test'
import assert from 'node:assert/strict'

import { asyncRow } from 'squirreling'
import { executeQuerySql } from '../../src/core/query/sql.js'

/**
 * @import { AsyncDataSource, SqlPrimitive } from 'squirreling/src/types.js'
 * @import { UsagePolicyResolver } from '../../src/core/usage-policy/types.js'
 */

/**
 * A resolver over a fixed cwd->class map; anything unmapped is `full`.
 *
 * @param {Record<string, 'ignore' | 'local-only' | 'full'>} classes
 * @returns {UsagePolicyResolver}
 */
function fakeResolver(classes) {
  return {
    resolve(cwd) {
      const cls = classes[cwd] ?? 'full'
      return { class: cls, governedBy: null, declared: null }
    },
    isIgnored(cwd) {
      return (classes[cwd] ?? 'full') === 'ignore'
    },
  }
}

/**
 * A memory-backed AsyncDataSource with optional fast-path hooks so the tests
 * can prove the filter refuses to forward them.
 *
 * @param {Record<string, SqlPrimitive>[]} rows
 * @param {{
 *   scanColumnCalls?: string[],
 *   applyLimit?: boolean,
 *   whereMatcher?: (row: Record<string, SqlPrimitive>) => boolean,
 * }} [opts]
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
      let selected = rows
      let appliedWhere = false
      let appliedLimitOffset = false
      // A source that eagerly applies a pushed-down WHERE against the TRUE
      // values: if the visibility wrapper forwarded the hint on a
      // suppression-active dataset, a matched-then-suppressed row would leak
      // its presence.
      if (options?.where && opts.whereMatcher) {
        selected = selected.filter((r) => /** @type {NonNullable<typeof opts.whereMatcher>} */ (opts.whereMatcher)(r))
        appliedWhere = true
      }
      // A source that eagerly applies LIMIT/OFFSET by physical position: if
      // the wrapper forwarded the hint, the slice happens BEFORE withholding
      // and visible rows are lost.
      if (opts.applyLimit && options?.limit !== undefined) {
        const start = options.offset ?? 0
        selected = selected.slice(start, start + options.limit)
        appliedLimitOffset = true
      }
      return {
        appliedWhere,
        appliedLimitOffset,
        async *rows() {
          for (const row of selected) yield asyncRow(row, rowColumns)
        },
      }
    },
  }
  if (opts.scanColumnCalls) {
    const calls = opts.scanColumnCalls
    source.scanColumn = ({ column }) => ({
      async *[Symbol.asyncIterator]() {
        calls.push(column)
        yield rows.map((r) => r[column] ?? null)
      },
    })
  }
  return source
}

/**
 * @param {AsyncDataSource} source
 * @param {{ localOnlyContentColumns?: string[] }} [extras]
 */
function registryFor(source, extras = {}) {
  const dataset = {
    discoverPartitions: async () => [],
    createDataSource: async () => source,
    ...extras,
  }
  return /** @type {any} */ ({ getDataset: () => dataset, listDatasets: () => [] })
}

/** Rows across the three classes, all cwd-bearing. */
const ROWS = [
  { id: 1, cwd: '/w/full', msg: 'full-1' },
  { id: 2, cwd: '/w/full', msg: 'full-2' },
  { id: 3, cwd: '/w/lo', msg: 'lo-1' },
  { id: 4, cwd: '/w/ig', msg: 'ig-1' },
]

const CLASSES = /** @type {Record<string, 'ignore' | 'local-only' | 'full'>} */ ({
  '/w/lo': 'local-only',
  '/w/ig': 'ignore',
})

/**
 * @param {{ rows?: Record<string, SqlPrimitive>[], sql?: string, callerCwd?: string | null, includeLocalOnly?: boolean, source?: AsyncDataSource, extras?: { localOnlyContentColumns?: string[] } }} [opts]
 */
async function run(opts = {}) {
  const source = opts.source ?? memorySource(opts.rows ?? ROWS)
  return executeQuerySql({
    query: opts.sql ?? 'SELECT id, msg FROM t ORDER BY id',
    registry: registryFor(source, opts.extras),
    storage: /** @type {any} */ ({}),
    refresh: 'never',
    usagePolicyResolver: fakeResolver(CLASSES),
    ...(opts.callerCwd !== undefined ? { callerCwd: opts.callerCwd } : {}),
    ...(opts.includeLocalOnly !== undefined ? { includeLocalOnly: opts.includeLocalOnly } : {}),
  })
}

test('caller-class lattice truth table: include iff caller class >= row class', async () => {
  const cases = /** @type {const} */ ([
    // [callerCwd, expected msgs, expected withheld, expected class]
    ['/w/full', ['full-1', 'full-2'], 2, 'full'],
    ['/w/lo', ['full-1', 'full-2', 'lo-1'], 1, 'local-only'],
    ['/w/ig', ['full-1', 'full-2', 'lo-1', 'ig-1'], 0, 'ignore'],
    [null, ['full-1', 'full-2'], 2, 'unknown'],
  ])
  for (const [callerCwd, msgs, withheld, cls] of cases) {
    const out = await run({ callerCwd })
    assert.deepEqual(out.rows.map((r) => r.msg), [...msgs], `caller ${String(callerCwd)}`)
    assert.equal(out.localOnly.withheldRows, withheld, `withheld count for caller ${String(callerCwd)}`)
    assert.equal(out.localOnly.callerClass, cls)
    assert.equal(out.localOnly.filtered, cls !== 'ignore', 'a top-of-lattice caller skips the filter entirely')
  }
})

test('an omitted callerCwd behaves exactly like null: the fail-closed backstop', async () => {
  const out = await run({})
  assert.deepEqual(out.rows.map((r) => r.msg), ['full-1', 'full-2'])
  assert.equal(out.localOnly.callerClass, 'unknown')
  assert.equal(out.localOnly.withheldRows, 2)
})

test('includeLocalOnly bypasses the filter and reports it unfiltered', async () => {
  const out = await run({ callerCwd: '/w/full', includeLocalOnly: true })
  assert.deepEqual(out.rows.map((r) => r.msg), ['full-1', 'full-2', 'lo-1', 'ig-1'])
  assert.equal(out.localOnly.filtered, false)
  assert.equal(out.localOnly.withheldRows, 0)
})

test('a projection that omits cwd cannot blind the filter, and the forced cwd never leaks out', async () => {
  const out = await run({ sql: 'SELECT msg FROM t', callerCwd: '/w/full' })
  assert.deepEqual(out.rows.map((r) => r.msg).sort(), ['full-1', 'full-2'])
  assert.ok(out.rows.every((r) => !('cwd' in r)), 'the force-scanned cwd is stripped back off')
  assert.equal(out.localOnly.withheldRows, 2)
})

test('rows without a cwd value in a plain cwd-bearing dataset pass through (export-seam parity)', async () => {
  const rows = [
    { id: 1, cwd: null, msg: 'no-cwd' },
    { id: 2, cwd: '/w/lo', msg: 'lo-1' },
  ]
  const out = await run({ rows, callerCwd: '/w/full' })
  assert.deepEqual(out.rows.map((r) => r.msg), ['no-cwd'])
  assert.equal(out.localOnly.withheldRows, 1)
  assert.equal(out.localOnly.suppressedRows, 0)
})

test('COUNT(*) cannot use numRows around the filter and counts only visible rows', async () => {
  const out = await run({ sql: 'SELECT COUNT(*) AS n FROM t', callerCwd: '/w/full' })
  assert.equal(Number(out.rows[0].n), 2)
})

test('the scanColumn fast path is withheld from a filtered caller and stays lit for a top-of-lattice one', async () => {
  /** @type {string[]} */
  const filteredCalls = []
  const filtered = await run({
    source: memorySource(ROWS, { scanColumnCalls: filteredCalls }),
    sql: 'SELECT SUM(id) AS s FROM t',
    callerCwd: '/w/full',
  })
  assert.equal(Number(filtered.rows[0].s), 3, 'aggregate over visible rows only (1+2)')
  assert.deepEqual(filteredCalls, [], 'a single-column stream cannot carry cwd, so it must not be offered')

  /** @type {string[]} */
  const openCalls = []
  const open = await run({
    source: memorySource(ROWS, { scanColumnCalls: openCalls }),
    sql: 'SELECT SUM(id) AS s FROM t',
    callerCwd: '/w/ig',
  })
  assert.equal(Number(open.rows[0].s), 10)
  assert.deepEqual(openCalls, ['id'], 'an unfiltered caller keeps the streaming fast path')
})

test('a source that eagerly applies LIMIT cannot under-return visible rows', async () => {
  // Physical order puts the withheld rows first: a forwarded LIMIT 2 would
  // slice them off before the filter and return nothing.
  const rows = [
    { id: 1, cwd: '/w/lo', msg: 'lo-1' },
    { id: 2, cwd: '/w/lo', msg: 'lo-2' },
    { id: 3, cwd: '/w/full', msg: 'full-1' },
    { id: 4, cwd: '/w/full', msg: 'full-2' },
  ]
  const out = await run({
    source: memorySource(rows, { applyLimit: true }),
    sql: 'SELECT msg FROM t LIMIT 2',
    callerCwd: '/w/full',
  })
  assert.deepEqual(out.rows.map((r) => r.msg), ['full-1', 'full-2'])
})

test('suppression: unprovenanced rows in a content-declaring dataset expose structure, never content', async () => {
  const rows = [
    { node_id: 'n-1', node_type: 'Session', label: 'secret-label', props: 'p' },
    { node_id: 'n-2', node_type: 'Tool', label: 'Bash', props: null },
  ]
  const out = await run({
    source: memorySource(rows),
    extras: { localOnlyContentColumns: ['label', 'props'] },
    sql: 'SELECT node_id, label FROM t ORDER BY node_id',
    callerCwd: '/w/full',
  })
  assert.deepEqual(out.rows, [
    { node_id: 'n-1', label: null },
    { node_id: 'n-2', label: null },
  ])
  assert.equal(out.localOnly.suppressedRows, 2)
  assert.equal(out.localOnly.withheldRows, 0)
})

test('suppression is skipped when the scan touches no declared content column', async () => {
  const rows = [
    { node_id: 'n-1', node_type: 'Session', label: 'secret-label', props: 'p' },
  ]
  const out = await run({
    source: memorySource(rows),
    extras: { localOnlyContentColumns: ['label', 'props'] },
    sql: 'SELECT node_id FROM t',
    callerCwd: '/w/full',
  })
  assert.deepEqual(out.rows, [{ node_id: 'n-1' }])
  assert.equal(out.localOnly.suppressedRows, 0, 'structure-only reads lose nothing and report nothing')
})

test('a WHERE over a suppressed column cannot reveal content by row presence', async () => {
  const rows = [
    { node_id: 'n-1', node_type: 'Session', label: 'secret-label', props: null },
    { node_id: 'n-2', node_type: 'Tool', label: 'Bash', props: null },
  ]
  // The source eagerly applies a pushed-down WHERE against the true values;
  // the wrapper must keep the hint from it so the engine re-evaluates over
  // the suppressed (null) values, where nothing can match.
  const out = await run({
    source: memorySource(rows, { whereMatcher: (r) => r.label === 'secret-label' }),
    extras: { localOnlyContentColumns: ['label', 'props'] },
    sql: "SELECT node_id FROM t WHERE label = 'secret-label'",
    callerCwd: '/w/full',
  })
  assert.deepEqual(out.rows, [], 'a matched-then-suppressed row would confirm the content exists')
})

test('an ignore-classed caller sees unprovenanced content unsuppressed', async () => {
  const rows = [{ node_id: 'n-1', node_type: 'Session', label: 'secret-label', props: null }]
  const out = await run({
    source: memorySource(rows),
    extras: { localOnlyContentColumns: ['label', 'props'] },
    sql: 'SELECT node_id, label FROM t',
    callerCwd: '/w/ig',
  })
  assert.deepEqual(out.rows, [{ node_id: 'n-1', label: 'secret-label' }])
  assert.equal(out.localOnly.suppressedRows, 0)
})

test('a resolver failure propagates: the query fails loudly, never silently unfiltered', async () => {
  /** @type {UsagePolicyResolver} */
  const broken = {
    resolve() { throw new Error('local-only list unreadable') },
    isIgnored() { return false },
  }
  await assert.rejects(
    executeQuerySql({
      query: 'SELECT msg FROM t',
      registry: registryFor(memorySource(ROWS)),
      storage: /** @type {any} */ ({}),
      refresh: 'never',
      usagePolicyResolver: broken,
      callerCwd: '/w/full',
    }),
    /local-only list unreadable/
  )
})

test('datasets with neither cwd nor a content declaration are untouched', async () => {
  const rows = [{ k: 'a', v: 1 }, { k: 'b', v: 2 }]
  const out = await run({ source: memorySource(rows), sql: 'SELECT k, v FROM t ORDER BY k', callerCwd: null })
  assert.deepEqual(out.rows, rows)
  assert.equal(out.localOnly.filtered, false)
  assert.equal(out.localOnly.callerClass, 'unknown')
})
