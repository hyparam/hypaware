// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { parquetMetadataAsync } from 'hyparquet'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { icebergDataSource, loadLatestFileCatalogMetadata } from 'icebird'
import { collect, executeSql, parseSql } from 'squirreling'

import { appendRowsToTable, dataSourceForTable } from '../../src/core/cache/iceberg/store.js'
import { createLocalIcebergIO, tableUrlForDir } from '../../src/core/cache/iceberg/resolver.js'
import { withSqlCorrectWhere } from '../../src/core/query/iceberg-source.js'
import { parquetDataSource } from '../../src/core/query/parquet-source.js'
import { rowsToColumnSources } from '../../hypaware-core/plugins-workspace/format-parquet/src/columns.js'

/**
 * @import { AsyncBuffer } from 'hyparquet'
 * @import { AsyncDataSource, ExprNode, ScanColumnResults, SelectStatement, SqlPrimitive } from 'squirreling/src/types.js'
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

// The same fixture `test/core/parquet-source.test.js` uses, so the two
// backends are asked identical questions over identical data: `ts` straddles a
// bound with NULLs either side, `neg` is the same shape with negative values
// (where a NULL coerced to 0 sails past `>`), `label` proves it for strings.
/** @type {ColumnSpec[]} */
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
 * Every predicate below, with the rows SQL's three-valued logic selects. The
 * cache (Iceberg) path and the parquet-file path must both return exactly
 * this, and the same rows as each other -- except a case marked `bounded`,
 * where the kernel converter (`whereToParquetFilter`) declines the predicate
 * (a CAST/typed-literal operand it can't read a literal out of) but icebird's
 * own converter still folds it and keeps forwarding `where` as a pruning
 * hint (LLP 0221#pruning-hint). The wrapper then claims `appliedWhere: false`
 * and hands the rows icebird's filter already let through back to the
 * engine's own two-valued WHERE. That is sound (icebird's filter never drops
 * a SQL-TRUE row, LLP 0221#pruning-hint) but not exact: the cache answer is
 * only guaranteed to sit between SQL's answer and the parquet path's
 * unpruned one, per LLP 0221#consequences, so a `bounded` case asserts
 * `SQL ⊆ cache ⊆ parquet` rather than equality.
 *
 * @type {[string, number[], { bounded?: boolean }?][]}
 */
const PARITY_CASES = [
  // --- comparison against a NULL literal ------------------------------------
  // icebird converts these to `IS NULL` semantics: `{ts: {$eq: null}}` returns
  // the NULL rows and `{ts: {$ne: null}}` the non-NULL ones. SQL says a
  // comparison with NULL is UNKNOWN for every row, and `NOT UNKNOWN` is still
  // UNKNOWN, so no row is ever TRUE.
  ['ts = NULL', []],
  ['NOT (ts = NULL)', []],
  ['ts != NULL', []],
  ['NOT (ts != NULL)', []],
  ['ts < NULL', []],
  ['NULL >= ts', []],
  ['NOT NOT (ts = NULL)', []],
  ['label = NULL', []],
  ['NOT (label = NULL)', []],
  ['ts BETWEEN NULL AND 500', []],
  ['ts NOT IN (300, NULL)', []],
  ['ts IN (300, NULL)', [3]],
  ['ts IN (NULL)', []],
  // A never-match leaf must not swallow its sibling.
  ['NOT (ts = NULL AND ts = 300)', [1, 5]],
  ['ts = NULL OR ts = 300', [3]],

  // --- unguarded inequalities over a nullable column ------------------------
  // icebird pushes a bare `{neg: {$gt: -400}}`; hyparquet compares with raw
  // JavaScript operators, which coerce a NULL column value to 0, so every
  // NULL row is > any negative bound.
  ['neg > -400', [3, 5]],
  ['neg >= -300', [3, 5]],
  ['neg < -400', [1]],
  ['neg <= -500', [1]],
  ['neg != -300', [1, 5]],
  ['ts != 300', [1, 5]],
  ['ts <= 300', [1, 3]],
  ['ts > 300', [5]],
  ['ts NOT IN (300)', [1, 5]],
  ["label != 'c'", [1, 5]],
  ["label >= 'c'", [3, 5]],
  ['NOT (ts > 300)', [1, 3]],
  ['NOT (ts = 300)', [1, 5]],

  // --- negated OR -----------------------------------------------------------
  // icebird wraps a negated OR in `$nor`, a two-valued complement: "no child
  // matched" reads as a match, so a row UNKNOWN for every disjunct is
  // returned. The NULL rows are UNKNOWN for both disjuncts here and neither
  // bare bound happens to catch them.
  ['NOT (ts > 300 OR ts > 400)', [1, 3]],
  ["NOT (label > 'c' OR label > 'd')", [1, 3]],
  ['NOT (neg < -400 OR neg < -600)', [3, 5]],
  ['NOT (ts = 100 OR ts = 300)', [5]],
  ['NOT (ts IS NULL OR ts > 300)', [1, 3]],
  ['NOT (ts >= 300 OR ts <= 100)', []],

  // --- shapes that must keep working ---------------------------------------
  ['ts IS NULL', [2, 4]],
  ['ts IS NOT NULL', [1, 3, 5]],
  ['ts >= 100 AND ts <= 300', [1, 3]],
  ['ts IN (300, 500)', [3, 5]],
  ['id > 2', [3, 4, 5]],
  // predicates neither converter takes: the engine owns them on both paths
  ["label LIKE 'a%'", [1]],
  ["label LIKE 'a%' OR ts > 300", [1, 5]],

  // --- a predicate the kernel converter declines (CAST/typed literal) ------
  // `whereToParquetFilter` only reads a literal straight off a comparison
  // operand (`extractColumnAndValue`), so a `CAST(... AS BIGINT)` operand
  // makes it decline, unlike the bare `neg > -400` case above. icebird's own
  // converter still folds the CAST and pushes the same unguarded `$gt`, so
  // the pruning hint carries the same NULL-coercion behavior either way; the
  // difference is that a declined predicate additionally gets re-judged by
  // the engine's own two-valued WHERE, which is NULL-correct for this
  // (non-negated) shape. `bounded` still applies: this is a `SQL ⊆ cache ⊆
  // parquet` case that happens to land on equality, not a guarantee that it
  // always will.
  ['neg > CAST(-400 AS BIGINT)', [3, 5], { bounded: true }],
]

/**
 * @param {number[]} inner
 * @param {number[]} outer
 * @returns {boolean}
 */
function isSubset(inner, outer) {
  const have = new Set(outer)
  return inner.every((id) => have.has(id))
}

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-iceberg-parity-${prefix}-`))
}

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
 * The parquet-file backend over the fixture, at the small row-group size the
 * differential harness uses so multi-row-group iteration is exercised.
 *
 * @returns {Promise<AsyncDataSource>}
 */
async function makeParquetSource() {
  const columnData = rowsToColumnSources(NULLABLE_COLUMNS, NULLABLE_ROWS)
  const arrayBuffer = parquetWriteBuffer({ columnData, codec: 'SNAPPY', rowGroupSize: 2 })
  const file = asyncBufferFromBytes(new Uint8Array(arrayBuffer))
  return parquetDataSource(file, await parquetMetadataAsync(file))
}

/**
 * The Iceberg cache backend over the same rows, through the same
 * `dataSourceForTable` seam `hyp query sql` reaches.
 *
 * @param {string} tablePath
 * @returns {Promise<AsyncDataSource>}
 */
async function makeIcebergSource(tablePath) {
  await appendRowsToTable(tablePath, NULLABLE_COLUMNS, NULLABLE_ROWS)
  const source = await dataSourceForTable(tablePath)
  assert.ok(source, 'expected a committed iceberg table')
  return source
}

/**
 * @param {AsyncDataSource} source
 * @param {string} predicate
 * @returns {Promise<number[]>}
 */
async function idsFor(source, predicate) {
  const rows = await collect(executeSql({
    tables: { t: source },
    query: `SELECT id FROM t WHERE ${predicate}`,
  }))
  return rows.map((r) => Number(r.id))
}

test('cache and parquet backends answer NULL predicates identically (issue #744)', async () => {
  const dir = await makeTmpDir('corpus')
  try {
    const iceberg = await makeIcebergSource(path.join(dir, 'table'))
    /** @type {string[]} */
    const wrong = []
    for (const [predicate, expected, opts] of PARITY_CASES) {
      const cacheIds = await idsFor(iceberg, predicate)
      const parquetIds = await idsFor(await makeParquetSource(), predicate)
      if (opts?.bounded) {
        // A declined predicate is only guaranteed SQL ⊆ cache ⊆ parquet
        // (LLP 0221#consequences), not cache === parquet.
        if (!isSubset(expected, cacheIds)) {
          wrong.push(`WHERE ${predicate} -> cache [${cacheIds.join(',')}] does not contain SQL's answer [${expected.join(',')}]`)
        }
        if (!isSubset(cacheIds, parquetIds)) {
          wrong.push(`WHERE ${predicate} -> cache [${cacheIds.join(',')}] is not a subset of parquet [${parquetIds.join(',')}]`)
        }
        continue
      }
      if (cacheIds.join(',') !== expected.join(',')) {
        wrong.push(`WHERE ${predicate} -> cache [${cacheIds.join(',')}], SQL says [${expected.join(',')}]`)
      }
      if (parquetIds.join(',') !== cacheIds.join(',')) {
        wrong.push(`WHERE ${predicate} -> cache [${cacheIds.join(',')}], parquet [${parquetIds.join(',')}]`)
      }
    }
    assert.deepEqual(wrong, [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// The predicate reaches an aggregate through `scanColumn`, a different code
// path with its own filter conversion in icebird (`icebergDataSource.js`
// converts twice). A COUNT over the same corpus must agree with the row count.
test('filtered aggregates take the same NULL semantics as the row scan (issue #744)', async () => {
  const dir = await makeTmpDir('aggregate')
  try {
    const iceberg = await makeIcebergSource(path.join(dir, 'table'))
    /** @type {[string, number][]} */
    const cases = [
      ['ts = NULL', 0],
      ['NOT (ts = NULL)', 0],
      ['ts NOT IN (300, NULL)', 0],
      ['ts > 300', 1],
      ['ts != 300', 2],
      ['NOT (ts > 300 OR ts > 400)', 2],
    ]
    /** @type {string[]} */
    const wrong = []
    for (const [predicate, expected] of cases) {
      const rows = await collect(executeSql({
        tables: { t: iceberg },
        query: `SELECT COUNT(ts) AS n FROM t WHERE ${predicate}`,
      }))
      const got = Number(rows[0].n)
      if (got !== expected) wrong.push(`COUNT WHERE ${predicate} -> ${got}, SQL says ${expected}`)
    }
    assert.deepEqual(wrong, [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// The column stream is a second conversion site inside icebird
// (`icebergDataSource.scanColumn` converts the predicate again) and the
// engine's filtered-aggregate fast path, so it has to be both NULL-correct and
// still claiming `appliedWhere` (LLP 0098). Both shapes are exercised: a
// predicate over the streamed column, and one over another column.
test('the cache column stream is NULL-correct and still claims the predicate', async () => {
  const dir = await makeTmpDir('scan-column')
  try {
    const iceberg = await makeIcebergSource(path.join(dir, 'table'))
    const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (iceberg.scanColumn)

    // Same column as the stream.
    const sameColumn = await drainColumn(scanColumn({
      column: 'ts',
      where: whereOf('SELECT ts FROM t WHERE NOT (ts = NULL)'),
    }))
    assert.equal(sameColumn.appliedWhere, true)
    assert.deepEqual(sameColumn.values, [])

    // Another column: the stream cannot carry the predicate's column, so the
    // wrapper reads rows and projects the streamed column back out. It must
    // still claim the predicate, or the engine falls back to materializing a
    // row per value.
    const crossColumn = await drainColumn(scanColumn({
      column: 'id',
      where: whereOf('SELECT id FROM t WHERE neg > -400'),
    }))
    assert.equal(crossColumn.appliedWhere, true)
    assert.deepEqual(crossColumn.values.map(Number).sort((a, b) => a - b), [3, 5])

    const declined = await drainColumn(scanColumn({
      column: 'id',
      where: whereOf("SELECT id FROM t WHERE label LIKE 'a%'"),
    }))
    assert.equal(declined.appliedWhere, false)
    assert.equal(declined.values.length, 5)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// `appliedWhere` is load-bearing: the engine never re-judges a claimed
// predicate (LLP 0098). A predicate the kernel converter declines must leave
// the flag false rather than inherit icebird's claim, and a predicate it owns
// must claim both flags it really applied.
test('the cache source claims appliedWhere only for a predicate it applied', async () => {
  const dir = await makeTmpDir('flags')
  try {
    const iceberg = await makeIcebergSource(path.join(dir, 'table'))
    const owned = iceberg.scan({
      columns: ['id', 'ts'],
      where: whereOf('SELECT id FROM t WHERE ts > 300'),
    })
    assert.equal(owned.appliedWhere, true)
    // LIKE has no parquet-filter equivalent in either converter.
    const declined = iceberg.scan({
      columns: ['id', 'label'],
      where: whereOf("SELECT id FROM t WHERE label LIKE 'a%'"),
    })
    assert.equal(declined.appliedWhere, false)
    assert.equal(declined.appliedLimitOffset, false)
    // A predicate on a column the projection does not carry cannot be matched
    // row-side, so the wrapper declines rather than answering on `undefined`.
    const unprojected = iceberg.scan({
      columns: ['id'],
      where: whereOf('SELECT id FROM t WHERE ts > 300'),
    })
    assert.equal(unprojected.appliedWhere, false)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// LIMIT rides on top of the wrapper's own filter, not icebird's: icebird would
// cap the scan at `offset + limit` rows matching ITS (wider) filter, and the
// narrowing that follows would under-return.
test('LIMIT/OFFSET over a filtered cache scan slices the matching rows', async () => {
  const dir = await makeTmpDir('limit')
  try {
    const iceberg = await makeIcebergSource(path.join(dir, 'table'))
    assert.deepEqual(
      await ids(iceberg, 'SELECT id FROM t WHERE ts IS NOT NULL LIMIT 2'),
      [1, 3]
    )
    assert.deepEqual(
      await ids(iceberg, 'SELECT id FROM t WHERE ts IS NOT NULL LIMIT 2 OFFSET 1'),
      [3, 5]
    )
    assert.deepEqual(
      await ids(iceberg, 'SELECT id FROM t WHERE neg > -400 LIMIT 5'),
      [3, 5]
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// The repair must not cost the file pruning the cache tier depends on
// (LLP 0098). Two appends make two data files with disjoint `ts` ranges; a
// predicate that can only match the second must leave the first unopened.
test('a filtered cache scan still prunes whole data files', async () => {
  const dir = await makeTmpDir('pruning')
  const tablePath = path.join(dir, 'table')
  try {
    await appendRowsToTable(tablePath, NULLABLE_COLUMNS, [
      { id: 1, ts: 100, neg: -500, label: 'a' },
      { id: 2, ts: 200, neg: -400, label: 'b' },
    ])
    await appendRowsToTable(tablePath, NULLABLE_COLUMNS, [
      { id: 3, ts: 9000, neg: -300, label: 'c' },
      { id: 4, ts: 9100, neg: -200, label: 'd' },
    ])

    /**
     * @param {string | undefined} predicate
     * @returns {Promise<{ dataFiles: number, ids: number[] }>}
     */
    async function scanOpening(predicate) {
      const { resolver, lister } = await createLocalIcebergIO()
      /** @type {Set<string>} */
      const opened = new Set()
      /** @type {typeof resolver} */
      const counting = {
        ...resolver,
        reader(url) {
          if (url.endsWith('.parquet')) opened.add(url)
          return resolver.reader(url)
        },
      }
      const url = tableUrlForDir(tablePath)
      const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: url, resolver: counting, lister })
      const source = withSqlCorrectWhere(
        await icebergDataSource({ tableUrl: url, metadata, resolver: counting, lister })
      )
      const query = predicate ? `SELECT id FROM t WHERE ${predicate}` : 'SELECT id FROM t'
      const rows = await collect(executeSql({ tables: { t: source }, query }))
      return { dataFiles: opened.size, ids: rows.map((r) => Number(r.id)) }
    }

    const unfiltered = await scanOpening(undefined)
    assert.equal(unfiltered.dataFiles, 2)
    const pruned = await scanOpening('ts > 8000')
    assert.deepEqual(pruned.ids.sort((a, b) => a - b), [3, 4])
    assert.equal(
      pruned.dataFiles,
      1,
      `pruned scan opened ${pruned.dataFiles} data files, unfiltered opened ${unfiltered.dataFiles}`
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/**
 * @param {AsyncIterable<ArrayLike<SqlPrimitive>> | ScanColumnResults} raw
 * @returns {Promise<{ appliedWhere: boolean, values: unknown[] }>}
 */
async function drainColumn(raw) {
  // The wrapper always returns the flagged shape; a bare iterable would mean
  // it had silently dropped the hint flags this test is about.
  assert.ok('chunks' in raw, 'expected flagged ScanColumnResults')
  const result = raw
  /** @type {unknown[]} */
  const values = []
  for await (const chunk of result.chunks()) {
    for (let i = 0; i < chunk.length; i++) values.push(chunk[i])
  }
  return { appliedWhere: result.appliedWhere, values }
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
 * @returns {Promise<number[]>}
 */
async function ids(source, query) {
  const rows = await collect(executeSql({ tables: { t: source }, query }))
  return rows.map((r) => Number(r.id))
}
