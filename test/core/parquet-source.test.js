// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { parquetMetadataAsync } from 'hyparquet'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { collect, executeSql, parseSql } from 'squirreling'

import { parquetDataSource } from '../../src/core/query/parquet-source.js'
import { whereToParquetFilter } from '../../src/core/query/parquet-pushdown.js'
import { rowsToColumnSources } from '../../hypaware-core/plugins-workspace/format-parquet/src/columns.js'

/**
 * @import { AsyncBuffer } from 'hyparquet'
 * @import { AsyncDataSource, ExprNode, SelectStatement } from 'squirreling/src/types.js'
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'name', type: 'STRING', nullable: false },
  { name: 'score', type: 'DOUBLE', nullable: false },
]

const ROWS = [
  { id: 1, name: 'alice', score: 1.5 },
  { id: 2, name: 'bob', score: 2.5 },
  { id: 3, name: 'carol', score: 3.5 },
  { id: 4, name: 'dave', score: 4.5 },
  { id: 5, name: 'eve', score: 5.5 },
]

/**
 * @param {Uint8Array} bytes
 * @returns {AsyncBuffer}
 */
function asyncBufferFromBytes(bytes) {
  return {
    byteLength: bytes.byteLength,
    slice(start, end) {
      const sliced = bytes.subarray(start, end)
      const out = new ArrayBuffer(sliced.byteLength)
      new Uint8Array(out).set(sliced)
      return out
    },
  }
}

/**
 * Build an in-memory parquet file from ROWS with a small row-group size
 * so the scan exercises multi-row-group iteration (2 + 2 + 1).
 *
 * @returns {Promise<AsyncDataSource>}
 */
async function makeSource() {
  const columnData = rowsToColumnSources(COLUMNS, ROWS)
  const arrayBuffer = parquetWriteBuffer({ columnData, codec: 'SNAPPY', rowGroupSize: 2 })
  const file = asyncBufferFromBytes(new Uint8Array(arrayBuffer))
  const metadata = await parquetMetadataAsync(file)
  return parquetDataSource(file, metadata)
}

/**
 * @param {string} sql
 * @returns {ExprNode | undefined}
 */
function whereOf(sql) {
  const stmt = /** @type {SelectStatement} */ (parseSql({ query: sql }))
  return stmt.where
}

/**
 * @param {AsyncDataSource} source
 * @param {string} query
 */
async function run(source, query) {
  return collect(executeSql({ tables: { t: source }, query }))
}

// --- pushdown conversion -----------------------------------------------------

test('whereToParquetFilter converts simple comparisons (integers coerced to bigint)', () => {
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id = 3')), { id: { $eq: 3n } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id > 3')), { id: { $gt: 3n } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id <= 3')), { id: { $lte: 3n } })
  assert.deepEqual(whereToParquetFilter(whereOf("SELECT * FROM t WHERE name = 'bob'")), { name: { $eq: 'bob' } })
})

test('whereToParquetFilter mirrors flipped operands (literal on the left)', () => {
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE 3 < id')), { id: { $gt: 3n } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE 3 >= id')), { id: { $lte: 3n } })
})

test('whereToParquetFilter handles AND / OR / NOT', () => {
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id >= 2 AND id <= 4')),
    { $and: [{ id: { $gte: 2n } }, { id: { $lte: 4n } }] }
  )
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id = 1 OR id = 2')),
    { $or: [{ id: { $eq: 1n } }, { id: { $eq: 2n } }] }
  )
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE NOT (id = 1)')), { id: { $ne: 1n } })
  // De Morgan: NOT (a OR b) -> $nor of the un-negated children
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE NOT (id = 1 OR id = 2)')),
    { $nor: [{ id: { $eq: 1n } }, { id: { $eq: 2n } }] }
  )
})

test('whereToParquetFilter handles IN / NOT IN / IS NULL', () => {
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id IN (1, 2)')), { id: { $in: [1n, 2n] } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id NOT IN (1, 2)')), { id: { $nin: [1n, 2n] } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE name IS NULL')), { name: { $eq: null } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE name IS NOT NULL')), { name: { $ne: null } })
})

test('whereToParquetFilter returns undefined for non-convertible predicates', () => {
  assert.equal(whereToParquetFilter(whereOf("SELECT * FROM t WHERE name LIKE 'a%'")), undefined)
  // a single non-convertible conjunct collapses the whole AND
  assert.equal(whereToParquetFilter(whereOf("SELECT * FROM t WHERE id = 1 AND name LIKE 'a%'")), undefined)
  assert.equal(whereToParquetFilter(undefined), undefined)
})

// --- scan through squirreling ------------------------------------------------

test('parquetDataSource exposes schema columns and row count', async () => {
  const source = await makeSource()
  assert.deepEqual(source.columns, ['id', 'name', 'score'])
  assert.equal(source.numRows, 5)
})

test('SELECT * returns every row across row groups', async () => {
  const source = await makeSource()
  const rows = await run(source, 'SELECT * FROM t')
  assert.equal(rows.length, 5)
  assert.deepEqual(rows.map((r) => r.name), ['alice', 'bob', 'carol', 'dave', 'eve'])
  assert.deepEqual(rows.map((r) => Number(r.id)), [1, 2, 3, 4, 5])
})

test('WHERE with pushed-down filter returns matching rows', async () => {
  const source = await makeSource()
  const rows = await run(source, 'SELECT name FROM t WHERE id = 3')
  assert.deepEqual(rows, [{ name: 'carol' }])
})

test('WHERE on a non-projected column still filters correctly', async () => {
  const source = await makeSource()
  // score is filtered but not selected; the scan must read it anyway
  const rows = await run(source, 'SELECT name FROM t WHERE score > 3')
  assert.deepEqual(rows.map((r) => r.name), ['carol', 'dave', 'eve'])
})

test('range WHERE (AND) returns the inclusive window', async () => {
  const source = await makeSource()
  const rows = await run(source, 'SELECT id FROM t WHERE id >= 2 AND id <= 4')
  assert.deepEqual(rows.map((r) => Number(r.id)), [2, 3, 4])
})

test('LIKE falls back to engine filtering (not pushed down)', async () => {
  const source = await makeSource()
  const rows = await run(source, "SELECT name FROM t WHERE name LIKE 'a%'")
  assert.deepEqual(rows, [{ name: 'alice' }])
})

test('LIMIT/OFFSET without WHERE is pushed down', async () => {
  const source = await makeSource()
  const rows = await run(source, 'SELECT id FROM t LIMIT 2 OFFSET 1')
  assert.deepEqual(rows.map((r) => Number(r.id)), [2, 3])
})

test('ORDER BY ... LIMIT sees all rows before limiting', async () => {
  const source = await makeSource()
  const rows = await run(source, 'SELECT id FROM t ORDER BY id DESC LIMIT 2')
  assert.deepEqual(rows.map((r) => Number(r.id)), [5, 4])
})

test('WHERE + LIMIT applies the limit over the filtered stream', async () => {
  const source = await makeSource()
  const rows = await run(source, 'SELECT id FROM t WHERE id >= 2 LIMIT 2')
  assert.deepEqual(rows.map((r) => Number(r.id)), [2, 3])
})

test('aggregate over the source', async () => {
  const source = await makeSource()
  const rows = await run(source, 'SELECT COUNT(*) AS n FROM t')
  assert.equal(Number(rows[0].n), 5)
})
