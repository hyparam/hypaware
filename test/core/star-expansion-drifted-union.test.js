// @ts-check

// Regression pins for LLP 0241: a scan must yield rows carrying the column
// list the scan advertises, so a star expansion cannot slide a later output
// name onto a neighbouring column's value.
//
// Every assertion here was written from a recorded run, not from reading the
// engine. On `origin/master` the shape below answered
// `SELECT *, gateway_id AS trailing` with the gateway_id value stored under
// the name `schema_version` (lone partition) or `git_remote` (the narrow half
// of a drifted union): a silently wrong answer, no error. The cell values are
// asserted by name with exact equality, because a row with the right SHAPE
// and the wrong occupant is exactly the failure being pinned.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collect, executeSql } from 'squirreling'

import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { alignRowColumns, unionSources } from '../../src/core/query/union-source.js'
import {
  createDataSource,
  DATASET_NAME,
  discoverParts,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @import { ColumnSpec, QueryScope } from '../../hypaware-plugin-kernel-types.js'
 * @import { AsyncDataSource, AsyncRow, SqlPrimitive } from 'squirreling/src/types.js'
 */

/** Columns every fixture partition carries. */
/** @type {ColumnSpec[]} */
const NARROW_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'gateway_id', type: 'STRING', nullable: true },
  { name: 'date', type: 'STRING', nullable: false },
]

/** The same plus `git_remote`, a real v7 capture column (LLP 0032). */
/** @type {ColumnSpec[]} */
const WIDE_COLUMNS = [...NARROW_COLUMNS, { name: 'git_remote', type: 'STRING', nullable: true }]

const REMOTE = 'git@example.com:acme/app.git'

/**
 * Stage an icebird-backed `ai_gateway_messages` cache and return the source a
 * query runs against.
 *
 * - `lone`: ONE partition whose iceberg schema never had `git_remote`, so
 *   `createDataSource` skips `unionSources` and only `withSchemaColumns`
 *   stands between the query and icebird.
 * - `drifted`: TWO partitions, one with `git_remote` and one without.
 *
 * @param {'lone' | 'drifted'} shape
 * @returns {Promise<{ cacheRoot: string, source: AsyncDataSource }>}
 */
async function stageFixture(shape) {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), `hyp-star-${shape}-`))
  await appendRowsToSourceTable(
    cacheRoot, DATASET_NAME, ['source=claude'],
    NARROW_COLUMNS, [{ id: 1, gateway_id: 'gw-narrow', date: '2026-05-26' }]
  )
  if (shape === 'drifted') {
    await appendRowsToSourceTable(
      cacheRoot, DATASET_NAME, ['source=codex'],
      WIDE_COLUMNS, [{ id: 2, gateway_id: 'gw-wide', date: '2026-05-27', git_remote: REMOTE }]
    )
  }
  const storage = createQueryStorageService({ cacheRoot })
  /** @type {QueryScope} */
  const scope = { limit: 1000 }
  const partitions = await discoverParts({ cacheDir: cacheRoot, scope, config: { version: 2 } })
  const source = await createDataSource(partitions, { scope, storage })
  return { cacheRoot, source }
}

/**
 * @param {'lone' | 'drifted'} shape
 * @param {(source: AsyncDataSource) => Promise<void>} body
 */
async function withFixture(shape, body) {
  const { cacheRoot, source } = await stageFixture(shape)
  try {
    await body(source)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
}

/**
 * Run a SELECT the way `hyp query sql` does, ordered by `id` so partition
 * scan order cannot make an assertion flap.
 *
 * @param {AsyncDataSource} source
 * @param {string} query
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function runSql(source, query) {
  const rows = await collect(executeSql({ tables: { t: source }, query }))
  return /** @type {Record<string, unknown>[]} */ (rows)
}

// --- the reported defect, at the SQL surface ---

test('star expansion: a trailing column keeps its own name over a lone drifted partition', async () => {
  await withFixture('lone', async (source) => {
    const rows = await runSql(source, 'SELECT *, gateway_id AS trailing FROM t ORDER BY id')
    assert.equal(rows.length, 1)
    assert.strictEqual(rows[0].trailing, 'gw-narrow', 'the aliased column holds its own value')
    assert.strictEqual(rows[0].gateway_id, 'gw-narrow', 'the star copy is unchanged')
    // Before the fix this held 'gw-narrow': the trailing column's value was
    // written under the name of the declared column sitting at the star's
    // (short) physical width.
    assert.strictEqual(rows[0].schema_version, undefined, 'no value slid into the neighbouring declared column')
  })
})

