// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { parquetWriteBuffer } from 'hyparquet-writer'
import { collect, executeSql } from 'squirreling'

import { buildS3QueryDataset } from '../../hypaware-core/plugins-workspace/s3/src/query-dataset.js'
import { rowsToColumnSources } from '../../hypaware-core/plugins-workspace/format-parquet/src/columns.js'
import { createLocalFsBlobStore } from '../../hypaware-core/plugins-workspace/local-fs/src/blob-store.js'
import { createBlobStoreIO, tableUrlForBlobPrefix } from '../../hypaware-core/plugins-workspace/format-iceberg/src/blob-io.js'
import { commitBatch, probeTable } from '../../hypaware-core/plugins-workspace/format-iceberg/src/commit.js'

/**
 * @import { BlobStore, ColumnSpec, DatasetRegistration } from '../../hypaware-plugin-kernel-types.js'
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
 * @param {DatasetRegistration} dataset
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

// The s3 iceberg branch (`createIcebergDataSource`) reaches the same
// `icebergDataSource` the local cache's `dataSourceForTable` does, so it
// inherits the same pushdown converter (LLP 0222), but it is a lazy dynamic
// import reached only by s3-configured deployments and had no test of its own.
// This writes a real table through a real BlobStore (local-fs standing in for
// S3, the same adapter shape `@hypaware/s3` uses) and proves the remote branch
// is NULL-correct, not just the local one.
test('iceberg query source is NULL-correct through a real BlobStore round trip', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-s3-iceberg-'))
  try {
    const blobStore = createLocalFsBlobStore({ baseDir: dir })
    const { resolver, lister } = await createBlobStoreIO(blobStore)
    const prefix = 'iceberg/datasets/ai_gw'
    const tableUrl = tableUrlForBlobPrefix(prefix)
    /** @type {ColumnSpec[]} */
    const columns = [
      { name: 'id', type: 'INT64', nullable: false },
      { name: 'ts', type: 'INT64', nullable: true },
    ]
    // Same `ts` shape as the local-cache parity fixture
    // (`test/core/iceberg-source-parity.test.js`): straddles a bound with
    // NULLs on either side, so `!= 300` has to exclude both the NULL rows
    // and the literal match rather than just the match.
    const rows = [
      { id: 1, ts: 100 },
      { id: 2, ts: null },
      { id: 3, ts: 300 },
      { id: 4, ts: null },
      { id: 5, ts: 500 },
    ]
    const priorState = await probeTable(tableUrl, resolver, lister)
    await commitBatch({ tableUrl, columns, rows, resolver, lister }, priorState)

    const dataset = buildS3QueryDataset({
      source: { name: 'ai_gw', format: 'iceberg', prefix, schema: columns },
      blobStore,
      plugin: '@hypaware/s3',
    })

    /** @type {[string, number[]][]} */
    const cases = [
      ['ts = NULL', []],
      ['NOT (ts = NULL)', []],
      ['ts != NULL', []],
      ['ts NOT IN (300, NULL)', []],
      ['ts != 300', [1, 5]],
      // the typed-literal fold has to reach the remote tier too, or an
      // s3-backed dataset scans unpruned where the local cache does not
      ['ts > CAST(300 AS BIGINT)', [5]],
      ['NOT (ts > CAST(300 AS BIGINT))', [1, 3]],
    ]
    /** @type {string[]} */
    const wrong = []
    for (const [predicate, expected] of cases) {
      const got = await runQuery(dataset, `SELECT id FROM ai_gw WHERE ${predicate}`)
      const ids = got.map((r) => Number(r.id)).sort((a, b) => a - b)
      if (ids.join(',') !== expected.join(',')) {
        wrong.push(`WHERE ${predicate} -> [${ids.join(',')}], SQL says [${expected.join(',')}]`)
      }
    }
    assert.deepEqual(wrong, [])

    const agg = await runQuery(dataset, 'SELECT COUNT(ts) AS n FROM ai_gw WHERE NOT (ts = NULL)')
    assert.equal(Number(agg[0].n), 0, 'a filtered aggregate must reach the same NULL-correct rows')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('parquet discovery bounds the prefix to a directory, excluding sibling namespaces', async () => {
  // `exports/events` and `exports/events_archive` share a string prefix.
  // S3 (and the BlobStore) match `prefix` as a bare string, so without a
  // trailing-slash boundary the archive's part would union into `events`.
  const objects = new Map([
    ['exports/events/part-0.parquet', parquetBytes([{ id: 1, name: 'alice' }])],
    ['exports/events_archive/part-0.parquet', parquetBytes([{ id: 99, name: 'archived' }])],
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
  assert.equal(partitions.length, 1, 'sibling namespace must not be discovered')
  assert.equal(partitions[0].tableUrl, 'exports/events/part-0.parquet')

  const rows = await runQuery(dataset, 'SELECT id FROM events')
  assert.deepEqual(rows.map((r) => Number(r.id)), [1], 'archived row must not leak in')
})

test('parquet read rejects when a listed object disappears before read (list→read race)', async () => {
  // listObjects advertises a key, but getObject returns null: the
  // real list→read race. The scan must reject, not silently drop rows.
  /** @type {BlobStore} */
  const racyBlobStore = /** @type {BlobStore} */ ({
    kind: 's3',
    async getObject() {
      return null
    },
    listObjects() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { key: 'exports/events/part-0.parquet', size: 10, lastModified: new Date(0) }
        },
      }
    },
    async putObject() {
      throw new Error('not supported')
    },
    async deleteObject() {},
  })
  const dataset = buildS3QueryDataset({
    source: { name: 'events', format: 'parquet', prefix: 'exports/events' },
    blobStore: racyBlobStore,
    plugin: '@hypaware/s3',
  })

  const partitions = await dataset.discoverPartitions({
    config: /** @type {any} */ ({ version: 2 }),
    scope: { limit: 1000 },
  })
  assert.equal(partitions.length, 1)
  await assert.rejects(
    async () => {
      await dataset.createDataSource(partitions, { scope: { limit: 1000 }, storage: /** @type {any} */ ({}) })
    },
    /query object not found/
  )
})
