// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { appendRowsToPartition, appendRowsToSourceTable, discoverCachePartitions, readCursorSync, writeCursor } from '../../src/core/cache/partition.js'
import { appendRowsToTable, readRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { migrateLegacyPartitions } from '../../src/core/cache/migrate.js'
import { purgeCache } from '../../src/core/cache/purge.js'
import { maintainCache } from '../../src/core/cache/maintenance.js'
import { resolveIcebergDir } from '../../src/core/cache/storage.js'
import { cacheCleanupId, readCacheCleanup, CACHE_PURGE_GRACE_MS } from '../../src/core/cache/purge-cleanup.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
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

test('migrateLegacyPartitions --force moves rows to source-table layout and retires legacy dir', async () => {
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
    assert.ok(partitions.length >= 2, 'should have source-table partitions after migration')
    const sources = partitions.map((p) => p.partition.source).sort()
    assert.ok(sources.includes('claude'))
    assert.ok(sources.includes('codex'))

    const claudePartition = partitions.find((p) => p.partition.source === 'claude')
    assert.ok(claudePartition, 'claude source partition should exist')
    const cursor = readCursorSync(claudePartition.path)
    assert.equal(cursor.layout, 'source-table')
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

test('migrateLegacyPartitions skips source-table partitions', async () => {
  const cacheRoot = await makeTmpDir('skip-source')
  try {
    await appendRowsToSourceTable(cacheRoot, 'data', ['source=claude'], TEST_COLUMNS, [
      { id: 1, value: 'new' },
    ])
    const result = await migrateLegacyPartitions({ cacheRoot, force: true })
    assert.equal(result.scanned, 0)
    assert.equal(result.migrated, 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('migrateLegacyPartitions migrates client=<x>/date=<y> epoch partitions', async () => {
  const cacheRoot = await makeTmpDir('epoch')
  try {
    await appendRowsToPartition(cacheRoot, 'ai_gateway_messages', ['client=claude', 'date=2026-05-26'], TEST_COLUMNS, [
      { id: 1, value: 'a', client_name: 'claude', timestamp: '2026-05-26T12:00:00Z' },
    ])
    await appendRowsToPartition(cacheRoot, 'ai_gateway_messages', ['client=codex', 'date=2026-05-25'], TEST_COLUMNS, [
      { id: 2, value: 'b', client_name: 'codex', timestamp: '2026-05-25T08:00:00Z' },
    ])

    const before = await discoverCachePartitions(cacheRoot)
    assert.equal(before.length, 2)
    assert.ok(before.some((p) => p.partition.client === 'claude'))

    const result = await migrateLegacyPartitions({ cacheRoot, force: true })
    assert.equal(result.scanned, 2)
    assert.equal(result.migrated, 2)
    assert.equal(result.rowsMigrated, 2)

    const after = await discoverCachePartitions(cacheRoot)
    assert.ok(after.length >= 2, 'should have source-table partitions')
    assert.ok(after.every((p) => 'source' in p.partition), 'all partitions should be source-table layout')
    const sources = after.map((p) => p.partition.source).sort()
    assert.ok(sources.includes('claude'))
    assert.ok(sources.includes('codex'))
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('migrateLegacyPartitions dry-run on epoch partitions reports without modifying', async () => {
  const cacheRoot = await makeTmpDir('epoch-dry')
  try {
    await appendRowsToPartition(cacheRoot, 'data', ['client=claude', 'date=2026-05-26'], TEST_COLUMNS, [
      { id: 1, value: 'a', client_name: 'claude', timestamp: '2026-05-26T12:00:00Z' },
    ])

    const partDir = path.join(cacheRoot, 'datasets', 'data', 'client=claude', 'date=2026-05-26')
    assert.ok(fsSync.existsSync(partDir))

    const result = await migrateLegacyPartitions({ cacheRoot, force: false })
    assert.equal(result.scanned, 1)
    assert.equal(result.migrated, 0)
    assert.equal(result.rowsMigrated, 1)
    assert.ok(fsSync.existsSync(partDir), 'epoch partition should still exist in dry-run')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('migrateLegacyPartitions retires only after successful append', async () => {
  const cacheRoot = await makeTmpDir('retire-order')
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'data', 'all')
    await fs.mkdir(partDir, { recursive: true })
    await appendRowsToTable(partDir, TEST_COLUMNS, [
      { id: 1, value: 'x', client_name: 'claude', timestamp: '2026-05-26T00:00:00Z' },
    ])

    await migrateLegacyPartitions({ cacheRoot, force: true })

    assert.ok(!fsSync.existsSync(partDir), 'legacy dir should be retired')

    const sourceDir = path.join(cacheRoot, 'datasets', 'data', 'source=claude')
    assert.ok(fsSync.existsSync(sourceDir), 'source-table dir should exist')

    const tableDir = path.join(sourceDir, 'table')
    assert.ok(fsSync.existsSync(tableDir), 'table subdir should exist')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// A legacy partition fans out into one append per source, and `retirePartition`
// is the only thing that stops the legacy directory being read again. So a
// refusal partway through the fan-out (LLP 0347#file-not-reader) would leave
// the sources ahead of it committed with the legacy directory still in place,
// and every later `hyp query maintain --force` would re-read the same rows and
// commit them again. The migration is asked before it commits anything, and a
// partition it cannot finish is left whole for the next run.
test('a legacy partition whose destination refuses is left whole, not migrated in part', async () => {
  const cacheRoot = await makeTmpDir('refused-destination')
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'proxy_messages_v4')
    await fs.mkdir(partDir, { recursive: true })
    await appendRowsToTable(partDir, TEST_COLUMNS, [
      { id: 1, value: 'a', client_name: 'claude', timestamp: '2026-05-26T12:00:00Z' },
      { id: 2, value: 'b', client_name: 'codex', timestamp: '2026-05-25T08:00:00Z' },
    ])
    // One of the two destinations already exists with a cursor that does not
    // read, so an append onto it is refused.
    const codexDir = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=codex')
    await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=codex'], TEST_COLUMNS, [
      { id: 99, value: 'already here', client_name: 'codex', timestamp: '2026-05-01T00:00:00Z' },
    ])
    await fs.writeFile(path.join(codexDir, 'cursor.json'), '{ not json')

    for (let run = 0; run < 3; run++) {
      const result = await migrateLegacyPartitions({ cacheRoot, force: true })
      assert.equal(result.migrated, 0, 'the migration does not report a partition it could not finish')
      assert.ok(fsSync.existsSync(partDir), 'the legacy directory stays, so the rows are still readable where they are')
      assert.equal(
        fsSync.existsSync(path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')), false,
        'and the healthy destination in the same partition is never written to, on this run or any other'
      )
    }
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// A purge position-deletes a session's rows and queues a cleanup journal; the
// physical bytes go only when maintenance rewrites the partition and reclaims
// the generations the journal names. Retiring the partition before that would
// carry those bytes into `.retired/`, where no reclaimer walks, and the
// journal sweep would then forget the erasure because the partition path is
// gone. So a partition with outstanding cleanup is deferred, untouched, and
// migrates once its cleanup has finished. (#2033)
test('a legacy partition with a pending purge cleanup is deferred until the cleanup finishes', async () => {
  const cacheRoot = await makeTmpDir('pending-cleanup')
  try {
    /** @type {ColumnSpec[]} */
    const columns = ['session_id', 'org', 'body', 'client_name'].map(name => ({ name, type: 'STRING', nullable: true }))
    const datasetDir = path.join(cacheRoot, 'datasets', 'events')
    const purgedDir = path.join(datasetDir, 'client=claude', 'date=2026-10-09')
    const neighborDir = path.join(datasetDir, 'client=codex', 'date=2026-10-09')
    const purgedInput = [
      { session_id: 'target', org: 'a', body: 'sensitive fixture', client_name: 'claude' },
      { session_id: 'neighbor', org: 'a', body: 'surviving neighbor', client_name: 'claude' },
    ]
    await appendRowsToTable(path.join(purgedDir, 'epoch=0'), columns, purgedInput)
    await writeCursor(purgedDir, { epoch: 0, rowCount: purgedInput.length, compaction: null })
    await appendRowsToTable(path.join(neighborDir, 'epoch=0'), columns, [
      { session_id: 'other', org: 'a', body: 'unrelated partition', client_name: 'codex' },
    ])
    await writeCursor(neighborDir, { epoch: 0, rowCount: 1, compaction: null })

    const purged = await purgeCache({ cacheRoot, target: { kind: 'session', id: 'target', org: 'a' } })
    assert.equal(purged.rowsDeleted, 1)
    const id = cacheCleanupId(cacheRoot, purgedDir)
    assert.ok(await readCacheCleanup(cacheRoot, id), 'the purge queued a cleanup journal')

    for (let run = 0; run < 2; run++) {
      const result = await migrateLegacyPartitions({ cacheRoot, force: true })
      assert.equal(result.deferred, 1, 'the purged partition is deferred on every run while its cleanup is pending')
      assert.ok(fsSync.existsSync(path.join(purgedDir, 'epoch=0')), 'the purged partition stays where its cleanup can reach it')
      assert.equal(result.migrated, run === 0 ? 1 : 0, 'the unrelated partition migrates on the first run')
      assert.ok(fsSync.existsSync(path.join(datasetDir, 'client=codex', '.retired', 'date=2026-10-09')), 'the unrelated partition is retired')
      assert.equal(fsSync.existsSync(path.join(datasetDir, 'client=claude', '.retired')), false, 'no retired copy of the purged partition')
      assert.equal(fsSync.existsSync(path.join(datasetDir, 'source=claude')), false, 'nothing of the deferred partition is appended')
      assert.ok(await readCacheCleanup(cacheRoot, id), 'the journal survives the migration attempt')
    }
    const codex = await readRowsFromTable(resolveIcebergDir(path.join(datasetDir, 'source=codex')))
    assert.deepEqual(codex.map(row => row.body), ['unrelated partition'], 'the unrelated partition migrated exactly once')

    // Cleanup finishes first: maintenance rewrites the partition, then
    // reclaims the purged generation once its grace has passed.
    assert.equal((await maintainCache({ cacheRoot })).totalFailed, 0)
    const journalFile = path.join(cacheRoot, '.purge-cleanup', `${id}.json`)
    const job = JSON.parse(await fs.readFile(journalFile, 'utf8'))
    job.requestedAt = Date.now() - CACHE_PURGE_GRACE_MS - 10000
    await fs.writeFile(journalFile, JSON.stringify(job))
    for (const name of job.generations) {
      const generation = path.join(purgedDir, name)
      if (fsSync.existsSync(generation)) await fs.writeFile(path.join(generation, '.retired'), new Date(job.requestedAt).toISOString())
    }
    assert.equal((await maintainCache({ cacheRoot })).totalFailed, 0)
    assert.equal(fsSync.existsSync(path.join(purgedDir, 'epoch=0')), false, 'the purged generation is reclaimed')
    // The journal is dropped one sweep after its last generation goes.
    assert.equal((await maintainCache({ cacheRoot })).totalFailed, 0)
    assert.equal(await readCacheCleanup(cacheRoot, id), null, 'the cleanup finished')

    const result = await migrateLegacyPartitions({ cacheRoot, force: true })
    assert.equal(result.deferred, 0)
    assert.equal(result.migrated, 1, 'the partition migrates once its cleanup is done')
    const claude = await readRowsFromTable(resolveIcebergDir(path.join(datasetDir, 'source=claude')))
    assert.deepEqual(claude.map(row => row.body), ['surviving neighbor'], 'the live rewritten generation is what migrates')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a legacy partition whose cleanup journal does not read is deferred, not migrated', async () => {
  const cacheRoot = await makeTmpDir('unreadable-cleanup')
  try {
    const partDir = path.join(cacheRoot, 'datasets', 'events', 'client=claude', 'date=2026-10-09')
    await appendRowsToTable(path.join(partDir, 'epoch=0'), TEST_COLUMNS, [
      { id: 1, value: 'a', client_name: 'claude', timestamp: '2026-10-09T12:00:00Z' },
    ])
    await writeCursor(partDir, { epoch: 0, rowCount: 1, compaction: null })
    await fs.mkdir(path.join(cacheRoot, '.purge-cleanup'), { recursive: true })
    await fs.writeFile(path.join(cacheRoot, '.purge-cleanup', `${cacheCleanupId(cacheRoot, partDir)}.json`), '{ not json')

    const result = await migrateLegacyPartitions({ cacheRoot, force: true })
    assert.equal(result.deferred, 1)
    assert.equal(result.migrated, 0)
    assert.ok(fsSync.existsSync(path.join(partDir, 'epoch=0')), 'unreadable cleanup state fails closed')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
