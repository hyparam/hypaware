// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { asyncRow, parseSql } from 'squirreling'
import { unionSources, emptySource } from '../../src/core/query/union-source.js'

/**
 * @import { AsyncDataSource, ExprNode, IdentifierNode, ScanColumnOptions, ScanColumnResults, ScanOptions, SqlPrimitive } from 'squirreling/src/types.js'
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

/**
 * Fake AsyncDataSource that exposes `scanColumn` (like the icebird-backed
 * sources behind each committed partition once T2 lands), yielding a single
 * column's values in fixed-size chunks and recording the options it was
 * called with.
 *
 * @param {string} column
 * @param {SqlPrimitive[]} values
 * @param {ScanColumnOptions[]} seenOptions
 * @param {number} [chunkSize]
 * @returns {AsyncDataSource}
 */
function fakeColumnSource(column, values, seenOptions, chunkSize = 2) {
  return {
    columns: [column],
    numRows: values.length,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (const v of values) yield asyncRow({ [column]: v }, [column])
        },
      }
    },
    async *scanColumn(options) {
      seenOptions.push(options)
      for (let i = 0; i < values.length; i += chunkSize) {
        yield values.slice(i, i + chunkSize)
      }
    },
  }
}

/**
 * Normalizes squirreling's `scanColumn` return, which is a union: a bare
 * `AsyncIterable` (what `unionSources` yields today) or the newer
 * `ScanColumnResults` wrapper (`.chunks()`). `@ref LLP 0055`.
 *
 * @param {AsyncIterable<ArrayLike<SqlPrimitive>> | ScanColumnResults} result
 * @returns {Promise<SqlPrimitive[]>}
 */
async function flattenColumn(result) {
  /** @type {SqlPrimitive[]} */
  const out = []
  const chunks = 'chunks' in result ? result.chunks() : result
  for await (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) out.push(chunk[i])
  }
  return out
}

test('unionSources forwards scanColumn, concatenating per-partition streams in source order', async () => {
  /** @type {ScanColumnOptions[]} */
  const seen = []
  const union = unionSources([
    fakeColumnSource('id', ['a1', 'a2', 'a3'], seen),
    fakeColumnSource('id', ['b1', 'b2'], seen),
  ])
  const scanColumn = union.scanColumn
  if (!scanColumn) throw new Error('expected union to expose scanColumn when every partition does')

  const values = await flattenColumn(scanColumn({ column: 'id' }))
  assert.deepEqual(values, ['a1', 'a2', 'a3', 'b1', 'b2'], 'values concatenated in source order across chunk boundaries')

  assert.equal(seen.length, 2)
  for (const options of seen) {
    assert.equal(options.column, 'id')
    assert.equal(options.limit, undefined, 'limit not pushed into per-partition scanColumn')
    assert.equal(options.offset, undefined, 'offset not pushed into per-partition scanColumn')
  }
})

test('unionSources scanColumn re-applies limit/offset over the merged column stream', async () => {
  /** @type {ScanColumnOptions[]} */
  const seen = []
  const union = unionSources([
    fakeColumnSource('id', ['a1', 'a2', 'a3'], seen),
    fakeColumnSource('id', ['b1', 'b2', 'b3'], seen),
  ])
  const scanColumn = union.scanColumn
  if (!scanColumn) throw new Error('expected union to expose scanColumn when every partition does')

  // offset=2 skips into the first partition, limit=3 stops partway into the
  // second, so both the offset skip and the limit cutoff must cross the
  // partition/chunk boundary rather than being applied per partition (which
  // would silently drop or duplicate values, per union-source.js:47's
  // reasoning for the row-scan case).
  const values = await flattenColumn(scanColumn({ column: 'id', limit: 3, offset: 2 }))
  assert.deepEqual(values, ['a3', 'b1', 'b2'])

  for (const options of seen) {
    assert.equal(options.limit, undefined, 'limit still not pushed into per-partition scanColumn')
    assert.equal(options.offset, undefined, 'offset still not pushed into per-partition scanColumn')
  }
})

test('unionSources does not expose scanColumn when any partition lacks it', () => {
  /** @type {ScanOptions[]} */
  const rowSeen = []
  /** @type {ScanColumnOptions[]} */
  const colSeen = []
  const union = unionSources([
    fakeSource([{ id: 'a1' }], rowSeen),
    fakeColumnSource('id', ['b1'], colSeen),
  ])
  assert.equal(union.scanColumn, undefined, 'engine falls back to the buffering scan path')
})

/**
 * Fake AsyncDataSource whose `scanColumn` returns the newer
 * `ScanColumnResults` shape (`.chunks()` plus the `appliedWhere`/
 * `appliedLimitOffset` hint flags) instead of a bare `AsyncIterable`,
 * matching what a future source (or squirreling's own type union) may
 * return. `@ref LLP 0055`.
 *
 * @param {string} column
 * @param {SqlPrimitive[]} values
 * @param {number} [chunkSize]
 * @returns {AsyncDataSource}
 */
function fakeColumnResultsSource(column, values, chunkSize = 2) {
  return {
    columns: [column],
    numRows: values.length,
    scan() {
      return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} }
    },
    scanColumn() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *chunks() {
          for (let i = 0; i < values.length; i += chunkSize) {
            yield values.slice(i, i + chunkSize)
          }
        },
      }
    },
  }
}

test('unionSources concatenates a child scanColumn that returns ScanColumnResults, not just a bare AsyncIterable', async () => {
  const union = unionSources([
    fakeColumnResultsSource('id', ['a1', 'a2', 'a3']),
    fakeColumnResultsSource('id', ['b1', 'b2']),
  ])
  const scanColumn = union.scanColumn
  if (!scanColumn) throw new Error('expected union to expose scanColumn when every partition does')

  const values = await flattenColumn(scanColumn({ column: 'id' }))
  assert.deepEqual(values, ['a1', 'a2', 'a3', 'b1', 'b2'], 'chunks() results concatenated the same as a bare AsyncIterable')
})

test('emptySource scanColumn yields an empty column stream', async () => {
  const source = emptySource(['x'])
  assert.equal(typeof source.scanColumn, 'function')
  const scanColumn = source.scanColumn
  if (!scanColumn) throw new Error('expected emptySource to expose scanColumn')
  const values = await flattenColumn(scanColumn({ column: 'x' }))
  assert.deepEqual(values, [])
})

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
