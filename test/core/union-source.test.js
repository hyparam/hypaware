// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { asyncRow, collect, executeSql, parseSql } from 'squirreling'
import { unionSources, emptySource } from '../../src/core/query/union-source.js'
import { normalizeScanColumn } from '../../src/core/query/scan-column.js'
import { parquetSourceFromRows } from '../helpers/parquet_source_fixture.js'

/**
 * @import { ScannableDataSource } from '../../hypaware-plugin-kernel-types.js'
 * @import { AsyncCells, AsyncDataSource, ExprNode, Field, ScanOptions, ScanRequest, SqlPrimitive } from 'squirreling'
 * @import { IdentifierNode, ScanColumnResults } from 'squirreling/src/types.js'
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/**
 * Fake AsyncDataSource that honors limit/offset pushdown (like the
 * iceberg-backed sources behind each committed partition) and records the
 * scan options it received.
 *
 * @param {Record<string, SqlPrimitive>[]} rows
 * @param {ScanOptions[]} seenOptions
 * @returns {ScannableDataSource}
 */
function fakeSource(rows, seenOptions) {
  const columns = Object.keys(rows[0] ?? {})
  return {
    columns,
    numRows: rows.length,
    /** @param {ScanOptions} [options] */
    scan(options = {}) {
      seenOptions.push(options)
      const offset = options?.offset ?? 0
      const limit = options?.limit ?? Infinity
      const slice = rows.slice(offset, offset + (Number.isFinite(limit) ? limit : rows.length))
      const rowColumns = options.columns ?? columns
      return {
        appliedWhere: false,
        appliedLimitOffset: true,
        async *rows() {
          for (const row of slice) yield asyncRow(row, rowColumns)
        },
      }
    },
  }
}

test('unionSources unions columns and sums numRows', () => {
  const union = unionSources([
    fakeSource([{ a: 1, b: 2 }], []),
    fakeSource([{ b: 3, c: 4 }, { b: 5, c: 6 }], []),
  ])
  assert.deepEqual([...union.columns].sort(), ['a', 'b', 'c'])
  assert.equal(union.numRows, 3)
})

test('unionSources leaves numRows unknown when any partition count is unknown', () => {
  const known = fakeSource([{ a: 1 }], [])
  const unknown = fakeSource([{ a: 2 }], [])
  unknown.numRows = undefined
  assert.equal(unionSources([known, unknown]).numRows, undefined)
})

test('unionSources does not forward limit/offset to sub-sources', async () => {
  /** @type {ScanOptions[]} */
  const seen = []
  const union = unionSources([
    fakeSource([{ id: 'a1' }, { id: 'a2' }], seen),
    fakeSource([{ id: 'b1' }, { id: 'b2' }], seen),
  ])

  const scan = union.scan({ limit: 2, offset: 1 })
  assert.equal(scan.appliedLimitOffset, false, 'engine applies limit/offset to the union stream')

  /** @type {Record<string, SqlPrimitive>[]} */
  const out = []
  for await (const row of scan.rows()) {
    assert.ok(row.resolved)
    out.push(row.resolved)
  }

  // Every underlying row must reach the engine. If limit/offset leaked into
  // the sub-scans, each partition would drop its first row per the offset,
  // and the engine would skip the offset again on the concatenated stream,
  // so a paginated multi-partition query would silently lose rows.
  assert.equal(out.length, 4)
  assert.deepEqual(out, [{ id: 'a1' }, { id: 'a2' }, { id: 'b1' }, { id: 'b2' }], 'rows are concatenated in source order')
  for (const options of seen) {
    assert.equal(options.limit, undefined, 'limit not pushed into sub-source')
    assert.equal(options.offset, undefined, 'offset not pushed into sub-source')
  }
})

/**
 * A native-batch source whose legacy row scan throws, so a successful query
 * proves every wrapper stayed on prepareScan. Each instance may use different
 * field ids, matching separately-created Iceberg tables.
 *
 * @param {Field[]} fields
 * @param {Record<string, SqlPrimitive>[]} rows
 * @param {ScanRequest[]} seen
 * @returns {ScannableDataSource}
 */
