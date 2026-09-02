// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { appendRowsToTable, scanRowsFromTable } from '../../src/core/cache/iceberg/store.js'
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
  for await (const { row, after } of svc.readRowsSince(tablePath, { since: watermark, includeLegacy: false })) {
    assert.ok(row, 'no usage-policy resolver ⇒ no drops')
    fresh.push(row)
    assert.ok(BigInt(after.seq) > BigInt(watermark.seq))
  }
  assert.equal(fresh.length, 2)
  assert.deepEqual(fresh.map((r) => Number(r.id)).sort((a, b) => a - b), [4, 5])

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

  // The local resolver reads every file through `fs.readFileSync`; record the
  // data files it opens during each scan.
  const fsSync = await import('node:fs')
  const realRead = fsSync.default.readFileSync
  /** @type {string[]} */
  const opened = []
  fsSync.default.readFileSync = /** @type {typeof realRead} */ ((...args) => {
    const target = String(args[0])
    if (target.endsWith('.parquet')) opened.push(path.basename(target))
    return realRead.apply(fsSync.default, /** @type {any} */ (args))
  })
  try {
    /** @type {number[]} */
    const fresh = []
    for await (const pair of svc.readRowsSince(tablePath, { since: watermark, includeLegacy: false })) {
      if (pair.row) fresh.push(Number(pair.row.id))
    }
    assert.deepEqual(fresh, [3])
    assert.equal(opened.length, 1, `only the file above the watermark is opened, got ${opened.join(', ')}`)

    let tip = watermark
    for await (const pair of svc.readRowsSince(tablePath, { since: watermark, includeLegacy: false })) tip = pair.after
    opened.length = 0
    /** @type {unknown[]} */
    const none = []
    for await (const pair of svc.readRowsSince(tablePath, { since: tip, includeLegacy: false })) none.push(pair)
    assert.equal(none.length, 0)
    assert.deepEqual(opened, [], 'an idle tick opens no data file at all')
  } finally {
    fsSync.default.readFileSync = realRead
  }

  await fs.rm(cacheRoot, { recursive: true, force: true })
})

/**
 * Run `fn` with `fs.readFileSync` instrumented, returning the basenames of the
 * data files it opened. The local Iceberg resolver reads every file through
 * `fs.readFileSync`, so this is what "the scan never opened that file" means.
 *
 * @param {() => Promise<void>} fn
 * @returns {Promise<string[]>}
 */
async function parquetOpens(fn) {
  const fsSync = await import('node:fs')
  const realRead = fsSync.default.readFileSync
  /** @type {string[]} */
  const opened = []
  fsSync.default.readFileSync = /** @type {typeof realRead} */ ((...args) => {
    const target = String(args[0])
    // Sidecar indexes and delete files are not the data files under test.
    if (target.endsWith('.parquet') && !target.endsWith('.index.parquet') &&
        !target.endsWith('-deletes.parquet')) opened.push(path.basename(target))
    return realRead.apply(fsSync.default, /** @type {any} */ (args))
  })
  try {
    await fn()
  } finally {
    fsSync.default.readFileSync = realRead
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
