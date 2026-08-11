// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createRetentionEnforcer, DEFAULT_RETENTION_DAYS } from '../../src/core/cache/retention.js'
import { maintainCache, cacheStatus, normalizeMaintenanceConfig } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync, writeCursor } from '../../src/core/cache/partition.js'
import { appendRowsToTable, currentPartitionSpec, currentSchema, readRowsFromTable, sortColumnsFromMetadata, tableExists } from '../../src/core/cache/iceberg/store.js'
import { createLocalIcebergIO, tableUrlForDir } from '../../src/core/cache/iceberg/resolver.js'
import { TracerProvider } from '../../src/core/observability/runtime.js'
import { fileCatalog, icebergRewrite, loadLatestFileCatalogMetadata } from 'icebird'
import { parquetMetadata } from 'hyparquet'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration } from '../../src/core/cache/types.js'
 * @import { Span } from '../../src/core/observability/runtime.js'
 */

/**
 * Row-group count of every data file in a table directory, in name order.
 *
 * @param {string} tableDir
 * @returns {Promise<number[]>}
 */
async function rowGroupCounts(tableDir) {
  const dataDir = path.join(tableDir, 'data')
  const names = (await fs.readdir(dataDir)).filter((n) => n.endsWith('.parquet')).sort()
  const counts = []
  for (const name of names) {
    const bytes = await fs.readFile(path.join(dataDir, name))
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    counts.push(parquetMetadata(buffer).row_groups.length)
  }
  return counts
}

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-retention-maint-${prefix}-`))
}

/** @param {string} p @returns {Promise<boolean>} */
async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'value', type: 'STRING', nullable: true },
  { name: 'timestamp', type: 'STRING', nullable: true },
]

/**
 * @param {number} daysAgo
 * @returns {string}
 */
function isoDateDaysAgo(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
}

// --- retention tests ---

test('default retention days is 90', () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 90)
})

test('retention normalizeConfig applies defaults', () => {
  const enforcer = createRetentionEnforcer({ cacheRoot: '/tmp/fake', config: undefined })
  assert.equal(enforcer.config.default_days, 90)
  assert.deepEqual(enforcer.config.datasets, {})
})

test('retention tick on empty cache returns empty results', async () => {
  const cacheRoot = await makeTmpDir('empty')
  try {
    const enforcer = createRetentionEnforcer({ cacheRoot, config: { default_days: 7 } })
    const result = await enforcer.tick()
    assert.deepEqual(result.evicted, [])
    assert.deepEqual(result.sourceTableResults, [])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('retention commits Iceberg deletes on source-table rows older than cutoff', async () => {
  const cacheRoot = await makeTmpDir('retention-delete')
  try {
    const oldTimestamp = isoDateDaysAgo(45)
    const recentTimestamp = isoDateDaysAgo(5)

    await appendRowsToSourceTable(cacheRoot, 'test_ds', ['source=claude'], COLUMNS, [
      { id: 1, value: 'old-1', timestamp: oldTimestamp },
      { id: 2, value: 'old-2', timestamp: oldTimestamp },
      { id: 3, value: 'recent', timestamp: recentTimestamp },
    ])

    const enforcer = createRetentionEnforcer({
      cacheRoot,
      config: { default_days: 30 },
    })
    const result = await enforcer.tick()

    assert.equal(result.sourceTableResults.length, 1)
    const stResult = result.sourceTableResults[0]
    assert.equal(stResult.dataset, 'test_ds')
    assert.equal(stResult.source, 'claude')
    assert.equal(stResult.rowsDeleted, 2)
    assert.ok(stResult.batchCount >= 1)

    // cursor rowCount should be updated
    const sourceDir = path.join(cacheRoot, 'datasets', 'test_ds', 'source=claude')
    const cursor = readCursorSync(sourceDir)
    assert.equal(cursor.rowCount, 1)
    assert.ok(cursor.retention?.lastCutoffDate)
    assert.ok(cursor.retention?.lastDeletedAt)
    assert.equal(cursor.retention?.rowsDeleted, 2)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('retention skips source tables when all rows are within retention', async () => {
  const cacheRoot = await makeTmpDir('retention-skip')
  try {
    const recentTimestamp = isoDateDaysAgo(2)

    await appendRowsToSourceTable(cacheRoot, 'test_ds', ['source=claude'], COLUMNS, [
      { id: 1, value: 'recent-1', timestamp: recentTimestamp },
      { id: 2, value: 'recent-2', timestamp: recentTimestamp },
    ])

    const enforcer = createRetentionEnforcer({
      cacheRoot,
      config: { default_days: 30 },
    })
    const result = await enforcer.tick()

    assert.equal(result.sourceTableResults.length, 1)
    assert.equal(result.sourceTableResults[0].rowsDeleted, 0)

    const sourceDir = path.join(cacheRoot, 'datasets', 'test_ds', 'source=claude')
    const cursor = readCursorSync(sourceDir)
    assert.equal(cursor.rowCount, 2)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('retention respects per-dataset override', async () => {
  const cacheRoot = await makeTmpDir('retention-override')
  try {
    const ts10daysAgo = isoDateDaysAgo(10)

    await appendRowsToSourceTable(cacheRoot, 'short_ds', ['source=test'], COLUMNS, [
      { id: 1, value: 'val', timestamp: ts10daysAgo },
    ])
    await appendRowsToSourceTable(cacheRoot, 'long_ds', ['source=test'], COLUMNS, [
      { id: 2, value: 'val', timestamp: ts10daysAgo },
    ])

    const enforcer = createRetentionEnforcer({
      cacheRoot,
      config: {
        default_days: 30,
        datasets: { short_ds: 7 },
      },
    })
    const result = await enforcer.tick()

    const shortResult = result.sourceTableResults.find(r => r.dataset === 'short_ds')
    const longResult = result.sourceTableResults.find(r => r.dataset === 'long_ds')
    assert.equal(shortResult?.rowsDeleted, 1)
    assert.equal(longResult?.rowsDeleted, 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// --- cacheStatus tests ---

test('cacheStatus reports source-table layout with source field', async () => {
  const cacheRoot = await makeTmpDir('status-source')
  try {
    await appendRowsToSourceTable(cacheRoot, 'ds1', ['source=claude'], COLUMNS, [
      { id: 1, value: 'a', timestamp: new Date().toISOString() },
    ])
    await appendRowsToSourceTable(cacheRoot, 'ds1', ['source=codex'], COLUMNS, [
      { id: 2, value: 'b', timestamp: new Date().toISOString() },
    ])

    const report = await cacheStatus({ cacheRoot })
    assert.equal(report.partitions.length, 2)

    const claude = report.partitions.find(p => p.source === 'claude')
    const codex = report.partitions.find(p => p.source === 'codex')

    assert.ok(claude)
    assert.equal(claude.dataset, 'ds1')
    assert.equal(claude.layout, 'source-table')
    assert.equal(claude.rowCount, 1)
    assert.ok(typeof claude.dataFileCount === 'number')
    assert.ok(typeof claude.snapshotCount === 'number')

    assert.ok(codex)
    assert.equal(codex.layout, 'source-table')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('cacheStatus reports lastRetentionCutoffDate after retention runs', async () => {
  const cacheRoot = await makeTmpDir('status-cutoff')
  try {
    await appendRowsToSourceTable(cacheRoot, 'ds1', ['source=test'], COLUMNS, [
      { id: 1, value: 'old', timestamp: isoDateDaysAgo(60) },
      { id: 2, value: 'new', timestamp: isoDateDaysAgo(1) },
    ])

    const enforcer = createRetentionEnforcer({
      cacheRoot,
      config: { default_days: 30 },
    })
    await enforcer.tick()

    const report = await cacheStatus({ cacheRoot })
    const part = report.partitions.find(p => p.source === 'test')
    assert.ok(part)
    assert.ok(part.lastRetentionCutoffDate)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// --- maintenance tests ---

test('normalizeMaintenanceConfig fills defaults', () => {
  const cfg = normalizeMaintenanceConfig(undefined)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.interval_minutes, 60)
  assert.equal(cfg.min_snapshots_to_keep, 10)
})

test('maintenance counts data files and snapshots for source tables', async () => {
  const cacheRoot = await makeTmpDir('maint-count')
  try {
    for (let i = 0; i < 5; i++) {
      await appendRowsToSourceTable(cacheRoot, 'ds1', ['source=test'], COLUMNS, [
        { id: i, value: `v${i}`, timestamp: new Date().toISOString() },
      ])
    }

    const report = await maintainCache({
      cacheRoot,
      dryRun: true,
    })

    assert.equal(report.partitions.length, 1)
    const p = report.partitions[0]
    assert.equal(p.dataset, 'ds1')
    assert.ok(p.dataFilesBefore >= 5)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('maintenance expires snapshots on source tables', async () => {
  const cacheRoot = await makeTmpDir('maint-expire')
  try {
    for (let i = 0; i < 15; i++) {
      await appendRowsToSourceTable(cacheRoot, 'ds1', ['source=test'], COLUMNS, [
        { id: i, value: `v${i}`, timestamp: new Date().toISOString() },
      ])
    }

    const report = await maintainCache({
      cacheRoot,
      expireOnly: true,
      config: {
        min_snapshots_to_keep: 2,
        max_snapshot_age_hours: 0,
      },
    })

    assert.ok(report.totalSnapshotsExpired > 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('compaction preserves source-table layout', async () => {
  const cacheRoot = await makeTmpDir('maint-compact')
  try {
    for (let i = 0; i < 40; i++) {
      await appendRowsToSourceTable(cacheRoot, 'ds1', ['source=test'], COLUMNS, [
        { id: i, value: `v${i}`, timestamp: new Date().toISOString() },
      ])
    }

    const report = await maintainCache({
      cacheRoot,
      force: true,
      compactOnly: true,
    })

    assert.ok(report.totalCompacted > 0)

    const sourceDir = path.join(cacheRoot, 'datasets', 'ds1', 'source=test')
    const cursor = readCursorSync(sourceDir)
    assert.equal(cursor.layout, 'source-table')
    assert.equal(cursor.rowCount, 40)

    const tableDir = path.join(sourceDir, 'table')
    assert.ok(tableExists(tableDir))
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('compaction retires empty source table and advances cursor', async () => {
  const cacheRoot = await makeTmpDir('maint-empty-source')
  try {
    const sourceDir = path.join(cacheRoot, 'datasets', 'ds1', 'source=test')
    const tableDir = path.join(sourceDir, 'table')
    await appendRowsToTable(tableDir, COLUMNS, [])
    await writeCursor(sourceDir, {
      epoch: 0,
      rowCount: 0,
      compaction: null,
      layout: 'source-table',
      tableDir: 'table',
    })

    const report = await maintainCache({
      cacheRoot,
      force: true,
      compactOnly: true,
    })

    assert.equal(report.totalCompacted, 1)
    const cursor = readCursorSync(sourceDir)
    assert.equal(cursor.layout, 'source-table')
    assert.equal(cursor.rowCount, 0)
    assert.notEqual(cursor.tableDir, 'table')
    await fs.stat(path.join(tableDir, '.retired'))
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('compaction preserves partition spec and column types from declaration', async () => {
  const cacheRoot = await makeTmpDir('maint-compact-decl')
  try {
    /** @type {ColumnSpec[]} */
    const declColumns = [
      { name: 'conversation_id', type: 'STRING', nullable: false },
      { name: 'date', type: 'STRING', nullable: false },
      { name: 'message', type: 'STRING', nullable: true },
    ]
    /** @type {CachePartitioningDeclaration} */
    const declaration = {
      source: { columns: ['conversation_id'] },
      iceberg: {
        fields: [
          { column: 'conversation_id', transform: 'identity', required: true },
          { column: 'date', transform: 'identity', required: true },
        ],
      },
    }

    for (let i = 0; i < 40; i++) {
      await appendRowsToSourceTable(cacheRoot, 'ds1', ['source=test'], declColumns, [
        { conversation_id: `c${i}`, date: '2026-05-27', message: `msg-${i}` },
      ], { declaration })
    }

    const sourceDir = path.join(cacheRoot, 'datasets', 'ds1', 'source=test')
    const tableDirBefore = path.join(sourceDir, 'table')
    const { resolver, lister } = await createLocalIcebergIO()
    const urlBefore = tableUrlForDir(tableDirBefore)
    const { metadata: metaBefore } = await loadLatestFileCatalogMetadata({ tableUrl: urlBefore, resolver, lister })
    const specBefore = currentPartitionSpec(metaBefore)
    const schemaBefore = currentSchema(metaBefore)
    assert.ok(specBefore, 'pre-compaction table should have a partition spec')
    assert.equal(specBefore.fields.length, 2)
    assert.ok(schemaBefore?.fields.some(f => f.name === 'conversation_id' && f.required === true))

    await maintainCache({ cacheRoot, force: true, compactOnly: true })

    const cursorAfter = readCursorSync(sourceDir)
    const newTableDir = path.join(sourceDir, cursorAfter.tableDir ?? 'table')
    const urlAfter = tableUrlForDir(newTableDir)
    const { metadata: metaAfter } = await loadLatestFileCatalogMetadata({ tableUrl: urlAfter, resolver, lister })
    const specAfter = currentPartitionSpec(metaAfter)
    const schemaAfter = currentSchema(metaAfter)

    assert.ok(specAfter, 'post-compaction table must preserve partition spec')
    assert.equal(specAfter.fields.length, 2)
    assert.equal(specAfter.fields[0].name, 'conversation_id')
    assert.equal(specAfter.fields[1].name, 'date')

    assert.ok(schemaAfter?.fields.some(f => f.name === 'conversation_id' && f.required === true),
      'required columns must stay required after compaction')

    assert.equal(cursorAfter.rowCount, 40)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('retention second tick reports zero newly deleted rows (no duplicate deletes)', async () => {
  const cacheRoot = await makeTmpDir('retention-two-tick')
  try {
    const oldTimestamp = isoDateDaysAgo(45)
    const recentTimestamp = isoDateDaysAgo(5)

    await appendRowsToSourceTable(cacheRoot, 'test_ds', ['source=claude'], COLUMNS, [
      { id: 1, value: 'old-1', timestamp: oldTimestamp },
      { id: 2, value: 'old-2', timestamp: oldTimestamp },
      { id: 3, value: 'recent', timestamp: recentTimestamp },
    ])

    const enforcer = createRetentionEnforcer({
      cacheRoot,
      config: { default_days: 30 },
    })

    const result1 = await enforcer.tick()
    assert.equal(result1.sourceTableResults.length, 1)
    assert.equal(result1.sourceTableResults[0].rowsDeleted, 2)

    const result2 = await enforcer.tick()
    assert.equal(result2.sourceTableResults.length, 1)
    assert.equal(result2.sourceTableResults[0].rowsDeleted, 0,
      'second tick should not re-delete already-deleted rows')

    const sourceDir = path.join(cacheRoot, 'datasets', 'test_ds', 'source=claude')
    const cursor = readCursorSync(sourceDir)
    assert.equal(cursor.rowCount, 1)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('retention re-scans unchanged source table when cutoff advances', async () => {
  const cacheRoot = await makeTmpDir('retention-cutoff-advance')
  try {
    await appendRowsToSourceTable(cacheRoot, 'test_ds', ['source=claude'], COLUMNS, [
      { id: 1, value: 'ages-later', timestamp: '2026-04-28T12:00:00.000Z' },
      { id: 2, value: 'still-new', timestamp: '2026-05-20T00:00:00.000Z' },
    ])

    const enforcer = createRetentionEnforcer({
      cacheRoot,
      config: { default_days: 30 },
    })

    const result1 = await enforcer.tick({ now: new Date('2026-05-28T00:00:00.000Z') })
    assert.equal(result1.sourceTableResults[0].rowsDeleted, 0)

    const result2 = await enforcer.tick({ now: new Date('2026-05-29T00:00:00.000Z') })
    assert.equal(result2.sourceTableResults[0].rowsDeleted, 1)

    const sourceDir = path.join(cacheRoot, 'datasets', 'test_ds', 'source=claude')
    const cursor = readCursorSync(sourceDir)
    assert.equal(cursor.rowCount, 1)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('retention uses dataset primaryTimestampColumn for source tables', async () => {
  const cacheRoot = await makeTmpDir('retention-primary-ts')
  try {
    /** @type {ColumnSpec[]} */
    const columns = [
      { name: 'id', type: 'INT32', nullable: false },
      { name: 'event_time', type: 'STRING', nullable: true },
      { name: 'message', type: 'STRING', nullable: true },
    ]
    await appendRowsToSourceTable(cacheRoot, 'event_ds', ['source=test'], columns, [
      { id: 1, event_time: '2026-04-01T00:00:00.000Z', message: 'old' },
      { id: 2, event_time: '2026-05-27T00:00:00.000Z', message: 'new' },
    ])

    const enforcer = createRetentionEnforcer({
      cacheRoot,
      config: { default_days: 30 },
      getDataset: (dataset) => dataset === 'event_ds'
        ? { primaryTimestampColumn: 'event_time', fallbackTimestampColumns: [] }
        : undefined,
    })

    const result = await enforcer.tick({ now: new Date('2026-05-28T00:00:00.000Z') })
    assert.equal(result.sourceTableResults[0].rowsDeleted, 1)

    const sourceDir = path.join(cacheRoot, 'datasets', 'event_ds', 'source=test')
    const rows = await readRowsFromTable(path.join(sourceDir, 'table'))
    assert.deepEqual(rows.map(row => row.id), [2])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('retention evicts source table by mtime when no timestamp column is resolvable', async () => {
  const cacheRoot = await makeTmpDir('retention-mtime-fallback')
  try {
    await appendRowsToSourceTable(cacheRoot, 'no_ts_ds', ['source=test'], [
      { name: 'id', type: 'INT32', nullable: false },
      { name: 'message', type: 'STRING', nullable: true },
    ], [
      { id: 1, message: 'no timestamp' },
    ])

    const enforcer = createRetentionEnforcer({
      cacheRoot,
      config: { default_days: 30 },
    })

    const result = await enforcer.tick({ now: new Date('2100-01-01T00:00:00.000Z') })
    assert.equal(result.sourceTableResults[0].rowsDeleted, 1)

    const sourceDir = path.join(cacheRoot, 'datasets', 'no_ts_ds', 'source=test')
    await assert.rejects(fs.stat(sourceDir), /ENOENT/)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('retention cursor stays accurate after new data arrives between ticks', async () => {
  const cacheRoot = await makeTmpDir('retention-interleave')
  try {
    const oldTimestamp = isoDateDaysAgo(45)
    const recentTimestamp = isoDateDaysAgo(5)

    await appendRowsToSourceTable(cacheRoot, 'test_ds', ['source=claude'], COLUMNS, [
      { id: 1, value: 'old-1', timestamp: oldTimestamp },
      { id: 2, value: 'old-2', timestamp: oldTimestamp },
      { id: 3, value: 'recent', timestamp: recentTimestamp },
    ])

    const enforcer = createRetentionEnforcer({
      cacheRoot,
      config: { default_days: 30 },
    })

    const result1 = await enforcer.tick()
    assert.equal(result1.sourceTableResults[0].rowsDeleted, 2)

    // New data arrives: creates a new snapshot, triggering a re-scan
    await appendRowsToSourceTable(cacheRoot, 'test_ds', ['source=claude'], COLUMNS, [
      { id: 4, value: 'new-recent', timestamp: recentTimestamp },
    ])

    const result2 = await enforcer.tick()
    assert.equal(result2.sourceTableResults[0].rowsDeleted, 0,
      'new recent data should not trigger duplicate deletes for prior expired rows')
    // Old expired rows are still in data files but position-deleted;
    // cursor rowCount must reflect actual visible rows, not drift.
    const sourceDir = path.join(cacheRoot, 'datasets', 'test_ds', 'source=claude')
    const cursor = readCursorSync(sourceDir)
    assert.equal(cursor.rowCount, 2, 'cursor should reflect 2 visible rows (1 original recent + 1 new)')

    const rows = await readRowsFromTable(path.join(sourceDir, 'table'))
    assert.equal(rows.length, 2, 'table should have 2 visible rows')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('source-table directory remains intact after retention', async () => {
  const cacheRoot = await makeTmpDir('retention-intact')
  try {
    await appendRowsToSourceTable(cacheRoot, 'ds1', ['source=test'], COLUMNS, [
      { id: 1, value: 'old', timestamp: isoDateDaysAgo(60) },
    ])

    const enforcer = createRetentionEnforcer({
      cacheRoot,
      config: { default_days: 30 },
    })
    await enforcer.tick()

    const sourceDir = path.join(cacheRoot, 'datasets', 'ds1', 'source=test')
    const tableDir = path.join(sourceDir, 'table')
    const stat = await fs.stat(sourceDir)
    assert.ok(stat.isDirectory())
    assert.ok(tableExists(tableDir))
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// --- memory-safe compaction (byte-aware batching) ---

test('normalizeMaintenanceConfig fills compact_batch_bytes default', () => {
  const cfg = normalizeMaintenanceConfig(undefined)
  assert.equal(cfg.compact_batch_bytes, 32 * 1024 * 1024)
})

test('normalizeMaintenanceConfig honours an explicit compact_batch_bytes', () => {
  const cfg = normalizeMaintenanceConfig({ compact_batch_bytes: 1234 })
  assert.equal(cfg.compact_batch_bytes, 1234)
})

// @ref LLP 0209#row-groups [tests]: the byte budget still bounds a batch, but
// what it produces is a row group, not a data file.
test('compaction flushes by byte budget so a fat column cannot blow up one batch', async () => {
  const cacheRoot = await makeTmpDir('maint-bytecap')
  try {
    // 20 rows, each carrying a ~80KB (UTF-16) value blob.
    const blob = 'x'.repeat(40_000)
    for (let i = 0; i < 20; i++) {
      await appendRowsToSourceTable(cacheRoot, 'ds1', ['source=test'], COLUMNS, [
        { id: i, value: blob, timestamp: new Date().toISOString() },
      ])
    }

    // A 150KB byte budget forces a flush roughly every two rows, so the
    // rewrite never holds more than a couple of rows at once.
    const report = await maintainCache({
      cacheRoot,
      force: true,
      compactOnly: true,
      config: { compact_batch_bytes: 150_000 },
    })

    assert.ok(report.totalCompacted > 0)
    const p = report.partitions[0]
    // The blob compresses far below `target_file_bytes`, so the many flushes
    // land as many row groups in ONE file.
    assert.equal(p.dataFilesAfter, 1)

    const sourceDir = path.join(cacheRoot, 'datasets', 'ds1', 'source=test')
    const cursor = readCursorSync(sourceDir)
    assert.equal(cursor.rowCount, 20)
    const liveDir = path.join(sourceDir, cursor.tableDir ?? 'table')
    assert.ok(
      (await rowGroupCounts(liveDir))[0] > 1,
      'expected the byte budget to flush more than one row group'
    )

    // All rows survive the split, and the data round-trips intact.
    const rows = await readRowsFromTable(liveDir)
    assert.equal(rows.length, 20)
    assert.equal(rows.every((r) => r.value === blob), true)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a generous byte budget compacts the same input into a single row group', async () => {
  const cacheRoot = await makeTmpDir('maint-bigcap')
  try {
    const blob = 'x'.repeat(40_000)
    for (let i = 0; i < 20; i++) {
      await appendRowsToSourceTable(cacheRoot, 'ds1', ['source=test'], COLUMNS, [
        { id: i, value: blob, timestamp: new Date().toISOString() },
      ])
    }

    const report = await maintainCache({
      cacheRoot,
      force: true,
      compactOnly: true,
      config: { compact_batch_bytes: 256 * 1024 * 1024 },
    })

    const p = report.partitions[0]
    assert.equal(p.dataFilesAfter, 1)
    const sourceDir = path.join(cacheRoot, 'datasets', 'ds1', 'source=test')
    const cursor = readCursorSync(sourceDir)
    const liveDir = path.join(sourceDir, cursor.tableDir ?? 'table')
    assert.deepEqual(await rowGroupCounts(liveDir), [1])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// --- orphan generation cleanup ---

test('maintenance reclaims a stale cursor-orphaned table dir with no .retired marker', async () => {
  const cacheRoot = await makeTmpDir('maint-orphan')
  try {
    // A live source table whose cursor points at `table`.
    await appendRowsToSourceTable(cacheRoot, 'ds1', ['source=test'], COLUMNS, [
      { id: 1, value: 'live', timestamp: new Date().toISOString() },
    ])
    const sourceDir = path.join(cacheRoot, 'datasets', 'ds1', 'source=test')
    assert.equal(readCursorSync(sourceDir).tableDir ?? 'table', 'table')

    // A leaked generation from a crashed compaction: table-prefixed,
    // unreferenced by the cursor, no `.retired` marker, aged past grace.
    const orphan = path.join(sourceDir, 'table-1700000000000')
    await fs.mkdir(path.join(orphan, 'data'), { recursive: true })
    await fs.writeFile(path.join(orphan, 'data', 'leak.parquet'), 'garbage')
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await fs.utimes(orphan, stale, stale)

    // A second generation that is still fresh: must be treated as a
    // possibly-in-flight compaction and left alone.
    const fresh = path.join(sourceDir, 'table-1800000000000')
    await fs.mkdir(path.join(fresh, 'data'), { recursive: true })
    await fs.writeFile(path.join(fresh, 'data', 'inflight.parquet'), 'wip')

    await maintainCache({ cacheRoot, expireOnly: true })

    assert.equal(await pathExists(orphan), false, 'stale orphan should be reclaimed')
    assert.equal(await pathExists(fresh), true, 'fresh generation must be preserved')
    assert.ok(tableExists(path.join(sourceDir, 'table')), 'live table must remain')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('orphan sweep never deletes the live table when cursor.json is unreadable', async () => {
  const cacheRoot = await makeTmpDir('maint-corrupt-cursor')
  try {
    await appendRowsToSourceTable(cacheRoot, 'ds1', ['source=test'], COLUMNS, [
      { id: 1, value: 'live', timestamp: new Date().toISOString() },
    ])
    const sourceDir = path.join(cacheRoot, 'datasets', 'ds1', 'source=test')
    const liveTable = path.join(sourceDir, 'table')
    assert.ok(tableExists(liveTable))

    // Corrupt the cursor and age the live table past the orphan grace.
    // A corrupt cursor must NOT be read as the default {epoch:0}, which
    // would otherwise make the live `table` dir an orphan-delete target.
    await fs.writeFile(path.join(sourceDir, 'cursor.json'), '{ this is not valid json', 'utf8')
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await fs.utimes(liveTable, stale, stale)

    await maintainCache({ cacheRoot, expireOnly: true })

    assert.ok(tableExists(liveTable), 'live table must survive an unreadable cursor')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('orphan sweep reclaims a stale epoch generation and keeps the live one', async () => {
  const cacheRoot = await makeTmpDir('maint-epoch-orphan')
  try {
    const sourceDir = path.join(cacheRoot, 'datasets', 'ds1', 'source=test')
    const live = path.join(sourceDir, 'epoch=1')
    await appendRowsToTable(live, COLUMNS, [
      { id: 1, value: 'live', timestamp: new Date().toISOString() },
    ])
    await writeCursor(sourceDir, {
      epoch: 1,
      rowCount: 1,
      compaction: null,
      layout: 'epoch',
    })

    const orphan = path.join(sourceDir, 'epoch=0')
    await fs.mkdir(path.join(orphan, 'data'), { recursive: true })
    await fs.writeFile(path.join(orphan, 'data', 'leak.parquet'), 'garbage')
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await fs.utimes(orphan, stale, stale)

    await maintainCache({ cacheRoot, expireOnly: true })

    assert.equal(await pathExists(orphan), false, 'stale epoch orphan should be reclaimed')
    assert.ok(tableExists(live), 'live epoch generation must remain')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('legacy epoch compaction preserves the table sort order', async () => {
  const cacheRoot = await makeTmpDir('maint-epoch-sort')
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'ds1', 'source=test')
    const epoch0 = path.join(partDir, 'epoch=0')
    for (let i = 0; i < 3; i++) {
      await appendRowsToTable(epoch0, COLUMNS, [
        { id: i, value: `v${i}`, timestamp: new Date().toISOString() },
      ], { sortOrder: [{ column: 'id', direction: 'asc' }] })
    }
    await writeCursor(partDir, {
      epoch: 0,
      rowCount: 3,
      compaction: null,
      layout: 'epoch',
    })

    const report = await maintainCache({ cacheRoot, force: true, compactOnly: true })
    assert.ok(report.totalCompacted > 0)

    const epoch1 = path.join(partDir, 'epoch=1')
    assert.ok(tableExists(epoch1), 'compaction should write the next epoch generation')
    const { resolver, lister } = await createLocalIcebergIO()
    const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl: tableUrlForDir(epoch1), resolver, lister })
    assert.deepEqual(
      sortColumnsFromMetadata(metadata),
      [{ column: 'id', direction: 'asc' }],
      'the epoch swap must carry the declared sort order'
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// --- convergence: baseline gate and neediest-first order (LLP 0199) ---

test('an already-compacted partition is not recompacted until new data flushes', async () => {
  const cacheRoot = await makeTmpDir('maint-baseline')
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'ds1', 'date=2026-08-01')
    const epoch0 = path.join(partDir, 'epoch=0')
    for (let i = 0; i < 3; i++) {
      await appendRowsToTable(epoch0, COLUMNS, [
        { id: i, value: `v${i}`, timestamp: new Date().toISOString() },
      ])
    }
    await writeCursor(partDir, { epoch: 0, rowCount: 3, compaction: null, layout: 'epoch' })

    // Tiny files: the avg-file-size heuristic marks the partition due.
    const first = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(first.totalCompacted, 1)
    assert.equal(readCursorSync(partDir).epoch, 1)

    // The rewrite's output files are still below compact_avg_file_bytes,
    // but nothing has flushed since: the partition has converged.
    const second = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(second.totalCompacted, 0)
    assert.equal(readCursorSync(partDir).epoch, 1)

    // New data moves the file count off the baseline: due again.
    await appendRowsToTable(path.join(partDir, 'epoch=1'), COLUMNS, [
      { id: 99, value: 'fresh', timestamp: new Date().toISOString() },
    ])
    const third = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(third.totalCompacted, 1)
    assert.equal(readCursorSync(partDir).epoch, 2)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// --- foreign sorted replace recognition (LLP 0207) ---

/**
 * Commit the central server's export-time rewrite shape onto a live
 * generation dir: an in-place `replace` snapshot through icebird, no
 * cursor touch (the server knows nothing about kernel cursors).
 *
 * @param {string} tableDir
 */
async function commitForeignReplace(tableDir) {
  const { resolver, lister } = await createLocalIcebergIO()
  const catalog = fileCatalog({ resolver, lister, conditionalCommits: true })
  await icebergRewrite({ catalog, tableUrl: tableUrlForDir(tableDir), targetFileRows: 100_000 })
}

test('a foreign sorted replace re-baselines the cursor instead of being rewritten', async () => {
  const cacheRoot = await makeTmpDir('maint-foreign-replace')
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'ds1', 'date=2026-08-08')
    const epoch0 = path.join(partDir, 'epoch=0')
    for (let i = 0; i < 3; i++) {
      await appendRowsToTable(epoch0, COLUMNS, [
        { id: i, value: `v${i}`, timestamp: new Date().toISOString() },
      ], { sortOrder: [{ column: 'id', direction: 'asc' }] })
    }
    await commitForeignReplace(epoch0)
    // A kernel cursor whose baseline no longer matches the live count: the
    // replace read as growth before LLP 0207.
    await writeCursor(partDir, {
      epoch: 0,
      rowCount: 3,
      layout: 'epoch',
      compaction: { compactedAt: '2026-08-08T00:00:00.000Z', resettleBaselineFiles: 99 },
    })

    // A dry run predicts the recognition without writing anything.
    const preview = await maintainCache({ cacheRoot, compactOnly: true, dryRun: true })
    assert.equal(preview.totalCompacted, 0)
    assert.equal(preview.totalRebaselined, 1, 'the report-level rebaseline count mirrors totalCompacted')
    assert.equal(preview.partitions[0].rebaselined, true)
    assert.equal(
      /** @type {{ resettleBaselineFiles: number }} */ (readCursorSync(partDir).compaction).resettleBaselineFiles,
      99,
      'dry run must not touch the cursor'
    )

    const first = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(first.totalCompacted, 0)
    assert.equal(first.totalRebaselined, 1, 're-baselining one partition must be reflected in the report total')
    assert.equal(first.partitions[0].rebaselined, true)
    const cursor = readCursorSync(partDir)
    assert.equal(cursor.epoch, 0, 'no rewrite: the generation must not advance')
    const compaction = /** @type {{ compactedAt: string, resettleBaselineFiles: number }} */ (cursor.compaction)
    assert.equal(compaction.resettleBaselineFiles, first.partitions[0].dataFilesBefore, 're-baselined to the live data-file count')
    assert.equal(compaction.compactedAt, '2026-08-08T00:00:00.000Z', 'recognition is not a compaction')
    assert.equal((await readRowsFromTable(epoch0)).length, 3, 'the foreign generation keeps its rows')

    // Converged: the baseline gate now blocks before any metadata load.
    const second = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(second.totalCompacted, 0)
    assert.equal(second.totalRebaselined, 0, 'converged: no rebaseline happened this tick')
    assert.notEqual(second.partitions[0].rebaselined, true)

    // A late append flips the current snapshot off `replace` and moves the
    // count off the baseline: genuinely due again, unchanged behavior.
    await appendRowsToTable(epoch0, COLUMNS, [
      { id: 99, value: 'fresh', timestamp: new Date().toISOString() },
    ], { sortOrder: [{ column: 'id', direction: 'asc' }] })
    const third = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(third.totalCompacted, 1)
    assert.equal(readCursorSync(partDir).epoch, 1)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('foreign sorted replace recognition works on the source-table layout', async () => {
  const cacheRoot = await makeTmpDir('maint-foreign-source')
  try {
    // Same recognition claim as above, but for the layout where the live
    // generation is `tableDir` rather than `epoch=N`: the server's day
    // compactor resolves and rewrites both layouts in prod.
    const partDir = path.join(cacheRoot, 'datasets', 'ds1', 'source=test')
    const tableDir = path.join(partDir, 'table')
    for (let i = 0; i < 3; i++) {
      await appendRowsToTable(tableDir, COLUMNS, [
        { id: i, value: `v${i}`, timestamp: new Date().toISOString() },
      ], { sortOrder: [{ column: 'id', direction: 'asc' }] })
    }
    await commitForeignReplace(tableDir)
    await writeCursor(partDir, {
      epoch: 0,
      rowCount: 3,
      compaction: { compactedAt: '2026-08-08T00:00:00.000Z', resettleBaselineFiles: 99 },
      layout: 'source-table',
      tableDir: 'table',
      retention: { lastCutoffDate: '2026-05-01' },
    })

    const report = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(report.totalCompacted, 0)
    assert.equal(report.partitions[0].rebaselined, true)
    const cursor = readCursorSync(partDir)
    assert.equal(cursor.tableDir, 'table', 'no generation swap: the cursor keeps pointing at the foreign rewrite')
    assert.equal(cursor.retention?.lastCutoffDate, '2026-05-01', 'the rebaseline preserves the retention state')
    const compaction = /** @type {{ resettleBaselineFiles: number }} */ (cursor.compaction)
    assert.equal(compaction.resettleBaselineFiles, report.partitions[0].dataFilesBefore)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('recognition outranks the re-settle force: a fallback row does not undo the sorted layout', async () => {
  const cacheRoot = await makeTmpDir('maint-foreign-resettle')
  try {
    // A committed provisional fallback row (LLP 0027 marker) normally
    // forces a rewrite so the sweep can re-settle it. Under a foreign
    // sorted replace that force must lose, or one leftover unmatchable
    // fallback re-shreds the sorted layout every night (LLP 0207).
    /** @type {ColumnSpec[]} */
    const columns = [...COLUMNS, { name: 'attributes', type: 'STRING', nullable: true }]
    const partDir = path.join(cacheRoot, 'datasets', 'ds1', 'date=2026-08-08')
    const epoch0 = path.join(partDir, 'epoch=0')
    await appendRowsToTable(epoch0, columns, [
      { id: 1, value: 'v1', timestamp: new Date().toISOString(), attributes: JSON.stringify({ gateway: { identity_source: 'gateway_fallback' } }) },
    ], { sortOrder: [{ column: 'id', direction: 'asc' }] })
    await commitForeignReplace(epoch0)
    await writeCursor(partDir, { epoch: 0, rowCount: 1, compaction: null, layout: 'epoch' })

    const report = await maintainCache({
      cacheRoot,
      compactOnly: true,
      storage: /** @type {any} */ ({}),
      getSettleHook: () => () => {
        throw new Error('the sweep must not run: recognition should skip the rewrite entirely')
      },
    })
    assert.equal(report.totalCompacted, 0)
    assert.equal(report.partitions[0].rebaselined, true)
    assert.equal(readCursorSync(partDir).epoch, 0, 'the fallback row must not force a shredding rewrite')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a foreign replace without a declared sort order is not blessed', async () => {
  const cacheRoot = await makeTmpDir('maint-foreign-unsorted')
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'ds1', 'date=2026-08-08')
    const epoch0 = path.join(partDir, 'epoch=0')
    for (let i = 0; i < 3; i++) {
      await appendRowsToTable(epoch0, COLUMNS, [
        { id: i, value: `v${i}`, timestamp: new Date().toISOString() },
      ])
    }
    await commitForeignReplace(epoch0)
    await writeCursor(partDir, { epoch: 0, rowCount: 3, compaction: null, layout: 'epoch' })

    const report = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(report.totalCompacted, 1, 'an arbitrary replace earns no convergence credit')
    assert.notEqual(report.partitions[0].rebaselined, true)
    assert.equal(readCursorSync(partDir).epoch, 1)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('force still rewrites a foreign sorted replace', async () => {
  const cacheRoot = await makeTmpDir('maint-foreign-force')
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'ds1', 'date=2026-08-08')
    const epoch0 = path.join(partDir, 'epoch=0')
    await appendRowsToTable(epoch0, COLUMNS, [
      { id: 1, value: 'v1', timestamp: new Date().toISOString() },
    ], { sortOrder: [{ column: 'id', direction: 'asc' }] })
    await commitForeignReplace(epoch0)
    await writeCursor(partDir, { epoch: 0, rowCount: 1, compaction: null, layout: 'epoch' })

    const report = await maintainCache({ cacheRoot, force: true, compactOnly: true })
    assert.equal(report.totalCompacted, 1, 'an explicit force is an operator override')
    assert.equal(readCursorSync(partDir).epoch, 1)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a foreign sorted replace tags the maintenance.partition span with rebaselined', async () => {
  const cacheRoot = await makeTmpDir('maint-foreign-span')
  /** @type {Span[]} */
  const captured = []
  const provider = new TracerProvider({
    resource: { attributes: {} },
    exporters: [{ exportBatch(/** @type {Span[]} */ spans) { captured.push(...spans) } }],
  })
  provider.register()
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'ds1', 'date=2026-08-08')
    const epoch0 = path.join(partDir, 'epoch=0')
    for (let i = 0; i < 3; i++) {
      await appendRowsToTable(epoch0, COLUMNS, [
        { id: i, value: `v${i}`, timestamp: new Date().toISOString() },
      ], { sortOrder: [{ column: 'id', direction: 'asc' }] })
    }
    await commitForeignReplace(epoch0)
    await writeCursor(partDir, {
      epoch: 0,
      rowCount: 3,
      layout: 'epoch',
      compaction: { compactedAt: '2026-08-08T00:00:00.000Z', resettleBaselineFiles: 99 },
    })

    const report = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(report.partitions[0].rebaselined, true, 'sanity: this tick recognized the foreign replace')

    const partitionSpan = captured.find((span) => span.name === 'maintenance.partition')
    assert.ok(partitionSpan, 'maintenance.partition span must be exported')
    assert.equal(
      partitionSpan?.attributes.rebaselined,
      true,
      'the span, not just the hyp_rebaselines counter, must name which partition re-baselined'
    )
  } finally {
    await provider.shutdown()
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a partition already due for compaction skips the resettle-candidate row scan', async (t) => {
  // @ref LLP 0207#outranks-resettle [tests]: once the cheap file-count/size
  // check alone makes compaction due, the resettle scan's answer cannot
  // change `shouldCompact`, so it must not run at all. `hasResettleCandidate`
  // is module-private and its `scanRowsFromTable` is an unpatchable ESM named
  // import, so there is no direct call-count hook to assert against; instead
  // this mocks `readFileSync` and captures a stack trace per `.parquet` read,
  // then asserts none of those stacks pass through `hasResettleCandidate`.
  // That frame name survives the async boundary between the scan and the
  // read, so it attributes each read to its caller instead of only counting
  // reads tick-wide (a second legitimate read elsewhere in the tick, e.g. a
  // footer-stats probe, would not falsely implicate the scan).
  //
  // A stack-based observation can go blind: the deciding frame sits ~8 frames
  // below the mock, and V8's default `Error.stackTraceLimit` of 10 leaves only
  // two frames of headroom. Three more frames anywhere between the mock and
  // the caller (an icebird refactor, extra node:test mock internals, a wrapper
  // in `resolver.js`) would drop it, and a negative "no stack mentions
  // `hasResettleCandidate`" assertion passes vacuously on truncated stacks.
  // Two guards keep that from happening silently:
  //   1. raise `Error.stackTraceLimit` while the mock is installed (restored
  //      below even if the test throws), which removes the hazard outright;
  //   2. assert positively that some stack names `compactGeneration`, the
  //      legitimate reader. It calls `scanRowsFromTable` from exactly the same
  //      depth as `hasResettleCandidate` does, so any truncation deep enough
  //      to hide the frame the negative assertion hunts for also hides this
  //      one, and the test fails loudly instead of going quiet. Asserting on
  //      `scanRowsFromTable` itself would not do: it sits one frame shallower
  //      and survives truncation that has already blinded the real check.
  // Guard 2 also catches the `?? ''` fallback below storing an unattributable
  // empty string.
  const cacheRoot = await makeTmpDir('maint-scan-skip')
  const originalStackTraceLimit = Error.stackTraceLimit
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'ds1', 'date=2026-08-08')
    const epoch0 = path.join(partDir, 'epoch=0')
    await appendRowsToTable(epoch0, COLUMNS, [
      { id: 1, value: 'v1', timestamp: new Date().toISOString() },
    ])
    // Never compacted: `grewSinceCompaction` is true unconditionally, so the
    // only thing standing between the old code and a resettle scan is the
    // `compactionDue` gate under test.
    await writeCursor(partDir, { epoch: 0, rowCount: 1, compaction: null, layout: 'epoch' })

    /** @type {string[]} */
    const stacks = []
    const original = fsSync.readFileSync
    Error.stackTraceLimit = 50
    t.mock.method(fsSync, 'readFileSync', function (p, ...rest) {
      if (String(p).endsWith('.parquet')) stacks.push(new Error().stack ?? '')
      return original.call(this, p, ...rest)
    })

    const report = await maintainCache({
      cacheRoot,
      compactOnly: true,
      // compact_file_count: 0 makes `needsCompaction` (and so
      // `compactionDue`) true on file count alone, with no size heuristic
      // involved: dueness is settled before the resettle scan would run.
      config: { compact_file_count: 0 },
      storage: /** @type {any} */ ({}),
      getSettleHook: () => async (rows) => rows,
    })
    assert.equal(report.totalCompacted, 1, 'sanity: compaction actually ran')

    assert.ok(stacks.length > 0, 'sanity: the data file was read at all')
    assert.ok(
      stacks.some((s) => s.includes('compactGeneration')),
      'sanity: captured stacks must be deep enough to name the reader, or the assertion below passes vacuously'
    )
    assert.deepEqual(
      stacks.filter((s) => s.includes('hasResettleCandidate')),
      [],
      'the resettle scan must not read the data file'
    )
  } finally {
    Error.stackTraceLimit = originalStackTraceLimit
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('maintenance walks partitions neediest-first, not directory order', async () => {
  const cacheRoot = await makeTmpDir('maint-order')
  try {
    // `aaa_light` sorts first in directory order but has one data file;
    // `zzz_heavy` sorts last but is the most fragmented.
    const lightDir = path.join(cacheRoot, 'datasets', 'aaa_light', 'date=2026-08-01')
    await appendRowsToTable(path.join(lightDir, 'epoch=0'), COLUMNS, [
      { id: 1, value: 'v', timestamp: new Date().toISOString() },
    ])
    await writeCursor(lightDir, { epoch: 0, rowCount: 1, compaction: null, layout: 'epoch' })

    const heavyDir = path.join(cacheRoot, 'datasets', 'zzz_heavy', 'date=2026-08-01')
    for (let i = 0; i < 3; i++) {
      await appendRowsToTable(path.join(heavyDir, 'epoch=0'), COLUMNS, [
        { id: i, value: `v${i}`, timestamp: new Date().toISOString() },
      ])
    }
    await writeCursor(heavyDir, { epoch: 0, rowCount: 3, compaction: null, layout: 'epoch' })

    const report = await maintainCache({ cacheRoot, dryRun: true })
    assert.equal(report.partitions.length, 2)
    assert.equal(report.partitions[0].dataset, 'zzz_heavy')
    assert.equal(report.partitions[1].dataset, 'aaa_light')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('neediest-first order reads the live table dir for source-table partitions', async () => {
  const cacheRoot = await makeTmpDir('maint-order-source')
  try {
    // Same ordering claim as above, but for the layout where the live
    // generation is `tableDir` rather than `epoch=N`: a source-table cursor
    // never advances its epoch, so file count is the only priority signal.
    const lightDir = path.join(cacheRoot, 'datasets', 'aaa_light', 'source=test')
    await appendRowsToTable(path.join(lightDir, 'table'), COLUMNS, [
      { id: 1, value: 'v', timestamp: new Date().toISOString() },
    ])
    await writeCursor(lightDir, {
      epoch: 0,
      rowCount: 1,
      compaction: null,
      layout: 'source-table',
      tableDir: 'table',
    })

    const heavyDir = path.join(cacheRoot, 'datasets', 'zzz_heavy', 'source=test')
    for (let i = 0; i < 4; i++) {
      await appendRowsToTable(path.join(heavyDir, 'table'), COLUMNS, [
        { id: i, value: `v${i}`, timestamp: new Date().toISOString() },
      ])
    }
    await writeCursor(heavyDir, {
      epoch: 0,
      rowCount: 4,
      compaction: null,
      layout: 'source-table',
      tableDir: 'table',
    })

    const report = await maintainCache({ cacheRoot, dryRun: true })
    assert.equal(report.partitions.length, 2)
    assert.equal(report.partitions[0].dataset, 'zzz_heavy')
    assert.equal(report.partitions[1].dataset, 'aaa_light')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
