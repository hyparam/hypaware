// @ts-check

// The maintenance walk visits partitions neediest-first (LLP 0199), so the
// most fragmented partition goes first - and that is exactly the partition
// most likely to fail a rewrite. Without a per-partition catch one such
// partition took the whole tick with it: every partition behind it got
// neither compaction nor snapshot expiry, every hour, forever. These tests
// pin the walk surviving one partition's error while still reporting it.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync, writeCursor } from '../../src/core/cache/partition.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 * @import { MaintenancePartitionReport, PartitionCursor } from '../../src/core/cache/types.js'
 */

/** @type {ColumnSpec[]} */
const SESSION_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'attributes', type: 'STRING', nullable: true },
]

/** @type {ColumnSpec[]} */
const FLAT_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'attributes', type: 'STRING', nullable: true },
]

/**
 * One Iceberg partition tuple per session, so ingest lands one data file
 * per session and the partition is both the neediest in the cache and the
 * one a torn file can break. Same fixture shape as the effectiveness
 * tests: this is the production partition from #723.
 */
const SESSION_DECLARATION = {
  source: { columns: ['source'] },
  iceberg: { fields: [{ column: 'session_id', transform: 'identity' }] },
}

/**
 * @param {string} cacheRoot
 * @param {number} sessions
 */
async function seedNeediestPartition(cacheRoot, sessions) {
  const rows = Array.from({ length: sessions }, (_, i) => ({
    id: i,
    session_id: `s-${i}`,
    attributes: `{"gateway":{"session":"s-${i}"}}`,
  }))
  await appendRowsToSourceTable(
    cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS, rows,
    { declaration: SESSION_DECLARATION }
  )
}

/**
 * A second, healthy partition holding strictly fewer live data files, so
 * the neediest-first ranking always puts it behind the one that throws.
 *
 * @param {string} cacheRoot
 * @param {number} waves
 */
async function seedHealthyPartition(cacheRoot, waves) {
  for (let wave = 0; wave < waves; wave++) {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: wave * 5 + i,
      attributes: `wave ${wave} row ${i}`,
    }))
    await appendRowsToSourceTable(cacheRoot, 'logs', ['source=claude'], FLAT_COLUMNS, rows)
  }
}

/** @param {string} cacheRoot @param {string} dataset @returns {string} */
function partitionDir(cacheRoot, dataset) {
  return path.join(cacheRoot, 'datasets', dataset, 'source=claude')
}

/**
 * Plant the stamp-less compaction record an older HypAware wrote: its
 * baseline sits on the live count, so the LLP 0199 gate skips the
 * partition, and it names no writer generation, so LLP 0217 owes it
 * exactly one retry under the writer running now. That retry is what the
 * torn file below turns into a throw.
 *
 * @param {string} dir
 * @param {number} baselineFiles
 * @returns {Promise<void>}
 */
async function plantStamplessRecord(dir, baselineFiles) {
  const cursor = readCursorSync(dir)
  /** @type {PartitionCursor} */
  const next = {
    ...cursor,
    compaction: {
      previousTableDir: 'table',
      compactedAt: '2026-08-12T21:55:35.168Z',
      resettleBaselineFiles: baselineFiles,
    },
  }
  await writeCursor(dir, next)
}

/**
 * Truncate one of the partition's live parquet files to a stub no reader
 * can decode: the torn-write stand-in from the issue, which makes the
 * rewrite's scan throw part-way through.
 *
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function tearOneDataFile(dir) {
  const cursor = readCursorSync(dir)
  const dataDir = path.join(dir, cursor.tableDir ?? 'table', 'data')
  const entries = await fs.readdir(dataDir, { withFileTypes: true })
  const [torn] = entries
    .filter((e) => e.isFile() && e.name.endsWith('.parquet'))
    .map((e) => path.join(dataDir, e.name))
  assert.ok(torn, 'fixture invariant: the partition must hold a live data file to tear')
  await fs.truncate(torn, 4)
}

/** @param {string} dir @returns {Record<string, unknown>} */
function compactionRecord(dir) {
  const { compaction } = readCursorSync(dir)
  assert.ok(compaction && typeof compaction === 'object', 'expected a compaction record on the cursor')
  return /** @type {Record<string, unknown>} */ (compaction)
}

/**
 * @param {{ partitions: MaintenancePartitionReport[] }} report
 * @param {string} dataset
 * @returns {MaintenancePartitionReport}
 */
function partitionReport(report, dataset) {
  const found = report.partitions.find((p) => p.dataset === dataset)
  assert.ok(found, `expected a report for ${dataset}; got ${report.partitions.map((p) => p.dataset).join(', ') || '(none)'}`)
  return found
}

/**
 * The cache both tests below run over: a neediest partition rigged to
 * throw on its rewrite, and a healthy partition behind it in walk order.
 *
 * @returns {Promise<string>}
 */
