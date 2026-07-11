// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { asyncRow, parseSql } from 'squirreling'
import { unionSources, emptySource } from '../../src/core/query/union-source.js'
import { normalizeScanColumn } from '../../src/core/query/scan-column.js'

/**
 * @import { AsyncDataSource, ExprNode, IdentifierNode, ScanOptions, SqlPrimitive } from 'squirreling/src/types.js'
 */

/**
 * Fake AsyncDataSource that honors limit/offset pushdown (like the
 * iceberg-backed sources behind each committed partition) and records the
 * scan options it received.
 *
 * @param {Record<string, SqlPrimitive>[]} rows
 * @param {ScanOptions[]} seenOptions
 * @returns {AsyncDataSource}
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
 * @param {AsyncDataSource} source
 * @param {Record<string, SqlPrimitive>[]} rows
 * @param {{ column: string, where?: ExprNode, limit?: number, offset?: number }[]} seenColumnScans
 * @returns {AsyncDataSource}
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
 * @param {AsyncDataSource} source
 * @param {Record<string, SqlPrimitive>[]} rows
 * @param {{ column: string, where?: ExprNode, limit?: number, offset?: number }[]} seenColumnScans
 * @returns {AsyncDataSource}
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
  /** @type {import('squirreling/src/types.js').ScanColumnResults} */
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
