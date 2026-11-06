// @ts-check

// A compaction that wrote its replacement generation and then failed to
// publish the cursor leaves that output behind. The retry used to pick the
// same name (`epoch=<live+1>`) and stream into it, so the abandoned rows and
// the fresh rewrite were published together: 12 source rows became 24
// (issue #2523). Each attempt now reserves a directory nobody else holds.

import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { maintainCache } from '../../src/core/cache/maintenance.js'
import { appendRowsToPartition, appendRowsToSourceTable, readCursorSync } from '../../src/core/cache/partition.js'
import { readRowsFromTable } from '../../src/core/cache/iceberg/store.js'

/**
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'session_id', type: 'STRING', nullable: false },
]

/** @param {number[]} ids */
const rows = (ids) => ids.map((id) => ({ id, session_id: `s-${id}` }))

/**
 * Run `fn` with the first rename onto a `cursor.json` failing, as a crash
 * or full disk between the generation write and the cursor swap would.
 *
 * @param {() => Promise<unknown>} fn
 */
async function withFailedCursorSwap(fn) {
  const real = fs.rename.bind(fs)
  let failed = false
  const m = mock.method(fs, 'rename', async (/** @type {string} */ from, /** @type {string} */ to) => {
    if (!failed && String(to).endsWith('cursor.json')) {
      failed = true
      throw Object.assign(new Error('injected cursor swap failure'), { code: 'EIO' })
    }
    return real(from, to)
  })
  try {
    await fn().catch(() => undefined)
  } finally {
    m.mock.restore()
  }
  assert.equal(failed, true, 'the injected swap failure fired')
}

/** @param {string} partition */
async function liveIds(partition) {
  const cursor = readCursorSync(partition)
  const dir = cursor.layout === 'source-table'
    ? path.join(partition, cursor.tableDir ?? 'table')
    : path.join(partition, `epoch=${cursor.epoch}`)
  return (await readRowsFromTable(dir)).map((row) => Number(row.id)).sort((a, b) => a - b)
}

/** @param {string} partition */
async function generationDirs(partition) {
  return (await fs.readdir(partition)).filter((name) => /^(epoch=|table)/.test(name)).sort()
}

const EXPECTED = Array.from({ length: 12 }, (_, i) => i + 1)

test('an epoch-layout retry after a failed cursor swap does not adopt the abandoned generation', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-fresh-gen-epoch-'))
  try {
    const segments = ['source=claude']
    for (let i = 0; i < 12; i += 3) {
      await appendRowsToPartition(cacheRoot, 'ai_gateway_messages', segments, COLUMNS, rows(EXPECTED.slice(i, i + 3)))
    }
    const partition = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
    assert.equal(readCursorSync(partition).layout, undefined, 'seeded in the legacy epoch layout')
    assert.deepEqual(await liveIds(partition), EXPECTED)

    await withFailedCursorSwap(() => maintainCache({ cacheRoot, compactOnly: true, force: true }))
    assert.equal(readCursorSync(partition).epoch, 0, 'the failed swap left epoch=0 live')
    const abandoned = (await generationDirs(partition)).filter((name) => name !== 'epoch=0')
    assert.equal(abandoned.length, 1, 'and its output behind')
    const abandonedRows = await readRowsFromTable(path.join(partition, abandoned[0]))

    await maintainCache({ cacheRoot, compactOnly: true, force: true })
    const cursor = readCursorSync(partition)
    assert.notEqual(`epoch=${cursor.epoch}`, abandoned[0], 'the retry published a generation of its own')
    assert.deepEqual(await liveIds(partition), EXPECTED, 'exactly the source rows, once each')
    assert.equal(cursor.rowCount, 12, 'and the cursor counts them')
    assert.deepEqual(
      (await readRowsFromTable(path.join(partition, abandoned[0]))).length,
      abandonedRows.length,
      'the abandoned output is left as it was, for the orphan sweep'
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a source-table retry after a failed cursor swap does not adopt the abandoned generation', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-fresh-gen-table-'))
  try {
    const partition = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
    for (let i = 0; i < 12; i += 3) {
      await appendRowsToSourceTable(cacheRoot, 'ai_gateway_messages', ['source=claude'], COLUMNS, rows(EXPECTED.slice(i, i + 3)))
    }
    assert.equal(readCursorSync(partition).layout, 'source-table')
    const live = readCursorSync(partition).tableDir ?? 'table'

    // The clock is frozen across both attempts, so the retry asks for the
    // same `table-<ms>` name the abandoned attempt used.
    const now = Date.now()
    const clock = mock.method(Date, 'now', () => now)
    try {
      await withFailedCursorSwap(() => maintainCache({ cacheRoot, compactOnly: true, force: true }))
      const abandoned = (await generationDirs(partition)).filter((name) => name !== live)
      assert.equal(abandoned.length, 1, 'the failed swap left its output behind')

      await maintainCache({ cacheRoot, compactOnly: true, force: true })
      const cursor = readCursorSync(partition)
      assert.notEqual(cursor.tableDir, abandoned[0], 'the retry published a generation of its own')
      assert.deepEqual(await liveIds(partition), EXPECTED, 'exactly the source rows, once each')
      assert.equal(cursor.rowCount, 12)
    } finally {
      clock.mock.restore()
    }
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('a compaction that finds every candidate generation taken fails without touching any of them', async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-fresh-gen-full-'))
  try {
    const segments = ['source=claude']
    for (let i = 0; i < 12; i += 3) {
      await appendRowsToPartition(cacheRoot, 'ai_gateway_messages', segments, COLUMNS, rows(EXPECTED.slice(i, i + 3)))
    }
    const partition = path.join(cacheRoot, 'datasets', 'ai_gateway_messages', 'source=claude')
    const taken = Array.from({ length: 8 }, (_, i) => `epoch=${i + 1}`)
    for (const name of taken) {
      await fs.mkdir(path.join(partition, name))
      await fs.writeFile(path.join(partition, name, 'keep'), name)
    }

    const report = await maintainCache({ cacheRoot, compactOnly: true, force: true })
    assert.ok(JSON.stringify(report).includes('no free compaction generation'), 'the failure says why')
    assert.equal(readCursorSync(partition).epoch, 0, 'epoch=0 stays live')
    assert.deepEqual(await liveIds(partition), EXPECTED)
    for (const name of taken) {
      assert.equal(await fs.readFile(path.join(partition, name, 'keep'), 'utf8'), name, `${name} is untouched`)
    }
    assert.deepEqual(await generationDirs(partition), ['epoch=0', ...taken], 'and no new dir was made')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
