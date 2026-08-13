// @ts-check

// A compaction that reproduces the file count it started with used to be
// indistinguishable from one that halved it: both recorded only the post
// count, and the LLP 0199 baseline gate then read "live count equals
// baseline" as convergence and skipped the partition forever. These tests
// pin the distinction: what the rewrite achieved is recorded, an
// ineffective verdict is retried exactly once when the compaction writer
// changes under it, and an effective one is still never retried.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync, writeCursor } from '../../src/core/cache/partition.js'
import { readRowsFromTable } from '../../src/core/cache/iceberg/store.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 * @import { PartitionCursor } from '../../src/core/cache/types.js'
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
 * `ai_gateway_messages` reduced to the axis that makes compaction
 * unable to shrink a partition: identity partitioning. A data file
 * cannot span partition tuples (LLP 0209#tuple-bound), so a partition
 * holding one file per tuple already sits on its floor and any rewrite
 * of it reproduces the same count. That is the production shape behind
 * the 1,521-file partition: one tuple per session.
 */
const SESSION_DECLARATION = {
  source: { columns: ['source'] },
  iceberg: { fields: [{ column: 'session_id', transform: 'identity' }] },
}

/**
 * A partition whose compaction provably cannot reduce the file count:
 * `sessions` distinct tuples, one row each, so both the ingest and every
 * later rewrite emit exactly one data file per tuple.
 *
 * @param {string} cacheRoot
 * @param {number} sessions
 */
async function seedUnshrinkablePartition(cacheRoot, sessions) {
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
 * A partition compaction can shrink: several ingest waves into one
 * unpartitioned table, so the rewrite folds them into a single file.
 *
 * @param {string} cacheRoot
 * @param {number} waves
 */
async function seedShrinkablePartition(cacheRoot, waves) {
  for (let wave = 0; wave < waves; wave++) {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: wave * 5 + i,
      attributes: `wave ${wave} row ${i}`,
    }))
    await appendRowsToSourceTable(cacheRoot, 'logs', ['source=claude'], FLAT_COLUMNS, rows)
  }
}

/** @param {string} cacheRoot @returns {string} */
function partitionDir(cacheRoot, dataset = 'ai_gateway_messages') {
  return path.join(cacheRoot, 'datasets', dataset, 'source=claude')
}

/**
 * Overwrite the partition's compaction record, keeping everything else
 * the cursor carries. Used to plant cursors an older HypAware wrote.
 *
 * @param {string} dir
 * @param {Record<string, unknown>} compaction
 * @returns {Promise<void>}
 */
async function plantCompactionRecord(dir, compaction) {
  const cursor = readCursorSync(dir)
  /** @type {PartitionCursor} */
  const next = { ...cursor, compaction }
  await writeCursor(dir, next)
}

/**
 * The parquet data files of the partition's live generation: exactly what
 * a rewrite has to read back.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function liveDataFiles(dir) {
  const cursor = readCursorSync(dir)
  const dataDir = path.join(dir, cursor.tableDir ?? 'table', 'data')
  const entries = await fs.readdir(dataDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.parquet'))
    .map((e) => path.join(dataDir, e.name))
}

/** @param {string} dir @returns {Record<string, unknown>} */
function compactionRecord(dir) {
  const { compaction } = readCursorSync(dir)
  assert.ok(compaction && typeof compaction === 'object', 'expected a compaction record on the cursor')
  return /** @type {Record<string, unknown>} */ (compaction)
}