test('star expansion: a trailing column keeps its own name on both halves of a drifted union', async () => {
  await withFixture('drifted', async (source) => {
    const rows = await runSql(source, 'SELECT *, gateway_id AS trailing FROM t ORDER BY id')
    assert.equal(rows.length, 2)
    assert.strictEqual(rows[0].id, 1)
    assert.strictEqual(rows[0].trailing, 'gw-narrow')
    // The narrow partition's short row put 'gw-narrow' here before the fix.
    assert.strictEqual(rows[0].git_remote, undefined, 'the column the narrow partition lacks stays absent')
    assert.strictEqual(rows[0].schema_version, undefined)
    assert.strictEqual(rows[1].id, 2)
    assert.strictEqual(rows[1].trailing, 'gw-wide')
    assert.strictEqual(rows[1].git_remote, REMOTE, 'the wide partition still reads its own git_remote')
    // The wide partition's row was one column short of the declared list, so
    // 'gw-wide' landed here before the fix.
    assert.strictEqual(rows[1].schema_version, undefined)
  })
})

test('star expansion: SELECT *, git_remote reads git_remote, not a neighbour', async () => {
  // The exact shape reported in issue #788.
  await withFixture('drifted', async (source) => {
    const rows = await runSql(source, 'SELECT *, git_remote AS gr FROM t ORDER BY id')
    assert.equal(rows.length, 2)
    assert.strictEqual(rows[0].gr, undefined, 'the partition that predates the column reads no value')
    assert.strictEqual(rows[1].gr, REMOTE)
    // Before the fix the remote URL came back under `schema_version`.
    assert.strictEqual(rows[1].schema_version, undefined, 'the remote did not land in a neighbouring column')
    assert.strictEqual(rows[1].gateway_id, 'gw-wide', 'no declared column holds another column\'s value')
  })
})

test('star expansion: a literal beside a star does not crash over a drifted partition', async () => {
  // On master this threw `TypeError: asyncRow.cells[k] is not a function`,
  // the same misalignment surfacing as a crash instead of a wrong value.
  await withFixture('lone', async (source) => {
    const rows = await runSql(source, 'SELECT *, 1 AS lit FROM t')
    assert.equal(rows.length, 1)
    assert.strictEqual(rows[0].lit, 1)
    assert.strictEqual(rows[0].id, 1)
  })
})

test('star expansion: a bare star still renders only the columns a partition holds', async () => {
  // Padding must not change what a plain `SELECT *` shows: an absent column
  // resolves to undefined, which JSON drops exactly as it did before.
  await withFixture('drifted', async (source) => {
    const rows = await runSql(source, 'SELECT * FROM t ORDER BY id')
    assert.equal(JSON.stringify(rows[0]), '{"id":1,"gateway_id":"gw-narrow","date":"2026-05-26"}')
    assert.equal(
      JSON.stringify(rows[1]),
      `{"id":2,"gateway_id":"gw-wide","date":"2026-05-27","git_remote":${JSON.stringify(REMOTE)}}`
    )
  })
})

test('a clause above the scan reads a column some partition lacks without throwing', async () => {
  // Padding is wider than the star expansion that motivated it. A `WHERE` the
  // union could not push down, or an `ORDER BY`, is evaluated above the scan
  // and reads the column off `row.cells`; on master that lookup missed on the
  // narrow partition's short row and raised
  // `ColumnNotFoundError: Column "git_remote" not found. Available columns:
  // id, gateway_id, date (row 1)`. LLP 0015 already required that a union
  // never throws here, so this pins the recorded before/after.
  // The star matters: only a star scan carries no `columns` hint, so only a
  // star leaves the partition free to yield a row narrower than the clause
  // needs. `SELECT id FROM t WHERE git_remote IS NULL` hints both columns and
  // never reproduced this.
  await withFixture('drifted', async (source) => {
    const isNull = await runSql(source, 'SELECT * FROM t WHERE git_remote IS NULL ORDER BY id')
    assert.deepEqual(isNull.map((r) => r.id), [1], 'only the partition lacking the column matches IS NULL')

    const noMatch = await runSql(source, "SELECT * FROM t WHERE git_remote = 'zzz' ORDER BY id")
    assert.deepEqual(noMatch, [], 'a predicate no row satisfies answers empty, it does not throw')

    const ordered = await runSql(source, 'SELECT * FROM t ORDER BY git_remote')
    assert.deepEqual(ordered.map((r) => r.id).sort(), [1, 2], 'ordering by the drifted column keeps every row')
  })
})

