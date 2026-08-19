// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

// A zone-less literal (`'2026-08-18T21:00:00'`) is *local* time, which is the
// whole reason LLP 0272 made docs/ACCEPTANCE.md keep its trailing `Z`. The
// cases below name exact row sets, so the file pins the zone rather than
// passing only on a UTC host. Set before the first Date is constructed.
process.env.TZ = 'UTC'

import { parseSql } from 'squirreling'

import { executeQuerySql } from '../../src/core/query/sql.js'
import {
  TimestampLiteralError,
  coerceTimestampLiterals,
} from '../../src/core/query/timestamp-literals.js'
import { parquetSourceFromRows } from '../helpers/parquet_source_fixture.js'

/**
 * @import { AsyncDataSource, SqlPrimitive } from 'squirreling/src/types.js'
 * @import { ColumnSpec, DatasetSchema } from '../../hypaware-plugin-kernel-types.js'
 */

// @ref LLP 0272#scope [tests]: only a declared TIMESTAMP column takes the coercion, and the rows come back in both directions
// The shipped shape the issue names: a NOT NULL TIMESTAMP the user bounds, a
// STRING `date` partition column whose comparisons always worked (so a fix
// that types every literal as a timestamp fails here), and a nullable
// TIMESTAMP, since SQL excludes a NULL from every bound in both directions.
/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'seen_at', type: 'TIMESTAMP', nullable: true },
]

const ROWS = [
  { id: 1, date: '2026-08-17', message_created_at: '2026-08-17T09:00:00Z', seen_at: '2026-08-17T09:00:00Z' },
  { id: 2, date: '2026-08-18', message_created_at: '2026-08-18T20:59:59Z', seen_at: null },
  { id: 3, date: '2026-08-18', message_created_at: '2026-08-18T21:00:00Z', seen_at: '2026-08-18T21:00:00Z' },
  { id: 4, date: '2026-08-18', message_created_at: '2026-08-18T22:01:39Z', seen_at: null },
]

/** @type {DatasetSchema} */
const SCHEMA = { columns: COLUMNS }

const storage = /** @type {any} */ ({
  cacheRoot: '/tmp/hypaware-timestamp-literals',
  pendingInfo: async () => ({ pending: false }),
})

/**
 * A registry over one real parquet partition, so the query runs the same
 * pushdown-then-scan path `hyp query sql` runs, not a hand-rolled source that
 * would filter in the engine only.
 *
 * @param {{ schema?: DatasetSchema, name?: string }} [options]
 */
function registryForMessages(options = {}) {
  const schema = options.schema ?? SCHEMA
  const name = options.name ?? 'ai_gateway_messages'
  const dataset = {
    name,
    schema,
    discoverPartitions: async () => [],
    /** @returns {Promise<AsyncDataSource>} */
    createDataSource: async () => parquetSourceFromRows(COLUMNS, ROWS, { rowGroupSize: 2 }),
  }
  return /** @type {any} */ ({
    getDataset: (/** @type {string} */ asked) => (asked === name ? dataset : undefined),
    listDatasets: () => [dataset],
  })
}

/**
 * @param {string} query
 * @param {{ schema?: DatasetSchema }} [options]
 * @returns {Promise<number[]>}
 */
async function ids(query, options) {
  const out = await executeQuerySql({
    query,
    registry: registryForMessages(options),
    storage,
  })
  return out.rows.map((row) => Number(row.id))
}

// --- the reported defect -----------------------------------------------------

