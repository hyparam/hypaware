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
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
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
  for await (const pair of svc.readRowsSince(tablePath, {})) seen.push(pair)
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
    // @ts-expect-error — deliberately malformed token
    for await (const _ of svc.readRowsSince(tablePath, { since: { v: 2, seq: '1' } })) { /* drain */ }
  }, /invalid SinkContinuation/)

  await fs.rm(cacheRoot, { recursive: true, force: true })
})
