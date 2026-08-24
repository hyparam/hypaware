// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { urlToPath } from '../../src/core/cache/iceberg/resolver.js'
import { listLiveDataFiles } from '../../src/core/cache/iceberg/store.js'
import { cacheStatus, maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService, resolveIcebergDir } from '../../src/core/cache/storage.js'
import { executeGrepSearch } from '../../src/core/search/grep_service.js'
import { sidecarPathFor } from '../../src/core/search/searchable_columns.js'
import { buildSidecarsForTable, createIndexQuarantine } from '../../src/core/search/sidecar_build.js'
import { aiGatewayDatasetRegistration } from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

const DATASET = 'ai_gateway_messages'

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'session_id', type: 'STRING', nullable: false },
  { name: 'conversation_id', type: 'STRING', nullable: true },
  { name: 'agent_id', type: 'STRING', nullable: true },
  { name: 'cwd', type: 'STRING', nullable: true },
  { name: 'content_text', type: 'STRING', nullable: true },
  { name: 'date', type: 'STRING', nullable: false },
  { name: 'part_id', type: 'STRING', nullable: false },
  { name: 'message_id', type: 'STRING', nullable: false },
  { name: 'message_created_at', type: 'TIMESTAMP', nullable: false },
  { name: 'client_name', type: 'STRING', nullable: true },
]

let rowSeq = 0

/** @param {Record<string, unknown>} [over] */
function mkRow(over = {}) {
  rowSeq += 1
  const date = typeof over.date === 'string' ? over.date : '2026-08-10'
  return {
    session_id: 's1',
    conversation_id: null,
    agent_id: null,
    cwd: '/home/open-proj',
    content_text: null,
    date,
    part_id: `m${rowSeq}#0`,
    message_id: `m${rowSeq}`,
    message_created_at: new Date(`${date}T00:00:00Z`).getTime() + rowSeq * 1000,
    client_name: 'test',
    ...over,
  }
}

/**
 * @param {Record<string, unknown>[][]} batches
 * @param {string} [dataset]
 */
async function makeCache(batches, dataset = DATASET) {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sidecar-'))
  const declaration = aiGatewayDatasetRegistration().cachePartitioning
  for (const batch of batches) {
    await appendRowsToSourceTable(cacheRoot, dataset, ['source=test'], COLUMNS, batch, { declaration })
  }
  const storage = createQueryStorageService({ cacheRoot })
  const partitionDir = path.join(cacheRoot, 'datasets', dataset, 'source=test')
  return { cacheRoot, storage, partitionDir, tableDir: () => resolveIcebergDir(partitionDir) }
}

/** A worker stand-in whose every build fails. */
function failingWorker() {
  return {
    build: () => Promise.reject(new Error('synthetic build failure')),
    close: async () => {},
  }
}

const quietLog = { info() {}, warn() {} }

const OLD = mkRow({ date: '2026-08-10', session_id: 's1', content_text: 'alpha needle one' })
const NEW = mkRow({ date: '2026-08-12', session_id: 's2', content_text: 'the needle two' })

test('buildSidecarsForTable builds one sidecar per file, idempotently, and grep serves them', async () => {
  const { storage, tableDir } = await makeCache([[OLD], [NEW]])
  const first = await buildSidecarsForTable({ tableDir: tableDir(), log: quietLog })
  assert.equal(first.built >= 2, true)
  assert.equal(first.present, 0)
  assert.equal(first.failed, 0)
  for (const file of await listLiveDataFiles(tableDir())) {
    assert.ok(fsSync.existsSync(sidecarPathFor(urlToPath(file.filePath))), 'every live file has a sidecar')
  }
  const second = await buildSidecarsForTable({ tableDir: tableDir(), log: quietLog })
  assert.equal(second.built, 0)
  assert.equal(second.present, first.built, 'existence is the completion marker; nothing rebuilds')

  const res = await executeGrepSearch({ storage, query: 'needle', limit: 10, includeLocalOnly: true })
  assert.equal(res.hits.length, 2)
  assert.equal(res.indexedFiles, first.built, 'the search runs on the indexed tier')
  assert.equal(res.scannedFiles, 0)
  assert.deepEqual(res.hits.map((h) => h.sessionId), ['s2', 's1'])
})