// Issue #860: every one of these returned zero rows. A bound on a TIMESTAMP
// column compared a Date against a string, which is false for every row in the
// engine and prunes every row group in the pushdown, so a healthy capture read
// as "nothing happened". Both directions are pinned: the rows the bound selects
// come back, and the rows outside it stay out.
test('a string bound on a TIMESTAMP column selects the rows it names (issue #860)', async () => {
  /** @type {[string, number[]][]} */
  const cases = [
    // rows: 2026-08-17T09:00:00Z, 08-18T20:59:59Z, 08-18T21:00:00Z, 08-18T22:01:39Z
    ["message_created_at >= '2026-08-18T21:00:00Z'", [3, 4]],
    ["message_created_at >= '2026-08-18T21:00:00'", [3, 4]],
    ["message_created_at > '2026-08-18T21:00:00Z'", [4]],
    ["message_created_at <= '2026-08-18T21:00:00Z'", [1, 2, 3]],
    ["message_created_at < '2026-08-18T21:00:00Z'", [1, 2]],
    ["message_created_at = '2026-08-18T21:00:00Z'", [3]],
    ["message_created_at != '2026-08-18T21:00:00Z'", [1, 2, 4]],
    ["message_created_at <> '2026-08-18T21:00:00Z'", [1, 2, 4]],
    // the literal on the left mirrors the operator
    ["'2026-08-18T21:00:00Z' <= message_created_at", [3, 4]],
    ["'2026-08-18T21:00:00Z' > message_created_at", [1, 2]],
    // a date-only literal is midnight UTC, so the whole of the 18th is above it
    ["message_created_at > '2026-08-18'", [2, 3, 4]],
    // bounds far outside the data must match everything / nothing, not zero
    // rows either way: the issue's clearest tell that the predicate never
    // evaluated rather than being off by one
    ["message_created_at >= '2020-01-01T00:00:00Z'", [1, 2, 3, 4]],
    ["message_created_at <= '2030-01-01T00:00:00Z'", [1, 2, 3, 4]],
    ["message_created_at >= '2030-01-01T00:00:00Z'", []],
    ["message_created_at <= '2020-01-01T00:00:00Z'", []],
    // composite shapes: a day window, BETWEEN (which desugars to two bounds),
    // IN, and a bound conjoined with the STRING partition column
    ["message_created_at >= '2026-08-18T00:00:00Z' AND message_created_at < '2026-08-19T00:00:00Z'", [2, 3, 4]],
    ["message_created_at BETWEEN '2026-08-18T21:00:00Z' AND '2026-08-18T23:00:00Z'", [3, 4]],
    ["message_created_at NOT BETWEEN '2026-08-18T21:00:00Z' AND '2026-08-18T23:00:00Z'", [1, 2]],
    ["message_created_at IN ('2026-08-17T09:00:00Z', '2026-08-18T22:01:39Z')", [1, 4]],
    ["message_created_at NOT IN ('2026-08-17T09:00:00Z')", [2, 3, 4]],
    ["date = '2026-08-18' AND message_created_at >= '2026-08-18T21:00:00Z'", [3, 4]],
    ["NOT (message_created_at >= '2026-08-18T21:00:00Z')", [1, 2]],
    // the space-separated form is ordinary SQL, and neither parser accepts it
    // raw, so the coercion normalizes the separator rather than refusing
    ["message_created_at >= '2026-08-18 21:00:00Z'", [3, 4]],
    // minute precision is a legal ISO instant both evaluators already parse,
    // so it must select rows rather than be refused as uncoercible
    ["message_created_at >= '2026-08-18T21:00Z'", [3, 4]],
    ["message_created_at < '2026-08-18T21:00Z'", [1, 2]],
  ]
  /** @type {string[]} */
  const wrong = []
  for (const [predicate, expected] of cases) {
    const got = await ids(`SELECT id FROM ai_gateway_messages WHERE ${predicate} ORDER BY id`)
    if (got.join(',') !== expected.join(',')) {
      wrong.push(`WHERE ${predicate} -> got [${got.join(',')}], SQL says [${expected.join(',')}]`)
    }
  }
  assert.deepEqual(wrong, [])
})

// A NULL is UNKNOWN against every bound, and a coercion that turned the
// comparison into something two-valued would leak those rows back in.
test('a string bound on a nullable TIMESTAMP still excludes NULL rows', async () => {
  assert.deepEqual(await ids("SELECT id FROM ai_gateway_messages WHERE seen_at >= '2020-01-01T00:00:00Z' ORDER BY id"), [1, 3])
  assert.deepEqual(await ids("SELECT id FROM ai_gateway_messages WHERE seen_at < '2030-01-01T00:00:00Z' ORDER BY id"), [1, 3])
  assert.deepEqual(await ids("SELECT id FROM ai_gateway_messages WHERE NOT (seen_at >= '2020-01-01T00:00:00Z') ORDER BY id"), [])
  assert.deepEqual(await ids('SELECT id FROM ai_gateway_messages WHERE seen_at IS NULL ORDER BY id'), [2, 4])
})

