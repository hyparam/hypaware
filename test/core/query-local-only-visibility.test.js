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
import { renderLocalOnlyNotice } from '../../src/core/query/verb.js'
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
  const report = { callerClass: /** @type {const} */ ('unknown'), filtered: true, withheldRows: 0, suppressedRows: 0, unprovenancedRows: 0 }
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

test('each distinct cwd is resolved once per query, on both scan paths', async () => {
  const rows = [...ROWS, { id: 5, cwd: '/w/full', msg: 'full-3' }, { id: 6, cwd: '/w/lo', msg: 'lo-2' }]
  for (const native of [false, true]) {
    /** @type {string[]} */
    const calls = []
    const inner = fakeResolver(CLASSES)
    /** @type {UsagePolicyResolver} */
    const counting = { ...inner, resolve(cwd) { calls.push(cwd); return inner.resolve(cwd) } }
    for (let i = 0; i < 2; i++) {
      const out = await executeQuerySql({
        query: 'SELECT id FROM t ORDER BY id',
        registry: registryFor(native ? nativeSource(rows, { type: 'all', length: rows.length }) : memorySource(rows)),
        storage: /** @type {any} */ ({}),
        refresh: 'never',
        usagePolicyResolver: counting,
        callerCwd: '/w/full',
      })
      assert.deepEqual(out.rows.map((r) => r.id), [1, 2, 5])
      assert.equal(out.localOnly.withheldRows, 3)
    }
    // Per query: the caller cwd plus each distinct row cwd, and nothing carries over.
    const perQuery = ['/w/full', '/w/full', '/w/lo', '/w/ig']
    assert.deepEqual(calls.sort(), [...perQuery, ...perQuery].sort(), native ? 'native' : 'row')
  }
})

test('sources mixing cwd and content suppression retain the row path', async () => {
  const rows = [{ id: 1, cwd: null, msg: 'secret' }]
  const native = nativeSource(rows, { type: 'all', length: 1 })
  const source = { ...native, scan: /** @type {ScannableDataSource} */ (memorySource(rows)).scan,
    prepareScan() { throw new Error('content suppression must use the row path') } }
  const out = await run({ source, extras: { localOnlyContentColumns: ['msg'] }, sql: "SELECT id FROM t WHERE msg = 'secret'" })
  assert.deepEqual(out.rows, [])
})

