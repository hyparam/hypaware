// @ts-check

// Cross-backend parity for the two data sources user SQL actually reaches.
//
// The iceberg cache tier (`dataSourceForTable` -> icebird's
// `icebergDataSource`, every intrinsic dataset: `ai_gateway_messages`,
// `traces`, `logs`) and the parquet-file tier (`parquetDataSource`) share one
// WHERE converter as of LLP 0222, but they are still different sources: they
// prune with different machinery (icebird walks manifests and data-file
// bounds before hyparquet ever sees a row group), they decide `appliedWhere`
// separately, and only one of them is a dependency this repo does not own.
// Every expected row set below is SQL's three-valued answer written down by
// hand, so this file fails on a shared regression as well as a divergent one.
//
// @ref LLP 0222#consequences [tests]: the behavioral guardrail, from the
// cache tier's side - `test/core/parquet-source.test.js` covers the parquet
// tier alone, this one asks both the same questions and compares.

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
import { parquetDataSource } from '../../src/core/query/parquet-source.js'
import { rowsToColumnSources } from '../../hypaware-core/plugins-workspace/format-parquet/src/columns.js'

/**
 * @import { AsyncBuffer } from 'hyparquet'
 * @import { ScannableDataSource } from '../../hypaware-plugin-kernel-types.js'
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
 * Every predicate below, with the rows SQL's three-valued logic selects. Both
 * backends must return exactly this, and the same rows as each other. The
 * expectations are Kleene truth, not a recording of current behavior, so a
 * regression that moves both tiers together still fails here.
 *
 * @type {[string, number[]][]}
 */
const PARITY_CASES = [
  // --- comparison against a NULL literal ------------------------------------
  // A comparison with NULL is UNKNOWN for every row and `NOT UNKNOWN` is still
  // UNKNOWN, so no row is ever TRUE. icebird declines these outright and the
  // engine answers them (LLP 0222#decision); the older converter folded them
  // to `IS NULL` semantics and claimed the answer, which is what made this
  // class wrong on the cache tier (issue #744).
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

  // --- relational bounds over a nullable column -----------------------------
  // icebird pushes these bare (`{neg: {$gt: -400}}`), which is only correct
  // because hyparquet >= 1.28.2 rejects a null cell in `$lt`/`$lte`/`$gt`/
  // `$gte` (LLP 0222#hyparquet-floor). On 1.28.1 a null coerced to 0 and every
  // NULL row sat above any negative bound, so `neg` is where a floor
  // regression shows up first.
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
  // De Morgan, not `$nor`: a two-valued complement reads "no child matched" as
  // a match, so a row UNKNOWN for every disjunct came back. The NULL rows are
  // UNKNOWN for both disjuncts in each case here and neither bound catches
  // them by accident.
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
  // predicates the converter declines: the engine owns them on both paths
  ["label LIKE 'a%'", [1]],
  ["label LIKE 'a%' OR ts > 300", [1, 5]],

  // --- CAST and typed literals ----------------------------------------------
  // The fold the kernel's own converter never had (LLP 0222#context): icebird
  // reads through the cast to the literal, so these push a real bound instead
  // of scanning unpruned. The negated forms are the ones worth staring at,
  // because folding a cast and then De Morgan'ing it is where a two-valued
  // complement over NULL rows would reappear.
  ['neg > CAST(-400 AS BIGINT)', [3, 5]],
  ['NOT (neg > CAST(-400 AS BIGINT))', [1]],
  ['NOT (neg >= CAST(-300 AS BIGINT))', [1]],
  ['NOT (neg > CAST(-400 AS BIGINT) OR neg > CAST(-600 AS BIGINT))', []],
  ['neg != CAST(-300 AS BIGINT)', [1, 5]],
  ["ts > CAST('300' AS BIGINT)", [5]],
]

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
 * @returns {Promise<ScannableDataSource>}
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
 * @returns {Promise<ScannableDataSource>}
 */
async function makeIcebergSource(tablePath) {
  await appendRowsToTable(tablePath, NULLABLE_COLUMNS, NULLABLE_ROWS)
  const source = await dataSourceForTable(tablePath)
  assert.ok(source, 'expected a committed iceberg table')
  return source
}

