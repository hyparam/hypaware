// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { parquetMetadata } from 'hyparquet'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToSourceTable, readCursorSync } from '../../src/core/cache/partition.js'
import { readRowsFromTable } from '../../src/core/cache/iceberg/store.js'
import { openStreamingAppend } from '../../src/core/cache/iceberg/stream_append.js'

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

/** @param {string} dir @returns {Promise<string[]>} */
async function dataFilePaths(dir) {
  /** @type {string[]} */
  let entries = []
  try {
    entries = await fs.readdir(path.join(dir, 'data'))
  } catch {
    return []
  }
  return entries
    .filter((name) => name.endsWith('.parquet'))
    .map((name) => path.join(dir, 'data', name))
}

/** @param {string} dir @returns {Promise<number>} */
async function dataFileCount(dir) {
  return (await dataFilePaths(dir)).length
}

/**
 * Row groups in each data file under `dir`. More than one row group in a
 * file is the signature of the roll: it can only happen if successive
 * flushes appended into a file that was already open.
 *
 * @param {string} dir
 * @returns {Promise<number[]>}
 */
async function rowGroupsPerFile(dir) {
  const counts = []
  for (const file of await dataFilePaths(dir)) {
    const bytes = await fs.readFile(file)
    counts.push(parquetMetadata(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).row_groups.length)
  }
  return counts
}

/**
 * Open file descriptors held by this process. Linux only; returns null
 * elsewhere so a descriptor assertion can be skipped rather than faked.
 *
 * @returns {Promise<number | null>}
 */
async function openFdCount() {
  try {
    return (await fs.readdir('/proc/self/fd')).length
  } catch {
    return null
  }
}

/** @param {string} dir @returns {Promise<string[]>} */
async function tempWriteFiles(dir) {
  try {
    return (await fs.readdir(path.join(dir, 'data'))).filter((name) => name.includes('.tmp.'))
  } catch {
    return []
  }
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

    // A file count above one is not evidence on its own: the pre-fix path
    // also wrote several files here, one per flushed batch. What only the
    // roll can produce is a file holding SEVERAL row groups, because that
    // means successive flushes appended into a file that stayed open. The
    // 512 KiB batch cap flushes ~21 times over these rows, and a 4 KiB
    // target absorbs several of those flushes per file.
    const groups = await rowGroupsPerFile(liveDir)
    assert.equal(groups.length, part.dataFilesAfter)
    assert.ok(
      Math.max(...groups) > 1,
      `expected at least one file to hold multiple row groups, got ${JSON.stringify(groups)}`
    )
    assert.ok(
      groups.reduce((sum, n) => sum + n, 0) > groups.length,
      'expected more row groups than files'
    )

    const readBack = await readRowsFromTable(liveDir)
    assert.equal(readBack.length, 600)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

// @ref LLP 0206#retained-metadata [tests]: an open file's retained row-group
// metadata is budgeted, so an unreachable byte target still rolls.
test('a streaming append rolls on retained row-group metadata, not only on target_file_bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-compact-stats-'))
  try {
    const tableDir = path.join(dir, 'table')
    /** @type {ColumnSpec[]} */
    const columns = [
      { name: 'id', type: 'INT32', nullable: false },
      { name: 'body', type: 'STRING', nullable: true },
    ]
    const sink = await openStreamingAppend({
      // Unreachable on purpose: the only thing that can close a file here
      // is the retained-metadata budget. `ParquetWriter` pins the raw,
      // untruncated min and max of every column of every row group until
      // the footer is written, so without a budget one open file would
      // hold all 40 fat values at once.
      tableDir,
      columns,
      targetFileBytes: Number.MAX_SAFE_INTEGER,
    })
    const groups = 40
    for (let g = 0; g < groups; g++) {
      // 1 MiB of distinct text per row group: ~4 MiB charged against the
      // 32 MiB budget, so a file may absorb at most ~8 of these.
      await sink.write([{ id: g, body: `${g}:${'x'.repeat(1024 * 1024)}` }])
    }
    const result = await sink.close()

    assert.equal(result.rowCount, groups)
    assert.ok(
      result.dataFiles > 1,
      `expected the stats budget to roll files, got ${result.dataFiles}`
    )
    const perFile = await rowGroupsPerFile(tableDir)
    assert.equal(perFile.reduce((sum, n) => sum + n, 0), groups)
    assert.ok(
      Math.max(...perFile) <= 12,
      `expected no file to pin more than ~8 fat row groups, got ${JSON.stringify(perFile)}`
    )

    const readBack = await readRowsFromTable(tableDir)
    assert.equal(readBack.length, groups)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// @ref LLP 0206#consequences [tests]: an append that throws part-way must
// not leave its descriptors and temp files behind for the next tick.
test('aborting a streaming append releases every open descriptor and temp file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-compact-abort-'))
  try {
    const tableDir = path.join(dir, 'table')
    /** @type {ColumnSpec[]} */
    const columns = [
      { name: 'id', type: 'INT32', nullable: false },
      { name: 'body', type: 'STRING', nullable: true },
    ]
    const sink = await openStreamingAppend({
      tableDir,
      columns,
      targetFileBytes: 128 * 1024 * 1024,
    })
    const fdsBefore = await openFdCount()
    await sink.write([{ id: 1, body: 'a' }, { id: 2, body: 'b' }])

    // A required column given null: the row group in flight throws while a
    // data file is open, which is the shape of every mid-rewrite failure.
    await assert.rejects(() => sink.write([{ id: null, body: 'c' }]))
    assert.equal((await tempWriteFiles(tableDir)).length, 1, 'the failing append should still hold its temp file')

    await sink.abort()

    assert.deepEqual(await tempWriteFiles(tableDir), [], 'abort should unlink every temp file')
    const fdsAfter = await openFdCount()
    if (fdsBefore !== null && fdsAfter !== null) {
      assert.ok(
        fdsAfter <= fdsBefore,
        `abort should release descriptors, had ${fdsBefore} before and ${fdsAfter} after`
      )
    }
    // Nothing was committed, so the table is still empty rather than
    // carrying a half-written file.
    assert.equal(await dataFileCount(tableDir), 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
