// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  BATCH_BYTE_LIMIT,
  BATCH_ROW_LIMIT,
  INTERNAL_FIELDS,
  readProgress,
  removeProgress,
  streamFlushFile,
  writeProgress,
} from '../../src/core/cache/streaming-reader.js'

/**
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'msg', type: 'STRING', nullable: false },
]

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {string}
 */
function envelope(rows) {
  return JSON.stringify({ version: 1, columns: COLUMNS, rows }) + '\n'
}

/**
 * @returns {Promise<string>}
 */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-stream-test-'))
}

test('streaming reader handles a large file without loading it into memory', async () => {
  const dir = await makeTmpDir()
  const filePath = path.join(dir, 'big.jsonl')

  const rowsPerLine = 50
  const lineCount = 2000
  const handle = await fs.open(filePath, 'w')
  for (let i = 0; i < lineCount; i++) {
    const rows = []
    for (let j = 0; j < rowsPerLine; j++) {
      rows.push({ id: i * rowsPerLine + j, msg: 'x'.repeat(200) })
    }
    await handle.writeFile(envelope(rows))
  }
  await handle.close()

  const stat = await fs.stat(filePath)
  assert.ok(stat.size > 500 * 1024 * 1024 / 1024, 'test file should be non-trivial')

  let totalRows = 0
  let batchCount = 0
  for await (const batch of streamFlushFile({ filePath, batchId: 'test-big' })) {
    totalRows += batch.chunk.rows.length
    batchCount++
    assert.ok(batch.chunk.rows.length <= BATCH_ROW_LIMIT)
  }

  assert.equal(totalRows, lineCount * rowsPerLine)
  assert.ok(batchCount >= 1)

  await fs.rm(dir, { recursive: true, force: true })
})

test('partial trailing line is preserved and correctly handled', async () => {
  const dir = await makeTmpDir()
  const filePath = path.join(dir, 'partial.jsonl')

  const completeLine = envelope([{ id: 1, msg: 'complete' }])
  const partialLine = '{"version":1,"columns":[{"name":"id","type":"INT64","nullable":false}],"rows":[{"id":2}]'
  await fs.writeFile(filePath, completeLine + partialLine)

  let totalRows = 0
  for await (const batch of streamFlushFile({ filePath, batchId: 'test-partial' })) {
    totalRows += batch.chunk.rows.length
  }

  assert.equal(totalRows, 1, 'only complete lines should be yielded')

  await fs.rm(dir, { recursive: true, force: true })
})

test('malformed JSON lines are counted, logged, and skipped without aborting', async () => {
  const dir = await makeTmpDir()
  const filePath = path.join(dir, 'malformed.jsonl')

  const good1 = envelope([{ id: 1, msg: 'ok' }])
  const bad1 = '{not valid json}\n'
  const bad2 = JSON.stringify({ version: 2, columns: [], rows: [] }) + '\n'
  const good2 = envelope([{ id: 2, msg: 'also ok' }])
  await fs.writeFile(filePath, good1 + bad1 + bad2 + good2)

  let totalRows = 0
  let totalMalformed = 0
  for await (const batch of streamFlushFile({ filePath, batchId: 'test-malformed' })) {
    totalRows += batch.chunk.rows.length
    totalMalformed += batch.malformedCount
  }

  assert.equal(totalRows, 2)
  assert.equal(totalMalformed, 2)

  await fs.rm(dir, { recursive: true, force: true })
})

test('resume cursor updates correctly and restart from cursor produces identical results', async () => {
  const dir = await makeTmpDir()
  const filePath = path.join(dir, 'resume.jsonl')

  const lines = []
  for (let i = 0; i < 5; i++) {
    lines.push(envelope([{ id: i, msg: `row-${i}` }]))
  }
  await fs.writeFile(filePath, lines.join(''))

  const firstRunRows = []
  let resumeAfterTwo = 0
  let batchesSeen = 0
  for await (const batch of streamFlushFile({
    filePath,
    batchId: 'run1',
    batchRowLimit: 2,
  })) {
    batchesSeen++
    for (const row of batch.chunk.rows) {
      firstRunRows.push(row)
    }
    if (batchesSeen === 1) {
      resumeAfterTwo = batch.resumeOffset
      await writeProgress(filePath, resumeAfterTwo)
      break
    }
  }

  assert.equal(firstRunRows.length, 2)
  assert.ok(resumeAfterTwo > 0)

  const progress = await readProgress(filePath)
  assert.ok(progress)
  assert.equal(progress.byteOffset, resumeAfterTwo)

  const secondRunRows = []
  for await (const batch of streamFlushFile({
    filePath,
    batchId: 'run2',
    startOffset: progress.byteOffset,
  })) {
    for (const row of batch.chunk.rows) {
      secondRunRows.push(row)
    }
  }

  assert.equal(secondRunRows.length, 3)

  const allIds = [...firstRunRows, ...secondRunRows]
    .map((r) => /** @type {number} */ (r.id))
    .sort((a, b) => a - b)
  assert.deepEqual(allIds, [0, 1, 2, 3, 4])

  await removeProgress(filePath)
  const gone = await readProgress(filePath)
  assert.equal(gone, null)

  await fs.rm(dir, { recursive: true, force: true })
})

