// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  appendRowsToPartition,
  discoverCachePartitions,
  readCursorSync,
  resolveClientName,
  writeCursor,
} from '../../src/core/cache/partition.js'

/** @type {import('../../collectivus-plugin-kernel-types.d.ts').ColumnSpec[]} */
const TEST_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'value', type: 'STRING', nullable: true },
]

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = path.join(os.tmpdir(), `hyp-test-partition-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// --- appendRowsToPartition ---

test('appendRowsToPartition creates epoch directory and cursor on first write', async () => {
  const cacheRoot = await makeTmpDir('append-first')
  try {
    const result = await appendRowsToPartition(
      cacheRoot, 'test_data', ['client=alpha', 'date=2026-05-26'],
      TEST_COLUMNS, [{ id: 1, value: 'hello' }]
    )
    assert.equal(result.appended, true)
    assert.ok(result.bytesWritten > 0)

    const partitionDir = path.join(cacheRoot, 'datasets', 'test_data', 'client=alpha', 'date=2026-05-26')
    const cursor = readCursorSync(partitionDir)
    assert.equal(cursor.epoch, 0)
    assert.equal(cursor.rowCount, 1)
    assert.equal(cursor.compaction, null)

    const epochDir = path.join(partitionDir, 'epoch=0')
    assert.ok(fsSync.existsSync(epochDir))
    const metadataDir = path.join(epochDir, 'metadata')
    assert.ok(fsSync.existsSync(metadataDir))
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('appendRowsToPartition with single partition segment', async () => {
  const cacheRoot = await makeTmpDir('append-single')
  try {
    await appendRowsToPartition(
      cacheRoot, 'logs', ['source=otlp'],
      TEST_COLUMNS, [{ id: 1, value: 'log1' }]
    )
    const partitionDir = path.join(cacheRoot, 'datasets', 'logs', 'source=otlp')
    const cursor = readCursorSync(partitionDir)
    assert.equal(cursor.epoch, 0)
    assert.equal(cursor.rowCount, 1)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('appendRowsToPartition with multi-segment path', async () => {
  const cacheRoot = await makeTmpDir('append-multi')
  try {
    await appendRowsToPartition(
      cacheRoot, 'ai_gateway_messages', ['client=claude', 'date=2026-05-26'],
      TEST_COLUMNS,
      [{ id: 1, value: 'a' }, { id: 2, value: 'b' }]
    )
    const partitionDir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'client=claude', 'date=2026-05-26')
    const cursor = readCursorSync(partitionDir)
    assert.equal(cursor.rowCount, 2)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('appendRowsToPartition updates cursor rowCount on subsequent writes', async () => {
  const cacheRoot = await makeTmpDir('append-subsequent')
  try {
    const segments = ['client=codex', 'date=2026-05-25']
    await appendRowsToPartition(cacheRoot, 'msgs', segments, TEST_COLUMNS, [{ id: 1, value: 'a' }])
    await appendRowsToPartition(cacheRoot, 'msgs', segments, TEST_COLUMNS, [{ id: 2, value: 'b' }, { id: 3, value: 'c' }])

    const partitionDir = path.join(cacheRoot, 'datasets', 'msgs', ...segments)
    const cursor = readCursorSync(partitionDir)
    assert.equal(cursor.epoch, 0)
    assert.equal(cursor.rowCount, 3)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('appendRowsToPartition returns early for empty rows', async () => {
  const cacheRoot = await makeTmpDir('append-empty')
  try {
    const result = await appendRowsToPartition(
      cacheRoot, 'test', ['all'], TEST_COLUMNS, []
    )
    assert.equal(result.appended, false)
    assert.equal(result.bytesWritten, 0)
    const partitionDir = path.join(cacheRoot, 'datasets', 'test', 'all')
    assert.equal(fsSync.existsSync(partitionDir), false)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// --- cursor management ---

test('readCursorSync returns default cursor for missing file', () => {
  const cursor = readCursorSync('/tmp/nonexistent-partition-dir')
  assert.deepEqual(cursor, { epoch: 0, rowCount: 0, compaction: null })
})

test('writeCursor creates the file and readCursorSync reads it back', async () => {
  const dir = await makeTmpDir('cursor-rw')
  try {
    await writeCursor(dir, { epoch: 2, rowCount: 42, compaction: null })
    const cursor = readCursorSync(dir)
    assert.equal(cursor.epoch, 2)
    assert.equal(cursor.rowCount, 42)
    assert.equal(cursor.compaction, null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// --- discoverCachePartitions ---

test('discoverCachePartitions returns empty for empty cache', async () => {
  const cacheRoot = await makeTmpDir('discover-empty')
  try {
    const result = await discoverCachePartitions(cacheRoot)
    assert.deepEqual(result, [])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('discoverCachePartitions finds a single dataset partition', async () => {
  const cacheRoot = await makeTmpDir('discover-single')
  try {
    await appendRowsToPartition(cacheRoot, 'logs', ['source=otlp', 'date=2026-05-26'], TEST_COLUMNS, [{ id: 1, value: 'x' }])
    const result = await discoverCachePartitions(cacheRoot)
    assert.equal(result.length, 1)
    assert.equal(result[0].dataset, 'logs')
    assert.deepEqual(result[0].partition, { source: 'otlp', date: '2026-05-26' })
    assert.equal(result[0].epoch, 0)
    assert.equal(result[0].rowCount, 1)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('discoverCachePartitions discovers multiple dates', async () => {
  const cacheRoot = await makeTmpDir('discover-multi')
  try {
    await appendRowsToPartition(cacheRoot, 'ai_gw', ['client=claude', 'date=2026-05-25'], TEST_COLUMNS, [{ id: 1, value: 'a' }])
    await appendRowsToPartition(cacheRoot, 'ai_gw', ['client=claude', 'date=2026-05-26'], TEST_COLUMNS, [{ id: 2, value: 'b' }])
    await appendRowsToPartition(cacheRoot, 'ai_gw', ['client=codex', 'date=2026-05-26'], TEST_COLUMNS, [{ id: 3, value: 'c' }])
    const result = await discoverCachePartitions(cacheRoot)
    assert.equal(result.length, 3)
    const dates = result.map((r) => `${r.partition.client}/${r.partition.date}`).sort()
    assert.deepEqual(dates, ['claude/2026-05-25', 'claude/2026-05-26', 'codex/2026-05-26'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('discoverCachePartitions filters by scope.datasets', async () => {
  const cacheRoot = await makeTmpDir('discover-filter-ds')
  try {
    await appendRowsToPartition(cacheRoot, 'logs', ['all'], TEST_COLUMNS, [{ id: 1, value: 'x' }])
    await appendRowsToPartition(cacheRoot, 'metrics', ['all'], TEST_COLUMNS, [{ id: 2, value: 'y' }])
    const result = await discoverCachePartitions(cacheRoot, { datasets: ['logs'] })
    assert.equal(result.length, 1)
    assert.equal(result[0].dataset, 'logs')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('discoverCachePartitions filters by scope.date', async () => {
  const cacheRoot = await makeTmpDir('discover-filter-date')
  try {
    await appendRowsToPartition(cacheRoot, 'data', ['date=2026-05-25'], TEST_COLUMNS, [{ id: 1, value: 'a' }])
    await appendRowsToPartition(cacheRoot, 'data', ['date=2026-05-26'], TEST_COLUMNS, [{ id: 2, value: 'b' }])
    const result = await discoverCachePartitions(cacheRoot, { date: '2026-05-26' })
    assert.equal(result.length, 1)
    assert.equal(result[0].partition.date, '2026-05-26')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('discoverCachePartitions filters by scope.from and scope.to', async () => {
  const cacheRoot = await makeTmpDir('discover-filter-range')
  try {
    await appendRowsToPartition(cacheRoot, 'data', ['date=2026-05-24'], TEST_COLUMNS, [{ id: 1, value: 'a' }])
    await appendRowsToPartition(cacheRoot, 'data', ['date=2026-05-25'], TEST_COLUMNS, [{ id: 2, value: 'b' }])
    await appendRowsToPartition(cacheRoot, 'data', ['date=2026-05-26'], TEST_COLUMNS, [{ id: 3, value: 'c' }])
    const result = await discoverCachePartitions(cacheRoot, { from: '2026-05-25', to: '2026-05-25' })
    assert.equal(result.length, 1)
    assert.equal(result[0].partition.date, '2026-05-25')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// --- resolveClientName ---

test('resolveClientName returns client_name when present', () => {
  assert.equal(resolveClientName({ client_name: 'claude', conversation_source: 'api', provider: 'anthropic' }), 'claude')
})

test('resolveClientName falls back to conversation_source', () => {
  assert.equal(resolveClientName({ conversation_source: 'cli', provider: 'anthropic' }), 'cli')
})

test('resolveClientName falls back to provider', () => {
  assert.equal(resolveClientName({ provider: 'openai' }), 'openai')
})

test('resolveClientName falls back to "unknown"', () => {
  assert.equal(resolveClientName({}), 'unknown')
})

test('resolveClientName skips empty strings in the fallback chain', () => {
  assert.equal(resolveClientName({ client_name: '', conversation_source: '', provider: 'anthropic' }), 'anthropic')
})
