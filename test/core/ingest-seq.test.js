// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { createIngestSeqAllocator } from '../../src/core/cache/ingest-seq.js'
import {
  INGEST_SEQ_COLUMN,
  INTERNAL_FIELDS,
  streamFlushFile,
} from '../../src/core/cache/streaming-reader.js'
import { createQueryStorageService, resolveIcebergDir } from '../../src/core/cache/storage.js'
import { scanRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { discoverCachePartitions } from '../../src/core/cache/partition.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.d.ts'
 */

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-ingest-seq-'))
}

const SEQ_FILE = '_hyp_ingest_seq.json'

test('reserve hands out contiguous, strictly increasing runs from 1', async () => {
  const dir = await makeTmpDir()
  const alloc = createIngestSeqAllocator({ cacheRoot: dir })

  const first = await alloc.reserve(4)
  const second = await alloc.reserve(1)
  const third = await alloc.reserve(5)

  assert.deepEqual([first, second, third], [1n, 5n, 6n])
  await fs.rm(dir, { recursive: true, force: true })
})

test('reserve-before-stamp: persisted nextSeq is always ahead of the last reserved seq', async () => {
  const dir = await makeTmpDir()
  const statePath = path.join(dir, SEQ_FILE)
  const alloc = createIngestSeqAllocator({ cacheRoot: dir })

  // The whole run is durable before the caller sees its first seq.
  const first = await alloc.reserve(8)
  assert.equal(first, 1n)
  const persistedAfterFirst = JSON.parse(await fs.readFile(statePath, 'utf8'))
  assert.equal(persistedAfterFirst.v, 1)
  assert.equal(persistedAfterFirst.nextSeq, '9')

  // Nothing is held back in memory: the next run starts where the file says.
  const ninth = await alloc.reserve(1)
  assert.equal(ninth, 9n)
  const persistedAfterCross = JSON.parse(await fs.readFile(statePath, 'utf8'))
  assert.equal(persistedAfterCross.nextSeq, '10')

  await fs.rm(dir, { recursive: true, force: true })
})

test('allocator never regresses across a restart', async () => {
  const dir = await makeTmpDir()

  const a = createIngestSeqAllocator({ cacheRoot: dir })
  const s1 = await a.reserve(100)
  assert.equal(s1, 1n)

  // Simulate a crash/restart: a brand-new allocator over the same cache root
  // must start past every seq the old one reserved, used or not.
  const b = createIngestSeqAllocator({ cacheRoot: dir })
  const s2 = await b.reserve(1)
  assert.equal(s2, 101n)

  await fs.rm(dir, { recursive: true, force: true })
})

test('concurrent reserve() calls never collide (single allocator, parallel flushes)', async () => {
  const dir = await makeTmpDir()
  const alloc = createIngestSeqAllocator({ cacheRoot: dir })

  const starts = await Promise.all(Array.from({ length: 50 }, () => alloc.reserve(1)))
  const unique = new Set(starts.map((s) => s.toString()))
  assert.equal(unique.size, 50, 'every reserved seq is unique')
  // The multiset is exactly 1..50 (no gaps inside a fully-drained run).
  const asNums = starts.map((s) => Number(s)).sort((x, y) => x - y)
  assert.deepEqual(asNums, Array.from({ length: 50 }, (_, i) => i + 1))

  await fs.rm(dir, { recursive: true, force: true })
})

test('reserve rejects a non-positive count and a missing cache root', async () => {
  const dir = await makeTmpDir()
  const alloc = createIngestSeqAllocator({ cacheRoot: dir })
  await assert.rejects(() => alloc.reserve(0))
  await assert.rejects(() => alloc.reserve(1.5))
  assert.throws(() => createIngestSeqAllocator({ cacheRoot: '' }))
  await fs.rm(dir, { recursive: true, force: true })
})

test('streamFlushFile leaves seq null and declares the column; the commit stamps the value', async () => {
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
