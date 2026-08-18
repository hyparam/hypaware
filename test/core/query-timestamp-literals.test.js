// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { parseSql } from 'squirreling'

import { executeQuerySql } from '../../src/core/query/sql.js'
import {
  TimestampLiteralError,
  coerceTimestampLiterals,
} from '../../src/core/query/timestamp-literals.js'
import { parquetSourceFromRows } from '../helpers/parquet_source_fixture.js'

/**
 * @import { AsyncDataSource } from 'squirreling/src/types.js'
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