test('a failing build quarantines after three attempts and the scan tier still serves the file', async () => {
  const { storage, tableDir } = await makeCache([[OLD]])
  const quarantine = createIndexQuarantine()
  for (let attempt = 1; attempt <= 3; attempt++) {
    const report = await buildSidecarsForTable({
      tableDir: tableDir(), quarantine, worker: failingWorker(), log: quietLog,
    })
    assert.equal(report.failed, 1, `attempt ${attempt} spends a build and fails`)
    assert.equal(report.built, 0)
  }
  const afterQuarantine = await buildSidecarsForTable({
    tableDir: tableDir(), quarantine, worker: failingWorker(), log: quietLog,
  })
  assert.equal(afterQuarantine.failed, 0, 'a quarantined file costs no further builds')
  assert.equal(afterQuarantine.quarantined, 1)

  const res = await executeGrepSearch({ storage, query: 'needle', limit: 10, includeLocalOnly: true })
  assert.equal(res.hits.length, 1, 'the unindexed file is served by the scan tier')
  assert.equal(res.scannedFiles, 1)
  assert.equal(res.indexedFiles, 0)
})

test('a corrupt sidecar degrades that one file to the scan tier instead of failing the search', async () => {
  const { storage, tableDir } = await makeCache([[OLD]])
  const [file] = await listLiveDataFiles(tableDir())
  await fs.writeFile(sidecarPathFor(urlToPath(file.filePath)), 'not a parquet file')
  const res = await executeGrepSearch({ storage, query: 'needle', limit: 10, includeLocalOnly: true })
  assert.equal(res.hits.length, 1)
  assert.equal(res.indexedFiles, 0)
  assert.equal(res.scannedFiles, 1, 'the unreadable sidecar fell back to the brute scan')
})

test('maintenance compaction finalizes files and builds their sidecars', async () => {
  const { cacheRoot, storage, tableDir } = await makeCache([[OLD], [NEW]])
  const result = await maintainCache({ cacheRoot, force: true })
  const report = result.partitions.find((p) => p.dataset === DATASET)
  assert.ok(report)
  assert.equal(report.compacted, true)
  assert.ok((report.sidecarsBuilt ?? 0) >= 1, 'the rewrite queued index builds for its files')
  assert.equal(report.sidecarsFailed ?? 0, 0)

  const files = await listLiveDataFiles(tableDir())
  assert.ok(files.length >= 1)
  for (const file of files) {
    assert.ok(fsSync.existsSync(sidecarPathFor(urlToPath(file.filePath))), 'every finalized file is indexed')
  }
  const res = await executeGrepSearch({ storage, query: 'needle', limit: 10, includeLocalOnly: true })
  assert.equal(res.hits.length, 2)
  assert.equal(res.scannedFiles, 0)

  // Coverage is observable from cacheStatus: indexed equals the data-file
  // count on the grep dataset, and the field stays absent elsewhere. The
  // second dataset is what makes the absence half of that claim testable:
  // without it a counter that fired on every dataset would pass here.
  await appendRowsToSourceTable(cacheRoot, 'logs', ['source=test'], COLUMNS, [mkRow()], {
    declaration: aiGatewayDatasetRegistration().cachePartitioning,
  })
  const status = await cacheStatus({ cacheRoot })
  const partition = status.partitions.find((p) => p.dataset === DATASET)
  assert.ok(partition)
  assert.ok(partition.dataFileCount >= 1)
  assert.equal(partition.indexedFileCount, partition.dataFileCount)
  assert.equal(partition.indexableFileCount, partition.dataFileCount)
  const other = status.partitions.find((p) => p.dataset === 'logs')
  assert.ok(other)
  assert.equal(other.indexedFileCount, undefined, 'only the grep dataset carries sidecars')
  assert.equal(other.indexableFileCount, undefined, 'only the grep dataset carries sidecars')
})

