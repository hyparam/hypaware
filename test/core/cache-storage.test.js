// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createQueryStorageService } from '../../src/core/cache/storage.js'

/**
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
 */

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-cache-storage-${prefix}-`))
}

/** @type {ColumnSpec[]} */
const SIMPLE_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'value', type: 'STRING', nullable: true },
]

test('storage.appendRowsToPartition returns append metadata', async () => {
  const cacheRoot = await makeTmpDir('append-meta')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    const result = await storage.appendRowsToPartition(
      'dataset',
      ['all'],
      SIMPLE_COLUMNS,
      [{ id: 1, value: 'a' }]
    )

    assert.equal(typeof result.tableUrl, 'string')
    assert.ok(result.tableUrl.length > 0)
    assert.equal(result.appended, true)
    assert.ok(result.bytesWritten > 0)
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('storage.dataSourceForTable keeps columns and cells aligned after internal-field filtering', async () => {
  const cacheRoot = await makeTmpDir('row-alignment')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    const columns = [
      { name: 'id', type: 'INT32', nullable: false },
      { name: '_hyp_cache_row_id', type: 'STRING', nullable: true },
      { name: 'value', type: 'STRING', nullable: true },
      { name: '_hyp_cache_batch_id', type: 'STRING', nullable: true },
    ]
    await storage.appendRowsToPartition(
      'dataset',
      ['all'],
      columns,
      [{ id: 7, _hyp_cache_row_id: 'row-7', value: 'kept', _hyp_cache_batch_id: 'batch-1' }]
    )

    const source = await storage.dataSourceForTable(storage.cacheTablePath('dataset', ['all']))
    assert.ok(source)

    const scan = source.scan({})
    for await (const row of scan.rows()) {
      assert.deepEqual(row.columns, ['id', 'value'])
      assert.equal(row.cells.length, 2)

      const first = await resolveCell(row.cells[0])
      const second = await resolveCell(row.cells[1])
      assert.equal(String(first), '7')
      assert.equal(second, 'kept')

      assert.deepEqual(row.resolved, { id: 7, value: 'kept' })
      return
    }

    assert.fail('expected one row from data source')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

/**
 * @param {unknown} cell
 * @returns {Promise<unknown>}
 */
async function resolveCell(cell) {
  if (typeof cell === 'function') return await cell()
  return await Promise.resolve(cell)
}
