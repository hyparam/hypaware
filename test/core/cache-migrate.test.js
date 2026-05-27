// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { appendRowsToPartition, discoverCachePartitions } from '../../src/core/cache/partition.js'
import { appendRowsToTable } from '../../src/core/cache/iceberg/store.js'
import { migrateLegacyPartitions } from '../../src/core/cache/migrate.js'

/**
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
 */

/** @type {ColumnSpec[]} */
const TEST_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'value', type: 'STRING', nullable: true },
  { name: 'client_name', type: 'STRING', nullable: true },
  { name: 'timestamp', type: 'STRING', nullable: true },
]

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  const dir = path.join(os.tmpdir(), `hyp-test-migrate-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

test('migrateLegacyPartitions dry-run reports legacy partitions without modifying', async () => {
  const cacheRoot = await makeTmpDir('dry-run')
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'proxy_messages_v4')
    await fs.mkdir(partDir, { recursive: true })
    await appendRowsToTable(partDir, TEST_COLUMNS, [
      { id: 1, value: 'old', client_name: 'claude', timestamp: '2026-05-26T12:00:00Z' },
    ])

    const result = await migrateLegacyPartitions({ cacheRoot, force: false })
    assert.equal(result.scanned, 1)
    assert.equal(result.migrated, 0)
    assert.equal(result.rowsMigrated, 1)
    assert.ok(fsSync.existsSync(partDir), 'legacy dir should still exist')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('migrateLegacyPartitions --force moves rows and retires legacy dir', async () => {
  const cacheRoot = await makeTmpDir('force')
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'proxy_messages_v4')
    await fs.mkdir(partDir, { recursive: true })
    await appendRowsToTable(partDir, TEST_COLUMNS, [
      { id: 1, value: 'a', client_name: 'claude', timestamp: '2026-05-26T12:00:00Z' },
      { id: 2, value: 'b', client_name: 'codex', timestamp: '2026-05-25T08:00:00Z' },
    ])

    const result = await migrateLegacyPartitions({ cacheRoot, force: true })
    assert.equal(result.scanned, 1)
    assert.equal(result.migrated, 1)
    assert.equal(result.rowsMigrated, 2)

    assert.ok(!fsSync.existsSync(partDir), 'legacy dir should be retired')
    const retiredDir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', '.retired', 'proxy_messages_v4')
    assert.ok(fsSync.existsSync(retiredDir), 'retired dir should exist')

    const partitions = await discoverCachePartitions(cacheRoot, { datasets: ['ai_gateway_messages'] })
    assert.ok(partitions.length >= 2, 'should have new-style partitions after migration')
    const clients = partitions.map((p) => p.partition.client).sort()
    assert.ok(clients.includes('claude'))
    assert.ok(clients.includes('codex'))
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('migrateLegacyPartitions is idempotent', async () => {
  const cacheRoot = await makeTmpDir('idempotent')
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'data', 'all')
    await fs.mkdir(partDir, { recursive: true })
    await appendRowsToTable(partDir, TEST_COLUMNS, [
      { id: 1, value: 'x', client_name: 'claude', timestamp: '2026-05-26T00:00:00Z' },
    ])

    const first = await migrateLegacyPartitions({ cacheRoot, force: true })
    assert.equal(first.migrated, 1)
    assert.equal(first.rowsMigrated, 1)

    const second = await migrateLegacyPartitions({ cacheRoot, force: true })
    assert.equal(second.scanned, 0)
    assert.equal(second.migrated, 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('migrateLegacyPartitions skips new-style partitions', async () => {
  const cacheRoot = await makeTmpDir('skip-new')
  try {
    await appendRowsToPartition(cacheRoot, 'data', ['client=claude', 'date=2026-05-26'], TEST_COLUMNS, [
      { id: 1, value: 'new' },
    ])
    const result = await migrateLegacyPartitions({ cacheRoot, force: true })
    assert.equal(result.scanned, 0)
    assert.equal(result.migrated, 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
