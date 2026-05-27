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
  resolvePartitionDate,
  resolvePartitionSegments,
  resolveSourceSegments,
  sanitizePathSegment,
  validateIcebergPartitionFields,
  writeCursor,
} from '../../src/core/cache/partition.js'
import { appendRowsToTable } from '../../src/core/cache/iceberg/store.js'
import { resolveIcebergDir } from '../../src/core/cache/storage.js'

/**
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
 */

/** @type {ColumnSpec[]} */
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

// --- resolvePartitionDate ---

test('resolvePartitionDate extracts date from ISO timestamp string', () => {
  assert.equal(resolvePartitionDate({ timestamp: '2026-05-26T12:00:00Z' }), '2026-05-26')
})

test('resolvePartitionDate extracts date from Date object', () => {
  assert.equal(resolvePartitionDate({ timestamp: new Date('2026-05-26T12:00:00Z') }), '2026-05-26')
})

test('resolvePartitionDate extracts date from epoch ms number', () => {
  assert.equal(resolvePartitionDate({ timestamp: new Date('2026-05-26T00:00:00Z').getTime() }), '2026-05-26')
})

test('resolvePartitionDate extracts date from created_at field', () => {
  assert.equal(resolvePartitionDate({ created_at: '2026-05-25T08:30:00Z' }), '2026-05-25')
})

test('resolvePartitionDate extracts date from date field', () => {
  assert.equal(resolvePartitionDate({ date: '2026-05-24' }), '2026-05-24')
})

test('resolvePartitionDate returns undefined when no timestamp field present', () => {
  assert.equal(resolvePartitionDate({ id: 1, value: 'foo' }), undefined)
})

// --- resolvePartitionSegments ---

test('resolvePartitionSegments returns client+date for rows with both', () => {
  assert.deepEqual(
    resolvePartitionSegments({ client_name: 'claude', timestamp: '2026-05-26T12:00:00Z' }),
    ['client=claude', 'date=2026-05-26']
  )
})

test('resolvePartitionSegments returns client+date using fallback chain', () => {
  assert.deepEqual(
    resolvePartitionSegments({ provider: 'openai', created_at: '2026-05-25T00:00:00Z' }),
    ['client=openai', 'date=2026-05-25']
  )
})

test('resolvePartitionSegments falls back to ["all"] when no partition keys', () => {
  assert.deepEqual(
    resolvePartitionSegments({ id: 1, value: 'test' }),
    ['all']
  )
})

test('resolvePartitionSegments returns client=unknown+date when only date present', () => {
  assert.deepEqual(
    resolvePartitionSegments({ timestamp: '2026-05-26T12:00:00Z' }),
    ['client=unknown', 'date=2026-05-26']
  )
})

// --- legacy partition discovery ---

