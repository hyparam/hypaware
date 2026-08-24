// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { parquetMetadataAsync } from 'hyparquet'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { collect, executeSql, parseSql } from 'squirreling'

import { parquetDataSource } from '../../src/core/query/parquet-source.js'
import { whereToParquetFilter } from '../../src/core/query/parquet-pushdown.js'
import { rowsToColumnSources } from '../../hypaware-core/plugins-workspace/format-parquet/src/columns.js'
import { asyncBufferFromBytes, parquetSourceFromRows } from '../helpers/parquet_source_fixture.js'

/**
 * @import { ExprNode, SelectStatement } from 'squirreling/src/types.js'
 * @import { ColumnSpec, ScannableDataSource } from '../../hypaware-plugin-kernel-types.js'
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
 * Build an in-memory parquet file from ROWS with a small row-group size
 * so the scan exercises multi-row-group iteration (2 + 2 + 1).
 *
 * @returns {Promise<ScannableDataSource>}
 */
async function makeSource() {
  return parquetSourceFromRows(COLUMNS, ROWS, { rowGroupSize: 2 })
}

// `at` is nullable on purpose. Eleven shipped `ColumnSpec`s are nullable
// TIMESTAMP, `logs.timestamp` and `traces.startTimestamp` among them, and a
// non-null fixture cannot see whether a folded bound leaks NULL rows past a
// filter the engine will not re-check.
/** @type {ColumnSpec[]} */
const TIMESTAMP_COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'at', type: 'TIMESTAMP', nullable: true },
]

// Two days either side of the 2026-08-11 window the day-bound tests select, so
// a bound that silently matched everything (or nothing) is visible, plus a NULL
// that SQL excludes from every bound.
const TIMESTAMP_ROWS = [
  { id: 1, at: '2026-08-10T23:59:59Z' },
  { id: 2, at: '2026-08-11T00:00:00Z' },
  { id: 3, at: '2026-08-11T23:59:59Z' },
  { id: 4, at: '2026-08-12T00:00:00Z' },
  { id: 5, at: null },
]

/**
 * @returns {Promise<ScannableDataSource>}
 */
async function makeTimestampSource() {
  const columnData = rowsToColumnSources(TIMESTAMP_COLUMNS, TIMESTAMP_ROWS)
  const arrayBuffer = parquetWriteBuffer({ columnData, codec: 'SNAPPY', rowGroupSize: 2 })
  const file = asyncBufferFromBytes(new Uint8Array(arrayBuffer))
  const metadata = await parquetMetadataAsync(file)
  return parquetDataSource(file, metadata)
}

/**
 * Same, over `NULLABLE_ROWS`.
 *
 * @returns {Promise<ScannableDataSource>}
 */
async function makeNullableSource() {
  return parquetSourceFromRows(NULLABLE_COLUMNS, NULLABLE_ROWS, { rowGroupSize: 2 })
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
 * @param {ScannableDataSource} source
 * @param {string} query
 */
async function run(source, query) {
  return collect(executeSql({ tables: { t: source }, query }))
}

// --- pushdown conversion -----------------------------------------------------

// Integer literals stay plain numbers: hyparquet >= 1.28.2 compares them to
// bigint-decoded INT64 columns through `equals()`, and its bloom hashing
// rejects a bigint for INT32/FLOAT/DOUBLE, so coercing would cost pruning.
// Relational bounds push bare: 1.28.2's matchFilter rejects null cells in
// $lt/$lte/$gt/$gte, so no guard is needed (LLP 0222).
test('whereToParquetFilter converts simple comparisons', () => {
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id = 3')), { id: { $eq: 3 } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id > 3')), { id: { $gt: 3 } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id <= 3')), { id: { $lte: 3 } })
  assert.deepEqual(whereToParquetFilter(whereOf("SELECT * FROM t WHERE name = 'bob'")), { name: { $eq: 'bob' } })
})

test('whereToParquetFilter mirrors flipped operands (literal on the left)', () => {
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE 3 < id')), { id: { $gt: 3 } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE 3 >= id')), { id: { $lte: 3 } })
})

