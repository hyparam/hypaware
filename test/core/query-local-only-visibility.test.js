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
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { asyncRow, selectVector } from 'squirreling'
import { executeQuerySql } from '../../src/core/query/sql.js'
import { withLocalOnlyVisibility } from '../../src/core/query/visibility.js'
import { appendRowsToTable, dataSourceForTable, deleteMatchingRows } from '../../src/core/cache/iceberg/store.js'
import { unionSources } from '../../src/core/query/union-source.js'

/**
 * @import { AsyncBatch, AsyncDataSource, RowSelection, SqlPrimitive } from 'squirreling/src/types.js'
 * @import { ScannableDataSource } from '../../hypaware-plugin-kernel-types.js'
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

/**
 * Native source whose deferred readers require their original batch.
 * @param {Record<string, SqlPrimitive>[]} rows
 * @param {RowSelection} selection
 * @returns {ScannableDataSource}
 */
function nativeSource(rows, selection) {
  const columns = ['id', 'cwd', 'msg']
  const fields = columns.map((name, index) => ({
    id: index + 10, name, nullable: true,
    dataType: name === 'id' ? /** @type {const} */ ({ type: 'number' }) : /** @type {const} */ ({ type: 'string' }),
  }))
  return {
    columns,
    schema: { fields },
    numRows: rows.length,
    scan() { throw new Error('visibility must stay on native batches') },
    prepareScan(request) {
      assert.equal(request.limit, undefined)
      assert.equal(request.offset, undefined)
      const cwdDemand = request.columns.find((demand) => demand.field === 11)
      assert.equal(cwdDemand?.mode, 'required')
      const requested = request.columns.map((demand) => fields.find((field) => field.id === demand.field))
      assert.ok(requested.every((field) => field !== undefined))
      return {
        schema: { fields: /** @type {typeof fields} */ (requested) },
        residual: { filter: request.filter },
        properties: { exactRows: rows.length, maxRows: rows.length },
        async *batches() {
          /** @type {AsyncBatch} */
          const batch = {
            selection,
            columns: requested.map((field) => ({
              read({ batch: input, selection: selected }) {
                assert.equal(input, batch, 'deferred readers retain their original input')
                const values = rows.map((row) => row[/** @type {NonNullable<typeof field>} */ (field).name])
                return selectVector({ type: 'values', values, length: rows.length }, selected)
              },
            })),
          }
          yield batch
        },
      }
    },
  }
}

// @ref LLP 0388#batch-filter [tests]: native filtering agrees with the row path through selections, aggregates, predicates and global range operators
test('native visibility agrees with row visibility across SQL shapes and caller classes', async () => {
  const rows = [...ROWS, { id: 5, cwd: null, msg: 'no provenance' }, { id: 6, cwd: '', msg: 'empty cwd' }]
  /** @type {{ selection: RowSelection, rows: typeof rows }[]} */
  const cases = [
    { selection: { type: 'all', length: rows.length }, rows },
    { selection: { type: 'range', start: 1, end: 5, length: rows.length }, rows: rows.slice(1, 5) },
    { selection: { type: 'indices', indices: new Uint32Array([0, 2, 4, 5]), length: rows.length }, rows: [rows[0], rows[2], rows[4], rows[5]] },
  ]
  const queries = [
    'SELECT id, msg FROM t ORDER BY id',
    'SELECT cwd, id FROM t ORDER BY id',
    'SELECT COUNT(*) AS n FROM t',
    'SELECT MIN(id) AS low, MAX(id) AS high, SUM(id) AS total FROM t',
    'SELECT cwd, COUNT(*) AS n FROM t GROUP BY cwd ORDER BY cwd',
    'SELECT id FROM t WHERE id > 1 LIMIT 2 OFFSET 1',
    "SELECT id FROM t WHERE cwd = '/w/lo'",
    'SELECT id FROM t ORDER BY id DESC LIMIT 2 OFFSET 1',
  ]
  for (const { selection, rows: selected } of cases) {
    for (const callerCwd of [null, '/w/full', '/w/lo']) {
      for (const sql of queries) {
        const native = await run({ source: nativeSource(rows, selection), sql, callerCwd })
        const legacy = await run({ rows: selected, sql, callerCwd })
        assert.deepEqual(native.rows, legacy.rows, `${selection.type}: ${callerCwd}: ${sql}`)
      }
    }
  }
  const out = await run({ source: nativeSource(rows, cases[0].selection) })
  assert.equal(out.localOnly.withheldRows, 2)
  assert.equal(out.localOnly.suppressedRows, 0)
})

test('native visibility drops an entirely withheld batch and propagates policy failures and aborts', async () => {
  const source = nativeSource(ROWS.slice(2), { type: 'all', length: 2 })
  assert.deepEqual((await run({ source, sql: 'SELECT COUNT(*) AS n FROM t' })).rows, [{ n: 0 }])
  const report = { callerClass: /** @type {const} */ ('unknown'), filtered: true, withheldRows: 0, suppressedRows: 0 }
  const guarded = withLocalOnlyVisibility(source, {
    resolver: { resolve() { throw new Error('policy unavailable') }, isIgnored() { return false } },
    callerRank: 0, report, contentColumns: [],
  })
  const scan = /** @type {NonNullable<typeof guarded.prepareScan>} */ (guarded.prepareScan)({ columns: [] })
  await assert.rejects(async () => { for await (const _ of scan.batches()) {} }, /policy unavailable/)
  const controller = new AbortController()
  controller.abort(new Error('query cancelled'))
  await assert.rejects(async () => { for await (const _ of scan.batches({ signal: controller.signal })) {} }, /query cancelled/)
})

test('content-suppressing sources retain the row path even when native batches are available', async () => {
  const rows = [{ id: 1, cwd: null, msg: 'secret' }]
  const native = nativeSource(rows, { type: 'all', length: 1 })
  const source = { ...native, scan: /** @type {ScannableDataSource} */ (memorySource(rows)).scan,
    prepareScan() { throw new Error('content suppression must use the row path') } }
  const out = await run({ source, extras: { localOnlyContentColumns: ['msg'] }, sql: "SELECT id FROM t WHERE msg = 'secret'" })
  assert.deepEqual(out.rows, [])
})

test('native visibility composes with real Iceberg position deletes and multiple partitions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-native-visibility-'))
  try {
    const sources = []
    for (const [index, rows] of [ROWS.slice(0, 2), ROWS.slice(2)].entries()) {
      const table = path.join(root, String(index))
      await appendRowsToTable(table, [
        { name: 'id', type: 'INT64', nullable: false },
        { name: 'cwd', type: 'STRING', nullable: true },
        { name: 'msg', type: 'STRING', nullable: true },
      ], rows)
      await deleteMatchingRows(table, (row) => Number(row.id) === 1, { columns: ['id'] })
      const source = await dataSourceForTable(table)
      assert.ok(source?.prepareScan)
      sources.push({ ...source, scan() { throw new Error('Iceberg visibility fell back to rows') } })
    }
    const source = unionSources(sources)
    assert.ok(source.prepareScan)
    assert.deepEqual((await run({ source, sql: 'SELECT COUNT(*) AS n FROM t' })).rows, [{ n: 1 }])
    assert.deepEqual((await run({ source, sql: 'SELECT id FROM t ORDER BY id' })).rows.map((row) => Number(row.id)), [2])
    assert.deepEqual((await run({ source, sql: 'SELECT id FROM t WHERE id > 1 LIMIT 1 OFFSET 1' })).rows, [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