async function seedTornAndHealthy() {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-maintain-walk-'))
  await seedNeediestPartition(cacheRoot, 8)
  await seedHealthyPartition(cacheRoot, 3)
  const torn = partitionDir(cacheRoot, 'ai_gateway_messages')
  await plantStamplessRecord(torn, 8)
  await tearOneDataFile(torn)
  return cacheRoot
}

// @ref LLP 0220#walk-survives-a-partition [tests]: the whole point. The
// neediest partition throws, and the partition behind it is still maintained
// in the same tick rather than an hour later, or never.
test('a partition whose compaction throws does not abort the rest of the walk', async () => {
  const cacheRoot = await seedTornAndHealthy()
  try {
    const report = await maintainCache({ cacheRoot, compactOnly: true })

    const torn = partitionReport(report, 'ai_gateway_messages')
    assert.equal(torn.compacted, false, 'fixture invariant: the neediest partition must attempt a rewrite and fail it')
    assert.equal(torn.failed, true, 'the partition that threw is reported as failed')

    const healthy = partitionReport(report, 'logs')
    assert.equal(
      healthy.compacted, true,
      'the partition behind the failure must still be compacted in this tick'
    )
    assert.equal(healthy.failed, undefined, 'the healthy partition did not fail')
    assert.equal(report.totalCompacted, 1)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0217#retry-on-writer-change [tests]: the per-partition catch must
// not swallow the failure before the stamp is written. The attempt spends the
// writer generation's retry whether or not it succeeded, or the same partition
// is re-attempted, and fails, on every tick forever.
test('the partition that threw still spends its writer generation', async () => {
  const cacheRoot = await seedTornAndHealthy()
  try {
    await maintainCache({ cacheRoot, compactOnly: true })

    const dir = partitionDir(cacheRoot, 'ai_gateway_messages')
    const record = compactionRecord(dir)
    assert.equal(typeof record.writerGeneration, 'number', 'a spent attempt must stamp the cursor')
    assert.equal(typeof record.attemptFailedAt, 'string', 'the stamp records when the attempt failed')
    assert.equal(record.resettleBaselineFiles, 8, 'a failed rewrite must not move the baseline')
    assert.equal(record.dataFilesBefore, undefined, 'a failed rewrite proves nothing about effectiveness')

    // @ref LLP 0218#report-the-spent-attempt [tests]: and from the next tick
    // on the partition is skipped for that stated reason, with the walk now
    // reporting no failure at all because nothing was attempted.
    const next = await maintainCache({ cacheRoot, compactOnly: true })
    const torn = partitionReport(next, 'ai_gateway_messages')
    assert.equal(torn.failed, undefined, 'nothing was attempted this tick, so nothing failed in it')
    assert.equal(torn.compactionAttemptFailed, true, 'the skip states the spent attempt as its reason')
    assert.equal(torn.compactionAttemptFailedAt, record.attemptFailedAt)
    assert.equal(next.totalFailed, 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0220#walk-survives-a-partition [tests]: compaction is not the only
// thing a partition behind the failure was owed. Snapshot expiry is the
// unbounded-growth guard (#723's metadata directories), and it runs before
// compaction for every partition in the walk, so aborting the walk cost it too.
test('snapshot expiry still runs for the partitions behind the one that threw', async () => {
  const cacheRoot = await seedTornAndHealthy()
  try {
    // Expire everything but the current snapshot, so the healthy partition's
    // three ingest waves leave something to expire.
    const report = await maintainCache({
      cacheRoot,
      config: { min_snapshots_to_keep: 0, max_snapshot_age_hours: 0 },
    })

    const healthy = partitionReport(report, 'logs')
    assert.ok(
      healthy.snapshotsExpired > 0,
      `the partition behind the failure must still have its snapshots expired; got ${healthy.snapshotsExpired}`
    )
    assert.ok(report.totalSnapshotsExpired > 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0220#tick-reports-degraded [tests]: continuing the walk must not
// cost the tick its failure signal. A tick that quietly returns a clean report
// while a partition went unmaintained is the same defect class as #723: the
// operator has nothing to read.
test('a tick that lost a partition reports the loss rather than swallowing it', async () => {
  const cacheRoot = await seedTornAndHealthy()
  try {
    const report = await maintainCache({ cacheRoot, compactOnly: true })

    assert.equal(report.totalFailed, 1, 'the tick counts the partition it lost')
    const torn = partitionReport(report, 'ai_gateway_messages')
    assert.equal(torn.failed, true)
    assert.equal(typeof torn.errorKind, 'string')
    assert.ok(
      typeof torn.errorMessage === 'string' && torn.errorMessage.length > 0,
      'the report carries the error that ended the partition, not just the fact of one'
    )
    // The failure is this tick's, and it is not the cursor-read skip reason
    // LLP 0218 defined: an operator must be able to tell "this partition threw
    // just now" from "this partition has been skipped since an earlier throw".
    assert.equal(torn.compactionAttemptFailed, undefined)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