function preparedSource(fields, rows, seen) {
  const columns = fields.map((field) => field.name)
  return {
    columns,
    numRows: rows.length,
    schema: { fields },
    scan() {
      throw new Error('legacy row scan should not run')
    },
    prepareScan(request) {
      seen.push(request)
      const requestedFields = request.columns.map((demand) => {
        const field = fields.find((candidate) => candidate.id === demand.field)
        if (!field) throw new Error(`unknown test field ${demand.field}`)
        return field
      })
      return {
        schema: { fields: requestedFields },
        residual: { filter: request.filter },
        properties: { maxRows: rows.length },
        async *batches() {
          yield {
            selection: { type: 'all', length: rows.length },
            columns: requestedFields.map((field) => ({
              type: 'values',
              values: rows.map((row) => row[field.name]),
              length: rows.length,
            })),
          }
        },
      }
    },
  }
}

// @ref LLP 0266#partition-union [tests]: field ids are local to each table, filters may prune each child, and ranges belong to the concatenated stream
test('unionSources concatenates prepared batches, remaps field ids, and keeps range hints global', async () => {
  /** @type {ScanRequest[]} */
  const seenA = []
  /** @type {ScanRequest[]} */
  const seenB = []
  /** @type {Field[]} */
  const fieldsA = [
    { id: 1, name: 'k', dataType: { type: 'string' }, nullable: false },
    { id: 2, name: 'v', dataType: { type: 'number' }, nullable: false },
  ]
  /** @type {Field[]} */
  const fieldsB = [
    { id: 101, name: 'k', dataType: { type: 'string' }, nullable: false },
    { id: 102, name: 'v', dataType: { type: 'number' }, nullable: false },
  ]
  const union = unionSources([
    preparedSource(fieldsA, [{ k: 'x', v: 1 }, { k: 'y', v: 2 }], seenA),
    preparedSource(fieldsB, [{ k: 'x', v: 3 }, { k: 'x', v: 4 }], seenB),
  ])

  assert.ok(union.schema)
  assert.equal(typeof union.prepareScan, 'function')
  const rows = await collect(executeSql({
    tables: { t: union },
    query: "SELECT v FROM t WHERE k = 'x' LIMIT 2 OFFSET 1",
  }))
  assert.deepEqual(rows, [{ v: 3 }, { v: 4 }])
  for (const request of [...seenA, ...seenB]) {
    assert.ok(request.filter, 'filter is forwarded for per-table pruning')
    assert.equal(request.limit, undefined, 'limit remains global')
    assert.equal(request.offset, undefined, 'offset remains global')
  }
  assert.deepEqual(seenA[0].columns.map((demand) => demand.field), [2, 1])
  assert.deepEqual(seenB[0].columns.map((demand) => demand.field), [102, 101])
})

test('unionSources declines prepared batches when partition schemas drift', () => {
  const seen = []
  const older = preparedSource([
    { id: 1, name: 'id', dataType: { type: 'number' }, nullable: false },
  ], [{ id: 1 }], seen)
  const newer = preparedSource([
    { id: 1, name: 'id', dataType: { type: 'number' }, nullable: false },
    { id: 2, name: 'extra', dataType: { type: 'string' }, nullable: true },
  ], [{ id: 2, extra: 'x' }], seen)
  const union = unionSources([older, newer])
  assert.equal(union.schema, undefined)
  assert.equal(union.prepareScan, undefined, 'row padding remains authoritative for drifted schemas')
})

/**
 * A `col = value` predicate as a squirreling ExprNode.
 *
 * @param {string} col
 * @param {SqlPrimitive} value
 * @param {string} [prefix]
 * @returns {ExprNode}
 */
function eqWhere(col, value, prefix) {
  /** @type {IdentifierNode} */
  const left = { type: 'identifier', name: col, positionStart: 0, positionEnd: 0 }
  if (prefix) left.prefix = prefix
  return {
    type: 'binary',
    op: '=',
    left,
    right: { type: 'literal', value, positionStart: 0, positionEnd: 0 },
    positionStart: 0,
    positionEnd: 0,
  }
}

test('unionSources forwards where/columns to sub-sources that have the predicate columns', async () => {
  /** @type {ScanOptions[]} */
  const seen = []
  const union = unionSources([
    fakeSource([{ id: 'a1' }], seen),
    fakeSource([{ id: 'b1' }], seen),
  ])
  const where = eqWhere('id', 'a1')
  const scan = union.scan({ where, columns: ['id'], limit: 1 })
  for await (const _ of scan.rows()) { /* drain */ }
  for (const options of seen) {
    assert.equal(options.where, where, 'where hint forwarded')
    assert.deepEqual(options.columns, ['id'], 'columns hint forwarded')
  }
})

