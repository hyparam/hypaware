// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createRetentionEnforcer, DEFAULT_RETENTION_DAYS } from '../../src/core/cache/retention.js'
import { maintainCache, cacheStatus, normalizeMaintenanceConfig } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync, writeCursor } from '../../src/core/cache/partition.js'
import { appendRowsToTable, currentPartitionSpec, currentSchema, readRowsFromTable, tableExists } from '../../src/core/cache/iceberg/store.js'
import { createLocalIcebergIO, tableUrlForDir } from '../../src/core/cache/iceberg/resolver.js'
import { loadLatestFileCatalogMetadata } from 'icebird'

/**
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
 * @import { CachePartitioningDeclaration } from '../../src/core/cache/types.d.ts'
 */

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

test('default retention days is 30', () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 30)
})

test('retention normalizeConfig applies defaults', () => {
  const enforcer = createRetentionEnforcer({ cacheRoot: '/tmp/fake', config: undefined })
  assert.equal(enforcer.config.default_days, 30)
  assert.deepEqual(enforcer.config.datasets, {})
  assert.equal(enforcer.config.wait_for_sink_ack, false)
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

    // New data arrives — creates a new snapshot, triggering a re-scan
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
    // compacted output spans many data files instead of one giant batch.
    const report = await maintainCache({
      cacheRoot,
      force: true,
      compactOnly: true,
      config: { compact_batch_bytes: 150_000 },
    })

    assert.ok(report.totalCompacted > 0)
    const p = report.partitions[0]
    assert.ok(p.dataFilesAfter > 1, `expected multiple flushed files, got ${p.dataFilesAfter}`)

    // All rows survive the split, and the data round-trips intact.
    const sourceDir = path.join(cacheRoot, 'datasets', 'ds1', 'source=test')
    const cursor = readCursorSync(sourceDir)
    assert.equal(cursor.rowCount, 20)
    const liveDir = path.join(sourceDir, cursor.tableDir ?? 'table')
    const rows = await readRowsFromTable(liveDir)
    assert.equal(rows.length, 20)
    assert.equal(rows.every((r) => r.value === blob), true)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a generous byte budget compacts the same input into a single file', async () => {
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

    // A second generation that is still fresh — must be treated as a
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
