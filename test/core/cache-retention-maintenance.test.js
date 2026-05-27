// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createRetentionEnforcer, DEFAULT_RETENTION_DAYS } from '../../src/core/cache/retention.js'
import { maintainCache, cacheStatus, normalizeMaintenanceConfig } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync } from '../../src/core/cache/partition.js'
import { readRowsFromTable, tableExists } from '../../src/core/cache/iceberg/store.js'

/**
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
 */

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-retention-maint-${prefix}-`))
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
