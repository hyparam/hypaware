// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { parquetWriteBuffer } from 'hyparquet-writer'
import { collect, executeSql } from 'squirreling'

import { buildS3QueryDataset } from '../../hypaware-core/plugins-workspace/s3/src/query-dataset.js'
import { rowsToColumnSources } from '../../hypaware-core/plugins-workspace/format-parquet/src/columns.js'

/**
 * @import { BlobStore, ColumnSpec } from '../../collectivus-plugin-kernel-types.d.ts'
 */

/** @type {ColumnSpec[]} */
const COLUMNS = [
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'name', type: 'STRING', nullable: false },
]

/**
 * Minimal in-memory BlobStore over a key -> bytes map. Mirrors the parts
 * of the S3 BlobStore the query path touches (getObject + listObjects).
 *
 * @param {Map<string, Uint8Array>} objects
 * @returns {BlobStore}
 */
function fakeBlobStore(objects) {
  return /** @type {BlobStore} */ ({
    kind: 's3',
    async getObject({ key }) {
      const bytes = objects.get(key)
      if (!bytes) return null
      return { body: Readable.from([bytes]), contentLength: bytes.byteLength, etag: '"etag"' }
    },
    listObjects({ prefix }) {
      const wanted = prefix ?? ''
      return {
        async *[Symbol.asyncIterator]() {
          const entries = [...objects.entries()].sort((a, b) => a[0].localeCompare(b[0]))
          for (const [key, bytes] of entries) {
            if (wanted.length > 0 && !key.startsWith(wanted)) continue
            yield { key, size: bytes.byteLength, lastModified: new Date(0) }
          }
        },
      }
    },
    async putObject() {
      throw new Error('fakeBlobStore: putObject not supported')
    },
    async deleteObject() {},
  })
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Uint8Array}
 */
function parquetBytes(rows) {
  const columnData = rowsToColumnSources(COLUMNS, rows)
  return new Uint8Array(parquetWriteBuffer({ columnData, codec: 'SNAPPY' }))
}

/**
 * Discover partitions + build the data source, then run SQL against it.
 *
 * @param {import('../../collectivus-plugin-kernel-types.d.ts').DatasetRegistration} dataset
 * @param {string} query
 */
async function runQuery(dataset, query) {
  const partitions = await dataset.discoverPartitions({
    config: /** @type {any} */ ({ version: 2 }),
    scope: { limit: 1000 },
  })
  const source = await dataset.createDataSource(partitions, {
    scope: { limit: 1000 },
    storage: /** @type {any} */ ({}),
  })
  return collect(executeSql({ tables: { [dataset.name]: source }, query }))
}

test('parquet query source reads a single object back through SQL', async () => {
  const objects = new Map([
    ['exports/events/part-0.parquet', parquetBytes([
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
    ])],
  ])
  const dataset = buildS3QueryDataset({
    source: { name: 'events', format: 'parquet', prefix: 'exports/events' },
    blobStore: fakeBlobStore(objects),
    plugin: '@hypaware/s3',
  })

  const partitions = await dataset.discoverPartitions({
    config: /** @type {any} */ ({ version: 2 }),
    scope: { limit: 1000 },
  })
  assert.equal(partitions.length, 1)
  assert.equal(partitions[0].tableUrl, 'exports/events/part-0.parquet')

  const rows = await runQuery(dataset, 'SELECT name FROM events WHERE id = 2')
  assert.deepEqual(rows, [{ name: 'bob' }])
})

test('parquet query source unions multiple objects and ignores non-parquet keys', async () => {
  const objects = new Map([
    ['exports/events/part-0.parquet', parquetBytes([{ id: 1, name: 'alice' }])],
    ['exports/events/part-1.parquet', parquetBytes([{ id: 2, name: 'bob' }, { id: 3, name: 'carol' }])],
    ['exports/events/_SUCCESS', new Uint8Array([1, 2, 3])],
  ])
  const dataset = buildS3QueryDataset({
    source: { name: 'events', format: 'parquet', prefix: 'exports/events' },
    blobStore: fakeBlobStore(objects),
    plugin: '@hypaware/s3',
  })

  const partitions = await dataset.discoverPartitions({
    config: /** @type {any} */ ({ version: 2 }),
    scope: { limit: 1000 },
  })
  assert.equal(partitions.length, 2, 'only .parquet objects become partitions')

  const all = await runQuery(dataset, 'SELECT id, name FROM events')
  assert.deepEqual(all.map((r) => Number(r.id)).sort((a, b) => a - b), [1, 2, 3])

  // Engine-side WHERE/aggregate over the union
  const count = await runQuery(dataset, 'SELECT COUNT(*) AS n FROM events WHERE id >= 2')
  assert.equal(Number(count[0].n), 2)
})

test('parquet query source with no objects yields an empty result', async () => {
  const dataset = buildS3QueryDataset({
    source: {
      name: 'events',
      format: 'parquet',
      prefix: 'exports/events',
      schema: COLUMNS,
    },
    blobStore: fakeBlobStore(new Map()),
    plugin: '@hypaware/s3',
  })
  const rows = await runQuery(dataset, 'SELECT * FROM events')
  assert.deepEqual(rows, [])
})

test('iceberg query source with no metadata reads as empty (no throw)', async () => {
  const dataset = buildS3QueryDataset({
    source: {
      name: 'ai_gw',
      format: 'iceberg',
      prefix: 'iceberg/datasets/ai_gw',
      schema: COLUMNS,
    },
    blobStore: fakeBlobStore(new Map()),
    plugin: '@hypaware/s3',
  })
  const rows = await runQuery(dataset, 'SELECT * FROM ai_gw')
  assert.deepEqual(rows, [])
})