test('whereToParquetFilter handles AND / OR / NOT', () => {
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id >= 2 AND id <= 4')),
    { $and: [{ id: { $gte: 2 } }, { id: { $lte: 4 } }] }
  )
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id = 1 OR id = 2')),
    { $or: [{ id: { $eq: 1 } }, { id: { $eq: 2 } }] }
  )
  // $ne is true on a null cell in hyparquet (MongoDB semantics), so it is the
  // one comparison that carries a null guard
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE NOT (id = 1)')),
    { $and: [{ id: { $ne: null } }, { id: { $ne: 1 } }] }
  )
  // De Morgan: NOT (a OR b) -> $and of the negated children, never `$nor`,
  // whose two-valued complement matches the rows its children left UNKNOWN
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE NOT (id = 1 OR id = 2)')),
    {
      $and: [
        { $and: [{ id: { $ne: null } }, { id: { $ne: 1 } }] },
        { $and: [{ id: { $ne: null } }, { id: { $ne: 2 } }] },
      ],
    }
  )
})

test('whereToParquetFilter handles IN / NOT IN / IS NULL', () => {
  // $in never matches a null cell, so it pushes bare; $nin, like $ne, is
  // true on one, so it carries the guard
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id IN (1, 2)')),
    { id: { $in: [1, 2] } }
  )
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id NOT IN (1, 2)')),
    { $and: [{ id: { $ne: null } }, { id: { $nin: [1, 2] } }] }
  )
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE name IS NULL')), { name: { $eq: null } })
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE name IS NOT NULL')), { name: { $ne: null } })
})

// The regression that motivated LLP 0222: squirreling parses a typed literal
// as a cast over a string, and requiring a bare literal operand made every
// timestamp-bounded predicate convert to undefined and prune nothing.
test('whereToParquetFilter folds typed literals (TIMESTAMP casts)', () => {
  assert.deepEqual(
    whereToParquetFilter(whereOf("SELECT * FROM t WHERE at >= TIMESTAMP '2026-08-11T00:00:00Z'")),
    { at: { $gte: new Date('2026-08-11T00:00:00Z') } }
  )
  // AND is all-or-nothing, so a day window only converts if both sides do
  assert.deepEqual(
    whereToParquetFilter(whereOf(
      "SELECT * FROM t WHERE at >= TIMESTAMP '2026-08-11T00:00:00Z' AND at < TIMESTAMP '2026-08-12T00:00:00Z'"
    )),
    {
      $and: [
        { at: { $gte: new Date('2026-08-11T00:00:00Z') } },
        { at: { $lt: new Date('2026-08-12T00:00:00Z') } },
      ],
    }
  )
  // A cast the engine would evaluate to null must not become a filter
  assert.equal(whereToParquetFilter(whereOf("SELECT * FROM t WHERE at >= TIMESTAMP 'not-a-day'")), undefined)
})

// Unwrapping a cast at boolean position is only sound when the cast preserves
// truthiness. CAST(<bool> AS TEXT) yields 'false', which is truthy, so pushing
// the bare comparison down would drop rows the query selects.
test('whereToParquetFilter only unwraps truthiness-preserving casts', () => {
  assert.deepEqual(whereToParquetFilter(whereOf('SELECT * FROM t WHERE CAST(id = 1 AS INT)')), { id: { $eq: 1 } })
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE CAST(id = 1 AS TEXT)')), undefined)
})

test('whereToParquetFilter returns undefined for non-convertible predicates', () => {
  assert.equal(whereToParquetFilter(whereOf("SELECT * FROM t WHERE name LIKE 'a%'")), undefined)
  // a single non-convertible conjunct collapses the whole AND
  assert.equal(whereToParquetFilter(whereOf("SELECT * FROM t WHERE id = 1 AND name LIKE 'a%'")), undefined)
  assert.equal(whereToParquetFilter(undefined), undefined)
})

test('whereToParquetFilter declines NULL-literal comparisons to the engine', () => {
  // A comparison against a NULL literal is UNKNOWN for every row. icebird
  // declines it rather than pushing a filter ({$eq: null} would mean IS NULL
  // to hyparquet), and squirreling >= 0.15.3 answers the fallback with
  // three-valued logic, so the negated shapes that issue #734 caught
  // returning every row now correctly return none (asserted end to end
  // below).
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id = NULL')), undefined)
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id != NULL')), undefined)
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id < NULL')), undefined)
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE NULL >= id')), undefined)
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE NOT (id = NULL)')), undefined)
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE NOT (id + 1 = NULL)')), undefined)
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id + NULL')), undefined)
  // Literal versus literal: no column to key a filter on, so this declines
  // for lack of a column rather than for the NULL-literal reason above.
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE NOT (NULL = 1)')), undefined)
  // Same NULL-literal branch as the arithmetic case above: the operator is
  // never consulted, since a NULL literal opposite a bare column declines
  // first.
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE name || NULL')), undefined)
  // ...and a value expression declines on the operator even without a NULL.
  assert.equal(whereToParquetFilter(whereOf("SELECT * FROM t WHERE name || 'x'")), undefined)
  // A declined conjunct collapses the surrounding tree to the engine too
  assert.equal(whereToParquetFilter(whereOf('SELECT * FROM t WHERE id = NULL OR id = 3')), undefined)
})

