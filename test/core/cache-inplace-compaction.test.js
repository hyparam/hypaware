// @ts-check

// In-place subset compaction (LLP 0310): routine dueness on a source-table
// generation merges only the fragmented partition tuples, committed as a
// replace snapshot into the same generation directory, instead of rewriting
// the whole table into a fresh one. These tests pin the three outcomes: a
// real merge (files drop, generation stays), the floor verdict (nothing
// mergeable, no rewrite at all), and the settle escape (victims carrying
// fallback rows route to the whole-generation rewrite). The last test pins
// the unreferenced-file sweep that releases what in-place commits supersede.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync } from '../../src/core/cache/partition.js'
import { deleteMatchingRows, readRowsFromTable } from '../../src/core/cache/iceberg/store.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const SESSION_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'attributes', type: 'STRING', nullable: true },
]

const SESSION_DECLARATION = {
  source: { columns: ['source'] },
  iceberg: { fields: [{ column: 'session_id', transform: 'identity' }] },
}

/**
 * `waves` ingest waves over the same `sessions` tuples: every tuple holds
 * `waves` small files, the shape in-place compaction exists to merge.
 *
 * @param {string} cacheRoot
 * @param {number} sessions
 * @param {number} waves
 * @param {(i: number) => string} [attributesFor]
 */
async function seedFragmented(cacheRoot, sessions, waves, attributesFor) {
  for (let wave = 0; wave < waves; wave++) {
    const rows = Array.from({ length: sessions }, (_, i) => ({
      id: wave * sessions + i,
      session_id: `s-${i}`,
      attributes: attributesFor
        ? attributesFor(i)
        : `{"gateway":{"session":"s-${i}","wave":${wave}}}`,
    }))
    await appendRowsToSourceTable(
      cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS, rows,
      { declaration: SESSION_DECLARATION }
    )
  }
}

/** @param {string} cacheRoot @returns {string} */
function partitionDir(cacheRoot) {
  return path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
}

/** @param {string} dir @returns {string} */
function liveTableDir(dir) {
  return path.join(dir, readCursorSync(dir).tableDir ?? 'table')
}