// The narrow-fix direction: only a column the schema declares TIMESTAMP takes
// the coercion. `date` is a STRING partition column whose string comparisons
// were the one thing that worked, and typing them would change what they mean.
test('string comparisons on non-TIMESTAMP columns are left exactly as written', async () => {
  assert.deepEqual(await ids("SELECT id FROM ai_gateway_messages WHERE date = '2026-08-18' ORDER BY id"), [2, 3, 4])
  assert.deepEqual(await ids("SELECT id FROM ai_gateway_messages WHERE date > '2026-08-17' ORDER BY id"), [2, 3, 4])
  // a value no timestamp parser accepts: still a plain string comparison
  assert.deepEqual(await ids("SELECT id FROM ai_gateway_messages WHERE date = 'not-a-day' ORDER BY id"), [])
  // ...and a dataset that types the same name as STRING keeps that meaning
  /** @type {DatasetSchema} */
  const stringSchema = {
    columns: COLUMNS.map((c) => (c.name === 'message_created_at' ? { ...c, type: 'STRING' } : c)),
  }
  assert.deepEqual(
    await ids("SELECT id FROM ai_gateway_messages WHERE message_created_at >= '2026-08-18T21:00:00Z' ORDER BY id", { schema: stringSchema }),
    []
  )
})

// A typed literal already worked (LLP 0222) and must keep working unchanged:
// the coercion produces the same node, so the two spellings agree.
test('an explicitly typed literal and a bare string agree', async () => {
  const typed = await ids("SELECT id FROM ai_gateway_messages WHERE message_created_at >= TIMESTAMP '2026-08-18T21:00:00Z' ORDER BY id")
  const bare = await ids("SELECT id FROM ai_gateway_messages WHERE message_created_at >= '2026-08-18T21:00:00Z' ORDER BY id")
  assert.deepEqual(typed, [3, 4])
  assert.deepEqual(bare, typed)
})

// The refusal. A literal that is not a timestamp cannot be compared to one, and
// an empty result would be exactly the failure this fix exists to end.
test('a literal that is not a timestamp is refused, not silently pruned (issue #860)', async () => {
  await assert.rejects(
    ids("SELECT id FROM ai_gateway_messages WHERE message_created_at >= 'yesterday'"),
    (err) => {
      assert.ok(err instanceof TimestampLiteralError)
      assert.equal(err.code, 'timestamp_literal_uncoercible')
      assert.equal(err.column, 'message_created_at')
      assert.equal(err.literal, 'yesterday')
      assert.match(err.message, /YYYY-MM-DD/)
      return true
    }
  )
})

// --- rewrite shape -----------------------------------------------------------

/**
 * @param {string} sql
 * @param {any} registry
 */
function whereOfRewritten(sql, registry) {
  const statement = /** @type {any} */ (parseSql({ query: sql }))
  coerceTimestampLiterals(statement, registry)
  return statement
}

test('the rewrite emits the same cast node a typed literal parses to', () => {
  const registry = registryForMessages()
  const rewritten = whereOfRewritten(
    "SELECT id FROM ai_gateway_messages WHERE message_created_at >= '2026-08-18T21:00:00Z'",
    registry
  )
  assert.equal(rewritten.where.right.type, 'cast')
  assert.equal(rewritten.where.right.toType, 'TIMESTAMP')
  assert.equal(rewritten.where.right.expr.value, '2026-08-18T21:00:00Z')
})

test('a bound inside a subquery is typed against the subquery own table', () => {
  const registry = registryForMessages()
  const rewritten = whereOfRewritten(
    "SELECT id FROM ai_gateway_messages WHERE id IN (SELECT id FROM ai_gateway_messages WHERE message_created_at >= '2026-08-18T21:00:00Z')",
    registry
  )
  assert.equal(rewritten.where.subquery.where.right.type, 'cast')
  assert.equal(rewritten.where.subquery.where.right.toType, 'TIMESTAMP')
})

test('a bound inside a subquery selects the rows it names', async () => {
  assert.deepEqual(
    await ids(
      'SELECT id FROM ai_gateway_messages WHERE id IN (' +
      "SELECT id FROM ai_gateway_messages WHERE message_created_at >= '2026-08-18T21:00:00Z') ORDER BY id"
    ),
    [3, 4]
  )
})

test('the rewrite does not reach into a subquery typed by another table', () => {
  const registry = registryForMessages()
  // `other` is not a registered dataset, so nothing in its scope is typed.
  const rewritten = whereOfRewritten(
    "SELECT id FROM ai_gateway_messages WHERE id IN (SELECT id FROM other WHERE message_created_at >= '2026-08-18T21:00:00Z')",
    registry
  )
  const inner = rewritten.where.subquery.where
  assert.equal(inner.right.type, 'literal', 'the inner scope has no TIMESTAMP columns to type against')
})

