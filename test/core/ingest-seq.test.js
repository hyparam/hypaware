// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  createIngestSeqAllocator,
  DEFAULT_SEQ_BLOCK_SIZE,
} from '../../src/core/cache/ingest-seq.js'
import {
  INGEST_SEQ_COLUMN,
  INTERNAL_FIELDS,
  streamFlushFile,
} from '../../src/core/cache/streaming-reader.js'
import { createQueryStorageService, resolveIcebergDir } from '../../src/core/cache/storage.js'
import { scanRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { discoverCachePartitions } from '../../src/core/cache/partition.js'

/**
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
 */

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ingest-seq-'))
}

const SEQ_FILE = '_hyp_ingest_seq.json'

test('allocator hands out a strictly increasing run from 1', async () => {
  const dir = await makeTmpDir()
  const alloc = createIngestSeqAllocator({ cacheRoot: dir, blockSize: 4 })

  /** @type {bigint[]} */
  const seqs = []
  for (let i = 0; i < 10; i++) seqs.push(await alloc.next())

  assert.deepEqual(seqs, [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n])
  await fs.rm(dir, { recursive: true, force: true })
})

test('reserve-before-stamp: persisted nextSeq is always ahead of the last issued seq', async () => {
  const dir = await makeTmpDir()
  const statePath = path.join(dir, SEQ_FILE)
  const alloc = createIngestSeqAllocator({ cacheRoot: dir, blockSize: 8 })

  // After the very first allocation, a whole block must already be durable.
  const first = await alloc.next()
  assert.equal(first, 1n)
  const persistedAfterFirst = JSON.parse(await fs.readFile(statePath, 'utf8'))
  assert.equal(persistedAfterFirst.v, 1)
  // Block of 8 reserved up front => nextSeq persisted at 9 while only seq 1 issued.
  assert.equal(persistedAfterFirst.nextSeq, '9')

  // Drain the rest of the block; nextSeq stays at the reserved boundary.
  for (let i = 0; i < 7; i++) await alloc.next()
  const persistedAfterBlock = JSON.parse(await fs.readFile(statePath, 'utf8'))
  assert.equal(persistedAfterBlock.nextSeq, '9')

  // Crossing the block boundary reserves the next block durably *before* use.
  const ninth = await alloc.next()
  assert.equal(ninth, 9n)
  const persistedAfterCross = JSON.parse(await fs.readFile(statePath, 'utf8'))
  assert.equal(persistedAfterCross.nextSeq, '17')

  await fs.rm(dir, { recursive: true, force: true })
})

test('allocator never regresses across a restart and skips the abandoned block tail', async () => {
  const dir = await makeTmpDir()

  const a = createIngestSeqAllocator({ cacheRoot: dir, blockSize: 100 })
  const s1 = await a.next()
  const s2 = await a.next()
  assert.deepEqual([s1, s2], [1n, 2n])

  // Simulate a crash/restart: a brand-new allocator over the same cache root.
  // The previous in-memory block (3..100) is abandoned; the new one must start
  // at the persisted watermark (101) and never re-issue 3..100.
  const b = createIngestSeqAllocator({ cacheRoot: dir, blockSize: 100 })
  const s3 = await b.next()
  assert.equal(s3, 101n)
  assert.ok(s3 > s2)

  await fs.rm(dir, { recursive: true, force: true })
})

test('concurrent next() calls never collide (single allocator, parallel flushes)', async () => {
  const dir = await makeTmpDir()
  const alloc = createIngestSeqAllocator({ cacheRoot: dir, blockSize: 3 })

  const seqs = await Promise.all(Array.from({ length: 50 }, () => alloc.next()))
  const sorted = [...seqs].map((s) => s.toString())
  const unique = new Set(sorted)
  assert.equal(unique.size, 50, 'every issued seq is unique')
  // The multiset is exactly 1..50 (no gaps inside a fully-drained run).
  const asNums = seqs.map((s) => Number(s)).sort((x, y) => x - y)
  assert.deepEqual(asNums, Array.from({ length: 50 }, (_, i) => i + 1))

  await fs.rm(dir, { recursive: true, force: true })
})

test('default block size is a positive integer and rejects bad input', async () => {
  const dir = await makeTmpDir()
  assert.ok(Number.isInteger(DEFAULT_SEQ_BLOCK_SIZE) && DEFAULT_SEQ_BLOCK_SIZE > 0)
  assert.throws(() => createIngestSeqAllocator({ cacheRoot: dir, blockSize: 0 }))
  assert.throws(() => createIngestSeqAllocator({ cacheRoot: '' }))
  await fs.rm(dir, { recursive: true, force: true })
})

