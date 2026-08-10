// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync } from '../../src/core/cache/partition.js'
import { readRowsFromTable } from '../../src/core/cache/iceberg/store.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'attributes', type: 'STRING', nullable: true },
]

/**
 * A row body that is fat in memory but compresses hard in parquet: the
 * shape of a real `ai_gateway_messages` row, whose denormalized
 * `attributes` blob repeats the same tool definitions on every row.
 *
 * @param {number} id
 * @returns {Record<string, unknown>}
 */
function fatRow(id) {
  const tool = JSON.stringify({
    name: 'read_file',
    description: 'Read a file from the local filesystem and return its contents.',
    parameters: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
  })
  return { id, attributes: `{"gateway":{"tools":[${new Array(48).fill(tool).join(',')}]}}` }
}

/** @param {string} dir @returns {Promise<number>} */
async function dataFileCount(dir) {
  const entries = await fs.readdir(path.join(dir, 'data'))
  return entries.filter((name) => name.endsWith('.parquet')).length
}

// @ref LLP 0206#decision [tests]: one compacted file per byte target, not
// one per in-memory batch estimate.
test('compaction sizes output files by bytes written, not the in-memory batch estimate', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-compact-size-'))
  try {
    const rows = Array.from({ length: 600 }, (_, i) => fatRow(i))
    await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=claude'], COLUMNS, rows)

    const report = await maintainCache({
      cacheRoot,
      force: true,
      compactOnly: true,
      // A batch cap far below the total payload, so the OOM guard fires
      // several times during the rewrite. Each flush used to become its
      // own data file.
      config: { compact_batch_bytes: 512 * 1024, target_file_bytes: 128 * 1024 * 1024 },
    })

    assert.equal(report.partitions.length, 1)
    const part = report.partitions[0]
    assert.equal(part.compacted, true)
    assert.equal(part.rowCount, 600)

    // The whole partition compresses to far under `target_file_bytes`, so a
    // converged compaction writes exactly one data file. Before the fix the
    // rewrite emitted one file per 512 KiB of *estimated in-memory* bytes.
    assert.equal(
      part.dataFilesAfter,
      1,
      `expected one compacted data file, got ${part.dataFilesAfter}`
    )

    // And the rewrite is lossless.
    const cursor = readCursorSync(part.path)
    const liveDir = path.join(part.path, cursor.tableDir ?? 'table')
    assert.equal(await dataFileCount(liveDir), 1)
    const readBack = await readRowsFromTable(liveDir)
    assert.equal(readBack.length, 600)
    assert.deepEqual(
      readBack.map((r) => Number(r.id)).sort((a, b) => a - b),
      rows.map((r) => Number(r.id))
    )
    assert.equal(readBack[0].attributes, rows[0].attributes)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0206#decision [tests]: the file boundary follows `target_file_bytes`.
test('compaction rolls to a new data file once target_file_bytes is written', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-compact-roll-'))
  try {
    const rows = Array.from({ length: 600 }, (_, i) => fatRow(i))
    await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=claude'], COLUMNS, rows)

    const report = await maintainCache({
      cacheRoot,
      force: true,
      compactOnly: true,
      config: { compact_batch_bytes: 512 * 1024, target_file_bytes: 4 * 1024 },
    })

    const part = report.partitions[0]
    assert.ok(part.dataFilesAfter > 1, `expected the target to roll files, got ${part.dataFilesAfter}`)
    assert.equal(part.rowCount, 600)

    const cursor = readCursorSync(part.path)
    const liveDir = path.join(part.path, cursor.tableDir ?? 'table')
    const readBack = await readRowsFromTable(liveDir)
    assert.equal(readBack.length, 600)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