test('a CTE shadowing a dataset name does not borrow the dataset schema', () => {
  const registry = registryForMessages()
  const rewritten = whereOfRewritten(
    "WITH ai_gateway_messages AS (SELECT 1 AS message_created_at) " +
    "SELECT message_created_at FROM ai_gateway_messages WHERE message_created_at >= '2026-08-18T21:00:00Z'",
    registry
  )
  assert.equal(rewritten.query.where.right.type, 'literal')
})

// squirreling resolves a CTE reference case-insensitively (it keys its CTE
// plans by `name.toLowerCase()`), so the shadow check has to as well or the
// dataset's schema is borrowed for columns the CTE actually supplies.
test('a CTE shadows a dataset name whatever case it is written in', () => {
  const registry = registryForMessages()
  const rewritten = whereOfRewritten(
    "WITH Ai_Gateway_Messages AS (SELECT '2026-08-18' AS message_created_at) " +
    "SELECT message_created_at FROM ai_gateway_messages WHERE message_created_at >= '2026-08-18T21:00:00Z'",
    registry
  )
  assert.equal(rewritten.query.where.right.type, 'literal')
})

// A qualified reference resolves through its qualifier. A joined derived table
// can expose a column that shares a dataset column's name and not its type;
// typing it from the dataset would compare a string cell to a Date, which is
// false for every row - the silently-wrong answer this whole change exists to
// prevent, just pointed the other way.
test('a qualified reference to a derived table is not typed from the dataset', () => {
  const registry = registryForMessages()
  const rewritten = whereOfRewritten(
    'SELECT m.id FROM ai_gateway_messages m ' +
    'JOIN (SELECT id, date AS message_created_at FROM ai_gateway_messages) s ON m.id = s.id ' +
    "WHERE s.message_created_at >= '2026-08-18'",
    registry
  )
  assert.equal(rewritten.where.right.type, 'literal')
})

test('a qualified reference to the base table (by alias or name) is still typed', () => {
  const registry = registryForMessages()
  for (const qualifier of ['m', 'ai_gateway_messages']) {
    const rewritten = whereOfRewritten(
      `SELECT m.id FROM ai_gateway_messages m WHERE ${qualifier}.message_created_at >= '2026-08-18T21:00:00Z'`,
      registry
    )
    assert.equal(rewritten.where.right.type, 'cast', qualifier)
  }
})

// The same Date-against-string comparison is false for every row wherever it
// sits, so a bound outside WHERE fails the same silent way.
test('a comparison outside WHERE is typed too', async () => {
  const rows = await executeQuerySql({
    query:
      "SELECT id, CASE WHEN message_created_at >= '2026-08-18T21:00:00Z' THEN 1 ELSE 0 END AS recent " +
      'FROM ai_gateway_messages ORDER BY id',
    registry: registryForMessages(),
    storage,
  })
  assert.deepEqual(rows.rows.map((row) => Number(row.recent)), [0, 0, 1, 1])
})

// --- calls that carry a column's type ----------------------------------------

/**
 * A registry over two real parquet partitions, so a scope can hold relations
 * that disagree about a column's type and a correlated reference has somewhere
 * to resolve to.
 *
 * @param {{ name: string, columns: ColumnSpec[], rows: Record<string, SqlPrimitive>[] }[]} specs
 */
function registryForDatasets(specs) {
  const datasets = specs.map((spec) => ({
    name: spec.name,
    schema: { columns: spec.columns },
    discoverPartitions: async () => [],
    /** @returns {Promise<AsyncDataSource>} */
    createDataSource: async () => parquetSourceFromRows(spec.columns, spec.rows, { rowGroupSize: 2 }),
  }))
  return /** @type {any} */ ({
    getDataset: (/** @type {string} */ asked) => datasets.find((dataset) => dataset.name === asked),
    listDatasets: () => datasets,
  })
}

/** A second dataset that types the same two column names STRING, so nothing in scope agrees. */
/** @type {ColumnSpec[]} */
const NODE_COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'message_created_at', type: 'STRING', nullable: false },
  { name: 'seen_at', type: 'STRING', nullable: true },
]

