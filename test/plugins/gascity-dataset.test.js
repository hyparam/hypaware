// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { appendRowsToSourceTable } from '../../src/core/cache/partition.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import {
  createDataSource,
  DATASET_NAME,
  discoverParts,
  GASCITY_SCHEMA_COLUMNS,
  PARTITION_LABEL,
} from '../../hypaware-core/plugins-workspace/gascity/src/dataset.js'

/** @param {string} prefix */
async function makeTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `hyp-gascity-${prefix}-`))
}

/**
 * @param {number} id
 * @returns {Record<string, unknown>}
 */
function makeRow(id) {
  return {
    city: `city-${id}`,
    provider_session_id: `session-${id}`,
    event_time: new Date().toISOString(),
    event_kind: 'message',
    template: null,
    content_text: `hello ${id}`,
    metadata: null,
  }
}

// The kernel cache flush path commits spooled rows under `source=<client>`
// partitions, so discovery must surface those alongside the spool path or
// committed rows become invisible to queries.

test('gascity discoverParts surfaces committed source= partitions alongside the spool', async () => {
  const cacheRoot = await makeTmpDir('discover')
  try {
    await appendRowsToSourceTable(
      cacheRoot, DATASET_NAME, ['source=unknown'],
      [...GASCITY_SCHEMA_COLUMNS], [makeRow(1)]
    )

    const partitions = await discoverParts(/** @type {any} */ ({ cacheDir: cacheRoot }))
    const tablePaths = partitions.map(p => p.tablePath)
    assert.equal(new Set(tablePaths).size, tablePaths.length, 'no duplicate tablePaths')

    const spoolPath = path.join(cacheRoot, 'datasets', DATASET_NAME, PARTITION_LABEL)
    assert.ok(tablePaths.includes(spoolPath), 'spool partition must stay listed for settlement flushes')
    const committedPath = path.join(cacheRoot, 'datasets', DATASET_NAME, 'source=unknown')
    assert.ok(tablePaths.includes(committedPath), 'committed source= partition must be discovered')
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('gascity createDataSource reads rows committed under source= partitions', async () => {
  const cacheRoot = await makeTmpDir('read')
  try {
    await appendRowsToSourceTable(
      cacheRoot, DATASET_NAME, ['source=unknown'],
      [...GASCITY_SCHEMA_COLUMNS], [makeRow(1), makeRow(2)]
    )

    const storage = createQueryStorageService({ cacheRoot })
    const partitions = await discoverParts(/** @type {any} */ ({ cacheDir: cacheRoot }))
    const source = await createDataSource(partitions, /** @type {any} */ ({ storage }))

    const seen = []
    for await (const row of source.scan({}).rows()) {
      if (row.resolved) seen.push(row.resolved)
    }

    assert.equal(seen.length, 2)
    assert.deepEqual(seen.map(r => r.city).sort(), ['city-1', 'city-2'])
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})

test('gascity createDataSource returns an empty source on a cold cache', async () => {
  const cacheRoot = await makeTmpDir('cold')
  try {
    const storage = createQueryStorageService({ cacheRoot })
    const partitions = await discoverParts(/** @type {any} */ ({ cacheDir: cacheRoot }))
    const source = await createDataSource(partitions, /** @type {any} */ ({ storage }))

    assert.equal(source.numRows, 0)
    assert.deepEqual(source.columns, GASCITY_SCHEMA_COLUMNS.map(c => c.name))
  } finally {
    await fs.rm(cacheRoot, { recursive: true, force: true })
  }
})
