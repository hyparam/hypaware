// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { createQueryStorageService, resolveIcebergDir } from '../../src/core/cache/storage.js'
import { dataSourceForTable } from '../../src/core/cache/iceberg/store.js'
import { discoverCachePartitions } from '../../src/core/cache/partition.js'

/**
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.js'
 * @import { AsyncDataSource, SqlPrimitive } from 'squirreling'
 */

// T2 (LLP 0059): the pinned icebird@0.8.12 bump is the whole kernel-side
// change (`@ref LLP 0055` at `dataSourceForTable`'s call to `icebergDataSource`
// in src/core/cache/iceberg/store.js). These tests drive that consumption
// point directly, against a real local Iceberg table, proving `scanColumn`
// streams a single column's values correctly and honors limit/offset/signal
// before anything forwards it further up the stack (union-source.js/T3,
// ai-gateway's withSchemaColumns/T4 remain unwired until those tasks land).

/** @returns {Promise<string>} */
async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hyp-scan-column-'))
}

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'msg', type: 'STRING', nullable: false },
]

/**
 * Build a small real local Iceberg table (via the cache spool + flush path)
 * and return the pinned-icebird-backed `AsyncDataSource` for it.
 *
 * @param {string} cacheRoot
 * @param {{ id: number, msg: string }[]} rows
 */
async function buildIcebergSource(cacheRoot, rows) {
  const svc = createQueryStorageService({ cacheRoot })
  const tablePath = svc.cacheTablePath('demo', ['all'])
  await svc.appendRows(tablePath, COLUMNS, rows)
  await svc.flushTable(tablePath, { reason: 'manual' })

  const parts = await discoverCachePartitions(cacheRoot)
  assert.equal(parts.length, 1)
  const icebergDir = resolveIcebergDir(parts[0].path)
  const source = await dataSourceForTable(icebergDir)
  assert.ok(source, 'expected a committed table to produce a data source')
  return source
}

/**
 * @param {AsyncDataSource} source
 * @param {{ column: string, limit?: number, offset?: number, signal?: AbortSignal }} options
 */
async function collectColumn(source, options) {
  assert.equal(typeof source.scanColumn, 'function', 'pinned icebird source exposes scanColumn')
  /** @type {SqlPrimitive[]} */
  const values = []
  const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (source.scanColumn)
  // squirreling@0.16.0's scanColumn return type is a union (bare
  // AsyncIterable, what icebird@0.8.12 yields today, or the newer
  // ScanColumnResults `.chunks()` wrapper); normalize before iterating.
  // `@ref LLP 0055`.
  const result = scanColumn(options)
  const chunks = 'chunks' in result ? result.chunks() : result
  for await (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) values.push(chunk[i])
  }
  return values
}

test('scanColumn streams a single column\'s values in row order', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const source = await buildIcebergSource(cacheRoot, [
      { id: 1, msg: 'a' },
      { id: 2, msg: 'b' },
      { id: 3, msg: 'c' },
      { id: 4, msg: 'd' },
      { id: 5, msg: 'e' },
    ])
    const ids = await collectColumn(source, { column: 'id' })
    assert.deepEqual(ids, [1, 2, 3, 4, 5])
    const msgs = await collectColumn(source, { column: 'msg' })
    assert.deepEqual(msgs, ['a', 'b', 'c', 'd', 'e'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('scanColumn honors limit and offset', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const source = await buildIcebergSource(cacheRoot, [
      { id: 1, msg: 'a' },
      { id: 2, msg: 'b' },
      { id: 3, msg: 'c' },
      { id: 4, msg: 'd' },
      { id: 5, msg: 'e' },
    ])
    const middle = await collectColumn(source, { column: 'id', offset: 1, limit: 2 })
    assert.deepEqual(middle, [2, 3])
    const tail = await collectColumn(source, { column: 'id', offset: 4, limit: 10 })
    assert.deepEqual(tail, [5])
    const none = await collectColumn(source, { column: 'id', offset: 10, limit: 5 })
    assert.deepEqual(none, [])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('scanColumn honors an already-aborted signal', async () => {
  const cacheRoot = await makeTmpDir()
  try {
    const source = await buildIcebergSource(cacheRoot, [
      { id: 1, msg: 'a' },
      { id: 2, msg: 'b' },
    ])
    await assert.rejects(
      collectColumn(source, { column: 'id', signal: AbortSignal.abort() }),
      /Aborted|AbortError/
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