const NODE_ROWS = [
  { id: 3, message_created_at: 'n3', seen_at: null },
  { id: 4, message_created_at: 'n4', seen_at: null },
]

function registryForBoth() {
  return registryForDatasets([
    { name: 'ai_gateway_messages', columns: COLUMNS, rows: ROWS },
    { name: 'node', columns: NODE_COLUMNS, rows: NODE_ROWS },
  ])
}

// `HAVING` almost always holds an aggregate rather than a bare column, and
// docs/ACCEPTANCE.md's own idiom is `max(message_created_at)`. A call whose
// result carries the column's type compares a Date to a string exactly as the
// bare column did, so the bound has to reach through it.
// @ref LLP 0272#scope [tests]: a bound on a type-preserving call is a bound on the column under it
test('a bound on a call that carries the column type selects the rows it names', async () => {
  /** @type {[string, number[]][]} */
  const cases = [
    // rows: 2026-08-17T09:00:00Z, 08-18T20:59:59Z, 08-18T21:00:00Z, 08-18T22:01:39Z
    ["SELECT id FROM ai_gateway_messages GROUP BY id HAVING max(message_created_at) >= '2026-08-18T21:00:00Z' ORDER BY id", [3, 4]],
    ["SELECT id FROM ai_gateway_messages GROUP BY id HAVING min(message_created_at) < '2026-08-18T21:00:00Z' ORDER BY id", [1, 2]],
    ["SELECT id FROM ai_gateway_messages WHERE coalesce(seen_at, message_created_at) >= '2026-08-18T21:00:00Z' ORDER BY id", [3, 4]],
    ["SELECT id FROM ai_gateway_messages WHERE date_trunc('day', message_created_at) = '2026-08-18' ORDER BY id", [2, 3, 4]],
    ["SELECT id FROM ai_gateway_messages WHERE greatest(seen_at, message_created_at) >= '2026-08-18T21:00:00Z' ORDER BY id", [3, 4]],
  ]
  /** @type {string[]} */
  const wrong = []
  for (const [query, expected] of cases) {
    const got = await ids(query)
    if (got.join(',') !== expected.join(',')) {
      wrong.push(`${query} -> got [${got.join(',')}], SQL says [${expected.join(',')}]`)
    }
  }
  assert.deepEqual(wrong, [])
})

// The other direction: a call whose result is not the column's type must not
// pull the coercion through it, and a call that types from one argument only
// must not type from the others. Both would coerce against the wrong column,
// which returns wrong rows rather than none.
test('a call that does not carry the column type leaves the literal alone', () => {
  const registry = registryForMessages()
  /** @type {[string, string][]} */
  const cases = [
    // EPOCH returns a number, not the column's type
    ["SELECT id FROM ai_gateway_messages WHERE epoch(message_created_at) >= '2026-08-18'", 'where'],
    // DATE_TRUNC's first argument is the unit, and MIN_BY takes only its first
    // argument's type, so the timestamp in the key position types nothing
    ["SELECT id FROM ai_gateway_messages GROUP BY id HAVING min_by(id, message_created_at) >= '2026-08-18'", 'having'],
    // a function nobody declared type-preserving
    ["SELECT id FROM ai_gateway_messages WHERE upper(message_created_at) >= '2026-08-18'", 'where'],
  ]
  for (const [sql, clause] of cases) {
    const rewritten = whereOfRewritten(sql, registry)
    assert.equal(rewritten[clause].right.type, 'literal', sql)
  }
  // ...while the same call with the column in the type-carrying position is typed
  const typed = whereOfRewritten(
    "SELECT id FROM ai_gateway_messages GROUP BY id HAVING min_by(message_created_at, id) >= '2026-08-18T21:00:00Z'",
    registry
  )
  assert.equal(typed.having.right.type, 'cast')
})

// --- scopes whose relations disagree, and correlated references --------------