test('a partition already at the compaction floor is still indexed', async () => {
  // The gap the compaction gate left: a partition that never becomes due
  // for a rewrite never gets a sidecar, so every grep brute-scans it for
  // the life of its generation and the status line advises a compaction
  // that will not run. Coverage is the gate now, so an untouched
  // generation is indexed on its first tick.
  const { cacheRoot, storage, tableDir } = await makeCache([[OLD]])
  // Thresholds no fixture-sized partition can trip, so "not due for a
  // rewrite" is the test's premise rather than an accident of file size.
  const atFloor = { compact_file_count: 1000, compact_avg_file_bytes: 1 }
  const result = await maintainCache({ cacheRoot, config: atFloor })
  const report = result.partitions.find((p) => p.dataset === DATASET)
  assert.ok(report)
  assert.equal(report.compacted, false, 'the partition is not due for a rewrite')
  assert.equal(report.sidecarsBuilt, 1, 'but its file is indexed anyway')

  for (const file of await listLiveDataFiles(tableDir())) {
    assert.ok(fsSync.existsSync(sidecarPathFor(urlToPath(file.filePath))))
  }
  const res = await executeGrepSearch({ storage, query: 'needle', limit: 10, includeLocalOnly: true })
  assert.equal(res.hits.length, 1)
  assert.equal(res.indexedFiles, 1)
  assert.equal(res.scannedFiles, 0)

  // And the pass does not re-run once coverage is complete: the gate is a
  // directory read, so a fully indexed partition costs no build pass at all.
  const second = await maintainCache({ cacheRoot, config: atFloor })
  const secondReport = second.partitions.find((p) => p.dataset === DATASET)
  assert.ok(secondReport)
  assert.equal(secondReport.sidecarsBuilt, undefined, 'complete coverage skips the pass entirely')
})

test('a spent tick budget defers the rest of the build to the next tick', async () => {
  // Indexing is seconds of CPU per file, so an unbounded pass appended
  // after the tick's cutoff undoes the budget's whole point. One file is
  // always attempted so a busy cache still makes progress; the rest are
  // deferred and picked up later, which is only sound because sidecar
  // existence is the completion marker.
  const { cacheRoot, tableDir } = await makeCache([[OLD], [NEW]])
  const files = await listLiveDataFiles(tableDir())
  assert.ok(files.length >= 2, 'the fixture needs more than one file to defer any')
  // Same at-floor thresholds as above: no rewrite, so the file set the two
  // ticks below see is the one measured here.
  const atFloor = { compact_file_count: 1000, compact_avg_file_bytes: 1 }

  const first = await maintainCache({ cacheRoot, config: atFloor, budgetMs: 0 })
  const firstReport = first.partitions.find((p) => p.dataset === DATASET)
  assert.ok(firstReport)
  assert.equal(firstReport.sidecarsBuilt, 1, 'the first missing file is always attempted')
  assert.equal(firstReport.sidecarsDeferred, files.length - 1)

  // A later tick with room finishes the job, without rebuilding the one
  // the exhausted tick already published.
  const second = await maintainCache({ cacheRoot, config: atFloor })
  const secondReport = second.partitions.find((p) => p.dataset === DATASET)
  assert.ok(secondReport)
  assert.equal(secondReport.sidecarsBuilt, files.length - 1)
  assert.equal(secondReport.sidecarsDeferred, 0)
  for (const file of await listLiveDataFiles(tableDir())) {
    assert.ok(fsSync.existsSync(sidecarPathFor(urlToPath(file.filePath))))
  }
})

test('a purge after the index build does not report coverage that can never be reached', async () => {
  // Position deletes land in the live `data/` directory as
  // `<uuid>-deletes.parquet`, so `countDataFiles` counts them. No sidecar is
  // ever built beside one, so borrowing that count as the coverage
  // denominator would make every partition purged since its last compaction
  // read as permanently under-indexed and advise a compaction that cannot
  // close the gap.
  const { cacheRoot, tableDir } = await makeCache([[OLD], [NEW]])
  await maintainCache({ cacheRoot, force: true })
  const before = await cacheStatus({ cacheRoot })
  const indexed = before.partitions.find((p) => p.dataset === DATASET)
  assert.ok(indexed)
  assert.equal(indexed.indexedFileCount, indexed.indexableFileCount)

  const dataDir = path.join(tableDir(), 'data')
  await fs.writeFile(path.join(dataDir, 'aaaaaaaa-deletes.parquet'), Buffer.alloc(64))

  const after = await cacheStatus({ cacheRoot })
  const purged = after.partitions.find((p) => p.dataset === DATASET)
  assert.ok(purged)
  assert.equal(purged.dataFileCount, indexed.dataFileCount + 1, 'the delete file joins the data-file count')
  assert.equal(purged.indexableFileCount, indexed.indexableFileCount, 'but not the indexable set')
  assert.equal(purged.indexedFileCount, purged.indexableFileCount, 'so coverage still reads complete')
})