// --- the same defect at the core union, independent of icebird ---

/**
 * A minimal source that declares `columns` but yields rows carrying only the
 * keys each object actually has, which is what a drifted partition does.
 *
 * @param {string[]} columns
 * @param {Record<string, SqlPrimitive>[]} objects
 * @returns {AsyncDataSource}
 */
function narrowSource(columns, objects) {
  return {
    columns,
    numRows: objects.length,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (const obj of objects) {
            const keys = Object.keys(obj)
            /** @type {Record<string, () => Promise<SqlPrimitive>>} */
            const cells = {}
            for (const key of keys) cells[key] = () => Promise.resolve(obj[key])
            yield { columns: keys, cells, resolved: obj }
          }
        },
      }
    },
  }
}

test('union: a partition missing a unioned column still yields the union column list', async () => {
  const union = unionSources([
    narrowSource(['a', 'b'], [{ a: 1, b: 2 }]),
    narrowSource(['a', 'b', 'c'], [{ a: 3, b: 4, c: 5 }]),
  ])
  assert.deepEqual(union.columns, ['a', 'b', 'c'])
  const rows = await runSql(union, 'SELECT *, b AS trailing FROM t ORDER BY a')
  assert.equal(rows.length, 2)
  // Before the fix the first row's `b` value (2) came back as `c`.
  assert.strictEqual(rows[0].trailing, 2)
  assert.strictEqual(rows[0].c, undefined, 'the column the first partition lacks stays absent')
  assert.strictEqual(rows[1].trailing, 4)
  assert.strictEqual(rows[1].c, 5)
})

test('union: a star renders keys in the advertised order, not each partition physical order', async () => {
  // Carrying the advertised list means carrying its ORDER, not just its
  // membership. Recorded run: before the fix the second partition's row came
  // back as {"b":4,"a":3}, which disagreed with the ["a","b"] that
  // QueryResults.columns had already reported for the same query.
  const union = unionSources([
    narrowSource(['a', 'b'], [{ a: 1, b: 2 }]),
    narrowSource(['b', 'a'], [{ b: 4, a: 3 }]),
  ])
  assert.deepEqual(union.columns, ['a', 'b'])
  const rows = await runSql(union, 'SELECT * FROM t ORDER BY a')
  assert.deepEqual(rows.map((r) => Object.keys(r)), [['a', 'b'], ['a', 'b']])
  assert.deepEqual(rows, [{ a: 1, b: 2 }, { a: 3, b: 4 }], 'reordering keys moved no value')
})

// --- the alignment helper itself ---

test('alignRowColumns: pads a short row and leaves an already-aligned row untouched', async () => {
  /** @type {AsyncRow} */
  const short = {
    columns: ['a', 'b'],
    cells: { a: () => Promise.resolve(1), b: () => Promise.resolve(2) },
    resolved: { a: 1, b: 2 },
  }
  const padded = alignRowColumns(short, ['a', 'b', 'c'])
  assert.deepEqual(padded.columns, ['a', 'b', 'c'])
  assert.strictEqual(await padded.cells.a(), 1)
  assert.strictEqual(await padded.cells.b(), 2)
  assert.strictEqual(await padded.cells.c(), undefined, 'the padded cell exists and reads undefined')
  assert.deepEqual(padded.resolved, { a: 1, b: 2 }, 'resolved keeps only the values the row really had')

  const aligned = alignRowColumns(short, ['a', 'b'])
  assert.strictEqual(aligned, short, 'an already-aligned row is returned as-is, not rebuilt')
})