/** @type {ColumnSpec[]} */
const PARQUET_PARTITION_COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'name', type: 'STRING', nullable: false },
  { name: 'score', type: 'DOUBLE', nullable: false },
]

/**
 * Build a real, on-disk-shaped parquet `AsyncDataSource` partition (the shared
 * fixture `test/core/parquet-source.test.js` also builds from), so the union
 * test below exercises actual hyparquet reads and pushdown, not a fake source.
 *
 * @param {Record<string, SqlPrimitive>[]} rows
 * @returns {Promise<ScannableDataSource>}
 */
async function makeParquetPartition(rows) {
  return parquetSourceFromRows(PARQUET_PARTITION_COLUMNS, rows, { rowGroupSize: 2 })
}

// @ref LLP 0015#multi-partition-union [tests]: appliedWhere: false only stays correct end-to-end because
// squirreling folds WHERE columns into the projection it hands to scan(); pin that at the layer
// that depends on it, with two real parquet partitions, not a fake source.
test('unionSources over two real parquet partitions filters correctly through executeSql (WHERE column folded into projection)', async () => {
  const partitionA = await makeParquetPartition([
    { id: 1, name: 'alice', score: 1.5 },
    { id: 2, name: 'bob', score: 2.5 },
    { id: 3, name: 'carol', score: 3.5 },
  ])
  const partitionB = await makeParquetPartition([
    { id: 4, name: 'dave', score: 4.5 },
    { id: 5, name: 'eve', score: 5.5 },
  ])
  const union = unionSources([partitionA, partitionB])

  // union.scan() always reports appliedWhere: false, handing the predicate
  // back to the engine to re-apply over the merged stream. That only returns
  // the right rows here because squirreling's planner folds `score` (the
  // WHERE column) into the projection it passes to scan(), even though the
  // query only selects `name`; each parquet partition then emits `score`
  // alongside `name`, and the engine can actually filter on it. If squirreling
  // ever stopped folding, this would start throwing `ColumnNotFoundError` at
  // query time, when the engine re-filters on a column the rows no longer
  // carry, while every other test in this file (and in parquet-source.test.js)
  // stayed green, since they exercise a single source, not the union path.
  const rows = await collect(executeSql({ tables: { t: union }, query: 'SELECT name FROM t WHERE score > 3' }))
  assert.deepEqual(rows, [{ name: 'carol' }, { name: 'dave' }, { name: 'eve' }])
})

test('unionSources drops where for a partition that lacks a predicate column but keeps it for one that has it', async () => {
  /** @type {ScanOptions[]} */
  const seen = []
  // Heterogeneous schemas: the first partition has `repo`, the second does not.
  const union = unionSources([
    fakeSource([{ id: 'a1', repo: 'x' }], seen),
    fakeSource([{ id: 'b1' }], seen),
  ])
  const where = eqWhere('repo', 'x')
  const scan = union.scan({ where })
  assert.equal(scan.appliedWhere, false, 'engine re-applies the filter over the merged stream')
  for await (const _ of scan.rows()) { /* drain */ }

  assert.equal(seen[0].where, where, 'where pushed to the partition that has `repo`')
  assert.equal(seen[1].where, undefined, 'where dropped for the partition missing `repo` (a parquet source would otherwise throw)')
})

test('unionSources does not push qualified where predicates to sub-sources', async () => {
  /** @type {ScanOptions[]} */
  const seen = []
  const union = unionSources([
    fakeSource([{ id: 'a1', flag: 0 }], seen),
    fakeSource([{ id: 'b1', flag: 0 }], seen),
  ])
  const where = eqWhere('flag', 1, 'outer')
  const scan = union.scan({ where })
  assert.equal(scan.appliedWhere, false, 'engine re-applies the qualified filter over the merged stream')

  for await (const _ of scan.rows()) { /* drain */ }

  assert.equal(seen[0].where, undefined, 'qualified predicate dropped for first sub-source')
  assert.equal(seen[1].where, undefined, 'qualified predicate dropped for second sub-source')
})

test('unionSources does not push a non-enumerable where (subquery) to any sub-source', async () => {
  /** @type {ScanOptions[]} */
  const seen = []
  const union = unionSources([fakeSource([{ id: 'a1' }], seen)])
  // A subquery predicate whose column set can't be enumerated locally.
  /** @type {ExprNode} */
  const where = { type: 'exists', subquery: parseSql({ query: 'select 1' }), positionStart: 0, positionEnd: 0 }
  const scan = union.scan({ where })
  for await (const _ of scan.rows()) { /* drain */ }
  assert.equal(seen[0].where, undefined, 'unenumerable predicate is left for the engine')
})