test('batch boundaries respect row-count threshold', async () => {
  const dir = await makeTmpDir()
  const filePath = path.join(dir, 'row-limit.jsonl')

  const rows = []
  for (let i = 0; i < 10; i++) {
    rows.push({ id: i, msg: `r${i}` })
  }
  await fs.writeFile(filePath, envelope(rows))

  const batches = []
  for await (const batch of streamFlushFile({
    filePath,
    batchId: 'test-row-limit',
    batchRowLimit: 3,
  })) {
    batches.push(batch.chunk.rows.length)
  }

  assert.ok(batches.length >= 3, `expected at least 3 batches, got ${batches.length}`)
  for (const size of batches) {
    assert.ok(size <= 3, `batch size ${size} exceeds limit of 3`)
  }
  const total = batches.reduce((a, b) => a + b, 0)
  assert.equal(total, 10)

  await fs.rm(dir, { recursive: true, force: true })
})

test('batch boundaries respect byte-size threshold', async () => {
  const dir = await makeTmpDir()
  const filePath = path.join(dir, 'byte-limit.jsonl')

  const rows = []
  for (let i = 0; i < 20; i++) {
    rows.push({ id: i, msg: 'x'.repeat(500) })
  }
  await fs.writeFile(filePath, envelope(rows))

  const singleRowBytes = Buffer.byteLength(JSON.stringify(rows[0]), 'utf8')
  const tinyByteLimit = singleRowBytes * 3

  const batches = []
  for await (const batch of streamFlushFile({
    filePath,
    batchId: 'test-byte-limit',
    batchByteLimit: tinyByteLimit,
    batchRowLimit: BATCH_ROW_LIMIT,
  })) {
    batches.push(batch.chunk.rows.length)
  }

  assert.ok(batches.length > 1, `expected multiple batches, got ${batches.length}`)
  const total = batches.reduce((a, b) => a + b, 0)
  assert.equal(total, 20)

  await fs.rm(dir, { recursive: true, force: true })
})

test('rows are decorated with internal fields', async () => {
  const dir = await makeTmpDir()
  const filePath = path.join(dir, 'fields.jsonl')

  await fs.writeFile(filePath, envelope([{ id: 1, msg: 'hello' }]))

  for await (const batch of streamFlushFile({ filePath, batchId: 'batch-42' })) {
    for (const row of batch.chunk.rows) {
      assert.ok(typeof row._hyp_cache_row_id === 'string')
      assert.ok(/** @type {string} */ (row._hyp_cache_row_id).length === 64)
      assert.equal(row._hyp_cache_batch_id, 'batch-42')
    }
  }

  assert.ok(INTERNAL_FIELDS.includes('_hyp_cache_row_id'))
  assert.ok(INTERNAL_FIELDS.includes('_hyp_cache_batch_id'))

  await fs.rm(dir, { recursive: true, force: true })
})

test('identical rows produce the same _hyp_cache_row_id', async () => {
  const dir = await makeTmpDir()
  const filePath = path.join(dir, 'dedup.jsonl')

  await fs.writeFile(
    filePath,
    envelope([{ id: 1, msg: 'same' }]) + envelope([{ id: 1, msg: 'same' }])
  )

  /** @type {string[]} */
  const ids = []
  for await (const batch of streamFlushFile({ filePath, batchId: 'dedup' })) {
    for (const row of batch.chunk.rows) {
      ids.push(/** @type {string} */ (row._hyp_cache_row_id))
    }
  }

  assert.equal(ids.length, 2)
  assert.equal(ids[0], ids[1])

  await fs.rm(dir, { recursive: true, force: true })
})

test('progress file write and read roundtrip', async () => {
  const dir = await makeTmpDir()
  const fakeSpool = path.join(dir, 'flush-123.jsonl')
  await fs.writeFile(fakeSpool, '')

  await writeProgress(fakeSpool, 4096)
  const state = await readProgress(fakeSpool)
  assert.ok(state)
  assert.equal(state.byteOffset, 4096)
  assert.ok(typeof state.updatedAt === 'string')

  await removeProgress(fakeSpool)
  assert.equal(await readProgress(fakeSpool), null)

  await fs.rm(dir, { recursive: true, force: true })
})

test('empty file yields no batches', async () => {
  const dir = await makeTmpDir()
  const filePath = path.join(dir, 'empty.jsonl')
  await fs.writeFile(filePath, '')

  let count = 0
  for await (const _batch of streamFlushFile({ filePath, batchId: 'empty' })) {
    count++
  }
  assert.equal(count, 0)

  await fs.rm(dir, { recursive: true, force: true })
})