// Two in-scope datasets that type every shared name differently leave nothing
// for an unqualified reference to agree on. That must not disable the
// qualified path: `m.message_created_at` names one relation and one type, and
// skipping it returns zero rows on matching data, which is issue #860 again.
test('a qualified reference is typed even when the in-scope datasets agree on nothing', async () => {
  const registry = registryForBoth()
  const sql =
    'SELECT m.id FROM ai_gateway_messages m JOIN node o ON m.id = o.id ' +
    "WHERE m.message_created_at >= '2026-08-18T21:00:00Z' ORDER BY m.id"
  assert.equal(whereOfRewritten(sql, registry).where.right.type, 'cast')
  const out = await executeQuerySql({ query: sql, registry, storage })
  assert.deepEqual(out.rows.map((row) => Number(row.id)), [3, 4])
  // and the STRING side of the same scope keeps its string comparison
  const other = whereOfRewritten(
    "SELECT m.id FROM ai_gateway_messages m JOIN node o ON m.id = o.id WHERE o.message_created_at >= 'n4'",
    registry
  )
  assert.equal(other.where.right.type, 'literal')
})

// A correlated reference resolves outward, so a bound written on the enclosing
// select's column from inside an EXISTS is a bound on a TIMESTAMP column. The
// inner FROM cannot name it, and leaving it a string is the silent empty
// result again.
// @ref LLP 0272#scope [tests]: a qualified reference resolves through its qualifier, outward
test('a correlated reference into the enclosing select is typed', async () => {
  const registry = registryForBoth()
  const sql =
    'SELECT m.id FROM ai_gateway_messages m WHERE EXISTS (' +
    "SELECT 1 FROM node o WHERE o.id = m.id AND m.message_created_at >= '2026-08-18T21:00:00Z') ORDER BY m.id"
  assert.equal(whereOfRewritten(sql, registry).where.subquery.where.right.right.type, 'cast')
  const out = await executeQuerySql({ query: sql, registry, storage })
  assert.deepEqual(out.rows.map((row) => Number(row.id)), [3, 4])
})

// The outward walk stops at the first relation the inner select binds, schema
// or not. An inner alias that shadows an enclosing one must keep its own
// (unknown) columns rather than borrow the enclosing relation's types.
test('an inner alias does not borrow an enclosing relation that shares its name', () => {
  const registry = registryForBoth()
  const rewritten = whereOfRewritten(
    'SELECT m.id FROM ai_gateway_messages m WHERE EXISTS (' +
    "SELECT 1 FROM (SELECT id, 'n' AS message_created_at FROM node) m WHERE m.message_created_at >= '2026-08-18')",
    registry
  )
  assert.equal(rewritten.where.subquery.where.right.type, 'literal')
})

// A relation in FROM or JOIN resolves entirely against its own tables: SQL
// gives it no view of the enclosing select, so it must not inherit one here
// either.
test('a derived table in FROM does not see the enclosing select scope', () => {
  const registry = registryForBoth()
  const rewritten = whereOfRewritten(
    'SELECT s.id FROM ai_gateway_messages m JOIN (' +
    "SELECT id FROM node WHERE m.message_created_at >= '2026-08-18T21:00:00Z') s ON m.id = s.id",
    registry
  )
  assert.equal(rewritten.joins[0].subquery.query.where.right.type, 'literal')
})

// --- relations the registry cannot name: CTEs and derived tables -------------

/**
 * A dataset that shares only `id` with the messages dataset, so an unqualified
 * name inside a subquery over it can only have come from the enclosing select.
 *
 * @type {ColumnSpec[]}
 */
const EDGE_COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'weight', type: 'DOUBLE', nullable: false },
]

const EDGE_ROWS = [
  { id: 1, weight: 1 },
  { id: 2, weight: 2 },
  { id: 3, weight: 3 },
  { id: 4, weight: 4 },
]

function registryForEdges() {
  return registryForDatasets([
    { name: 'ai_gateway_messages', columns: COLUMNS, rows: ROWS },
    { name: 'edge', columns: EDGE_COLUMNS, rows: EDGE_ROWS },
  ])
}