// @ref LLP 0431#native-suppression [tests]: graph-shaped sources stay native without leaking predicate matches, decoding content or losing deletes
test('cwd-less native suppression agrees with row semantics across predicates, ranges and deletes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-native-suppression-'))
  const rows = [{ id: 1, msg: 'deleted' }, { id: 2, msg: 'secret' }, { id: 3, msg: 'other' }]
  try {
    await appendRowsToTable(root, [
      { name: 'id', type: 'INT64', nullable: false },
      { name: 'msg', type: 'STRING', nullable: false },
    ], rows)
    await deleteMatchingRows(root, row => Number(row.id) === 1, { columns: ['id'] })
    const original = await dataSourceForTable(root)
    assert.ok(original?.prepareScan)
    const prepare = original.prepareScan.bind(original)
    const source = { ...original, scan() { throw new Error('suppression fell back to rows') },
      prepareScan(request) {
        const contentRequested = request.columns.some(demand => original.schema?.fields.find(f => f.id === demand.field)?.name === 'msg')
        if (contentRequested) assert.equal(request.filter, undefined, 'content predicates cannot reach the source')
        assert.equal(request.limit, undefined)
        assert.equal(request.offset, undefined)
        const inner = prepare(request)
        return { ...inner, async *batches(options) {
          for await (const batch of inner.batches(options)) {
            yield { ...batch, columns: batch.columns.map((column, i) => inner.schema.fields[i].name === 'msg'
              ? { read() { throw new Error('suppressed content must not be decoded') } } : column) }
          }
        } }
      },
    }
    for (const sql of [
      'SELECT id, msg FROM t ORDER BY id',
      "SELECT id FROM t WHERE msg = 'secret'",
      "SELECT id FROM t WHERE msg = 'other' OR id = 2",
      'SELECT id, msg FROM t WHERE msg IS NULL ORDER BY id LIMIT 1 OFFSET 1',
      'SELECT id FROM t WHERE msg IS NOT NULL',
      'SELECT COUNT(*) AS n, COUNT(msg) AS visible FROM t',
      'SELECT id FROM t WHERE id > 1 ORDER BY id LIMIT 1 OFFSET 1',
      'SELECT msg, COUNT(*) AS n FROM t GROUP BY msg',
    ]) {
      const extras = { localOnlyContentColumns: ['msg'] }
      const native = await run({ source, extras, sql })
      const legacy = await run({ rows: rows.slice(1), extras, sql })
      assert.deepEqual(native.rows.map(row => 'id' in row ? { ...row, id: Number(row.id) } : row), legacy.rows, sql)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
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

test('a top-k hint cannot prune visible rows behind withheld ones that sort first', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-native-visibility-topk-'))
  try {
    // One data file per append: the withheld rows fill the file whose bounds
    // sort first, so a source pruning to the best k files before the filter
    // runs keeps only rows the caller cannot see.
    const files = [
      [1, 2, 3, 4].map((id) => ({ id, cwd: '/w/lo', msg: `lo-${id}` })),
      [5, 6, 7, 8].map((id) => ({ id, cwd: '/w/full', msg: `full-${id}` })),
      [9, 10, 11, 12].map((id) => ({ id, cwd: '/w/full', msg: `full-${id}` })),
    ]
    for (const rows of files) {
      await appendRowsToTable(root, [
        { name: 'id', type: 'INT64', nullable: false },
        { name: 'cwd', type: 'STRING', nullable: true },
        { name: 'msg', type: 'STRING', nullable: true },
      ], rows)
    }
    const table = await dataSourceForTable(root)
    assert.ok(table?.prepareScan)
    const source = { ...table, scan() { throw new Error('Iceberg visibility fell back to rows') } }
    /** @param {string} sql */
    const ids = async (sql) => (await run({ source, sql, callerCwd: '/w/full' })).rows.map((row) => Number(row.id))
    assert.deepEqual(await ids('SELECT id FROM t ORDER BY id LIMIT 2'), [5, 6])
    assert.deepEqual(await ids('SELECT id FROM t ORDER BY id LIMIT 2 OFFSET 3'), [8, 9])
    assert.deepEqual(await ids('SELECT id, msg FROM t ORDER BY id LIMIT 6'), [5, 6, 7, 8, 9, 10])
    // A local-only caller is still wrapped (ignore outranks it) but withholds nothing here.
    assert.deepEqual((await run({ source, sql: 'SELECT id FROM t ORDER BY id LIMIT 2', callerCwd: '/w/lo' })).rows.map((row) => Number(row.id)), [1, 2])
    // An include-local-only read skips the wrapper and keeps the hint.
    assert.deepEqual((await run({ source, sql: 'SELECT id FROM t ORDER BY id LIMIT 2', includeLocalOnly: true })).rows.map((row) => Number(row.id)), [1, 2])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a top-k hint over a suppressed content column cannot order rows by their true values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-native-suppression-topk-'))
  try {
    // The file holding the content that sorts first is written second: a
    // source pruning on the true values would return its rows, where the
    // suppressed (all null) column leaves the engine the scan order.
    for (const rows of [
      [{ id: 1, msg: 'y' }, { id: 2, msg: 'z' }],
      [{ id: 3, msg: 'a' }, { id: 4, msg: 'b' }],
    ]) {
      await appendRowsToTable(root, [
        { name: 'id', type: 'INT64', nullable: false },
        { name: 'msg', type: 'STRING', nullable: false },
      ], rows)
    }
    const table = await dataSourceForTable(root)
    assert.ok(table?.prepareScan)
    const source = { ...table, scan() { throw new Error('suppression fell back to rows') } }
    const extras = { localOnlyContentColumns: ['msg'] }
    for (const sql of ['SELECT id FROM t ORDER BY msg LIMIT 2', 'SELECT id FROM t ORDER BY msg DESC LIMIT 1 OFFSET 1']) {
      const native = await run({ source, extras, sql })
      const legacy = await run({ rows: [{ id: 1, msg: 'y' }, { id: 2, msg: 'z' }, { id: 3, msg: 'a' }, { id: 4, msg: 'b' }], extras, sql })
      assert.deepEqual(native.rows.map((row) => ({ id: Number(row.id) })), legacy.rows, sql)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a top-k hint cannot prune ahead of a WHERE kept from the source for suppression', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-native-suppression-topk-where-'))
  try {
    // Content is demanded, so the WHERE stays residual. The rows it matches
    // sit in the file whose bounds sort last: pruning to the best k files
    // before that WHERE keeps only rows it then drops.
    const all = [{ id: 1, kind: 'a', msg: 'p' }, { id: 2, kind: 'a', msg: 'q' }, { id: 3, kind: 'b', msg: 'r' }, { id: 4, kind: 'b', msg: 's' }]
    for (const rows of [all.slice(0, 2), all.slice(2)]) {
      await appendRowsToTable(root, [
        { name: 'id', type: 'INT64', nullable: false },
        { name: 'kind', type: 'STRING', nullable: false },
        { name: 'msg', type: 'STRING', nullable: false },
      ], rows)
    }
    const table = await dataSourceForTable(root)
    assert.ok(table?.prepareScan)
    const source = { ...table, scan() { throw new Error('suppression fell back to rows') } }
    const extras = { localOnlyContentColumns: ['msg'] }
    for (const sql of [
      "SELECT id, msg FROM t WHERE kind = 'b' ORDER BY id LIMIT 2",
      "SELECT id, msg FROM t WHERE msg IS NULL AND kind = 'b' ORDER BY id LIMIT 1 OFFSET 1",
    ]) {
      const native = await run({ source, extras, sql })
      const legacy = await run({ rows: all, extras, sql })
      assert.deepEqual(native.rows.map((row) => Number(row.id)), legacy.rows.map((row) => Number(row.id)), sql)
      assert.ok(native.rows.length > 0, sql)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// --- LLP 0616: graph rows carry their source folders ---

/** Graph-shaped rows: one per provenance state the read path must judge. */
const GRAPH_ROWS = [
  { node_id: 'n1-full', node_type: 'Tool', label: 'full-label', source_cwds: '["/w/full"]' },
  { node_id: 'n2-none', node_type: 'Tool', label: 'folderless-label', source_cwds: '[]' },
  { node_id: 'n3-lo', node_type: 'Tool', label: 'lo-label', source_cwds: '["/w/lo"]' },
  { node_id: 'n4-mixed', node_type: 'Tool', label: 'mixed-label', source_cwds: '["/w/full","/w/lo"]' },
  { node_id: 'n5-old', node_type: 'Tool', label: 'old-label', source_cwds: null },
  { node_id: 'n6-bad', node_type: 'Tool', label: 'bad-label', source_cwds: '{"not":"a list"}' },
]
const GRAPH_EXTRAS = { localOnlyContentColumns: ['label', 'source_cwds'] }

// @ref LLP 0616#read [tests]: visible only when no recorded folder outranks the caller; null and unreadable fail closed; the column never names a hidden folder
test('graph provenance: content shows only where every recorded folder is visible to the caller', async () => {
  const sql = 'SELECT node_id, label, source_cwds FROM t ORDER BY node_id'
  const synced = await run({ rows: GRAPH_ROWS, extras: GRAPH_EXTRAS, sql, callerCwd: '/w/full' })
  assert.deepEqual(synced.rows, [
    { node_id: 'n1-full', label: 'full-label', source_cwds: '["/w/full"]' },
    { node_id: 'n2-none', label: 'folderless-label', source_cwds: '[]' },
    { node_id: 'n3-lo', label: null, source_cwds: null },
    { node_id: 'n4-mixed', label: null, source_cwds: null },
    { node_id: 'n5-old', label: null, source_cwds: null },
    { node_id: 'n6-bad', label: null, source_cwds: null },
  ])
  assert.ok(!JSON.stringify(synced.rows).includes('/w/lo'), 'source_cwds never names a local-only folder to a syncing caller')
  assert.equal(synced.localOnly.suppressedRows, 4)
  assert.equal(synced.localOnly.unprovenancedRows, 2, 'the null and the unreadable value')
  assert.equal(synced.localOnly.withheldRows, 0, 'suppression is not withholding: every row keeps its structure')

  const unknown = await run({ rows: GRAPH_ROWS, extras: GRAPH_EXTRAS, sql, callerCwd: null })
  assert.deepEqual(unknown.rows, synced.rows, 'an unknown caller fails closed at the full rank')

  const local = await run({ rows: GRAPH_ROWS, extras: GRAPH_EXTRAS, sql, callerCwd: '/w/lo' })
  assert.deepEqual(local.rows.map((r) => r.label), ['full-label', 'folderless-label', 'lo-label', 'mixed-label', null, null])
  assert.equal(local.rows[3].source_cwds, '["/w/full","/w/lo"]')
  assert.equal(local.localOnly.suppressedRows, 2)
  assert.equal(local.localOnly.unprovenancedRows, 2)

  // A caller at ignore, or one passing --include-local-only, skips the wrapper.
  for (const opts of [{ callerCwd: '/w/ig' }, { callerCwd: '/w/full', includeLocalOnly: true }]) {
    const open = await run({ rows: GRAPH_ROWS, extras: GRAPH_EXTRAS, sql, ...opts })
    assert.deepEqual(open.rows, GRAPH_ROWS.map(({ node_id, label, source_cwds }) => ({ node_id, label, source_cwds })))
    assert.equal(open.localOnly.filtered, false)
    assert.equal(open.localOnly.suppressedRows, 0)
    assert.equal(open.localOnly.unprovenancedRows, 0)
  }
})

test('graph provenance: the forced source_cwds never reaches a projection that did not ask for it', async () => {
  /** @type {(string[] | undefined)[]} */
  const scanned = []
  const inner = /** @type {ScannableDataSource} */ (memorySource(GRAPH_ROWS))
  const source = { ...inner, scan: /** @type {ScannableDataSource['scan']} */ ((options) => { scanned.push(options?.columns); return inner.scan(options) }) }
  const out = await run({ source, extras: GRAPH_EXTRAS, sql: 'SELECT node_id, label FROM t ORDER BY node_id', callerCwd: '/w/full' })
  assert.deepEqual(out.rows.map((r) => r.label), ['full-label', 'folderless-label', null, null, null, null])
  assert.ok(out.rows.every((r) => !('source_cwds' in r)), 'stripped back off the yielded row')
  assert.ok(scanned.some((columns) => columns?.includes('source_cwds')), 'forced into the scan when content is demanded')

  scanned.length = 0
  const structural = await run({ source, extras: GRAPH_EXTRAS, sql: 'SELECT node_id FROM t ORDER BY node_id', callerCwd: '/w/full' })
  assert.equal(structural.rows.length, GRAPH_ROWS.length)
  assert.ok(scanned.every((columns) => !columns?.includes('source_cwds')), 'a structure-only read does not pay for it')
  assert.equal(structural.localOnly.suppressedRows, 0)
})

test('graph provenance: a WHERE over content matches visible rows and never a suppressed one', async () => {
  /** @type {[string, { node_id: string }[]][]} */
  const cases = [['lo-label', []], ['mixed-label', []], ['old-label', []], ['full-label', [{ node_id: 'n1-full' }]]]
  for (const [label, expected] of cases) {
    const out = await run({
      source: memorySource(GRAPH_ROWS, { whereMatcher: (r) => r.label === label }),
      extras: GRAPH_EXTRAS,
      sql: `SELECT node_id FROM t WHERE label = '${label}'`,
      callerCwd: '/w/full',
    })
    assert.deepEqual(out.rows, expected, label)
  }
})

// @ref LLP 0616#column [tests]: folders are classified at read time, so a folder marked local-only after projection hides its rows on the next query
test('graph provenance: a folder reclassified after the row was written hides it on the next query', async () => {
  /** @type {Record<string, 'ignore' | 'local-only' | 'full'>} */
  const classes = {}
  const query = () => executeQuerySql({
    query: "SELECT label FROM t WHERE node_id = 'n3-lo'",
    registry: registryFor(memorySource(GRAPH_ROWS), GRAPH_EXTRAS),
    storage: /** @type {any} */ ({}),
    refresh: 'never',
    usagePolicyResolver: fakeResolver(classes),
    callerCwd: '/w/full',
  })
  assert.deepEqual((await query()).rows, [{ label: 'lo-label' }], 'visible while its folder syncs')
  classes['/w/lo'] = 'local-only'
  assert.deepEqual((await query()).rows, [{ label: null }], 'hidden once its folder is local-only')
})

test('graph provenance: each folder resolves once per query, however many rows and strings name it', async () => {
  const rows = []
  for (let i = 0; i < 200; i++) {
    const source_cwds = ['["/w/full"]', '["/w/lo"]', '["/w/full","/w/lo"]', '[]'][i % 4]
    rows.push({ node_id: `n${i}`, node_type: 'Tool', label: `l${i}`, source_cwds })
  }
  /** @type {string[]} */
  const calls = []
  const inner = fakeResolver(CLASSES)
  const out = await executeQuerySql({
    query: 'SELECT COUNT(label) AS named FROM t',
    registry: registryFor(memorySource(rows), GRAPH_EXTRAS),
    storage: /** @type {any} */ ({}),
    refresh: 'never',
    usagePolicyResolver: { ...inner, resolve(cwd) { calls.push(cwd); return inner.resolve(cwd) } },
    callerCwd: '/w/full',
  })
  assert.equal(Number(out.rows[0].named), 100)
  assert.deepEqual(calls.sort(), ['/w/full', '/w/full', '/w/lo'], 'the caller, then each distinct folder once')
})

/**
 * A native graph source over several batches. Each content reader records the
 * base rows it decoded, so a test can prove masked rows were never read.
 *
 * @param {{ rows: Record<string, SqlPrimitive>[], selection: RowSelection }[]} batches
 * @param {Map<string, number[]>} decoded `${batch}:${column}` -> decoded base rows
 * @param {(request: any) => void} [onRequest]
 * @returns {ScannableDataSource}
 */
function nativeGraphSource(batches, decoded, onRequest) {
  const columns = ['node_id', 'node_type', 'label', 'source_cwds']
  const fields = columns.map((name, index) => ({ id: index + 20, name, nullable: true, dataType: /** @type {const} */ ({ type: 'string' }) }))
  return {
    columns,
    schema: { fields },
    scan() { throw new Error('provenance visibility must stay on native batches') },
    prepareScan(request) {
      onRequest?.(request)
      assert.equal(request.limit, undefined)
      assert.equal(request.offset, undefined)
      const requested = request.columns.map((demand) => /** @type {typeof fields[number]} */ (fields.find((field) => field.id === demand.field)))
      return {
        schema: { fields: requested },
        residual: { filter: request.filter },
        properties: {},
        async *batches() {
          for (const [index, { rows, selection }] of batches.entries()) {
            /** @type {AsyncBatch} */
            const batch = {
              selection,
              columns: requested.map((field) => ({
                read({ batch: input, selection: selected }) {
                  assert.equal(input, batch, 'deferred readers retain their original input')
                  const key = `${index}:${field.name}`
                  const seen = decoded.get(key) ?? []
                  for (let i = 0; i < selected.length; i++) {
                    if (selected.type === 'all' || (selected.type === 'range' ? i >= selected.start && i < selected.end : selected.indices.includes(i))) seen.push(i)
                  }
                  decoded.set(key, seen)
                  const values = rows.map((row) => row[field.name])
                  return selectVector({ type: 'values', values, length: rows.length }, selected)
                },
              })),
            }
            yield batch
          }
        },
      }
    },
  }
}

/** Visible, fully suppressed and mixed batches, as a synced caller judges them. */
const GRAPH_BATCHES = [
  { rows: [GRAPH_ROWS[0], GRAPH_ROWS[1]], selection: /** @type {RowSelection} */ ({ type: 'all', length: 2 }) },
  { rows: [GRAPH_ROWS[2], GRAPH_ROWS[3], GRAPH_ROWS[4]], selection: /** @type {RowSelection} */ ({ type: 'all', length: 3 }) },
  { rows: GRAPH_ROWS, selection: /** @type {RowSelection} */ ({ type: 'indices', indices: new Uint32Array([0, 2, 4, 5]), length: GRAPH_ROWS.length }) },
  { rows: GRAPH_ROWS, selection: /** @type {RowSelection} */ ({ type: 'range', start: 1, end: 4, length: GRAPH_ROWS.length }) },
]

/** @param {{ rows: Record<string, SqlPrimitive>[], selection: RowSelection }[]} batches */
function selectedRows(batches) {
  return batches.flatMap(({ rows, selection }) => selection.type === 'all' ? rows
    : selection.type === 'range' ? rows.slice(selection.start, selection.end)
      : [...selection.indices].map((i) => rows[i]))
}

// @ref LLP 0616#read [tests]: the native batch path and the row path agree on provenance verdicts, counts and SQL semantics
test('graph provenance: native batches agree with the row path across SQL shapes and caller classes', async () => {
  const queries = [
    'SELECT node_id, label FROM t ORDER BY node_id',
    'SELECT node_id, label, source_cwds FROM t ORDER BY node_id',
    'SELECT * FROM t ORDER BY node_id',
    'SELECT node_id FROM t ORDER BY node_id',
    "SELECT node_id FROM t WHERE label = 'full-label'",
    "SELECT node_id FROM t WHERE label = 'lo-label'",
    'SELECT node_id FROM t WHERE label IS NULL ORDER BY node_id',
    "SELECT node_id FROM t WHERE source_cwds = '[\"/w/lo\"]'",
    'SELECT COUNT(*) AS n, COUNT(label) AS named FROM t',
    'SELECT label, COUNT(*) AS n FROM t GROUP BY label ORDER BY label',
    'SELECT node_id, label FROM t ORDER BY label, node_id LIMIT 3',
    "SELECT node_id, label FROM t WHERE node_type = 'Tool' ORDER BY node_id LIMIT 2 OFFSET 1",
  ]
  for (const callerCwd of [null, '/w/full', '/w/lo']) {
    for (const sql of queries) {
      const native = await run({ source: nativeGraphSource(GRAPH_BATCHES, new Map()), extras: GRAPH_EXTRAS, sql, callerCwd })
      const legacy = await run({ rows: selectedRows(GRAPH_BATCHES), extras: GRAPH_EXTRAS, sql, callerCwd })
      assert.deepEqual(native.rows, legacy.rows, `${callerCwd}: ${sql}`)
      assert.deepEqual(
        [native.localOnly.suppressedRows, native.localOnly.unprovenancedRows],
        [legacy.localOnly.suppressedRows, legacy.localOnly.unprovenancedRows],
        `counts ${callerCwd}: ${sql}`
      )
    }
  }
})

test('graph provenance: native batches pass visible vectors through, keep constant nulls, and never decode masked rows', async () => {
  /** @type {Map<string, number[]>} */
  const decoded = new Map()
  /** @type {any[]} */
  const requests = []
  const source = nativeGraphSource(GRAPH_BATCHES, decoded, (request) => requests.push(request))
  const out = await run({ source, extras: GRAPH_EXTRAS, sql: "SELECT node_id, label FROM t WHERE node_type = 'Tool'", callerCwd: '/w/full' })
  assert.deepEqual(out.rows.map((r) => r.label), [
    'full-label', 'folderless-label', // all visible
    null, null, null, // all suppressed
    'full-label', null, null, null, // mixed: n1, n3, n5, n6
    'folderless-label', null, null, // mixed: n2, n3, n4
  ])
  assert.ok(out.rows.every((r) => !('source_cwds' in r)), 'the forced provenance column is not output')
  assert.equal(requests[0].filter, undefined, 'a WHERE stays residual when content is demanded')
  assert.ok(requests[0].columns.some((/** @type {any} */ demand) => demand.field === 23 && demand.mode === 'required'), 'source_cwds forced into the scan')
  assert.deepEqual(decoded.get('0:label'), [0, 1], 'a visible batch reads its content as is')
  assert.equal(decoded.get('1:label'), undefined, 'a fully suppressed batch never decodes content')
  assert.deepEqual(decoded.get('2:label'), [0], 'a mixed batch decodes only its visible rows')
  assert.deepEqual(decoded.get('3:label'), [1])
  assert.equal(out.localOnly.suppressedRows, 8)
  assert.equal(out.localOnly.unprovenancedRows, 3)

  decoded.clear()
  requests.length = 0
  const structural = await run({ source, extras: GRAPH_EXTRAS, sql: "SELECT node_id FROM t WHERE node_type = 'Tool'", callerCwd: '/w/full' })
  assert.equal(structural.rows.length, 12)
  assert.equal(decoded.get('0:source_cwds'), undefined, 'a structure-only read never reads provenance')
  assert.ok(requests[0].filter, 'a structure-only WHERE still reaches the source')
})

// @ref LLP 0616#notice [tests]: an ignored folder outranks a synced caller too, and the notice says so
test('graph provenance: a row from an ignored folder is hidden by its folder and the notice names both classes', async () => {
  const rows = [{ node_id: 'n-ig', node_type: 'Tool', label: 'ignored-label', source_cwds: '["/w/ig"]' }]
  const out = await run({ rows, extras: GRAPH_EXTRAS, sql: 'SELECT node_id, label FROM t', callerCwd: '/w/full' })
  assert.deepEqual(out.rows, [{ node_id: 'n-ig', label: null }])
  assert.equal(out.localOnly.suppressedRows, 1)
  assert.equal(out.localOnly.unprovenancedRows, 0, 'its provenance is recorded')
  const notice = renderLocalOnlyNotice(out.localOnly)
  assert.match(notice, /on 1 row\(s\) drawn from a local-only or ignored folder/)
  assert.doesNotMatch(notice, /no recorded provenance/)
})