// @ref LLP 0217#record-effectiveness [tests]: the rewrite records what it
// achieved, so a partition that could not be shrunk is skipped for a stated
// reason instead of by the baseline coincidence.
test('a compaction that cannot reduce the file count records that it did not', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-compact-ineffective-'))
  try {
    await seedUnshrinkablePartition(cacheRoot, 8)

    const report = await maintainCache({ cacheRoot, force: true, compactOnly: true })
    const part = report.partitions[0]
    assert.equal(part.compacted, true)
    assert.equal(part.dataFilesBefore, 8)
    assert.equal(
      part.dataFilesAfter, 8,
      'fixture invariant: this partition is already at one file per tuple, so the rewrite cannot shrink it'
    )
    assert.equal(part.compactionIneffective, true, 'the rewrite achieved no reduction and must say so')

    // The cursor keeps both sides of the comparison, not just the post
    // count, plus the writer generation that produced them.
    const record = compactionRecord(partitionDir(cacheRoot))
    assert.equal(record.resettleBaselineFiles, 8)
    assert.equal(record.dataFilesBefore, 8)
    assert.equal(typeof record.writerGeneration, 'number')

    // The next tick still skips (the count has not moved, and this writer
    // has already proved it cannot shrink this partition) but the report
    // now names the reason.
    const second = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(second.totalCompacted, 0)
    assert.equal(second.partitions[0].compacted, false)
    assert.equal(second.partitions[0].compactionIneffective, true)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0217#retry-on-writer-change [tests]: the frozen partition from
// issue #723 thaws exactly once when the writer that froze it is replaced.
test('a partition frozen by an ineffective compaction is retried once under a new compaction writer', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-compact-thaw-'))
  try {
    await seedUnshrinkablePartition(cacheRoot, 8)
    await maintainCache({ cacheRoot, force: true, compactOnly: true })

    const dir = partitionDir(cacheRoot)
    const live = readCursorSync(dir)
    // Exactly the cursor shape issue #723 reported, written by a HypAware
    // that recorded only the post-rewrite count: no effectiveness, no
    // writer generation.
    await plantCompactionRecord(dir, {
      previousTableDir: 'table',
      compactedAt: '2026-08-12T21:55:35.168Z',
      resettleBaselineFiles: 8,
    })
    assert.equal(readCursorSync(dir).tableDir, live.tableDir, 'planting the old record must not move the live generation')

    // The partition is fragmented (8 tiny files, far below
    // compact_avg_file_bytes) and its live count sits exactly on the
    // recorded baseline. Before the fix the baseline gate read that as
    // convergence and skipped it forever, whatever the writer could now do.
    const thaw = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(
      thaw.totalCompacted, 1,
      'a partition whose recorded compaction achieved nothing must be retried when the writer changes'
    )
    assert.equal(thaw.partitions[0].compacted, true)

    // And it converges again immediately: the retry is once per writer
    // generation, not once per tick.
    const settled = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(settled.totalCompacted, 0, 'the retry must not become a rewrite-forever loop')
    const third = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(third.totalCompacted, 0)

    // The retry is a real rewrite, so it must still be lossless.
    const cursor = readCursorSync(dir)
    const rows = await readRowsFromTable(path.join(dir, cursor.tableDir ?? 'table'))
    assert.equal(rows.length, 8)
    assert.equal(new Set(rows.map((r) => r.session_id)).size, 8)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0199#baseline-gate [tests]: the anti-regression. The gate exists
// because the avg-file-size heuristic re-flags every compacted partition
// forever; recording effectiveness must not hand that loop back.
test('a compaction that did reduce the file count is never retried', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-compact-converged-'))
  try {
    await seedShrinkablePartition(cacheRoot, 6)
    const first = await maintainCache({ cacheRoot, force: true, compactOnly: true })
    const part = first.partitions[0]
    assert.equal(part.compacted, true)
    assert.ok(part.dataFilesAfter < part.dataFilesBefore, `fixture invariant: expected a reduction, got ${part.dataFilesBefore} -> ${part.dataFilesAfter}`)
    assert.equal(part.compactionIneffective, undefined)

    const dir = partitionDir(cacheRoot, 'logs')
    const after = part.dataFilesAfter

    // A converged partition whose compaction worked, recorded by a writer
    // generation this build no longer runs. The recorded reduction is what
    // suppresses the retry: an old stamp alone must not thaw a partition
    // that is already as compact as it gets.
    await plantCompactionRecord(dir, {
      previousTableDir: 'table',
      compactedAt: '2026-08-12T21:55:35.168Z',
      resettleBaselineFiles: after,
      dataFilesBefore: after + 5,
    })
    for (const tick of [1, 2, 3]) {
      const converged = await maintainCache({ cacheRoot, compactOnly: true })
      assert.equal(converged.totalCompacted, 0, `tick ${tick}: an effective compaction must stay converged`)
      assert.equal(converged.partitions[0].compactionIneffective, undefined)
    }

    // Control: the same partition, the same stamp-less record, differing
    // only in what the last rewrite achieved. The tick compacts, which is
    // what proves the assertion above is about effectiveness and not about
    // the partition being too healthy to flag at all.
    await plantCompactionRecord(dir, {
      previousTableDir: 'table',
      compactedAt: '2026-08-12T21:55:35.168Z',
      resettleBaselineFiles: after,
      dataFilesBefore: after,
    })
    const retried = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(retried.totalCompacted, 1)
    // The control converges too, so the run above is one retry and not the
    // rewrite loop the baseline gate exists to prevent.
    for (const tick of [1, 2]) {
      const settled = await maintainCache({ cacheRoot, compactOnly: true })
      assert.equal(settled.totalCompacted, 0, `tick ${tick}: the retry must not become a rewrite-forever loop`)
    }
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0217#retry-on-writer-change [tests]: the *attempt* spends the
// retry, not its success. A rewrite that throws writes no cursor of its own,
// so without a stamp the stale verdict stands and the partition is attempted,
// and fails, on every later tick. The walk goes neediest-first
// (LLP 0199#neediest-first), so that is also every healthier partition
// starved behind it.
test('a retry whose rewrite throws still spends its writer generation', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-compact-throw-'))
  try {
    await seedUnshrinkablePartition(cacheRoot, 8)
    await maintainCache({ cacheRoot, force: true, compactOnly: true })

    const dir = partitionDir(cacheRoot)
    // The stamp-less cursor from issue #723 again: this partition is owed
    // exactly one attempt under the writer running now.
    await plantCompactionRecord(dir, {
      previousTableDir: 'table',
      compactedAt: '2026-08-12T21:55:35.168Z',
      resettleBaselineFiles: 8,
    })
    // A torn write: one live data file truncated to a stub no parquet
    // reader can decode, so the retry's scan throws part-way through.
    const [torn] = await liveDataFiles(dir)
    await fs.truncate(torn, 4)

    await assert.rejects(
      maintainCache({ cacheRoot, compactOnly: true }),
      'fixture invariant: the retry must attempt a rewrite, and that rewrite must fail'
    )

    // The failed attempt is still the generation's attempt. It records no
    // verdict about the partition (the baseline is untouched and no
    // before-count is invented), only that this writer has had its turn.
    const record = compactionRecord(dir)
    assert.equal(typeof record.writerGeneration, 'number', 'a spent attempt must stamp the cursor')
    assert.equal(record.resettleBaselineFiles, 8, 'a failed rewrite must not move the baseline')
    assert.equal(record.dataFilesBefore, undefined, 'a failed rewrite proves nothing about effectiveness')

    // So the next ticks walk past the partition instead of re-entering a
    // rewrite that cannot succeed and taking the whole tick down with it.
    for (const tick of [1, 2]) {
      const after = await maintainCache({ cacheRoot, compactOnly: true })
      assert.equal(after.totalCompacted, 0, `tick ${tick} must not re-enter the failing rewrite`)
      assert.equal(after.partitions[0].compacted, false)
    }
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0217#record-effectiveness [tests]: a partition holding one data
// file is at its floor, not fragmented. A rewrite of it reduces nothing
// because there is nothing to reduce, which is evidence about neither the
// writer nor the partition and must not be reported as a failure.
test('a partition already at one data file is not reported as an ineffective compaction', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-compact-floor-'))
  try {
    // One ingest wave, so the partition holds exactly one data file: the
    // shape of every low-volume partition, and one `needsCompaction` still
    // flags because that single file sits far below compact_avg_file_bytes.
    await seedShrinkablePartition(cacheRoot, 1)

    const first = await maintainCache({ cacheRoot, force: true, compactOnly: true })
    const part = first.partitions[0]
    assert.equal(part.compacted, true)
    assert.equal(part.dataFilesBefore, 1, 'fixture invariant: the partition starts at its one-file floor')
    assert.equal(part.dataFilesAfter, 1)
    assert.equal(part.compactionIneffective, undefined, 'a 1 -> 1 rewrite had nothing to reduce')

    // And the verdict is not then carried for life: later ticks skip the
    // partition without reporting a compaction that achieved nothing.
    for (const tick of [1, 2]) {
      const later = await maintainCache({ cacheRoot, compactOnly: true })
      assert.equal(later.totalCompacted, 0, `tick ${tick} must stay quiesced`)
      assert.equal(
        later.partitions[0].compactionIneffective, undefined,
        `tick ${tick} must not report the partition's floor as an ineffective compaction`
      )
    }
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
