// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { unionSources, emptySource } from '../../src/core/query/union-source.js'

/**
 * Fake AsyncDataSource that honors limit/offset pushdown (like the
 * iceberg-backed sources behind each committed partition) and records the
 * scan options it received.
 *
 * @param {Record<string, unknown>[]} rows
 * @param {Record<string, unknown>[]} seenOptions
 */
function fakeSource(rows, seenOptions) {
  return {
    columns: Object.keys(rows[0] ?? {}),
    numRows: rows.length,
    /** @param {{ limit?: number, offset?: number }} [options] */
    scan(options) {
      seenOptions.push(options ?? {})
      const offset = options?.offset ?? 0
      const limit = options?.limit ?? Infinity
      const slice = rows.slice(offset, offset + (Number.isFinite(limit) ? limit : rows.length))
      return {
        appliedWhere: false,
        appliedLimitOffset: true,
        async *rows() {
          yield* slice
        },
      }
    },
  }
}

test('unionSources unions columns and sums numRows', () => {
  const union = unionSources([
    /** @type {any} */ ({ columns: ['a', 'b'], numRows: 1, scan() { return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} } } }),
    /** @type {any} */ ({ columns: ['b', 'c'], numRows: 2, scan() { return { appliedWhere: false, appliedLimitOffset: false, async *rows() {} } } }),
  ])
  assert.deepEqual([...union.columns].sort(), ['a', 'b', 'c'])
  assert.equal(union.numRows, 3)
})

test('unionSources does not forward limit/offset to sub-sources', async () => {
  /** @type {Record<string, unknown>[]} */
  const seen = []
  const union = unionSources([
    /** @type {any} */ (fakeSource([{ id: 'a1' }, { id: 'a2' }], seen)),
    /** @type {any} */ (fakeSource([{ id: 'b1' }, { id: 'b2' }], seen)),
  ])

  const scan = union.scan({ limit: 2, offset: 1 })
  assert.equal(scan.appliedLimitOffset, false, 'engine applies limit/offset to the union stream')

  /** @type {unknown[]} */
  const out = []
  for await (const row of scan.rows()) out.push(row)

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
 * @param {unknown} value
 */
function eqWhere(col, value) {
  return { type: 'binary', op: '=', left: { type: 'identifier', name: col }, right: { type: 'literal', value } }
}

test('unionSources forwards where/columns to sub-sources that have the predicate columns', async () => {
  /** @type {Record<string, unknown>[]} */
  const seen = []
  const union = unionSources([
    /** @type {any} */ (fakeSource([{ id: 'a1' }], seen)),
    /** @type {any} */ (fakeSource([{ id: 'b1' }], seen)),
  ])
  const where = /** @type {any} */ (eqWhere('id', 'a1'))
  const scan = union.scan(/** @type {any} */ ({ where, columns: ['id'], limit: 1 }))
  for await (const _ of scan.rows()) { /* drain */ }
  for (const options of seen) {
    assert.equal(options.where, where, 'where hint forwarded')
    assert.deepEqual(options.columns, ['id'], 'columns hint forwarded')
  }
})

test('unionSources drops where for a partition that lacks a predicate column but keeps it for one that has it', async () => {
  /** @type {Record<string, unknown>[]} */
  const seen = []
  // Heterogeneous schemas: the first partition has `repo`, the second does not.
  const union = unionSources([
    /** @type {any} */ (fakeSource([{ id: 'a1', repo: 'x' }], seen)),
    /** @type {any} */ (fakeSource([{ id: 'b1' }], seen)),
  ])
  const where = /** @type {any} */ (eqWhere('repo', 'x'))
  const scan = union.scan(/** @type {any} */ ({ where }))
  assert.equal(scan.appliedWhere, false, 'engine re-applies the filter over the merged stream')
  for await (const _ of scan.rows()) { /* drain */ }

  assert.equal(seen[0].where, where, 'where pushed to the partition that has `repo`')
  assert.equal(seen[1].where, undefined, 'where dropped for the partition missing `repo` (a parquet source would otherwise throw)')
})

test('unionSources does not push a non-enumerable where (subquery) to any sub-source', async () => {
  /** @type {Record<string, unknown>[]} */
  const seen = []
  const union = unionSources([/** @type {any} */ (fakeSource([{ id: 'a1' }], seen))])
  // A subquery predicate whose column set can't be enumerated locally.
  const where = /** @type {any} */ ({ type: 'exists', subquery: {} })
  const scan = union.scan(/** @type {any} */ ({ where }))
  for await (const _ of scan.rows()) { /* drain */ }
  assert.equal(seen[0].where, undefined, 'unenumerable predicate is left for the engine')
})

test('unionSources tolerates a scan with no options', async () => {
  /** @type {Record<string, unknown>[]} */
  const seen = []
  const union = unionSources([/** @type {any} */ (fakeSource([{ id: 'a1' }], seen))])
  const scan = union.scan(/** @type {any} */ (undefined))
  /** @type {unknown[]} */
  const out = []
  for await (const row of scan.rows()) out.push(row)
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