test('whereToParquetFilter handles NULL members of an IN list', () => {
  // NOT IN over a list containing NULL matches no row: FALSE on a listed
  // value, UNKNOWN everywhere else, and no negation rescues an UNKNOWN.
  // `$in: []` is hyparquet's never-match and prunes every row group.
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id NOT IN (1, NULL)')),
    { id: { $in: [] } }
  )
  // A NULL member of a non-negated list cannot make the disjunction true, so
  // it is dropped: same rows, and the leaf keeps its statistics pruning.
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id IN (1, NULL)')),
    { id: { $in: [1] } }
  )
  assert.deepEqual(
    whereToParquetFilter(whereOf('SELECT * FROM t WHERE id IN (NULL)')),
    { id: { $in: [] } }
  )
})

// --- NULL rows must not leak past a pushed-down filter ------------------------

// @ref LLP 0098 [tests]: the scan claims `appliedWhere` for
// every convertible predicate, so the engine never re-filters, and a filter
// that disagrees with SQL on null cells is a silent wrong answer rather than
// an error. hyparquet >= 1.28.2 rejects null cells in bare relational bounds;
// $ne and $nin need the converter's explicit guard.
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
    // NOT over an OR: a NULL row is UNKNOWN for every disjunct, which SQL
    // excludes but a two-valued complement reports as "nothing matched,
    // therefore true". Only correct while negation reaches the leaves, so
    // each leaf carries its own guard.
    ['NOT (ts > 300 OR ts < 100)', [1, 3]],
    ['NOT (ts >= 300 OR ts <= 100)', []],
    ['NOT (ts = 100 OR ts = 300)', [5]],
    ["NOT (ts IN (100) OR label = 'c')", [5]],
    ['NOT (neg > -400 OR neg < -600)', [1]],
    ["NOT (label < 'c' OR label > 'c')", [3]],
    ['NOT (ts IS NULL OR ts > 300)', [1, 3]],
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
    ['ts NOT IN (300, NULL)', []],
  ]
  assert.deepEqual(await mismatches(cases), [])
})

// A NULL-literal comparison is UNKNOWN for every row whatever the negation
// depth. The converter declines these shapes, and the decline is only safe
// because squirreling >= 0.15.3 evaluates WHERE with three-valued logic:
// its old two-valued NOT flipped UNKNOWN to TRUE and returned every row for
// exactly these predicates (issue #734).
test('negated comparisons against a NULL literal match no rows (issue #734)', async () => {
  /** @type {[string, number[]][]} */
  const cases = [
    // rows: ts = 100, NULL, 300, NULL, 500
    ['NOT (ts = NULL)', []],
    ['NOT (ts != NULL)', []],
    ['NOT (ts <> NULL)', []],
    ['NOT (ts < NULL)', []],
    ['NOT (ts <= NULL)', []],
    ['NOT (ts > NULL)', []],
    ['NOT (ts >= NULL)', []],
    // literal on the left mirrors the operator but not the UNKNOWN
    ['NOT (NULL = ts)', []],
    ['NOT (NULL > ts)', []],
    // NOT UNKNOWN is UNKNOWN, so negation depth never makes it TRUE
    ['NOT NOT (ts = NULL)', []],
    ['NOT NOT NOT (ts = NULL)', []],
    // strings and LIKE are UNKNOWN against a NULL literal too
    ['NOT (label = NULL)', []],
    ['label LIKE NULL', []],
    ['NOT (label LIKE NULL)', []],
    // BETWEEN desugars to two comparisons, one of them against the NULL
    ['ts BETWEEN NULL AND 500', []],
    ['NOT (ts BETWEEN NULL AND 500)', []],
    // These three are non-empty on purpose. The negated case above is empty
    // only because `ts` maxes at 500, so its `ts > 500` conjunct is FALSE for
    // every row: an accident of the data, not of the logic. (The non-negated
    // case above is empty at any bound, since a never-match zeroes an $and.)
    // A bound of 50, or moving the NULL to the upper bound, leaves rows whose
    // non-NULL conjunct is FALSE rather than TRUE, so the negation matches.
    // A bug that pushed never-match for the whole desugared AND, rather than
    // only for the conjunct holding the NULL, would return [] and fail these.
    ['NOT (ts BETWEEN NULL AND 50)', [1, 3, 5]],
    ['ts NOT BETWEEN NULL AND 50', [1, 3, 5]],
    ['NOT (ts BETWEEN 400 AND NULL)', [1, 3]],
    // composition: UNKNOWN AND TRUE is UNKNOWN, UNKNOWN OR TRUE is TRUE
    ['NOT (ts = NULL) AND ts >= 300', []],
    ['NOT (ts = NULL) OR ts >= 300', [3, 5]],
    ['NOT (ts = NULL OR ts = 300)', []],
    // ...and the never-match branch must not swallow its sibling: NOT (a AND b)
    // is TRUE wherever b is FALSE, however UNKNOWN a is
    ['NOT (ts = NULL AND ts = 300)', [1, 5]],
    ['ts IN (NULL)', []],
  ]
  assert.deepEqual(await mismatches(cases), [])
})

