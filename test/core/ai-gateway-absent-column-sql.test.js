// @ts-check

// SQL-surface pins for the icebird-backed absent-column contract of
// `ai_gateway_messages` (LLP 0240). Every assertion here was derived by
// running the query and recording what came back, not by reading the code:
// five successive from-the-code descriptions of this mechanism were each
// measured wrong during PR #740's review. The values are asserted exactly
// (`strictEqual` against `null` / `undefined`, key presence, the JSON
// rendering) rather than through a tolerant `?? null`, because the whole
// point is which of those it is.
//
// `test/core/ai-gateway-dataset.test.js` pins the raw `scan()` rows and the
// `scanColumn()` chunks. This file pins what a user actually types: a full
// SELECT through `executeSql` + `collect`, the pair `hyp query sql` runs.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collect, executeSql } from 'squirreling'

import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import {
  createDataSource,
  DATASET_NAME,
  discoverParts,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @import { ColumnSpec, QueryScope } from '../../hypaware-plugin-kernel-types.js'
 * @import { AsyncDataSource, ExprNode } from 'squirreling/src/types.js'
 */

/** Two columns every fixture partition carries. */
/** @type {ColumnSpec[]} */
const NARROW_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
]

/** The same plus `git_remote`, a real v7 capture column (LLP 0032). */
/** @type {ColumnSpec[]} */
const WIDE_COLUMNS = [...NARROW_COLUMNS, { name: 'git_remote', type: 'STRING', nullable: true }]

const REMOTE = 'git@example.com:acme/app.git'

/**
 * Stage an icebird-backed `ai_gateway_messages` cache and return the dataset
 * source a query would run against.
 *
 * `shape` picks the drift:
 * - `lone`: ONE partition whose iceberg schema never had `git_remote`. This
 *   is the shape that skips `unionSources` entirely (`createDataSource`
 *   returns `withSchemaColumns(sources[0])`), so nothing but the wrapper
 *   stands between the query and icebird.
 * - `drifted`: TWO partitions, one with `git_remote` and one without, joined
 *   by `unionSources`.
 *
 * @param {'lone' | 'drifted'} shape
 * @returns {Promise<{ cacheRoot: string, source: AsyncDataSource }>}
 */