// LLP 0272 typed a bound only from a dataset schema, so a select whose FROM was
// a CTE or a derived table got no coercion and returned zero rows on matching
// data - issue #860's own failure, one relation further in. The columns are
// carried out of the inner select instead, so the bound lands the same way.
// @ref LLP 0280#carry [tests]: a bound on a CTE or derived table selects the same rows the base table's does
test('a string bound on a CTE or derived table column selects the rows it names', async () => {
  /** @type {[string, number[]][]} */
  const cases = [
    // rows: 2026-08-17T09:00:00Z, 08-18T20:59:59Z, 08-18T21:00:00Z, 08-18T22:01:39Z
    ["WITH c AS (SELECT * FROM ai_gateway_messages) SELECT id FROM c WHERE message_created_at >= '2026-08-18T21:00:00Z' ORDER BY id", [3, 4]],
    ["WITH c AS (SELECT id, message_created_at FROM ai_gateway_messages) SELECT id FROM c WHERE message_created_at < '2026-08-18T21:00:00Z' ORDER BY id", [1, 2]],
    // an alias renames the column, and the type follows the rename
    ["WITH c AS (SELECT id, message_created_at AS ts FROM ai_gateway_messages) SELECT id FROM c WHERE ts >= '2026-08-18T21:00:00Z' ORDER BY id", [3, 4]],
    // the derived-table spelling of the same thing, unqualified and qualified
    ["SELECT id FROM (SELECT * FROM ai_gateway_messages) t WHERE message_created_at >= '2026-08-18T21:00:00Z' ORDER BY id", [3, 4]],
    ["SELECT t.id FROM (SELECT * FROM ai_gateway_messages) t WHERE t.message_created_at >= '2026-08-18T21:00:00Z' ORDER BY t.id", [3, 4]],
    // a CTE over a CTE: the carry has to survive more than one hop
    ["WITH c AS (SELECT * FROM ai_gateway_messages), d AS (SELECT * FROM c) SELECT id FROM d WHERE message_created_at >= '2026-08-18T21:00:00Z' ORDER BY id", [3, 4]],
    // a set operation carries a column's type only when both sides agree on it
    ["SELECT id FROM (SELECT * FROM ai_gateway_messages UNION ALL SELECT * FROM ai_gateway_messages) t WHERE message_created_at >= '2026-08-18T21:00:00Z' ORDER BY id", [3, 3, 4, 4]],
    // every clause and shape the base-table case already covers
    ["WITH c AS (SELECT * FROM ai_gateway_messages) SELECT id FROM c GROUP BY id HAVING max(message_created_at) >= '2026-08-18T21:00:00Z' ORDER BY id", [3, 4]],
    ["WITH c AS (SELECT * FROM ai_gateway_messages) SELECT id FROM c WHERE message_created_at IN ('2026-08-18T21:00:00Z') ORDER BY id", [3]],
    ["WITH c AS (SELECT * FROM ai_gateway_messages) SELECT id FROM c WHERE message_created_at BETWEEN '2026-08-18T21:00:00Z' AND '2026-08-18T23:00:00Z' ORDER BY id", [3, 4]],
  ]
  /** @type {string[]} */
  const wrong = []
  for (const [query, expected] of cases) {
    const got = await ids(query)
    if (got.join(',') !== expected.join(',')) {
      wrong.push(`${query} -> got [${got.join(',')}], SQL says [${expected.join(',')}]`)
    }
  }
  assert.deepEqual(wrong, [])
})

// The other direction, which is the reason LLP 0272 declined to guess: an inner
// select can hand a dataset column's name to a value of another type, and
// typing that from the dataset would compare a string cell to a Date - zero
// rows again, pointed the other way.
// @ref LLP 0280#carry [tests]: the carried type is the inner expression's, never the dataset's
test('a CTE that renames another type onto a TIMESTAMP column name keeps its string comparison', async () => {
  assert.deepEqual(
    await ids(
      'WITH c AS (SELECT id, date AS message_created_at FROM ai_gateway_messages) ' +
      "SELECT id FROM c WHERE message_created_at >= '2026-08-18' ORDER BY id"
    ),
    [2, 3, 4]
  )
})

// An inner select the walk cannot read end to end supplies nothing at all,
// rather than a partial column list a later name could be mis-typed against.
// @ref LLP 0280#complete [tests]: a partially-readable inner select contributes no types
test('an inner select that cannot be read completely types nothing', () => {
  const registry = registryForMessages()
  /** @type {string[]} */
  const cases = [
    // `other` is not a registered dataset, so the CTE's own columns are unknown
    "WITH c AS (SELECT * FROM other) SELECT id FROM c WHERE message_created_at >= '2026-08-18T21:00:00Z'",
    // an output column with neither an alias nor a bare name cannot be placed
    // in the list, so the list is not a list
    'SELECT id FROM (SELECT id, message_created_at, upper(date) FROM ai_gateway_messages) t ' +
    "WHERE message_created_at >= '2026-08-18T21:00:00Z'",
    // a table function names columns this walk cannot enumerate
    'WITH c AS (SELECT * FROM unnest([1, 2])) SELECT id FROM c ' + "WHERE message_created_at >= '2026-08-18T21:00:00Z'",
  ]
  for (const sql of cases) {
    const rewritten = whereOfRewritten(sql, registry)
    const where = rewritten.type === 'with' ? rewritten.query.where : rewritten.where
    assert.equal(where.right.type, 'literal', sql)
  }
})