// The conservative direction. A predicate that is not UNKNOWN for every row
// must keep its ordinary filter (or keep declining), and the rows must still
// be the ones SQL names.
test('predicates that are not always-UNKNOWN keep their ordinary handling (issue #734)', async () => {
  /** @type {[string, number[]][]} */
  const cases = [
    ['NOT (ts = 300)', [1, 5]],
    ['NOT (ts = 300 OR ts = 500)', [1]],
    ['NOT (ts IS NULL)', [1, 3, 5]],
    ['ts IN (300, NULL)', [3]],
    // declined subtrees the engine still gets right
    ["label LIKE 'a%'", [1]],
    ["label LIKE 'a%' OR ts > 300", [1, 5]],
    ["NOT (label LIKE 'a%') AND ts IS NOT NULL", [3, 5]],
    ["NOT (label LIKE 'a%')", [3, 5]],
  ]
  assert.deepEqual(await mismatches(cases), [])
})

// The row set is the same either way, so only the read proves this one: a
// NULL member left in a non-negated `$in` list is undecidable against
// BYTE_ARRAY bounds, and one undecidable member forfeits statistics pruning
// for the whole leaf. Measure the bytes the scan pulls off the file.
test('a NULL member in an IN list does not cost row-group pruning (issue #734)', async () => {
  const columnData = rowsToColumnSources(NULLABLE_COLUMNS, NULLABLE_ROWS)
  const arrayBuffer = parquetWriteBuffer({ columnData, codec: 'SNAPPY', rowGroupSize: 2 })
  const bytes = new Uint8Array(arrayBuffer)

  /**
   * @param {string} predicate
   * @returns {Promise<{ read: number, ids: number[] }>}
   */
  async function scanReading(predicate) {
    const counting = asyncBufferFromBytes(bytes)
    let read = 0
    const file = {
      byteLength: counting.byteLength,
      /**
       * @param {number} start
       * @param {number} [end]
       */
      slice(start, end) {
        read += (end ?? bytes.byteLength) - start
        return counting.slice(start, end)
      },
    }
    const source = parquetDataSource(file, await parquetMetadataAsync(file))
    // Count only what the scan reads, not the metadata read above.
    read = 0
    /** @type {number[]} */
    const ids = []
    const scan = source.scan({ columns: ['id'], where: whereOf(`SELECT id FROM t WHERE ${predicate}`) })
    assert.equal(scan.appliedWhere, true)
    for await (const row of scan.rows()) ids.push(Number(await row.cells.id))
    return { read, ids }
  }

  // No row group holds a label at or above 'zz', so every one is skippable.
  const withNull = await scanReading("label IN ('zz', NULL)")
  const withoutNull = await scanReading("label IN ('zz')")
  const unfiltered = await scanReading('id >= 1')

  assert.deepEqual(withNull.ids, [])
  assert.deepEqual(withoutNull.ids, [])
  // Pruned to nothing, and the NULL member costs nothing.
  assert.equal(withNull.read, withoutNull.read)
  assert.ok(
    withNull.read < unfiltered.read,
    `pruned scan read ${withNull.read} bytes, unfiltered read ${unfiltered.read}`
  )
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

// A filtered scan must still honor the projection. The tests above only prove
// the rows are right, which stays true when the scan reads every column and
// the engine projects afterwards; on a table whose unselected columns hold
// message bodies, that difference is the whole read. Assert the narrow read
// directly, both in what the scan emits and in what it pulls off the file.
test('a pushed-down filter does not widen the projection', async () => {
  const columnData = rowsToColumnSources(COLUMNS, ROWS)
  const arrayBuffer = parquetWriteBuffer({ columnData, codec: 'SNAPPY', rowGroupSize: 2 })
  const bytes = new Uint8Array(arrayBuffer)

  /**
   * Scan `columns` under a filter on `score`, reporting the bytes pulled from
   * the file. `score` is deliberately absent from every projection so the read
   * can only cover it because hyparquet folds filter columns into its own plan.
   *
   * @param {string[] | undefined} columns
   * @returns {Promise<{ read: number, emitted: string[][] }>}
   */
  async function scanWithFilter(columns) {
    let read = 0
    const counting = asyncBufferFromBytes(bytes)
    const file = {
      byteLength: counting.byteLength,
      /**
       * @param {number} start
       * @param {number} [end]
       */
      slice(start, end) {
        read += (end ?? bytes.byteLength) - start
        return counting.slice(start, end)
      },
    }
    const source = parquetDataSource(file, await parquetMetadataAsync(file))
    const scan = source.scan({ columns, where: whereOf('SELECT name FROM t WHERE score > 3') })
    assert.equal(scan.appliedWhere, true)
    /** @type {string[][]} */
    const emitted = []
    for await (const row of scan.rows()) emitted.push(row.columns)
    return { read, emitted }
  }

  const projected = await scanWithFilter(['name'])
  const everything = await scanWithFilter(undefined)

  // The filter is honored on a column the scan never emits.
  assert.equal(projected.emitted.length, 3)
  for (const columns of projected.emitted) assert.deepEqual(columns, ['name'])
  // ...and the unselected columns were never read off the file.
  assert.ok(
    projected.read < everything.read,
    `projected scan read ${projected.read} bytes, unprojected read ${everything.read}`
  )
})

test('range WHERE (AND) returns the inclusive window', async () => {
  const source = await makeSource()
  const rows = await run(source, 'SELECT id FROM t WHERE id >= 2 AND id <= 4')
  assert.deepEqual(rows.map((r) => Number(r.id)), [2, 3, 4])
})

// A converted predicate sets appliedWhere, so the engine does NOT re-filter:
// a folded literal that compares wrongly against the decoded column would
// silently drop rows rather than merely lose pruning. This is the check that
// the TIMESTAMP fold is safe end to end, not just well-shaped.
test('timestamp day bounds filter correctly through the pushed-down scan', async () => {
  const source = await makeTimestampSource()
  const rows = await run(
    source,
    "SELECT id FROM t WHERE at >= TIMESTAMP '2026-08-11T00:00:00Z' AND at < TIMESTAMP '2026-08-12T00:00:00Z'"
  )
  // id 5 is the NULL row: UNKNOWN against both bounds, so SQL excludes it
  assert.deepEqual(rows.map((r) => Number(r.id)), [2, 3])
})

// The rows above come out right whether or not the bound is pushed down, since
// an unconverted predicate leaves `appliedWhere` false and the engine filters
// to the same answer. Pushing it down is the entire point of folding the typed
// literal, so assert the claim itself: without this, an upstream regression
// that stopped folding `TIMESTAMP '...'` would keep the suite green and
// silently give back the scan time.
test('a folded timestamp bound is actually pushed down, not left to the engine', async () => {
  const source = await makeTimestampSource()
  const scan = source.scan({
    columns: ['id'],
    where: whereOf("SELECT id FROM t WHERE at >= TIMESTAMP '2026-08-11T00:00:00Z'"),
  })
  assert.equal(scan.appliedWhere, true)
})

test('a timestamp bound matching no rows returns none (and one matching all returns all)', async () => {
  const none = await run(await makeTimestampSource(), "SELECT id FROM t WHERE at >= TIMESTAMP '2099-01-01T00:00:00Z'")
  assert.deepEqual(none, [])
  // 4, not 5: the NULL row is UNKNOWN against the bound, so SQL drops it even
  // though every non-null row qualifies
  const all = await run(await makeTimestampSource(), "SELECT id FROM t WHERE at >= TIMESTAMP '2000-01-01T00:00:00Z'")
  assert.equal(all.length, 4)
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
