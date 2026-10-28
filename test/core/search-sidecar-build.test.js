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
import { createRetentionEnforcer } from '../../src/core/cache/retention.js'
import { createQueryStorageService, resolveIcebergDir } from '../../src/core/cache/storage.js'
import { executeGrepSearch } from '../../hypaware-core/plugins-workspace/grep/src/grep_service.js'
import { sidecarPathFor } from '../../src/core/search/searchable_columns.js'
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

const OLD = mkRow({ date: '2026-08-10', session_id: 's1', content_text: 'alpha needle one' })
const NEW = mkRow({ date: '2026-08-12', session_id: 's2', content_text: 'the needle two' })

test('maintenance never builds indexes, before or after compaction', async () => {
  const { cacheRoot, storage, tableDir } = await makeCache([[OLD], [NEW]])
  for (const force of [false, true]) {
    const result = await maintainCache({ cacheRoot, force })
    assert.equal(result.totalFailed, 0)
    const files = await listLiveDataFiles(tableDir())
    assert.ok(files.length > 0)
    for (const file of files) {
      assert.equal(fsSync.existsSync(sidecarPathFor(urlToPath(file.filePath))), false)
    }
    const answer = await executeGrepSearch({ storage, query: 'needle', limit: 10, includeLocalOnly: true })
    assert.deepEqual(answer.hits.map((hit) => hit.sessionId), ['s2', 's1'])
    assert.equal(answer.scannedFiles, files.length)
    assert.equal(answer.indexedFiles, 0)
  }
  const status = await cacheStatus({ cacheRoot })
  assert.ok(status.partitions.every((part) => !('indexedFileCount' in part)))
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
  // bytes join the average. The two files sit in different partition
  // tuples, so a due tick cannot merge them: what proves dueness fired is
  // the recorded floor verdict (LLP 0310), which only a due tick writes.
  const result = await maintainCache({
    cacheRoot,
    config: { compact_file_count: 1000, compact_avg_file_bytes: Math.ceil(avgBytes) + 1 },
  })
  const report = result.partitions.find((p) => p.dataset === DATASET)
  assert.ok(report)
  assert.equal(report.compactionIneffective, true, 'the orphaned scratch did not inflate the average file size')
})

test('retention that reclaims a whole partition takes its sidecars with it', async () => {
  // The other retention path: a table whose schema carries no timestamp
  // column at all is evicted by directory mtime, recursively. Sidecars live
  // inside `data/`, so they die with their files and nothing sweeps them
  // separately - the no-GC-code guarantee, on the second of the two paths
  // LLP 0265 T6 names.
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-sidecar-ret-'))
  /** @type {ColumnSpec[]} */
  const untimed = [
    { name: 'session_id', type: 'STRING', nullable: false },
    { name: 'content_text', type: 'STRING', nullable: true },
    { name: 'part_id', type: 'STRING', nullable: false },
  ]
  const declaration = {
    source: { columns: ['session_id'], fallback: 'unknown' },
    iceberg: { fields: [{ column: 'session_id', transform: /** @type {const} */ ('identity'), required: true }] },
  }
  await appendRowsToSourceTable(cacheRoot, DATASET, ['source=test'], untimed,
    [{ session_id: 's1', content_text: 'needle', part_id: 'p1' }], { declaration })
  const partitionDir = path.join(cacheRoot, 'datasets', DATASET, 'source=test')
  const dir = resolveIcebergDir(partitionDir)
  const [file] = await listLiveDataFiles(dir)
  await fs.writeFile(sidecarPathFor(urlToPath(file.filePath)), 'legacy sidecar')
  assert.ok(fsSync.existsSync(sidecarPathFor(urlToPath(file.filePath))))

  const enforcer = createRetentionEnforcer({ cacheRoot, config: { default_days: 1 } })
  await enforcer.tick({ now: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
  assert.equal(fsSync.existsSync(partitionDir), false, 'the partition and every sidecar inside it are gone')
})