test('unionSources tolerates a scan with no options', async () => {
  /** @type {ScanOptions[]} */
  const seen = []
  const union = unionSources([fakeSource([{ id: 'a1' }], seen)])
  const scan = union.scan(/** @type {ScanOptions} */ (/** @type {unknown} */ (undefined)))
  /** @type {Record<string, SqlPrimitive>[]} */
  const out = []
  for await (const row of scan.rows()) {
    assert.ok(row.resolved)
    out.push(row.resolved)
  }
  assert.deepEqual(out, [{ id: 'a1' }])
})

/**
 * Add a recording LEGACY `scanColumn` (bare AsyncIterable, no applied
 * flags) to a fake source, honoring its own limit/offset. Exercises the
 * union's normalization shim for pre-0.15 plugin sources.
 *
 * @param {ScannableDataSource} source
 * @param {Record<string, SqlPrimitive>[]} rows
 * @param {{ column: string, where?: ExprNode, limit?: number, offset?: number }[]} seenColumnScans
 * @returns {ScannableDataSource}
 */
function withFakeScanColumn(source, rows, seenColumnScans) {
  source.scanColumn = ({ column, where, limit, offset }) => ({
    async *[Symbol.asyncIterator]() {
      seenColumnScans.push({ column, where, limit, offset })
      const start = offset ?? 0
      const end = limit === undefined ? rows.length : Math.min(rows.length, start + limit)
      if (end > start) yield rows.slice(start, end).map((r) => r[column] ?? null)
    },
  })
  return source
}

/**
 * Add a recording FLAGGED `scanColumn` (ScanColumnResults shape) that
 * applies an equality `where` like the icebird source does, reporting
 * `appliedWhere` honestly.
 *
 * @param {ScannableDataSource} source
 * @param {Record<string, SqlPrimitive>[]} rows
 * @param {{ column: string, where?: ExprNode, limit?: number, offset?: number }[]} seenColumnScans
 * @returns {ScannableDataSource}
 */
function withFlaggedScanColumn(source, rows, seenColumnScans) {
  source.scanColumn = ({ column, where, limit, offset }) => {
    seenColumnScans.push({ column, where, limit, offset })
    let matching = rows
    if (where && where.type === 'binary' && where.left.type === 'identifier' && where.right.type === 'literal') {
      const { name } = where.left
      const { value } = where.right
      matching = rows.filter((r) => r[name] === value)
    }
    return {
      appliedWhere: true,
      appliedLimitOffset: !where,
      async *chunks() {
        const start = where ? 0 : offset ?? 0
        const end = limit === undefined ? matching.length : Math.min(matching.length, start + limit)
        if (end > start) yield matching.slice(start, end).map((r) => r[column] ?? null)
      },
    }
  }
  return source
}

/**
 * Drain a ScanColumnResults into flat values plus its flags.
 *
 * @param {ReturnType<NonNullable<AsyncDataSource['scanColumn']>>} result
 */
async function drainColumns(result) {
  assert.ok('chunks' in result, 'union scanColumn returns the flagged ScanColumnResults shape')
  /** @type {SqlPrimitive[]} */
  const values = []
  for await (const chunk of result.chunks()) {
    for (let i = 0; i < chunk.length; i++) values.push(chunk[i])
  }
  return { values, appliedWhere: result.appliedWhere, appliedLimitOffset: result.appliedLimitOffset }
}

test('unionSources omits scanColumn unless every partition can stream the column', () => {
  const rows = [{ id: 'a1' }]
  const withHook = withFakeScanColumn(fakeSource(rows, []), rows, [])
  const withoutHook = fakeSource([{ id: 'b1' }], [])
  assert.equal(typeof unionSources([withHook, withoutHook]).scanColumn, 'undefined', 'mixed union stays row-based')
  assert.equal(typeof unionSources([withHook]).scanColumn, 'function')
})