async function stageFixture(shape) {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), `hyp-absent-col-${shape}-`))
  await appendRowsToSourceTable(
    cacheRoot, DATASET_NAME, ['source=claude'],
    NARROW_COLUMNS, [{ id: 1, date: '2026-05-26' }]
  )
  if (shape === 'drifted') {
    await appendRowsToSourceTable(
      cacheRoot, DATASET_NAME, ['source=codex'],
      WIDE_COLUMNS, [{ id: 2, date: '2026-05-27', git_remote: REMOTE }]
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
 * Run a SELECT the way `hyp query sql` does and return the collected rows,
 * ordered by `id` so partition scan order can't make an assertion flap.
 *
 * @param {AsyncDataSource} source
 * @param {string} query
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function runSql(source, query) {
  const rows = await collect(executeSql({ tables: { t: source }, query }))
  return /** @type {Record<string, unknown>[]} */ (rows)
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

// --- what the wrapper makes addressable at all ---

test('absent column: an icebird source advertises the declared column it physically lacks', async () => {
  await withFixture('lone', async (source) => {
    assert.ok(source.columns.includes('git_remote'), 'declared v7 column is addressable')
    assert.ok(source.columns.includes('id'), 'physical column is addressable')
    // Without this the SELECTs below would fail in validateScan, not in the
    // scan: the contract only becomes interesting because planning succeeds.
    assert.equal(typeof source.scanColumn, 'function', 'the column-stream hook survives the wrapper')
  })
})

// --- the two read paths yield DIFFERENT values ---

test('absent column: a single-column bare projection reads null (scanColumn fast path)', async () => {
  // The engine routes a scan whose hint set is exactly one column through
  // `scanColumn` (squirreling execute.js gates on `columns?.length === 1`,
  // with no aggregate required), and `withSchemaColumns` normalizes the
  // hole to null on that path. So this yields null, and RENDERS as null.
  await withFixture('lone', async (source) => {
    const rows = await runSql(source, 'SELECT git_remote FROM t')
    assert.equal(rows.length, 1)
    assert.ok('git_remote' in rows[0])
    assert.strictEqual(rows[0].git_remote, null, 'single-column projection reads null, not undefined')
    assert.equal(JSON.stringify(rows[0]), '{"git_remote":null}', 'null survives JSON rendering')
  })
})

test('absent column: an aliased single-column projection is still the null path', async () => {
  await withFixture('lone', async (source) => {
    const rows = await runSql(source, 'SELECT git_remote AS gr FROM t')
    assert.deepEqual(rows.map((r) => r.gr), [null])
  })
})

test('absent column: a non-identifier sibling does NOT change the value or throw', async () => {
  // Recorded because the natural prediction is the opposite. On the parquet
  // union a literal sibling collapses the resolveable fast path and the
  // drifted column's thunk throws. Here it does not: the hint set is still
  // the single column `git_remote` (a literal reads no column), so the query
  // stays on the `scanColumn` path and still reads null.
  await withFixture('lone', async (source) => {
    const rows = await runSql(source, 'SELECT git_remote, 1 AS n FROM t')
    assert.equal(rows.length, 1)
    assert.strictEqual(rows[0].git_remote, null)
    assert.equal(rows[0].n, 1)
  })
})

test('absent column: a multi-column bare projection reads undefined and JSON drops the key', async () => {
  // Two hint columns take the row path instead. icebird builds the row with
  // `asyncRow(obj, requestedColumns)`, so the cell EXISTS but resolves to
  // undefined, and the pre-materialized `resolved` map `collect()` reads
  // simply has no entry. The key is present on the output row with the value
  // undefined, which `JSON.stringify` omits.
  await withFixture('lone', async (source) => {
    const rows = await runSql(source, 'SELECT id, git_remote FROM t')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 1)
    assert.ok('git_remote' in rows[0], 'the key is present on the row')
    assert.strictEqual(rows[0].git_remote, undefined, 'multi-column projection reads undefined, not null')
    assert.equal(JSON.stringify(rows[0]), '{"id":1}', 'JSON.stringify drops the undefined key')
  })
})

test('absent column: a WHERE on a present column pushes the projection onto the row path', async () => {
  // The trap this pins: the query LOOKS like the single-column null case,
  // but the predicate's column joins the hint set, making it two, so the
  // same SELECT list reads undefined instead of null. Nothing about the
  // projection changed.
  await withFixture('lone', async (source) => {
    const rows = await runSql(source, "SELECT git_remote FROM t WHERE date >= '2026-01-01'")
    assert.equal(rows.length, 1)
    assert.strictEqual(rows[0].git_remote, undefined)
    assert.equal(JSON.stringify(rows[0]), '{}')
  })
})

test('absent column: SELECT * omits the key entirely for the partition that lacks it', async () => {
  await withFixture('drifted', async (source) => {
    const rows = (await runSql(source, 'SELECT * FROM t')).sort((a, b) => Number(a.id) - Number(b.id))
    assert.equal(rows.length, 2)
    assert.equal('git_remote' in rows[0], false, 'star keeps each partition\'s own row shape')
    assert.equal(rows[1].git_remote, REMOTE)
  })
})

// --- nothing on this path throws ---

test('absent column: evaluating, ordering, grouping and aggregating never throw on icebird', async () => {
  // The parquet-backed union throws `ColumnNotFoundError` for these, because
  // its rows carry no cell for the column at all. icebird's do (a thunk that
  // resolves to undefined), so every one of these answers instead. This is
  // the single sharpest difference between the two backings.
  await withFixture('lone', async (source) => {
    assert.deepEqual(await runSql(source, "SELECT git_remote || 'x' AS e FROM t"), [{ e: null }])
    assert.deepEqual(await runSql(source, 'SELECT id FROM t ORDER BY git_remote'), [{ id: 1 }])
    assert.deepEqual(await runSql(source, 'SELECT DISTINCT git_remote FROM t'), [{ git_remote: null }])
    assert.deepEqual(
      await runSql(source, 'SELECT git_remote, COUNT(*) AS n FROM t GROUP BY git_remote'),
      [{ git_remote: null, n: 1 }]
    )
    assert.deepEqual(await runSql(source, 'SELECT COUNT(git_remote) AS n FROM t'), [{ n: 0 }])
    assert.deepEqual(await runSql(source, 'SELECT MAX(git_remote) AS m FROM t'), [{ m: null }])
  })
})

// --- predicates on the absent column answer correctly ---

test('absent column: a lone icebird partition answers predicates on the column it lacks', async () => {
  // Regression pin. `withSchemaColumns.scan` used to forward the predicate
  // verbatim; icebird converted it to a hyparquet filter over a column its
  // schema never had, filtered nothing, and still reported
  // `appliedWhere: true`, so the engine trusted the unfiltered stream and
  // BOTH of these returned the row. The union's own gate hid it, so only a
  // single-partition cache (a fresh install with one client) was affected.
  // @ref LLP 0240#where-gate [tests]: an ungated row-path where made a lone icebird partition answer predicates on an absent column wrongly
  await withFixture('lone', async (source) => {
    assert.deepEqual(await runSql(source, "SELECT id FROM t WHERE git_remote = 'zzz'"), [])
    assert.deepEqual(await runSql(source, 'SELECT id FROM t WHERE git_remote IS NOT NULL'), [])
    assert.deepEqual(await runSql(source, 'SELECT id FROM t WHERE git_remote IS NULL'), [{ id: 1 }])
    assert.deepEqual(await runSql(source, 'SELECT COUNT(*) AS n FROM t WHERE git_remote IS NULL'), [{ n: 1 }])
    assert.deepEqual(await runSql(source, "SELECT COUNT(*) AS n FROM t WHERE git_remote = 'zzz'"), [{ n: 0 }])
  })
})

test('absent column: the wrapper reports appliedWhere false for a predicate it had to strip', async () => {
  // The flag is what the engine trusts; assert it directly so a regression
  // shows up as a flag, not only as a wrong row count.
  await withFixture('lone', async (source) => {
    /** @type {ExprNode} */
    const where = {
      type: 'binary',
      op: '=',
      left: { type: 'identifier', name: 'git_remote', positionStart: 0, positionEnd: 0 },
      right: { type: 'literal', value: 'zzz', positionStart: 0, positionEnd: 0 },
      positionStart: 0,
      positionEnd: 0,
    }
    const stripped = source.scan({ columns: ['id', 'git_remote'], where, limit: 1 })
    assert.equal(stripped.appliedWhere, false, 'a predicate on a physically absent column is not claimed')
    assert.equal(stripped.appliedLimitOffset, false, 'the slice is handed back with the filter')

    // A predicate the partition CAN satisfy is still pushed and claimed, so
    // the gate does not cost the ordinary filtered read its pushdown.
    /** @type {ExprNode} */
    const pushable = {
      type: 'binary',
      op: '=',
      left: { type: 'identifier', name: 'id', positionStart: 0, positionEnd: 0 },
      right: { type: 'literal', value: 1, positionStart: 0, positionEnd: 0 },
      positionStart: 0,
      positionEnd: 0,
    }
    assert.equal(source.scan({ columns: ['id'], where: pushable }).appliedWhere, true)
  })
})

// --- the drifted union: present values are untouched ---

test('absent column: a drifted union reads real values alongside the holes', async () => {
  await withFixture('drifted', async (source) => {
    const bare = (await runSql(source, 'SELECT git_remote FROM t'))
      .map((r) => r.git_remote).sort()
    assert.deepEqual(bare, [REMOTE, null], 'the hole is null on the single-column path, the value is intact')

    const pair = (await runSql(source, 'SELECT id, git_remote FROM t'))
      .sort((a, b) => Number(a.id) - Number(b.id))
    assert.strictEqual(pair[0].git_remote, undefined, 'the hole is undefined on the row path')
    assert.equal(pair[1].git_remote, REMOTE)

    assert.deepEqual(await runSql(source, 'SELECT id FROM t WHERE git_remote IS NOT NULL'), [{ id: 2 }])
    assert.deepEqual(await runSql(source, 'SELECT id FROM t WHERE git_remote IS NULL'), [{ id: 1 }])
    assert.deepEqual(await runSql(source, 'SELECT COUNT(git_remote) AS n FROM t'), [{ n: 1 }])
    assert.deepEqual(await runSql(source, 'SELECT MAX(git_remote) AS m FROM t'), [{ m: REMOTE }])
  })
})

test('absent column: a present column is unaffected on either path', async () => {
  // The control. If these ever drift, the assertions above are measuring the
  // fixture rather than the contract.
  await withFixture('drifted', async (source) => {
    const ids = (await runSql(source, 'SELECT id FROM t')).map((r) => r.id).sort()
    assert.deepEqual(ids, [1, 2])
    const pairs = (await runSql(source, 'SELECT id, date FROM t'))
      .sort((a, b) => Number(a.id) - Number(b.id))
    assert.deepEqual(pairs, [{ id: 1, date: '2026-05-26' }, { id: 2, date: '2026-05-27' }])
  })
})