test('sidecars do not re-trigger compaction: the data-file counters exclude them', async () => {
  const { cacheRoot } = await makeCache([[OLD], [NEW]])
  await maintainCache({ cacheRoot, force: true })
  // No new data flushed since the rewrite; a second unforced tick must see
  // a converged partition, not one that "grew" by its own index files.
  const second = await maintainCache({ cacheRoot })
  const report = second.partitions.find((p) => p.dataset === DATASET)
  assert.ok(report)
  assert.equal(report.compacted, false, 'the sidecars did not read as growth')
})

test('an orphaned publish scratch counts as index bytes, not data bytes', async () => {
  // A build killed between the write and the rename leaves
  // `<file>.index.parquet.<uuid>.tmp` in the live data dir, and nothing
  // reaps it before the generation retires. `countDataFiles` already skips
  // it (no `.parquet` suffix), so the byte measure has to skip it too: the
  // avg-file-size heuristic compacts when the average is LOW, so counting a
  // large orphan makes a fragmented partition read as healthy and go
  // unrewritten.
  const { cacheRoot, tableDir } = await makeCache([[OLD], [NEW]])
  const files = await listLiveDataFiles(tableDir())
  assert.ok(files.length >= 2)
  let dataBytes = 0
  for (const file of files) dataBytes += (await fs.stat(urlToPath(file.filePath))).size
  const avgBytes = dataBytes / files.length
  const orphan = `${sidecarPathFor(urlToPath(files[0].filePath))}.orphaned-build.tmp`
  await fs.writeFile(orphan, Buffer.alloc(dataBytes * 4))

  // Due by a hair on the real data bytes; not due at all if the orphan's
  // bytes join the average.
  const result = await maintainCache({
    cacheRoot,
    config: { compact_file_count: 1000, compact_avg_file_bytes: Math.ceil(avgBytes) + 1 },
  })
  const report = result.partitions.find((p) => p.dataset === DATASET)
  assert.ok(report)
  assert.equal(report.compacted, true, 'the orphaned scratch did not inflate the average file size')
})

test('a non-grep dataset is compacted without sidecars', async () => {
  const { cacheRoot, tableDir } = await makeCache([[mkRow({ content_text: 'needle' })]], 'other_dataset')
  const result = await maintainCache({ cacheRoot, force: true })
  const report = result.partitions.find((p) => p.dataset === 'other_dataset')
  assert.ok(report)
  assert.equal(report.compacted, true)
  assert.equal(report.sidecarsBuilt, undefined, 'the build pass never ran')
  for (const file of await listLiveDataFiles(tableDir())) {
    assert.equal(fsSync.existsSync(sidecarPathFor(urlToPath(file.filePath))), false)
  }
})

test('a retired generation dies whole, sidecars included', async () => {
  const { cacheRoot, partitionDir } = await makeCache([[OLD], [NEW]])
  await maintainCache({ cacheRoot, force: true })
  const compactedDir = resolveIcebergDir(partitionDir)
  assert.ok((await listLiveDataFiles(compactedDir)).length >= 1)

  // New data, then a second rewrite: the first compacted generation (with
  // its sidecars inside) is retired.
  const declaration = aiGatewayDatasetRegistration().cachePartitioning
  await appendRowsToSourceTable(cacheRoot, DATASET, ['source=test'], COLUMNS,
    [mkRow({ date: '2026-08-14', session_id: 's3', content_text: 'needle three' })], { declaration })
  await maintainCache({ cacheRoot, force: true })
  assert.notEqual(resolveIcebergDir(partitionDir), compactedDir, 'a fresh generation is live')
  assert.ok(fsSync.existsSync(path.join(compactedDir, '.retired')), 'the old generation is marked retired')

  // Backdate the marker past the grace period; the next tick's sweep
  // reclaims the directory, and the sidecars go with it because they live
  // inside it: the no-GC-code guarantee this test exists to pin.
  await fs.writeFile(path.join(compactedDir, '.retired'), new Date(0).toISOString())
  await maintainCache({ cacheRoot })
  assert.equal(fsSync.existsSync(compactedDir), false, 'the retired generation and its sidecars are gone')
})