test('unionSources scanColumn concatenates partitions and owns limit/offset over the merged stream', async () => {
  /** @type {{ column: string, limit?: number, offset?: number }[]} */
  const seen = []
  const aRows = [{ v: 1 }, { v: 2 }, { v: 3 }]
  const bRows = [{ v: 4 }, { v: 5 }, { v: 6 }]
  const union = unionSources([
    withFakeScanColumn(fakeSource(aRows, []), aRows, seen),
    withFakeScanColumn(fakeSource(bRows, []), bRows, seen),
  ])

  const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (union.scanColumn)
  const { values, appliedWhere, appliedLimitOffset } = await drainColumns(scanColumn({ column: 'v', offset: 2, limit: 3 }))

  // Offset/limit apply to the CONCATENATED stream: skip 1,2 then take 3.
  assert.deepEqual(values, [3, 4, 5])
  assert.equal(appliedWhere, true, 'no predicate was requested')
  assert.equal(appliedLimitOffset, true, 'the union owns the merged slice')
  // Offset is never pushed per partition (not distributive); only the
  // remaining-need upper bound is, so a partition never over-reads.
  assert.deepEqual(seen, [
    { column: 'v', where: undefined, limit: 5, offset: undefined },
    { column: 'v', where: undefined, limit: 2, offset: undefined },
  ])
})

test('unionSources scanColumn skips a whole partition its numRows proves is inside the offset', async () => {
  /** @type {{ column: string, limit?: number, offset?: number }[]} */
  const seen = []
  const aRows = [{ v: 1 }, { v: 2 }]
  const bRows = [{ v: 3 }, { v: 4 }]
  const union = unionSources([
    withFakeScanColumn(fakeSource(aRows, []), aRows, seen),
    withFakeScanColumn(fakeSource(bRows, []), bRows, seen),
  ])

  const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (union.scanColumn)
  const { values } = await drainColumns(scanColumn({ column: 'v', offset: 3 }))

  assert.deepEqual(values, [4])
  assert.deepEqual(seen, [{ column: 'v', where: undefined, limit: undefined, offset: undefined }], 'first partition never opened')
})

test('unionSources scanColumn forwards where per partition and reports the merged appliedWhere', async () => {
  /** @type {{ column: string, where?: ExprNode, limit?: number, offset?: number }[]} */
  const seen = []
  const aRows = [{ k: 'x', v: 1 }, { k: 'y', v: 2 }]
  const bRows = [{ k: 'x', v: 3 }]
  const union = unionSources([
    withFlaggedScanColumn(fakeSource(aRows, []), aRows, seen),
    withFlaggedScanColumn(fakeSource(bRows, []), bRows, seen),
  ])

  const where = eqWhere('k', 'x')
  const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (union.scanColumn)
  const { values, appliedWhere, appliedLimitOffset } = await drainColumns(scanColumn({ column: 'v', where, limit: 5 }))

  assert.deepEqual(values, [1, 3], 'each partition filtered its own values')
  assert.equal(appliedWhere, true, 'every partition applied the predicate, so the engine need not re-filter')
  assert.equal(appliedLimitOffset, false, 'a filtered slice belongs to the engine')
  assert.equal(seen[0].where, where, 'predicate pushed to the first partition')
  assert.equal(seen[1].where, where, 'predicate pushed to the second partition')
  assert.equal(seen[0].limit, undefined, 'limit never coexists with a forwarded where')
  assert.equal(seen[1].limit, undefined, 'limit never coexists with a forwarded where')
})

test('unionSources scanColumn drops where for a partition lacking a predicate column and reports appliedWhere false', async () => {
  /** @type {{ column: string, where?: ExprNode, limit?: number, offset?: number }[]} */
  const seen = []
  // Additive schema drift: the second partition predates the `k` column.
  const aRows = [{ k: 'x', v: 1 }, { k: 'y', v: 2 }]
  const bRows = [{ v: 3 }]
  const union = unionSources([
    withFlaggedScanColumn(fakeSource(aRows, []), aRows, seen),
    withFlaggedScanColumn(fakeSource(bRows, []), bRows, seen),
  ])

  const where = eqWhere('k', 'x')
  const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (union.scanColumn)
  const { values, appliedWhere } = await drainColumns(scanColumn({ column: 'v', where }))

  assert.deepEqual(values, [1, 3], 'the drifted partition streams unfiltered values for the engine to judge')
  assert.equal(appliedWhere, false, 'one unfiltered partition means the engine re-applies the predicate')
  assert.equal(seen[0].where, where)
  assert.equal(seen[1].where, undefined, 'predicate dropped for the partition missing `k` (a parquet source would otherwise throw)')
})

