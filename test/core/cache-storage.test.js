// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createQueryStorageService } from '../../src/core/cache/storage.js'
import { DEFAULT_SPOOL_BYTES_THRESHOLD } from '../../src/core/cache/spool.js'

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

test('default spool threshold is Iceberg-sized to avoid frequent small commits', () => {
  assert.equal(DEFAULT_SPOOL_BYTES_THRESHOLD, 512 * 1024 * 1024)
})

test('storage.appendRowsToPartition writes data without error', async () => {
  const cacheRoot = await makeTmpDir('append-meta')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    await storage.appendRowsToPartition(
      'dataset',
      ['all'],
      SIMPLE_COLUMNS,
      [{ id: 1, value: 'a' }]
    )
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('storage.dataSourceForTable keeps columns and cells aligned after internal-field filtering', async () => {
  const cacheRoot = await makeTmpDir('row-alignment')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    /** @type {ColumnSpec[]} */
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
      assert.ok(!row.columns.includes('_hyp_cache_row_id'))
      assert.ok(!row.columns.includes('_hyp_cache_batch_id'))

      if (row.resolved) {
        assert.ok(!('_hyp_cache_row_id' in row.resolved))
        assert.ok(!('_hyp_cache_batch_id' in row.resolved))
      }
      return
    }

    assert.fail('expected one row from data source')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