// LLP 0272 also named the unqualified correlated reference as a residual. It is
// not the same defect: the engine does not resolve an unqualified name into an
// enclosing select at all, so the query raises rather than returning zero rows,
// and it raises identically whether the literal is typed or bare. Typing it
// could not change the answer, which is why the rewrite leaves it alone.
// @ref LLP 0280#unqualified-correlated [tests]: the engine rejects the shape either way, so there is no silent answer to fix
test('an unqualified correlated reference is rejected by the engine, typed or bare', async () => {
  const registry = registryForEdges()
  for (const literal of ["TIMESTAMP '2026-08-18T21:00:00Z'", "'2026-08-18T21:00:00Z'"]) {
    await assert.rejects(
      executeQuerySql({
        query:
          'SELECT m.id FROM ai_gateway_messages m WHERE EXISTS (' +
          `SELECT 1 FROM edge e WHERE e.id = m.id AND message_created_at >= ${literal})`,
        registry,
        storage,
      }),
      /Column "message_created_at" not found/,
      literal
    )
  }
})

// A relation can expose one name twice: `select *` over a join expands both
// sides, and `ai_gateway_messages` and `node` disagree about
// `message_created_at`. Reading the first occurrence (or the union of the
// TIMESTAMP ones, which is what a qualified reference used to be answered
// from) types the bound against a column the engine does not hand it, and the
// bound goes silently empty on matching data - #860 again, one join in. A name
// whose occurrences disagree is therefore not a TIMESTAMP.
// @ref LLP 0280#complete [tests]: a name a relation exposes twice with two types is not typed
test('a name an inner select exposes twice with two types keeps its string comparison', async () => {
  const registry = registryForBoth()
  const joined = 'ai_gateway_messages m JOIN node n ON m.id = n.id'
  /** @type {[string, number[]][]} */
  const cases = [
    // the join exposes `message_created_at` as TIMESTAMP (m) and STRING (n);
    // the engine hands the outer select n's, whose values are 'n3' and 'n4'
    [`WITH c AS (SELECT * FROM ${joined}) SELECT c.id FROM c WHERE c.message_created_at >= '2026-08-18' ORDER BY c.id`, [3, 4]],
    [`WITH c AS (SELECT * FROM ${joined}) SELECT id FROM c WHERE message_created_at >= '2026-08-18' ORDER BY id`, [3, 4]],
    // and one hop further, where the ambiguous name is read by an inner
    // select's own expression rather than by the outer scope
    [
      `WITH c AS (SELECT * FROM ${joined}), d AS (SELECT id, message_created_at AS ts FROM c) ` +
      "SELECT id FROM d WHERE ts >= '2026-08-18' ORDER BY id",
      [3, 4],
    ],
  ]
  /** @type {string[]} */
  const wrong = []
  for (const [query, expected] of cases) {
    const out = await executeQuerySql({ query, registry, storage })
    const got = out.rows.map((row) => Number(row.id))
    if (got.join(',') !== expected.join(',')) {
      wrong.push(`${query} -> got [${got.join(',')}], SQL says [${expected.join(',')}]`)
    }
  }
  assert.deepEqual(wrong, [])
})

// The same shape, said loudly: a string bound the coercion cannot read is an
// error rather than an empty result (LLP 0272 #refuse-uncoercible). Typing an
// ambiguous name therefore does not just lose rows, it refuses a comparison
// that is a perfectly ordinary string one.
// @ref LLP 0280#complete [tests]: an ambiguous name does not turn a string bound into a refusal
test('an ambiguous name does not refuse a string bound that is not a timestamp', async () => {
  const registry = registryForBoth()
  const joined = 'ai_gateway_messages m JOIN node n ON m.id = n.id'
  const out = await executeQuerySql({
    query: `WITH c AS (SELECT * FROM ${joined}) SELECT c.id FROM c WHERE c.message_created_at >= 'n4' ORDER BY c.id`,
    registry,
    storage,
  })
  assert.deepEqual(out.rows.map((row) => Number(row.id)), [4])
})