test('unionSources scanColumn reports appliedWhere false over a legacy bare-iterable partition', async () => {
  /** @type {{ column: string, where?: ExprNode, limit?: number, offset?: number }[]} */
  const seen = []
  const aRows = [{ k: 'x', v: 1 }]
  const bRows = [{ k: 'y', v: 2 }]
  const union = unionSources([
    withFlaggedScanColumn(fakeSource(aRows, []), aRows, seen),
    // Legacy shape: predates `where`, streams everything, reports nothing.
    withFakeScanColumn(fakeSource(bRows, []), bRows, seen),
  ])

  const where = eqWhere('k', 'x')
  const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (union.scanColumn)
  const { values, appliedWhere } = await drainColumns(scanColumn({ column: 'v', where }))

  assert.deepEqual(values, [1, 2], 'the legacy partition streams unfiltered values')
  assert.equal(appliedWhere, false, 'a legacy partition cannot claim the predicate applied')
})

test('normalizeScanColumn passes a flagged result through and shims a legacy iterable', async () => {
  /** @type {ScanColumnResults} */
  const flagged = { appliedWhere: true, appliedLimitOffset: false, async *chunks() {} }
  assert.equal(normalizeScanColumn(flagged, { column: 'v' }), flagged, 'flagged shape is returned untouched')

  const legacy = (async function* () { yield [1, 2] })()
  const noWhere = normalizeScanColumn(legacy, { column: 'v', limit: 2 })
  assert.equal(noWhere.appliedWhere, true, 'nothing to apply without a predicate')
  assert.equal(noWhere.appliedLimitOffset, true, 'the legacy contract required the source to own limit/offset')

  const withWhere = normalizeScanColumn((async function* () {})(), { column: 'v', where: eqWhere('v', 1) })
  assert.equal(withWhere.appliedWhere, false, 'a legacy source predates where and cannot claim it')
  assert.equal(withWhere.appliedLimitOffset, false, 'nor may it slice ahead of an unapplied predicate')
})

test('emptySource advertises the given columns and yields no rows', async () => {
  const source = emptySource(['x', 'y'])
  assert.deepEqual(source.columns, ['x', 'y'])
  assert.equal(source.numRows, 0)
  const scan = source.scan({})
  assert.equal(scan.appliedWhere, false)
  assert.equal(scan.appliedLimitOffset, false)
  /** @type {unknown[]} */
  const out = []
  for await (const row of scan.rows()) out.push(row)
  assert.equal(out.length, 0)
})

// --- additive schema drift over real parquet partitions ----------------------

/** @type {ColumnSpec[]} */
const DRIFT_BASE_COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'score', type: 'DOUBLE', nullable: false },
]

/**
 * Two real parquet partitions with additive drift: `extra` exists only in the
 * newer one, the shape a cache takes on the day a dataset gains a column.
 *
 * @returns {Promise<ScannableDataSource>}
 */
async function driftedUnion() {
  const older = await parquetSourceFromRows(DRIFT_BASE_COLUMNS, [
    { id: 1, score: 1.5 },
    { id: 2, score: 2.5 },
  ])
  const newer = await parquetSourceFromRows(
    [...DRIFT_BASE_COLUMNS, { name: 'extra', type: 'STRING', nullable: true }],
    [{ id: 3, score: 3.5, extra: 'x' }]
  )
  return unionSources([older, newer])
}

/**
 * @param {string} query
 * @returns {Promise<Record<string, SqlPrimitive>[]>}
 */
async function runDrifted(query) {
  return collect(executeSql({ tables: { t: await driftedUnion() }, query }))
}

/**
 * @param {Record<string, SqlPrimitive>[]} rows
 * @param {string} [key]
 * @returns {boolean[]}
 */
function hasExtraKey(rows, key = 'extra') {
  return rows.map((row) => Object.prototype.hasOwnProperty.call(row, key))
}

