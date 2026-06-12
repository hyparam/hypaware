// @ts-check

import assert from 'node:assert/strict'
import test from 'node:test'

import { unionSources } from '../../hypaware-core/plugins-workspace/context-graph/src/datasets.js'

/**
 * Fake AsyncDataSource that honors limit/offset pushdown (like the
 * iceberg-backed sources) and records the scan options it received.
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

  // The union must yield every underlying row: if limit/offset leaked into
  // the sub-scans, each partition would drop its first row and the engine
  // would then skip the offset again on the concatenated stream.
  assert.equal(out.length, 4)
  for (const options of seen) {
    assert.equal(options.limit, undefined, 'limit not pushed into sub-source')
    assert.equal(options.offset, undefined, 'offset not pushed into sub-source')
  }
})

test('unionSources preserves where/columns hints for sub-sources', async () => {
  /** @type {Record<string, unknown>[]} */
  const seen = []
  const union = unionSources([
    /** @type {any} */ (fakeSource([{ id: 'a1' }], seen)),
    /** @type {any} */ (fakeSource([{ id: 'b1' }], seen)),
  ])
  const where = /** @type {any} */ ({ column: 'id', op: '=', value: 'a1' })
  const scan = union.scan({ where, columns: ['id'], limit: 1 })
  for await (const _ of scan.rows()) { /* drain */ }
  for (const options of seen) {
    assert.equal(options.where, where, 'where hint forwarded')
    assert.deepEqual(options.columns, ['id'], 'columns hint forwarded')
  }
})
