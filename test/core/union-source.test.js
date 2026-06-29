// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { asyncRow, parseSql } from 'squirreling'
import { unionSources, emptySource } from '../../src/core/query/union-source.js'

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