// @ref LLP 0015#multi-partition-union [tests]: the union pads a drifted cell with `undefined`, never `null`, which is why the doc no longer promises null
test('a projected column one partition lacks reads as undefined, never null', async () => {
  // Every bare-projection shape the LLP names, so "Pinned by" covers the alias
  // and `LIMIT` variants it claims and not just the plain projection.
  const cases = [
    { query: 'SELECT extra FROM t', key: 'extra', values: [undefined, undefined, 'x'], json: '[{},{},{"extra":"x"}]' },
    { query: 'SELECT extra FROM t WHERE score > 1', key: 'extra', values: [undefined, undefined, 'x'], json: '[{},{},{"extra":"x"}]' },
    { query: 'SELECT extra AS e FROM t', key: 'e', values: [undefined, undefined, 'x'], json: '[{},{},{"e":"x"}]' },
    // A bare-identifier SIBLING keeps `executeProject`'s `resolveable` gate
    // open, so `collect()` stays on its pre-materialized fast path. The test
    // below pins the same answer coming back off the slow path, where a
    // non-identifier sibling closes that gate and the cell is really invoked.
    { query: 'SELECT score, extra FROM t', key: 'extra', values: [undefined, undefined, 'x'], json: '[{"score":1.5},{"score":2.5},{"score":3.5,"extra":"x"}]' },
    { query: 'SELECT extra FROM t LIMIT 1', key: 'extra', values: [undefined], json: '[{}]' },
    { query: 'SELECT extra FROM t LIMIT 0', key: 'extra', values: [], json: '[]' },
  ]
  for (const { query, key, values, json } of cases) {
    const rows = await runDrifted(query)
    assert.equal(rows.length, values.length, query)
    assert.deepEqual(hasExtraKey(rows, key), values.map(() => true), 'the projection puts the key on every row')
    assert.deepEqual(rows.map((row) => row[key]), values, query)
    assert.equal(rows[0]?.[key] === null, false, 'undefined, not null: the union pads the drifted cell, it does not null it')
    assert.equal(JSON.stringify(rows), json, 'JSON.stringify drops the undefined cells')
  }
})

// @ref LLP 0241#alignment [tests]: the drifted cell is padded by the union, so it is a real resolvable cell rather than a throwing thunk
test('the drifted cell is padded, so it resolves to undefined instead of throwing', async () => {
  const results = executeSql({ tables: { t: await driftedUnion() }, query: 'SELECT extra FROM t' })
  /** @type {{ resolvedHasKey: boolean, cell: string, value: SqlPrimitive | undefined }[]} */
  const seen = []
  for await (const row of results.rows()) {
    const resolved = row.resolved
    let cell = 'ok'
    /** @type {SqlPrimitive | undefined} */
    let value
    try {
      value = await row.cells.extra()
    } catch (err) {
      cell = err instanceof Error ? err.constructor.name : 'unknown'
    }
    seen.push({ resolvedHasKey: !!resolved && Object.prototype.hasOwnProperty.call(resolved, 'extra'), cell, value })
  }
  // The union pads each row out to the column list the scan advertised, so
  // `executeProject` finds `extra` in `row.cells` on every row and takes its
  // copy path. The cell is real, it resolves to `undefined`, and `resolved`
  // carries the key. Nothing here depends on `collect()`'s fast path: the
  // caller reading the cell directly and the caller reading `resolved` now
  // agree, which is what stops the same query answering two different ways.
  assert.deepEqual(seen, [
    { resolvedHasKey: true, cell: 'ok', value: undefined },
    { resolvedHasKey: true, cell: 'ok', value: undefined },
    { resolvedHasKey: true, cell: 'ok', value: 'x' },
  ], 'the padded cell resolves to undefined and `resolved` carries the key')
})

// @ref LLP 0241#alignment [tests]: padding happens below `executeProject`, so a partition that pre-materializes no `resolved` map reads the same as one that does
test('a partition whose rows carry no resolved map reads the same, because the union pads below it', async () => {
  /**
   * A legal `AsyncDataSource` that hand-rolls its rows instead of going
   * through squirreling's `asyncRow`, so nothing pre-materializes `resolved`.
   *
   * @param {string[]} columns
   * @param {Record<string, SqlPrimitive>[]} rows
   * @returns {ScannableDataSource}
   */
  function unresolvedSource(columns, rows) {
    return {
      columns,
      numRows: rows.length,
      /** @param {ScanOptions} [options] */
      scan(options = {}) {
        const wanted = options.columns ?? columns
        return {
          appliedWhere: false,
          appliedLimitOffset: false,
          async *rows() {
            for (const row of rows) {
              const present = wanted.filter((c) => c in row)
              /** @type {AsyncCells} */
              const cells = {}
              for (const c of present) cells[c] = async () => row[c]
              yield { columns: present, cells }
            }
          },
        }
      },
    }
  }

  const union = unionSources([
    unresolvedSource(['id', 'score'], [{ id: 1, score: 1.5 }]),
    unresolvedSource(['id', 'score', 'extra'], [{ id: 3, score: 3.5, extra: 'x' }]),
  ])
  // The union pads before `executeProject` ever sees a row, so where the
  // source got its cells no longer decides the answer. A hand-rolled source
  // that never calls squirreling's `asyncRow` reads exactly like the parquet
  // partitions above.
  /** @type {[string, string, (SqlPrimitive | undefined)[]][]} */
  const cases = [
    ['SELECT extra FROM t', 'extra', [undefined, 'x']],
    ['SELECT extra AS e FROM t', 'e', [undefined, 'x']],
    ['SELECT extra FROM t LIMIT 1', 'extra', [undefined]],
    // A non-identifier sibling closes `executeProject`'s `resolveable` gate,
    // so `collect()` falls off its pre-materialized fast path and invokes the
    // cell. The padded cell resolves, so this shape answers too.
    ['SELECT extra, 1 AS n FROM t', 'extra', [undefined, 'x']],
  ]
  for (const [query, key, values] of cases) {
    const rows = await collect(executeSql({ tables: { t: union }, query }))
    assert.deepEqual(hasExtraKey(rows, key), values.map(() => true), `${query} puts the key on every row`)
    assert.deepEqual(rows.map((row) => row[key]), values, query)
  }
})

