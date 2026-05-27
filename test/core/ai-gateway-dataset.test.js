// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendRowsToPartition } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import {
  createDataSource,
  DATASET_NAME,
  discoverParts,
} from '../../hypaware-core/plugins-workspace/ai-gateway/src/dataset.js'

/**
 * @import { ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
 */

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-ai-gw-${prefix}-`))
}

/** @type {ColumnSpec[]} */
const TEST_COLUMNS = [
  { name: 'id', type: 'INT32', nullable: false },
  { name: 'date', type: 'STRING', nullable: false },
]

test('ai-gateway createDataSource honors scope when re-discovering fresh partitions', async () => {
  const cacheRoot = await makeTmpDir('scope')
  try {
    await appendRowsToPartition(
      cacheRoot,
      DATASET_NAME,
      ['client=claude', 'date=2026-05-25'],
      TEST_COLUMNS,
      [{ id: 1, date: '2026-05-25' }]
    )
    await appendRowsToPartition(
      cacheRoot,
      DATASET_NAME,
      ['client=claude', 'date=2026-05-26'],
      TEST_COLUMNS,
      [{ id: 2, date: '2026-05-26' }]
    )

    const storage = createQueryStorageService({ cacheRoot })
    const scope = { date: '2026-05-26' }
    const partitions = await discoverParts({ cacheDir: cacheRoot, scope, config: { version: 2 } })
    const source = await createDataSource(partitions, { scope, storage })

    const seen = []
    for await (const row of source.scan({}).rows()) {
      if (row.resolved) {
        seen.push(row.resolved)
        continue
      }
      seen.push(await resolveRow(row))
    }

    assert.equal(seen.length, 1)
    assert.equal(seen[0].id, 2)
    assert.equal(seen[0].date, '2026-05-26')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

/**
 * @param {{ columns: string[], cells: unknown[] }} row
 * @returns {Promise<Record<string, unknown>>}
 */
async function resolveRow(row) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (let i = 0; i < row.columns.length; i++) {
    const cell = row.cells[i]
    out[row.columns[i]] = typeof cell === 'function' ? await cell() : await Promise.resolve(cell)
  }
  return out
}