/**
 * Parquet data files (sidecars and delete files excluded) in the live
 * generation's directory: the on-disk view, which after an in-place merge
 * includes files the table no longer references.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function dataFilesOnDisk(dir) {
  const dataDir = path.join(liveTableDir(dir), 'data')
  const entries = await fs.readdir(dataDir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.parquet') && !e.name.endsWith('.index.parquet') && !e.name.endsWith('-deletes.parquet'))
    .map((e) => path.join(dataDir, e.name))
}

test('routine compaction merges fragmented tuples in place, keeping the generation', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-inplace-merge-'))
  try {
    await seedFragmented(cacheRoot, 4, 3)
    const dir = partitionDir(cacheRoot)
    const generationBefore = readCursorSync(dir).tableDir

    const report = await maintainCache({ cacheRoot, compactOnly: true })
    const part = report.partitions[0]
    assert.equal(part.compacted, true)
    assert.equal(part.dataFilesBefore, 12)
    assert.equal(part.dataFilesAfter, 4, 'three waves merge to one file per tuple')
    assert.equal(part.compactionIneffective, undefined, 'a real reduction is not an ineffective verdict')

    // The generation did not swap: same directory, superseded files still
    // on disk until the sweep releases them.
    const cursor = readCursorSync(dir)
    assert.equal(cursor.tableDir, generationBefore, 'in-place compaction must not swap the generation')
    const record = /** @type {Record<string, unknown>} */ (cursor.compaction)
    assert.equal(record.dataFilesBefore, 12)
    assert.equal(record.resettleBaselineFiles, 4, 'the baseline is the live count, not the directory count')
    assert.equal(record.previousTableDir, undefined, 'nothing was retired')
    assert.ok((await dataFilesOnDisk(dir)).length > 4, 'superseded files await the sweep, not a directory swap')

    // Lossless: the merged generation reads back every row.
    const rows = await readRowsFromTable(liveTableDir(dir))
    assert.equal(rows.length, 12)
    assert.equal(new Set(rows.map((r) => r.session_id)).size, 4)

    // Converged: the next tick skips, and does not read the directory
    // count's superseded files as growth.
    const second = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(second.totalCompacted, 0, 'a merged partition converges')
    assert.equal(second.partitions[0].compactionIneffective, undefined)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a partition at its tuple floor gets the verdict without any rewrite', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-inplace-floor-'))
  try {
    await seedFragmented(cacheRoot, 4, 1)
    const dir = partitionDir(cacheRoot)
    const filesBefore = (await dataFilesOnDisk(dir)).sort()

    const report = await maintainCache({ cacheRoot, compactOnly: true })
    const part = report.partitions[0]
    assert.equal(part.compacted, false, 'nothing mergeable, so nothing is rewritten')
    assert.equal(part.compactionIneffective, true, 'the floor is reported as the verdict it is')
    assert.equal(part.compactionIneffectiveFiles, 4)
    const record = /** @type {Record<string, unknown>} */ (readCursorSync(dir).compaction)
    assert.equal(record.dataFilesBefore, 4)
    assert.equal(record.resettleBaselineFiles, 4)
    assert.equal(typeof record.writerGeneration, 'number')

    // The verdict cost a listing: the data files are byte-identical.
    assert.deepEqual((await dataFilesOnDisk(dir)).sort(), filesBefore, 'no data file was written or replaced')

    const second = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(second.totalCompacted, 0)
    assert.equal(second.partitions[0].compactionIneffective, true, 'later ticks state the recorded reason')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('victims whose fallback rows can settle route to the whole-generation rewrite', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-inplace-settle-'))
  try {
    await seedFragmented(cacheRoot, 2, 2, () => '{"gateway":{"identity_source":"gateway_fallback"}}')
    const dir = partitionDir(cacheRoot)
    const generationBefore = readCursorSync(dir).tableDir

    // The stub settle "upgrades" every fallback row (returns new objects,
    // the convention resettleFallbackRows reads as upgraded), so the escape
    // fires; the rows carry no part identity, so nothing collapses.
    const storage = /** @type {any} */ ({})
    const getSettleHook = () => async (/** @type {Record<string, unknown>[]} */ rows) => rows.map((r) => ({ ...r }))
    const report = await maintainCache({ cacheRoot, compactOnly: true, storage, getSettleHook })
    assert.equal(report.totalCompacted, 1)

    const cursor = readCursorSync(dir)
    assert.notEqual(cursor.tableDir, generationBefore, 'the settle escape takes the generation-swap rewrite')
    const rows = await readRowsFromTable(liveTableDir(dir))
    assert.equal(rows.length, 4, 'no identity keys, so no row is dropped')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('unmatchable fallback rows do not force the whole-generation rewrite', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-inplace-unmatchable-'))
  try {
    await seedFragmented(cacheRoot, 2, 2, () => '{"gateway":{"identity_source":"gateway_fallback"}}')
    const dir = partitionDir(cacheRoot)
    const generationBefore = readCursorSync(dir).tableDir

    // A hook that returns every row unchanged has no twin to collapse: the
    // LLP 0027 unmatchable-fallback case. It must merge in place, or one
    // permanently-unmatchable row buys a full rewrite on every growth tick.
    const storage = /** @type {any} */ ({})
    const getSettleHook = () => async (/** @type {Record<string, unknown>[]} */ rows) => rows
    const report = await maintainCache({ cacheRoot, compactOnly: true, storage, getSettleHook })
    assert.equal(report.totalCompacted, 1)
    assert.equal(report.partitions[0].dataFilesAfter, 2, 'the merge still happens, one file per tuple')

    const cursor = readCursorSync(dir)
    assert.equal(cursor.tableDir, generationBefore, 'unmatchable fallbacks stay on the in-place path')
    const rows = await readRowsFromTable(liveTableDir(dir))
    assert.equal(rows.length, 4, 'the fallback rows survive verbatim')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('the sweep releases superseded files once no retained snapshot references them', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-inplace-sweep-'))
  try {
    await seedFragmented(cacheRoot, 4, 3)
    const dir = partitionDir(cacheRoot)

    const merged = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(merged.totalCompacted, 1)
    const onDiskAfterMerge = await dataFilesOnDisk(dir)
    assert.ok(onDiskAfterMerge.length > 4, 'fixture invariant: superseded files linger on disk')

    // Age everything past the staged-write grace, then let a tick expire
    // the pre-merge snapshots (retention zeroed) and sweep. Retention is
    // the reader-safety window: only once expiry has dropped every
    // snapshot that could read the superseded files may the sweep delete.
    const dataDir = path.join(liveTableDir(dir), 'data')
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000)
    for (const name of await fs.readdir(dataDir)) {
      await fs.utimes(path.join(dataDir, name), stale, stale)
    }
    const swept = await maintainCache({
      cacheRoot,
      config: { min_snapshots_to_keep: 0, max_snapshot_age_hours: 0 },
    })
    assert.ok(
      (swept.partitions[0].unreferencedFilesRemoved ?? 0) >= 12,
      'the superseded data files are released'
    )

    const remaining = await dataFilesOnDisk(dir)
    assert.equal(remaining.length, 4, 'exactly the live merged files survive')
    const rows = await readRowsFromTable(liveTableDir(dir))
    assert.equal(rows.length, 12, 'the sweep never touches what the table still references')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0302#purge-by-position [tests]: the in-place merge reads its
// victims with committed position deletes applied, so a purged row cannot
// come back through compaction. The whole-generation rewrite was the only
// compactor before LLP 0310; this pins the property for the path that
// replaced it, because the failure is silent (rows reappear, nothing errors).
test('an in-place merge does not resurrect rows a purge deleted', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-inplace-purge-'))
  try {
    await seedFragmented(cacheRoot, 4, 3)
    const dir = partitionDir(cacheRoot)

    const purged = await deleteMatchingRows(
      liveTableDir(dir), (row) => row.session_id === 's-1', { columns: ['session_id'] }
    )
    assert.equal(purged.rowsDeleted, 3, 'fixture invariant: one tuple loses all three of its rows')
    const before = await readRowsFromTable(liveTableDir(dir))
    assert.equal(before.length, 9)

    const report = await maintainCache({ cacheRoot, compactOnly: true })
    assert.equal(report.partitions[0].compacted, true)

    const after = await readRowsFromTable(liveTableDir(dir))
    assert.equal(after.length, 9, 'the merge conserves exactly the live rows it started from')
    assert.deepEqual(
      after.map((r) => Number(r.id)).sort((a, b) => a - b),
      before.map((r) => Number(r.id)).sort((a, b) => a - b),
      'row identity survives the merge, purged ids included in neither side'
    )
    assert.ok(!after.some((r) => r.session_id === 's-1'), 'the purged tuple stays purged')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0310#victim-selection [tests]: a tuple heavier than one round's
// byte budget is merged a prefix at a time. Skipping it instead would be
// permanent: routine dueness never reaches the whole-generation rewrite, so
// the partition would stay due, produce an empty victim set, and collect the
// floor verdict while remaining fragmented.
test('a tuple heavier than one round of budget still merges, a prefix at a time', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-inplace-overbudget-'))
  try {
    await seedFragmented(cacheRoot, 1, 6)
    const dir = partitionDir(cacheRoot)
    const files = await dataFilesOnDisk(dir)
    assert.equal(files.length, 6, 'fixture invariant: one tuple, six small files')

    // A budget that fits some of the tuple's files but nowhere near all of
    // them: the shape that used to skip the tuple outright.
    const sizes = await Promise.all(files.map(async (f) => (await fs.stat(f)).size))
    const total = sizes.reduce((a, b) => a + b, 0)
    const compact_batch_bytes = Math.floor(total / 2)
    assert.ok(compact_batch_bytes < total, 'fixture invariant: the tuple does not fit one round')

    const report = await maintainCache({ cacheRoot, compactOnly: true, config: { compact_batch_bytes } })
    const part = report.partitions[0]
    assert.equal(part.compacted, true, 'an over-budget tuple must still be merged, not frozen')
    assert.ok(part.dataFilesAfter < 6, 'the live file count falls')
    assert.equal(part.compactionIneffective, undefined, 'a real reduction is not the floor verdict')

    const rows = await readRowsFromTable(liveTableDir(dir))
    assert.equal(rows.length, 6, 'the prefix merges conserve every row')
    assert.deepEqual(rows.map((r) => Number(r.id)).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0310#in-place-by-default [tests]: the settle escape is asked
// about every committed victim the tick merges, not only the first round's.
// The round budget stops round 0 long before a fragmented partition is
// exhausted, so a settleable fallback row routinely sits in a file only a
// later round selects; probing round 0 alone would merge that file in place
// and leave its twin uncollapsed, silently - no error, no row lost.
test('a settleable fallback row a later round selects still routes to the full rewrite', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-inplace-lateprobe-'))
  try {
    // Five waves over one tuple. Only the last carries a fallback row, and
    // its slightly longer attributes make its file the largest, so the
    // smallest-first prefix the first round takes cannot reach it.
    for (let wave = 0; wave < 5; wave++) {
      const fallback = wave === 4
      await appendRowsToSourceTable(
        cacheRoot, 'ai_gateway_messages', ['source=claude'], SESSION_COLUMNS,
        [{
          id: wave,
          session_id: 's-0',
          attributes: fallback
            ? '{"gateway":{"identity_source":"gateway_fallback","pad":"only the last wave is a fallback row"}}'
            : `{"gateway":{"wave":${wave}}}`,
        }],
        { declaration: SESSION_DECLARATION }
      )
    }
    const dir = partitionDir(cacheRoot)
    const generationBefore = readCursorSync(dir).tableDir

    const files = await dataFilesOnDisk(dir)
    assert.equal(files.length, 5, 'fixture invariant: one tuple, five files')
    const sizes = (await Promise.all(files.map(async (f) => (await fs.stat(f)).size)))
      .sort((a, b) => a - b)
    // A budget that fits exactly the three smallest files. Round 0 therefore
    // takes three plain files; the fallback row's file is only reachable by
    // round 1, which is the case this test exists for.
    const compact_batch_bytes = sizes[0] + sizes[1] + sizes[2]
    assert.ok(sizes[3] + sizes[4] <= compact_batch_bytes, 'fixture invariant: a later round can take the fallback file')
    assert.ok(sizes[4] > sizes[3], 'fixture invariant: the fallback row\'s file is the largest, so round 0 cannot reach it')

    const storage = /** @type {any} */ ({})
    const getSettleHook = () => async (/** @type {Record<string, unknown>[]} */ rows) => rows.map((r) => ({ ...r }))
    const report = await maintainCache({
      cacheRoot, compactOnly: true, storage, getSettleHook, config: { compact_batch_bytes },
    })
    assert.equal(report.totalCompacted, 1)

    assert.notEqual(
      readCursorSync(dir).tableDir, generationBefore,
      'the escape fires for a victim no first round probed'
    )
    const rows = await readRowsFromTable(liveTableDir(dir))
    assert.equal(rows.length, 5, 'every row survives the routed rewrite')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

/**
 * Snapshots the live generation's newest metadata version records. The
 * reader-safety window is measured in these: snapshot expiry keeps the
 * newest `min_snapshots_to_keep`, and the unreferenced-file sweep only
 * reclaims what no retained snapshot names.
 *
 * @param {string} dir
 * @returns {Promise<number>}
 */
async function snapshotCount(dir) {
  const metaDir = path.join(liveTableDir(dir), 'metadata')
  const versions = (await fs.readdir(metaDir))
    .map((name) => ({ name, version: Number(/^v(\d+)\.metadata\.json$/.exec(name)?.[1]) }))
    .filter((entry) => Number.isFinite(entry.version))
    .sort((a, b) => b.version - a.version)
  const latest = versions[0]
  assert.ok(latest, 'fixture invariant: the live generation has metadata versions')
  const meta = JSON.parse(await fs.readFile(path.join(metaDir, latest.name), 'utf8'))
  return (meta.snapshots ?? []).length
}

// @ref LLP 0312#round-cap-under-retention [tests]: one tick must never commit
// as many snapshots as retention keeps, or the next tick's expiry retires
// everything the previous tick left and a reader that started before the tick
// loses its snapshot. The round cap is what one tick spends, so it is clamped
// by `min_snapshots_to_keep` rather than being a constant 8.
test('one in-place tick commits fewer snapshots than snapshot retention keeps', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-inplace-window-'))
  try {
    // One tuple, twenty small files: fragmented enough to want far more
    // merge rounds than a tick may spend.
    await seedFragmented(cacheRoot, 1, 20)
    const dir = partitionDir(cacheRoot)
    const files = await dataFilesOnDisk(dir)
    assert.equal(files.length, 20, 'fixture invariant: one tuple, twenty small files')

    // A budget that fits only the two smallest files, so every round merges
    // a prefix and the partition stays due for another round.
    const sizes = (await Promise.all(files.map(async (f) => (await fs.stat(f)).size)))
      .sort((a, b) => a - b)
    const compact_batch_bytes = sizes[0] + sizes[1]

    const min_snapshots_to_keep = 3
    const before = await snapshotCount(dir)
    const report = await maintainCache({
      cacheRoot,
      compactOnly: true,
      config: { compact_batch_bytes, min_snapshots_to_keep },
    })
    assert.equal(report.partitions[0].compacted, true, 'the tick still merges')

    const committed = await snapshotCount(dir) - before
    assert.ok(committed > 0, 'fixture invariant: the tick committed merges')
    assert.ok(
      committed < min_snapshots_to_keep,
      `a tick committed ${committed} snapshots while retention keeps ${min_snapshots_to_keep}: ` +
      'the next expiry would retire every snapshot the previous tick left'
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0312#metadata-dueness [tests]: in-place compaction cannot shrink a
// source table's metadata directory, so a metadata-only dueness verdict is one
// routine maintenance can never clear. Metadata is bounded by the version trim
// and the unreferenced sweep, both of which run every tick regardless.
test('a fat metadata directory alone does not make a source table due', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-inplace-fatmeta-'))
  try {
    // One file per tuple: the identity-partitioning floor, nothing to merge.
    await seedFragmented(cacheRoot, 4, 1)
    const dir = partitionDir(cacheRoot)
    assert.equal((await dataFilesOnDisk(dir)).length, 4, 'fixture invariant: the partition is on its floor')

    // 65 MB of metadata, sparse so the fixture costs no disk.
    const fat = await fs.open(path.join(liveTableDir(dir), 'metadata', 'fat.avro'), 'w')
    try {
      await fat.truncate(65 * 1024 * 1024)
    } finally {
      await fat.close()
    }

    // Neither size heuristic can fire, so metadata bytes are the only thing
    // that could call this partition due.
    const report = await maintainCache({
      cacheRoot,
      compactOnly: true,
      dryRun: true,
      config: { compact_file_count: 1000, compact_avg_file_bytes: 1 },
    })

    assert.ok(
      !report.partitions[0].compacted,
      'metadata bytes routine compaction cannot shrink must not schedule a rewrite'
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
