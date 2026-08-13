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
 * A nullable-column fixture: `ts` straddles the bound with NULLs either side,
 * `neg` is the same shape with negative values (where `>` / `>=` leak, since
 * a coerced NULL reads as 0), and `label` proves the same for strings.
 *
 * @type {ColumnSpec[]}
 */
const NULLABLE_COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'ts', type: 'INT64', nullable: true },
  { name: 'neg', type: 'INT64', nullable: true },
  { name: 'label', type: 'STRING', nullable: true },
]

const NULLABLE_ROWS = [
  { id: 1, ts: 100, neg: -500, label: 'a' },
  { id: 2, ts: null, neg: null, label: null },
  { id: 3, ts: 300, neg: -300, label: 'c' },
  { id: 4, ts: null, neg: null, label: null },
  { id: 5, ts: 500, neg: -100, label: 'e' },
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
 * Same, over `NULLABLE_ROWS`.
 *
 * @returns {Promise<AsyncDataSource>}
 */
async function makeNullableSource() {
  const columnData = rowsToColumnSources(NULLABLE_COLUMNS, NULLABLE_ROWS)
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
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id > 3')), { id: { $ne: null, $gt: 3n } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id <= 3')), { id: { $ne: null, $lte: 3n } })
  assert.deepEqual(whereToParquetFilter(whereOf("SELECT * FROM t WHERE name = 'bob'")), { name: { $eq: 'bob' } })
})

test('whereToParquetFilter mirrors flipped operands (literal on the left)', () => {
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE 3 < id')), { id: { $ne: null, $gt: 3n } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE 3 >= id')), { id: { $ne: null, $lte: 3n } })
})

test('whereToParquetFilter handles AND / OR / NOT', () => {
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id >= 2 AND id <= 4')),
    { $and: [{ id: { $ne: null, $gte: 2n } }, { id: { $ne: null, $lte: 4n } }] }
  )
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id = 1 OR id = 2')),
    { $or: [{ id: { $eq: 1n } }, { id: { $eq: 2n } }] }
  )
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE NOT (id = 1)')),
    { $and: [{ id: { $ne: null } }, { id: { $ne: 1n } }] }
  )
  // De Morgan: NOT (a OR b) -> $nor of the un-negated children
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE NOT (id = 1 OR id = 2)')),
    { $nor: [{ id: { $eq: 1n } }, { id: { $eq: 2n } }] }
  )
})

test('whereToParquetFilter handles IN / NOT IN / IS NULL', () => {
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id IN (1, 2)')),
    { id: { $ne: null, $in: [1n, 2n] } }
  )
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id NOT IN (1, 2)')),
    { id: { $ne: null, $nin: [1n, 2n] } }
  )
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE name IS NULL')), { name: { $eq: null } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE name IS NOT NULL')), { name: { $ne: null } })
})

test('whereToParquetFilter returns undefined for non-convertible predicates', () => {
  assert.equal(whereToParquetFilter(whereOf("SELECT * FROM t WHERE name LIKE 'a%'")), undefined)
  // a single non-convertible conjunct collapses the whole AND
  assert.equal(whereToParquetFilter(whereOf("SELECT * FROM t WHERE id = 1 AND name LIKE 'a%'")), undefined)
  assert.equal(whereToParquetFilter(undefined), undefined)
})

test('whereToParquetFilter declines predicates whose SQL result is always UNKNOWN', () => {
  // Comparison against a NULL literal never matches a row, not even a NULL
  // one; there is no hyparquet operator for "never match", so the engine
  // keeps the predicate rather than the scan claiming a filter that reads
  // like IS NULL.
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id = NULL')), undefined)
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id != NULL')), undefined)
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id < NULL')), undefined)
  // NOT IN over a list containing NULL is UNKNOWN for every row too.
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id NOT IN (1, NULL)')), undefined)
  // IN over such a list is expressible: the NULL entry cannot make the
  // disjunction true, and the guard keeps NULL rows out.
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id IN (1, NULL)')),
    { id: { $ne: null, $in: [1n, null] } }
  )
})

// --- NULL rows must not leak past a pushed-down filter ------------------------

// @ref LLP 0098#wrapper-duties [tests]: the scan claims `appliedWhere` for
// every convertible predicate, so the engine never re-filters. hyparquet
// evaluates a bare bound with raw JS comparison, where `null <= 300n` is true,
// so an unguarded filter is a silent wrong answer rather than an error.
test('pushed-down comparisons do not leak NULL rows (issue #728)', async () => {
  /** @type {[string, number[]][]} */
  const cases = [
    // rows: ts = 100, NULL, 300, NULL, 500
    ['ts <= 300', [1, 3]],
    ['ts < 300', [1]],
    ['ts != 300', [1, 5]],
    ['ts <> 300', [1, 5]],
    ['ts > 300', [5]],
    ['ts >= 300', [3, 5]],
    ['ts = 300', [3]],
    ['300 >= ts', [1, 3]],
    ['NOT (ts > 300)', [1, 3]],
    ['ts >= 100 AND ts <= 300', [1, 3]],
    ['ts IN (300, 500)', [3, 5]],
    ['ts NOT IN (300)', [1, 5]],
    // negative bounds: a coerced NULL reads as 0, so `>` and `>=` leak here
    // even though they happen to be correct for a positive bound.
    // rows: neg = -500, NULL, -300, NULL, -100
    ['neg > -400', [3, 5]],
    ['neg >= -300', [3, 5]],
    ['neg < -400', [1]],
    ['neg <= -500', [1]],
    ['neg != -300', [1, 5]],
    // strings compare the same way once NULL is out of the picture
    // rows: label = 'a', NULL, 'c', NULL, 'e'
    ["label < 'c'", [1]],
    ["label >= 'c'", [3, 5]],
    ["label != 'c'", [1, 5]],
    // IS NULL / IS NOT NULL still mean what they say
    ['ts IS NULL', [2, 4]],
    ['ts IS NOT NULL', [1, 3, 5]],
    ['NOT (ts IS NULL)', [1, 3, 5]],
  ]
  assert.deepEqual(await mismatches(cases), [])
})

test('comparison against a NULL literal matches no rows (issue #728)', async () => {
  /** @type {[string, number[]][]} */
  const cases = [
    ['ts = NULL', []],
    ['ts != NULL', []],
    ['ts < NULL', []],
    ['ts IN (300, NULL)', [3]],
  ]
  assert.deepEqual(await mismatches(cases), [])
})

/**
 * Run every predicate against a fresh nullable source and report the ones
 * whose result differs from SQL's. Reporting all of them at once, rather
 * than failing on the first, keeps the failure output a full census of which
 * operators leak.
 *
 * @param {[string, number[]][]} cases
 * @returns {Promise<string[]>}
 */
async function mismatches(cases) {
  /** @type {string[]} */
  const wrong = []
  for (const [predicate, expected] of cases) {
    const source = await makeNullableSource()
    const rows = await run(source, `SELECT id FROM t WHERE ${predicate}`)
    const got = rows.map((r) => Number(r.id))
    if (got.join(',') !== expected.join(',')) {
      wrong.push(`WHERE ${predicate} -> got [${got.join(',')}], SQL says [${expected.join(',')}]`)
    }
  }
  return wrong
}

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