test('discoverCachePartitions detects a legacy Iceberg table without cursor.json', async () => {
  const cacheRoot = await makeTmpDir('discover-legacy')
  try {
    // Simulate the real pre-cursor legacy layout: Iceberg data directly
    // in the partition dir (no epoch= subdir, no cursor.json).
    const partDir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'proxy_messages_v4')
    await fs.mkdir(partDir, { recursive: true })
    await appendRowsToTable(partDir, TEST_COLUMNS, [{ id: 1, value: 'old' }])
    const result = await discoverCachePartitions(cacheRoot)
    assert.equal(result.length, 1)
    assert.equal(result[0].dataset, 'ai_gateway_messages')
    assert.equal(result[0].legacy, true)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('discoverCachePartitions finds both legacy and new-style partitions', async () => {
  const cacheRoot = await makeTmpDir('discover-legacy-new')
  try {
    const legacyDir = path.join(cacheRoot, 'datasets', 'ai_gw', 'proxy_messages_v4')
    await fs.mkdir(legacyDir, { recursive: true })
    await appendRowsToTable(legacyDir, TEST_COLUMNS, [{ id: 1, value: 'old' }])
    await appendRowsToPartition(cacheRoot, 'ai_gw', ['client=claude', 'date=2026-05-26'], TEST_COLUMNS, [{ id: 2, value: 'new' }])
    const result = await discoverCachePartitions(cacheRoot)
    assert.equal(result.length, 2)
    const legacy = result.find((r) => r.legacy === true)
    const modern = result.find((r) => r.partition.client === 'claude')
    assert.ok(legacy, 'legacy partition should be found')
    assert.ok(modern, 'modern partition should be found')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('discoverCachePartitions skips .retired directories', async () => {
  const cacheRoot = await makeTmpDir('discover-retired')
  try {
    await appendRowsToPartition(cacheRoot, 'data', ['client=claude', 'date=2026-05-26'], TEST_COLUMNS, [{ id: 1, value: 'live' }])
    const retiredDir = path.join(cacheRoot, 'datasets', 'data', '.retired', 'proxy_messages_v4')
    await fs.mkdir(retiredDir, { recursive: true })
    await writeCursor(retiredDir, { epoch: 0, rowCount: 5, compaction: null })
    const result = await discoverCachePartitions(cacheRoot)
    assert.equal(result.length, 1)
    assert.equal(result[0].partition.client, 'claude')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// --- sanitizePathSegment ---

test('sanitizePathSegment passes through normal values', () => {
  assert.equal(sanitizePathSegment('claude'), 'claude')
  assert.equal(sanitizePathSegment('my-app'), 'my-app')
})

test('sanitizePathSegment replaces path separators and special chars', () => {
  assert.equal(sanitizePathSegment('a/b\\c'), 'a_b_c')
  assert.equal(sanitizePathSegment('a:b*c'), 'a_b_c')
  assert.equal(sanitizePathSegment('a<b>c'), 'a_b_c')
})

test('sanitizePathSegment escapes dot and dotdot', () => {
  assert.equal(sanitizePathSegment('.'), '_._')
  assert.equal(sanitizePathSegment('..'), '_.._')
})

test('sanitizePathSegment handles empty string', () => {
  assert.equal(sanitizePathSegment(''), '_empty_')
})

test('sanitizePathSegment replaces control characters', () => {
  assert.equal(sanitizePathSegment('a\x00b\x1fc'), 'a_b_c')
})

// --- resolveSourceSegments ---

/** @type {import('../../src/core/cache/types.d.ts').CachePartitioningDeclaration} */
const AI_GATEWAY_PARTITIONING = {
  source: {
    columns: ['client_name', 'conversation_source', 'provider'],
    fallback: 'unknown',
  },
  iceberg: {
    fields: [
      { column: 'conversation_id', transform: 'identity', required: true },
      { column: 'cwd', transform: 'identity' },
      { column: 'date', transform: 'identity', required: true },
    ],
  },
}

test('resolveSourceSegments uses first non-empty source column', () => {
  assert.deepEqual(
    resolveSourceSegments({ client_name: 'claude', conversation_source: 'api', provider: 'anthropic' }, AI_GATEWAY_PARTITIONING),
    ['source=claude']
  )
})

test('resolveSourceSegments falls through source columns', () => {
  assert.deepEqual(
    resolveSourceSegments({ conversation_source: 'cli', provider: 'anthropic' }, AI_GATEWAY_PARTITIONING),
    ['source=cli']
  )
  assert.deepEqual(
    resolveSourceSegments({ provider: 'openai' }, AI_GATEWAY_PARTITIONING),
    ['source=openai']
  )
})

test('resolveSourceSegments uses fallback when no columns match', () => {
  assert.deepEqual(
    resolveSourceSegments({}, AI_GATEWAY_PARTITIONING),
    ['source=unknown']
  )
})

test('resolveSourceSegments skips empty string values', () => {
  assert.deepEqual(
    resolveSourceSegments({ client_name: '', provider: 'anthropic' }, AI_GATEWAY_PARTITIONING),
    ['source=anthropic']
  )
})

test('resolveSourceSegments sanitizes path-unsafe source values', () => {
  const result = resolveSourceSegments({ client_name: 'a/b' }, AI_GATEWAY_PARTITIONING)
  assert.deepEqual(result, ['source=a_b'])
})

// --- validateIcebergPartitionFields ---

test('validateIcebergPartitionFields passes when required fields present', () => {
  const result = validateIcebergPartitionFields(
    { conversation_id: 'conv-1', cwd: '/tmp', date: '2026-05-26' },
    AI_GATEWAY_PARTITIONING
  )
  assert.equal(result.valid, true)
  assert.deepEqual(result.missing, [])
})

test('validateIcebergPartitionFields fails when required fields missing', () => {
  const result = validateIcebergPartitionFields(
    { cwd: '/tmp' },
    AI_GATEWAY_PARTITIONING
  )
  assert.equal(result.valid, false)
  assert.deepEqual(result.missing, ['conversation_id', 'date'])
})

test('validateIcebergPartitionFields ignores optional fields', () => {
  const result = validateIcebergPartitionFields(
    { conversation_id: 'conv-1', date: '2026-05-26' },
    AI_GATEWAY_PARTITIONING
  )
  assert.equal(result.valid, true)
  assert.deepEqual(result.missing, [])
})

test('validateIcebergPartitionFields treats empty strings as missing', () => {
  const result = validateIcebergPartitionFields(
    { conversation_id: '', cwd: '/tmp', date: '2026-05-26' },
    AI_GATEWAY_PARTITIONING
  )
  assert.equal(result.valid, false)
  assert.deepEqual(result.missing, ['conversation_id'])
})

// --- readCursorSync preserves new fields ---

test('readCursorSync preserves layout and retention fields', async () => {
  const dir = await makeTmpDir('cursor-extended')
  try {
    await writeCursor(dir, {
      epoch: 0,
      rowCount: 42,
      compaction: null,
      layout: 'source-table',
      tableDir: 'table',
      retention: { lastCutoffDate: '2026-05-20', rowsDeleted: 10 },
    })
    const cursor = readCursorSync(dir)
    assert.equal(cursor.layout, 'source-table')
    assert.equal(cursor.tableDir, 'table')
    assert.deepEqual(cursor.retention, { lastCutoffDate: '2026-05-20', rowsDeleted: 10 })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('readCursorSync returns default cursor without new fields when missing', () => {
  const cursor = readCursorSync('/nonexistent/path')
  assert.equal(cursor.epoch, 0)
  assert.equal(cursor.rowCount, 0)
  assert.equal(cursor.layout, undefined)
  assert.equal(cursor.tableDir, undefined)
  assert.equal(cursor.retention, undefined)
})

// --- resolveIcebergDir ---

test('resolveIcebergDir returns tablePath/table for source-table layout', async () => {
  const dir = await makeTmpDir('resolve-source-table')
  try {
    await writeCursor(dir, {
      epoch: 0,
      rowCount: 5,
      compaction: null,
      layout: 'source-table',
    })
    assert.equal(resolveIcebergDir(dir), path.join(dir, 'table'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('resolveIcebergDir uses custom tableDir for source-table layout', async () => {
  const dir = await makeTmpDir('resolve-custom-tabledir')
  try {
    await writeCursor(dir, {
      epoch: 0,
      rowCount: 5,
      compaction: null,
      layout: 'source-table',
      tableDir: 'my-table',
    })
    assert.equal(resolveIcebergDir(dir), path.join(dir, 'my-table'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('resolveIcebergDir returns epoch path for legacy layout', async () => {
  const dir = await makeTmpDir('resolve-epoch')
  try {
    await writeCursor(dir, { epoch: 2, rowCount: 10, compaction: null })
    assert.equal(resolveIcebergDir(dir), path.join(dir, 'epoch=2'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('resolveIcebergDir returns tablePath unchanged when no cursor', () => {
  assert.equal(resolveIcebergDir('/nonexistent/path'), '/nonexistent/path')
})