test('streamFlushFile stamps a monotonic _hyp_ingest_seq and adds the column', async () => {
  const dir = await makeTmpDir()
  const filePath = path.join(dir, 'seq.jsonl')

  /** @type {ColumnSpec[]} */
  const cols = [
    { name: 'id', type: 'INT64', nullable: false },
    { name: 'msg', type: 'STRING', nullable: false },
  ]
  const lines = []
  for (let i = 0; i < 5; i++) {
    lines.push(JSON.stringify({ version: 1, columns: cols, rows: [{ id: i, msg: `r${i}` }] }) + '\n')
  }
  await fs.writeFile(filePath, lines.join(''))

  let n = 100n
  const nextSeq = async () => n++

  /** @type {bigint[]} */
  const stamped = []
  for await (const batch of streamFlushFile({ filePath, batchId: 'b1', nextSeq })) {
    // Chunk columns carry the additive nullable seq column.
    assert.ok(batch.chunk.columns.some((c) => c.name === '_hyp_ingest_seq' && c.type === 'INT64' && c.nullable === true))
    for (const row of batch.chunk.rows) {
      assert.equal(typeof row._hyp_ingest_seq, 'bigint')
      stamped.push(/** @type {bigint} */ (row._hyp_ingest_seq))
    }
  }

  assert.deepEqual(stamped, [100n, 101n, 102n, 103n, 104n])
  assert.equal(INGEST_SEQ_COLUMN.name, '_hyp_ingest_seq')
  assert.ok(INTERNAL_FIELDS.includes('_hyp_ingest_seq'))

  await fs.rm(dir, { recursive: true, force: true })
})

test('streamFlushFile leaves seq null and still declares the column when no allocator is wired', async () => {
  const dir = await makeTmpDir()
  const filePath = path.join(dir, 'noalloc.jsonl')
  /** @type {ColumnSpec[]} */
  const cols = [{ name: 'id', type: 'INT64', nullable: false }]
  await fs.writeFile(filePath, JSON.stringify({ version: 1, columns: cols, rows: [{ id: 1 }] }) + '\n')

  for await (const batch of streamFlushFile({ filePath, batchId: 'b' })) {
    assert.ok(batch.chunk.columns.some((c) => c.name === '_hyp_ingest_seq'))
    for (const row of batch.chunk.rows) {
      assert.equal(row._hyp_ingest_seq, null)
    }
  }
  await fs.rm(dir, { recursive: true, force: true })
})

test('seq survives a flush into Iceberg, increases per row, and is stripped from readRows', async () => {
  const cacheRoot = await makeTmpDir()
  const svc = createQueryStorageService({ cacheRoot })
  /** @type {ColumnSpec[]} */
  const cols = [
    { name: 'id', type: 'INT64', nullable: false },
    { name: 'msg', type: 'STRING', nullable: false },
  ]
  const tablePath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(tablePath, cols, [
    { id: 1, msg: 'a' },
    { id: 2, msg: 'b' },
    { id: 3, msg: 'c' },
  ])
  await svc.flushTable(tablePath, { reason: 'manual' })

  const parts = await discoverCachePartitions(cacheRoot)
  assert.equal(parts.length, 1)
  const icebergDir = resolveIcebergDir(parts[0].path)

  /** @type {bigint[]} */
  const rawSeqs = []
  for await (const row of scanRowsFromTable(icebergDir)) {
    assert.ok('_hyp_ingest_seq' in row, 'seq column persisted in the iceberg schema')
    rawSeqs.push(/** @type {bigint} */ (row._hyp_ingest_seq))
  }
  assert.equal(rawSeqs.length, 3)
  // Strictly increasing, regardless of read order.
  const sorted = [...rawSeqs].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] > sorted[i - 1])

  // Query/readRows consumers never see the internal seq column.
  for await (const row of svc.readRows(tablePath)) {
    assert.ok(!('_hyp_ingest_seq' in row))
    assert.ok(!('_hyp_cache_row_id' in row))
  }

  // The cache-global allocator state file lives at the cache root, outside
  // datasets/, so partition discovery is unaffected.
  const stat = await fs.stat(path.join(cacheRoot, SEQ_FILE))
  assert.ok(stat.isFile())

  await fs.rm(cacheRoot, { recursive: true, force: true })
})