// @ref LLP 0241#alignment [tests]: a clause the engine evaluates above the scan reads the padded cell as undefined and answers, where a short row made it throw
test('evaluating a column one partition lacks answers with undefined, and so does a non-identifier sibling', async () => {
  // Every shape here read the absent column off `row.cells` above the scan and
  // raised `ColumnNotFoundError` on the short row. On a padded row the lookup
  // hits, resolves to `undefined`, and the query answers. The answers are the
  // ones the hinted form of each query always gave, so this is the union
  // agreeing with itself rather than a new result.
  assert.deepEqual(await runDrifted('SELECT extra FROM t WHERE extra IS NOT NULL'), [{ extra: 'x' }])
  assert.deepEqual((await runDrifted("SELECT id FROM t WHERE extra = 'x'")).map((row) => Number(row.id)), [3])
  assert.deepEqual(await runDrifted("SELECT coalesce(extra, 'none') AS e FROM t"), [{ e: 'none' }, { e: 'none' }, { e: 'x' }])
  assert.deepEqual(await runDrifted('SELECT max(extra) AS m FROM t'), [{ m: 'x' }])

  const ordered = await runDrifted('SELECT id, extra FROM t ORDER BY extra')
  assert.deepEqual(ordered.map((row) => Number(row.id)), [1, 2, 3])
  assert.deepEqual(ordered.map((row) => row.extra), [undefined, undefined, 'x'])

  // Nothing below evaluates `extra`, but a literal or expression sibling
  // closes `executeProject`'s `resolveable` gate, so `collect()` leaves its
  // pre-materialized fast path and invokes the cell for real. The padded cell
  // resolves, so the sibling no longer decides whether the query answers.
  for (const [query, key, values] of /** @type {[string, string, (SqlPrimitive | undefined)[]][]} */ ([
    ['SELECT extra, 1 AS n FROM t', 'n', [1, 1, 1]],
    ['SELECT extra, score * 2 AS d FROM t', 'd', [3, 5, 7]],
  ])) {
    const rows = await runDrifted(query)
    assert.deepEqual(rows.map((row) => row.extra), [undefined, undefined, 'x'], query)
    assert.deepEqual(rows.map((row) => row[key]), values, query)
  }
})

// @ref LLP 0241#alignment [tests]: a star pads each partition row out to the advertised list, so the key count matches the schema `QueryResults.columns` already promised
test('SELECT * pads each partition row to the union column list, so a drifted key is present and undefined', async () => {
  const rows = await runDrifted('SELECT * FROM t')
  assert.deepEqual(hasExtraKey(rows), [true, true, true], 'every row carries every advertised column')
  assert.deepEqual(rows.map((row) => Object.keys(row)), [
    ['id', 'score', 'extra'],
    ['id', 'score', 'extra'],
    ['id', 'score', 'extra'],
  ], 'the key order is the advertised order, on the narrow partition too')
  assert.deepEqual(rows.map((row) => row.extra), [undefined, undefined, 'x'])
  // The padded cell is `undefined`, not `null`, so the rendering is byte for
  // byte what the unpadded star produced: `JSON.stringify` drops the key it
  // used to drop by absence.
  assert.equal(
    JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? Number(value) : value)),
    '[{"id":1,"score":1.5},{"id":2,"score":2.5},{"id":3,"score":3.5,"extra":"x"}]',
    'padding an absent cell with undefined renders identically to omitting the key'
  )
})