/**
 * @param {ScannableDataSource} source
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

test('cache and parquet backends answer the corpus identically, and answer it the way SQL does', async () => {
  const dir = await makeTmpDir('corpus')
  try {
    const iceberg = await makeIcebergSource(path.join(dir, 'table'))
    /** @type {string[]} */
    const wrong = []
    for (const [predicate, expected] of PARITY_CASES) {
      const cacheIds = await idsFor(iceberg, predicate)
      const parquetIds = await idsFor(await makeParquetSource(), predicate)
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
// path with its own filter conversion in icebird (`icebergDataSource` converts
// twice). A COUNT over the same corpus must agree with the row count.
test('filtered aggregates take the same NULL semantics as the row scan', async () => {
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
      ['NOT (neg > CAST(-400 AS BIGINT))', 1],
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

// The column stream is icebird's second conversion site and the engine's
// filtered-aggregate fast path (LLP 0098). Its `appliedWhere` is final: the
// engine never re-judges a claimed predicate, and a direct `scanColumn` caller
// has nothing above it to re-filter. So a claim for a predicate icebird
// declined is a wrong answer, not a lost optimisation.
test('the cache column stream reports appliedWhere honestly', async () => {
  const dir = await makeTmpDir('scan-column')
  try {
    const iceberg = await makeIcebergSource(path.join(dir, 'table'))
    const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (iceberg.scanColumn)

    // A NULL-literal comparison is declined, so the raw column comes back and
    // the flag says so. The converter that folded this to a never-match and
    // claimed it is the one LLP 0222 retired.
    const nullLiteral = await drainColumn(scanColumn({
      column: 'ts',
      where: whereOf('SELECT ts FROM t WHERE NOT (ts = NULL)'),
    }))
    assert.equal(nullLiteral.appliedWhere, false)
    assert.deepEqual(nullLiteral.values.map((v) => (v === null ? null : Number(v))), [100, null, 300, null, 500])

    // A predicate over the streamed column is converted and applied.
    const sameColumn = await drainColumn(scanColumn({
      column: 'ts',
      where: whereOf('SELECT ts FROM t WHERE ts > 300'),
    }))
    assert.equal(sameColumn.appliedWhere, true)
    assert.deepEqual(sameColumn.values.map(Number), [500])

    // Another column: the stream cannot carry the predicate's column, so the
    // rows are read and the streamed column projected back out. It must still
    // claim the predicate, or the engine falls back to materializing a row per
    // value (LLP 0098).
    const crossColumn = await drainColumn(scanColumn({
      column: 'id',
      where: whereOf('SELECT id FROM t WHERE neg > -400'),
    }))
    assert.equal(crossColumn.appliedWhere, true)
    assert.deepEqual(crossColumn.values.map(Number).sort((a, b) => a - b), [3, 5])

    // A folded cast is claimed on this path too, not just on `scan`.
    const cast = await drainColumn(scanColumn({
      column: 'id',
      where: whereOf('SELECT id FROM t WHERE neg > CAST(-400 AS BIGINT)'),
    }))
    assert.equal(cast.appliedWhere, true)
    assert.deepEqual(cast.values.map(Number).sort((a, b) => a - b), [3, 5])

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

// The contract LLP 0222 makes the whole stack depend on, pinned from the
// consumer's side: which predicates icebird converts, which it declines, and
// that both backends agree shape by shape. `test/core/parquet-source.test.js`
// asserts the parquet tier's flags; this asserts they match the cache tier's,
// which is the part a converter change in a dependency could break silently.
test('both backends agree on which predicates are converted and which are declined', async () => {
  const dir = await makeTmpDir('flags')
  try {
    const iceberg = await makeIcebergSource(path.join(dir, 'table'))
    const parquet = await makeParquetSource()

    /** @type {[string, string[], string, boolean][]} */
    const cases = [
      // a bare relational bound: converted
      ['bare bound', ['id', 'ts'], 'SELECT id FROM t WHERE ts > 300', true],
      // a cast over a literal: folded through, the fold LLP 0222#context is about
      ['folded cast', ['id', 'neg'], 'SELECT id FROM t WHERE neg > CAST(-400 AS BIGINT)', true],
      // a NULL literal: declined to the three-valued engine
      ['NULL literal', ['id', 'ts'], 'SELECT id FROM t WHERE ts = NULL', false],
      // LIKE has no parquet-filter equivalent
      ['LIKE', ['id', 'label'], "SELECT id FROM t WHERE label LIKE 'a%'", false],
      // nor does a function call
      ['function call', ['id', 'label'], "SELECT id FROM t WHERE LOWER(label) = 'a'", false],
      // nor a column compared to another column
      ['column vs column', ['id', 'ts', 'neg'], 'SELECT id FROM t WHERE ts > neg', false],
      // a predicate on a column the projection omits is still converted on
      // both tiers, because both read the filter's columns for themselves
      ['unprojected column', ['id'], 'SELECT id FROM t WHERE ts > 300', true],
    ]
    /** @type {string[]} */
    const wrong = []
    for (const [name, columns, sql, converted] of cases) {
      const where = whereOf(sql)
      const cache = iceberg.scan({ columns, where })
      const file = parquet.scan({ columns, where })
      if (cache.appliedWhere !== converted) {
        wrong.push(`${name}: cache appliedWhere=${cache.appliedWhere}, expected ${converted}`)
      }
      if (file.appliedWhere !== cache.appliedWhere) {
        wrong.push(`${name}: cache appliedWhere=${cache.appliedWhere}, parquet ${file.appliedWhere}`)
      }
      // A source that claimed the predicate but not the slice is the invariant
      // the engine's "applied limit/offset without applying where" check rests
      // on, so no shape may set `appliedLimitOffset` here.
      if (cache.appliedLimitOffset) wrong.push(`${name}: cache claimed limit/offset with no limit or offset asked for`)
    }
    assert.deepEqual(wrong, [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// Position pushdown has to be withheld whenever a WHERE rides along, on both
// tiers: a source that capped the scan at `offset + limit` rows before the
// engine finished judging the predicate would under-return. The engine reads
// `appliedLimitOffset` and re-slices when it is false, so the flag is the
// whole contract.
test('LIMIT and OFFSET are held back under a WHERE and the slice still lands on the matching rows', async () => {
  const dir = await makeTmpDir('limit')
  try {
    const iceberg = await makeIcebergSource(path.join(dir, 'table'))
    const parquet = await makeParquetSource()

    // No predicate: both tiers take the slice themselves.
    const bare = iceberg.scan({ columns: ['id'], limit: 2 })
    assert.equal(bare.appliedLimitOffset, true)
    assert.equal(parquet.scan({ columns: ['id'], limit: 2 }).appliedLimitOffset, true)

    // With a predicate, converted or declined, the slice goes back to the
    // engine on both tiers.
    for (const sql of [
      'SELECT id FROM t WHERE ts > 100',
      "SELECT id FROM t WHERE label LIKE 'a%'",
    ]) {
      const where = whereOf(sql)
      assert.equal(iceberg.scan({ columns: ['id', 'ts', 'label'], where, limit: 2 }).appliedLimitOffset, false, sql)
      assert.equal(parquet.scan({ columns: ['id', 'ts', 'label'], where, limit: 2 }).appliedLimitOffset, false, sql)
    }

    // End to end: filter first, then offset, then limit.
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
    assert.deepEqual(
      await ids(iceberg, "SELECT id FROM t WHERE label LIKE 'a%' LIMIT 2"),
      [1]
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// Parity must not be bought by giving up the file pruning the cache tier
// depends on (LLP 0098, LLP 0222#consequences). Two appends make two data
// files with disjoint `ts` ranges; a predicate that can only match the second
// must leave the first unopened, which only happens if `where` reaches
// icebird's manifest walk rather than being answered above it.
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
      const source = await icebergDataSource({ tableUrl: url, metadata, resolver: counting, lister })
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
    // A folded cast has to prune too, or the fold LLP 0222 bought is only
    // cosmetic: the same bound written as a cast must open the same one file.
    const prunedCast = await scanOpening('ts > CAST(8000 AS BIGINT)')
    assert.deepEqual(prunedCast.ids.sort((a, b) => a - b), [3, 4])
    assert.equal(prunedCast.dataFiles, 1, `cast-bounded scan opened ${prunedCast.dataFiles} data files`)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

/**
 * @param {AsyncIterable<ArrayLike<SqlPrimitive>> | ScanColumnResults} raw
 * @returns {Promise<{ appliedWhere: boolean, values: unknown[] }>}
 */
async function drainColumn(raw) {
  // A bare iterable would mean the source dropped the hint flags this test is
  // about, which the engine reads as "nothing was applied".
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
 * @param {ScannableDataSource} source
 * @param {string} query
 * @returns {Promise<number[]>}
 */
async function ids(source, query) {
  const rows = await collect(executeSql({ tables: { t: source }, query }))
  return rows.map((r) => Number(r.id))
}
