// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { appendRowsToTable, dataSourceForTable, deleteMatchingRows, scanRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { INGEST_SEQ_COLUMN } from '../../src/core/cache/streaming-reader.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.d.ts'
 */

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-since-'))
}

/** @type {ColumnSpec[]} */
const COLS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'msg', type: 'STRING', nullable: false },
]

test('batch-backed internal scans preserve typed values, projections and deleted positions across files', async () => {
  const root = await makeTmpDir()
  try {
    /** @type {ColumnSpec[]} */
    const columns = [
      ...COLS,
      { name: 'flag', type: 'BOOLEAN', nullable: true },
      { name: 'score', type: 'DOUBLE', nullable: true },
      { name: 'at', type: 'TIMESTAMP', nullable: true },
      { name: 'attrs', type: 'JSON', nullable: true },
      INGEST_SEQ_COLUMN,
    ]
    // More than one native batch; deleting both leading and interior rows
    // catches reading vector indices without composing the source selection.
    for (let file = 0; file < 2; file++) {
      await appendRowsToTable(root, columns, Array.from({ length: 1100 }, (_, i) => ({
        id: file * 1100 + i,
        msg: `row-${file}-${i}`,
        flag: i % 3 === 0 ? null : i % 2 === 0,
        score: i % 5 === 0 ? null : i / 3,
        at: i % 7 === 0 ? null : new Date('2026-09-01T00:00:00Z'),
        attrs: i % 11 === 0 ? null : { label: `value-${i}`, n: i },
        [INGEST_SEQ_COLUMN.name]: i % 13 === 0 ? null : BigInt(file * 1100 + i),
      })))
    }
    await deleteMatchingRows(root, (row) => Number(row.id) % 19 === 0, { columns: ['id'] })
    const source = await dataSourceForTable(root)
    assert.ok(source?.prepareScan)
    for (const projection of [undefined, [], ['msg', 'score', 'attrs', 'at', 'flag'], ['id', 'unknown_column']]) {
      const names = projection?.length ? projection : source.columns
      /** @type {Record<string, unknown>[]} */
      const expected = []
      for await (const row of source.scan({ columns: names }).rows()) {
        const resolved = row.resolved ? { ...row.resolved } : {}
        for (const name of names) {
          if (!Object.hasOwn(resolved, name)) resolved[name] = await row.cells[name]?.()
        }
        expected.push(resolved)
      }
      const actual = []
      for await (const row of scanRowsFromTable(root, projection)) actual.push(row)
      assert.deepEqual(actual, expected)
    }
    for (const includeLegacy of [true, false]) {
      const actual = []
      for await (const row of scanRowsFromTable(root, ['id'], { since: 1100n, includeLegacy })) {
        actual.push(Number(row.id))
      }
      const expected = Array.from({ length: 2200 }, (_, id) => id).filter((id) =>
        id % 19 !== 0 && ((id % 1100) % 13 === 0 ? includeLegacy : id > 1100))
      assert.deepEqual(actual, expected)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('lookup columns outside projection still filter rows before the incremental sequence check', async () => {
  const root = await makeTmpDir()
  try {
    await appendRowsToTable(root, [...COLS, INGEST_SEQ_COLUMN], [
      { id: 1, msg: 'keep', [INGEST_SEQ_COLUMN.name]: null },
      { id: 2, msg: 'other', [INGEST_SEQ_COLUMN.name]: 20n },
      { id: 3, msg: 'keep', [INGEST_SEQ_COLUMN.name]: 10n },
      { id: 4, msg: 'keep', [INGEST_SEQ_COLUMN.name]: 20n },
    ])
    for (const includeLegacy of [true, false]) {
      const actual = []
      for await (const row of scanRowsFromTable(root, ['id'], {
        since: 10n, includeLegacy, whereIn: { msg: ['keep'] },
      })) actual.push(Number(row.id))
      assert.deepEqual(actual, includeLegacy ? [1, 4] : [4])
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('targeted batches intersect lookup keys and deletes without exposing filter-only columns', async () => {
  const root = await makeTmpDir()
  try {
    /** @type {ColumnSpec[]} */
    const columns = [
      ...COLS, { name: 'session_id', type: 'STRING', nullable: true },
      { name: 'role', type: 'STRING', nullable: true },
    ]
    const rows = Array.from({ length: 2200 }, (_, id) => ({
      id, msg: `message-${id}`,
      session_id: id % 5 === 0 ? null : id % 2 === 0 ? 'a' : 'b',
      role: id % 3 === 0 ? 'assistant' : 'user',
    }))
    await appendRowsToTable(root, columns, rows)
    await deleteMatchingRows(root, (row) => Number(row.id) % 7 === 0, { columns: ['id'] })
    for (const keys of [['a'], ['a', 'b', 'a'], ['absent']]) {
      const actual = []
      for await (const row of scanRowsFromTable(root, ['msg', 'id'], {
        whereIn: { session_id: keys, role: ['assistant'] },
      })) {
        assert.deepEqual(Object.keys(row), ['msg', 'id'])
        actual.push(Number(row.id))
      }
      assert.deepEqual(actual, rows.filter((row) => row.session_id !== null && keys.includes(row.session_id) &&
        row.role === 'assistant' && row.id % 7 !== 0).map((row) => row.id))
    }
    // An absent projected field retains the row fallback's padding behavior.
    const fallback = []
    for await (const row of scanRowsFromTable(root, ['id', 'absent'], { whereIn: { session_id: ['a'] } })) {
      assert.equal(row.absent, undefined)
      fallback.push(Number(row.id))
    }
    assert.deepEqual(fallback, rows.filter((row) => row.session_id === 'a' && row.id % 7 !== 0).map((row) => row.id))
    // Numeric coercion follows the same batch path, including deleted keys and
    // a second predicate on a column absent from the output projection.
    const numeric = []
    for await (const row of scanRowsFromTable(root, ['msg'], {
      whereIn: { id: ['6', '12', '42', '2106'], role: ['assistant'] },
    })) numeric.push(row)
    assert.deepEqual(numeric, [6, 12, 2106].map((id) => ({ msg: `message-${id}` })))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('targeted scans preserve numeric lookup coercion and reject invalid lookup requests', async () => {
  const root = await makeTmpDir()
  try {
    await appendRowsToTable(root, COLS, [{ id: 1, msg: 'one' }, { id: 2, msg: 'two' }])
    const actual = []
    for await (const row of scanRowsFromTable(root, ['msg'], { whereIn: { id: ['2'] } })) actual.push(row.msg)
    assert.deepEqual(actual, ['two'])
    /** @type {Record<string, string[]>[]} */
    const invalid = [{ msg: [] }, { missing: ['x'] }]
    for (const whereIn of invalid) {
      await assert.rejects(async () => {
        for await (const _ of scanRowsFromTable(root, ['id'], { whereIn })) {}
      }, /cache lookup/)
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readRows back-compat: no opts is unchanged, internal fields never leak', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({ cacheRoot })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, msg: 'a' },
    { id: 2, msg: 'b' },
    { id: 3, msg: 'c' },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  // The spool re-groups rows into a committed `source=<client>` partition; a
  // sink reads from the discovered partition path, not the spool path.
  const parts = await svc.discoverCachePartitions()
  assert.equal(parts.length, 1)
  const tablePath = parts[0].path

  /** @type {Record<string, unknown>[]} */
  const all = []
  for await (const row of svc.readRows(tablePath)) all.push(row)
  assert.equal(all.length, 3)
  for (const row of all) {
    assert.ok(!('_hyp_ingest_seq' in row))
    assert.ok(!('_hyp_cache_row_id' in row))
    assert.ok(!('_hyp_cache_batch_id' in row))
  }

  // Column projection is still honoured and still strips internals.
  /** @type {Record<string, unknown>[]} */
  const idOnly = []
  for await (const row of svc.readRows(tablePath, ['id'])) idOnly.push(row)
  assert.equal(idOnly.length, 3)
  for (const row of idOnly) assert.deepEqual(Object.keys(row), ['id'])

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('readRowsSince pairs each row with a monotonic after token and strips the seq', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({ cacheRoot })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, msg: 'a' },
    { id: 2, msg: 'b' },
    { id: 3, msg: 'c' },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  const parts = await svc.discoverCachePartitions()
  assert.equal(parts.length, 1)
  const tablePath = parts[0].path

  /** @type {{ row: Record<string, unknown>, after: { v: 1, seq: string } }[]} */
  const seen = []
  for await (const pair of svc.readRowsSince(tablePath, {})) {
    assert.ok(!pair.dropped && pair.row, 'no usage-policy resolver ⇒ every entry carries a row')
    seen.push({ row: pair.row, after: pair.after })
  }
  assert.equal(seen.length, 3)

  let prev = -1n
  for (const { row, after } of seen) {
    assert.ok(!('_hyp_ingest_seq' in row), 'seq never reaches the row payload')
    assert.equal(after.v, 1)
    assert.match(after.seq, /^\d+$/)
    const cur = BigInt(after.seq)
    assert.ok(cur >= prev, 'after token never regresses across the scan')
    prev = cur
  }
  const watermark = seen[seen.length - 1].after

  // A second read from the watermark with no new rows yields nothing (≈0 bytes),
  // via both the cursor-aware surface and the plain `readRows` `since`.
  /** @type {unknown[]} */
  const none = []
  for await (const pair of svc.readRowsSince(tablePath, { since: watermark })) none.push(pair)
  assert.equal(none.length, 0)
  /** @type {unknown[]} */
  const noneFlat = []
  for await (const row of svc.readRows(tablePath, undefined, { since: watermark })) noneFlat.push(row)
  assert.equal(noneFlat.length, 0)

  // After N new rows, only the N new ones are read, independent of the rest.
  await svc.appendRows(spoolPath, COLS, [
    { id: 4, msg: 'd' },
    { id: 5, msg: 'e' },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {Record<string, unknown>[]} */
  const fresh = []
  for await (const { row, after } of svc.readRowsSince(tablePath, { since: watermark })) {
    assert.ok(row, 'no usage-policy resolver ⇒ no drops')
    fresh.push(row)
    assert.ok(BigInt(after.seq) > BigInt(watermark.seq))
  }
  assert.equal(fresh.length, 2)
  assert.deepEqual(fresh.map((r) => Number(r.id)).sort((a, b) => a - b), [4, 5])

  // The same read the way a sink that already HAS a durable watermark issues
  // it. That is the only policy the seq predicate is pushed into the scan on,
  // so it has to land on exactly the rows the default policy above yielded.
  /** @type {number[]} */
  const freshPushed = []
  for await (const { row } of svc.readRowsSince(tablePath, { since: watermark, includeLegacy: false })) {
    if (row) freshPushed.push(Number(row.id))
  }
  assert.deepEqual(freshPushed.sort((a, b) => a - b), [4, 5])

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('null-seq (legacy) rows are always treated as new and never skipped', async () => {
  const root = await makeTmpDir()
  const dir = path.join(root, 'legacy-table')
  /** @type {ColumnSpec[]} */
  const cols = [
    { name: 'id', type: 'INT64', nullable: false },
    INGEST_SEQ_COLUMN,
  ]
  // A migration-era table: some rows pre-date the seq column (null), some carry
  // real seqs. Built directly so the seq values are controlled exactly.
  await appendRowsToTable(dir, cols, [
    { id: 1, [INGEST_SEQ_COLUMN.name]: null },
    { id: 2, [INGEST_SEQ_COLUMN.name]: 5n },
    { id: 3, [INGEST_SEQ_COLUMN.name]: 10n },
    { id: 4, [INGEST_SEQ_COLUMN.name]: null },
  ])

  // since = 5: keep null(1), skip seq 5(2), keep seq 10(3), keep null(4).
  /** @type {number[]} */
  const kept = []
  for await (const row of scanRowsFromTable(dir, undefined, { since: 5n })) kept.push(Number(row.id))
  assert.deepEqual(kept, [1, 3, 4])

  // since = 0: every row is new.
  /** @type {number[]} */
  const allIds = []
  for await (const row of scanRowsFromTable(dir, undefined, { since: 0n })) allIds.push(Number(row.id))
  assert.deepEqual(allIds, [1, 2, 3, 4])

  // Through the cursor-aware surface: a null-seq row carries the prior watermark
  // forward unchanged (it does not advance the high-water seq).
  const svc = createQueryStorageService({ cacheRoot: root })
  /** @type {{ id: number, after: string }[]} */
  const pairs = []
  for await (const { row, after } of svc.readRowsSince(dir, { since: { v: 1, seq: '5' } })) {
    assert.ok(row, 'no usage-policy resolver ⇒ no drops')
    assert.ok(!(INGEST_SEQ_COLUMN.name in row))
    pairs.push({ id: Number(row.id), after: after.seq })
  }
  assert.deepEqual(pairs, [
    { id: 1, after: '5' },
    { id: 3, after: '10' },
    { id: 4, after: '10' },
  ])

  await fs.rm(root, { recursive: true, force: true })
})

test('a table with no seq column at all yields everything (pure legacy)', async () => {
  const root = await makeTmpDir()
  const dir = path.join(root, 'no-seq-col')
  await appendRowsToTable(dir, COLS, [
    { id: 1, msg: 'a' },
    { id: 2, msg: 'b' },
  ])

  // Even with a high watermark, a table that never carried the seq column has
  // only implicit null-seq rows, so all are new.
  const svc = createQueryStorageService({ cacheRoot: root })
  /** @type {{ id: number, after: string }[]} */
  const pairs = []
  for await (const { row, after } of svc.readRowsSince(dir, { since: { v: 1, seq: '999' } })) {
    assert.ok(row, 'no usage-policy resolver ⇒ no drops')
    pairs.push({ id: Number(row.id), after: after.seq })
  }
  assert.deepEqual(pairs, [
    { id: 1, after: '999' },
    { id: 2, after: '999' },
  ])

  await fs.rm(root, { recursive: true, force: true })
})

test('an invalid continuation token is rejected', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({ cacheRoot })
  const tablePath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(tablePath, COLS, [{ id: 1, msg: 'a' }])
  await svc.flushTable(tablePath, { reason: 'manual' })

  await assert.rejects(async () => {
    // @ts-expect-error: deliberately malformed token
    for await (const _ of svc.readRowsSince(tablePath, { since: { v: 2, seq: '1' } })) { /* drain */ }
  }, /invalid SinkContinuation/)

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

test('a watermark prunes data files below it: an idle tick opens no data file', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({ cacheRoot })
  const spoolPath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(spoolPath, COLS, [
    { id: 1, msg: 'a' },
    { id: 2, msg: 'b' },
  ])
  await svc.flushTable(spoolPath, { reason: 'manual' })
  const parts = await svc.discoverCachePartitions()
  assert.equal(parts.length, 1)
  const tablePath = parts[0].path

  /** @type {{ v: 1, seq: string } | undefined} */
  let watermark
  for await (const pair of svc.readRowsSince(tablePath, {})) watermark = pair.after
  assert.ok(watermark)

  // A second flush lands in a second data file, above the watermark.
  await svc.appendRows(spoolPath, COLS, [{ id: 3, msg: 'c' }])
  await svc.flushTable(spoolPath, { reason: 'manual' })

  /** @type {number[]} */
  const fresh = []
  let tip = watermark
  const opened = await parquetOpens(async () => {
    for await (const pair of svc.readRowsSince(tablePath, { since: watermark, includeLegacy: false })) {
      if (pair.row) fresh.push(Number(pair.row.id))
      tip = pair.after
    }
  })
  assert.deepEqual(fresh, [3])
  assert.equal(opened.length, 1, `only the file above the watermark is opened, got ${opened.join(', ')}`)

  /** @type {unknown[]} */
  const none = []
  const openedIdle = await parquetOpens(async () => {
    for await (const pair of svc.readRowsSince(tablePath, { since: tip, includeLegacy: false })) none.push(pair)
  })
  assert.equal(none.length, 0)
  assert.deepEqual(openedIdle, [], 'an idle tick opens no data file at all')

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

/**
 * Run `fn` with `fs.stat` instrumented, returning the basenames of the
 * data files requested. The local Iceberg resolver stats each file once
 * when constructing its range reader, before any slices are requested.
 *
 * @param {() => Promise<void>} fn
 * @returns {Promise<string[]>}
 */
async function parquetOpens(fn) {
  const realRead = fs.stat
  /** @type {string[]} */
  const opened = []
  fs.stat = /** @type {typeof realRead} */ ((...args) => {
    const target = String(args[0])
    // Sidecar indexes and delete files are not the data files under test.
    if (target.endsWith('.parquet') && !target.endsWith('.index.parquet') &&
        !target.endsWith('-deletes.parquet')) opened.push(path.basename(target))
    return realRead.apply(fs, /** @type {any} */ (args))
  })
  try {
    await fn()
  } finally {
    fs.stat = realRead
  }
  return opened
}

// The loss-bearing direction of the pushdown. Pruning trusts the manifest's
// upper bound on the seq column, so the file-skip and the yielded-row filter
// have to agree on `> since` EXACTLY: prune iff `hi <= since`. One step the
// wrong way (`hi < since`, or a `>=` predicate) and the file holding the very
// next row is skipped, its rows are never forwarded, and the watermark still
// advances past them. Adjacent seqs on either side of the watermark are the
// only fixture that can tell those apart.
test('the pushed predicate agrees with the row filter at the exact watermark boundary', async () => {
  const root = await makeTmpDir()
  const dir = path.join(root, 'boundary')
  /** @type {ColumnSpec[]} */
  const cols = [
    { name: 'id', type: 'INT64', nullable: false },
    INGEST_SEQ_COLUMN,
  ]
  // One row per data file, at three consecutive seqs, so each file's manifest
  // bounds are a single point and pruning has no slack to hide an off-by-one.
  await appendRowsToTable(dir, cols, [{ id: 10, [INGEST_SEQ_COLUMN.name]: 10n }])
  await appendRowsToTable(dir, cols, [{ id: 11, [INGEST_SEQ_COLUMN.name]: 11n }])
  await appendRowsToTable(dir, cols, [{ id: 12, [INGEST_SEQ_COLUMN.name]: 12n }])

  // since = 10: seq 10 is NOT new (strictly `>`), 11 and 12 are. The seq-11
  // file sits exactly one above the watermark: it must still be opened.
  /** @type {number[]} */
  const above = []
  const openedAbove = await parquetOpens(async () => {
    for await (const row of scanRowsFromTable(dir, undefined, { since: 10n, includeLegacy: false })) {
      above.push(Number(row.id))
    }
  })
  assert.deepEqual(above.sort((a, b) => a - b), [11, 12], 'the row one seq above the watermark is never dropped')
  assert.equal(openedAbove.length, 2, `the seq-10 file is pruned and no other, got ${openedAbove.join(', ')}`)

  // since = 11: only seq 12 survives, and the two files at or below are pruned.
  /** @type {number[]} */
  const tail = []
  const openedTail = await parquetOpens(async () => {
    for await (const row of scanRowsFromTable(dir, undefined, { since: 11n, includeLegacy: false })) {
      tail.push(Number(row.id))
    }
  })
  assert.deepEqual(tail, [12])
  assert.equal(openedTail.length, 1, `only the seq-12 file is opened, got ${openedTail.join(', ')}`)

  // since = 12: the tip. Nothing is new and nothing is opened.
  /** @type {number[]} */
  const none = []
  const openedNone = await parquetOpens(async () => {
    for await (const row of scanRowsFromTable(dir, undefined, { since: 12n, includeLegacy: false })) {
      none.push(Number(row.id))
    }
  })
  assert.deepEqual(none, [])
  assert.deepEqual(openedNone, [], 'an idle tick at the tip opens no data file')

  await fs.rm(root, { recursive: true, force: true })
})

// `includeLegacy: false` is the ONLY case the predicate is pushed on, and it is
// also the case where null-seq rows are reachable: a table mid-migration holds
// both. `null > since` is false for icebird and for the row filter alike, so
// the two must land on the same rows. A file mixing nulls with real seqs must
// still be opened on the strength of its real ones, and its real rows above the
// watermark must all come out.
test('with includeLegacy false the pushed predicate drops null seqs and no real one', async () => {
  const root = await makeTmpDir()
  const dir = path.join(root, 'mixed')
  /** @type {ColumnSpec[]} */
  const cols = [
    { name: 'id', type: 'INT64', nullable: false },
    INGEST_SEQ_COLUMN,
  ]
  // File 1 mixes pre-column rows with real seqs at and above the watermark;
  // its bounds are [5, 10], so it cannot be pruned at since = 5.
  await appendRowsToTable(dir, cols, [
    { id: 1, [INGEST_SEQ_COLUMN.name]: null },
    { id: 2, [INGEST_SEQ_COLUMN.name]: 5n },
    { id: 3, [INGEST_SEQ_COLUMN.name]: 10n },
    { id: 4, [INGEST_SEQ_COLUMN.name]: null },
  ])
  // File 2 is all null seq: it records no bound on the column at all, which is
  // the "absent bound" case pruning must resolve by KEEPING the file.
  await appendRowsToTable(dir, cols, [
    { id: 5, [INGEST_SEQ_COLUMN.name]: null },
    { id: 6, [INGEST_SEQ_COLUMN.name]: null },
  ])

  /** @type {number[]} */
  const kept = []
  for await (const row of scanRowsFromTable(dir, undefined, { since: 5n, includeLegacy: false })) {
    kept.push(Number(row.id))
  }
  assert.deepEqual(kept, [3], 'only the real seq above the watermark; every null seq is already exported')

  // The same table under the default policy keeps the legacy rows, which is
  // exactly why the predicate is not pushed there. Same rows as before the
  // pushdown existed.
  /** @type {number[]} */
  const withLegacy = []
  for await (const row of scanRowsFromTable(dir, undefined, { since: 5n })) withLegacy.push(Number(row.id))
  assert.deepEqual(withLegacy.sort((a, b) => a - b), [1, 3, 4, 5, 6])

  await fs.rm(root, { recursive: true, force: true })
})

// icebird's `remapFilterColumns` drops the WHOLE filter for a data file that
// is missing any column the filter names, and `whereIn` is a predicate callers
// rely on that `scanRowsFromTable` does not re-check on yielded rows (`since`
// it does). Conjoining the two would therefore let a pre-seq-column file lose
// its lookup clause silently, so the seq predicate is not pushed at all when a
// `whereIn` is present. Asserted by the files opened: with the push the seq-12
// file would be the only one read.
test('the seq predicate is not pushed alongside a whereIn lookup', async () => {
  const root = await makeTmpDir()
  const dir = path.join(root, 'lookup')
  /** @type {ColumnSpec[]} */
  const cols = [
    { name: 'id', type: 'INT64', nullable: false },
    // Constant across every file, so this lookup prunes nothing by its own
    // bounds and the opened-file count reports only the seq predicate.
    { name: 'tag', type: 'STRING', nullable: false },
    INGEST_SEQ_COLUMN,
  ]
  await appendRowsToTable(dir, cols, [{ id: 10, tag: 'k', [INGEST_SEQ_COLUMN.name]: 10n }])
  await appendRowsToTable(dir, cols, [{ id: 11, tag: 'k', [INGEST_SEQ_COLUMN.name]: 11n }])
  await appendRowsToTable(dir, cols, [{ id: 12, tag: 'k', [INGEST_SEQ_COLUMN.name]: 12n }])

  /** @type {number[]} */
  const kept = []
  const opened = await parquetOpens(async () => {
    const opts = { since: 11n, includeLegacy: false, whereIn: { tag: ['k'] } }
    for await (const row of scanRowsFromTable(dir, undefined, opts)) kept.push(Number(row.id))
  })
  assert.deepEqual(kept, [12], 'the row filter still resolves the watermark')
  assert.equal(opened.length, 3, `every file is read so the lookup clause survives, got ${opened.join(', ')}`)

  await fs.rm(root, { recursive: true, force: true })
})
