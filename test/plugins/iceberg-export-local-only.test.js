// @ts-check

// The Iceberg table-format sink used to read committed rows through
// `storage.readRows` — a plain full scan that bypasses the shared,
// filtered export seam (`storage.readRowsSince`). Every other sink
// (central forward, blob/local-fs incremental) already honors a
// `local-only` cwd by reading through that seam; the Iceberg writer was
// the last export path still off it, so a `local-only` directory could
// leak into a committed snapshot even though it never reached any other
// sink (LLP 0070#why-export, task T4). This asserts the reroute: the
// committed snapshot excludes `local-only` rows, and is unaffected when
// no `local-only` list is configured at all.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { icebergRead, loadLatestFileCatalogMetadata } from 'icebird'

import { createTableFormatProvider } from '../../hypaware-core/plugins-workspace/format-iceberg/src/table-format.js'
import {
  createBlobStoreIO,
  tableUrlForBlobPrefix,
} from '../../hypaware-core/plugins-workspace/format-iceberg/src/blob-io.js'
import { createLocalFsBlobStore } from '../../hypaware-core/plugins-workspace/local-fs/src/blob-store.js'
import { createQueryStorageService } from '../../src/core/cache/storage.js'
import {
  createUsagePolicyResolver,
  localOnlyListPath,
  writeLocalOnlyDirs,
} from '../../src/core/usage-policy/index.js'

/**
 * @import { BlobStore } from '../../hypaware-plugin-kernel-types.js'
 */

const DATASET = 'iceberg_local_only_rows'
const COLUMNS = /** @type {const} */ ([
  { name: 'id', type: 'INT64', nullable: false },
  { name: 'cwd', type: 'STRING', nullable: false },
])

function makeLog() {
  const noop = () => {}
  return { debug: noop, info: noop, warn: noop, error: noop }
}

function makeEncoder() {
  return /** @type {any} */ ({
    format: 'parquet',
    extension: 'parquet',
    supports: ['queryable'],
    async encodePartition() {
      return { filename: 'f', bytes: new Uint8Array() }
    },
  })
}

/**
 * @param {string} baseDir
 */
async function freshFixture(baseDir) {
  const cacheRoot = path.join(baseDir, 'cache')
  const stateDir = path.join(baseDir, 'state')
  const destDir = path.join(baseDir, 'export')
  await fs.mkdir(cacheRoot, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
  await fs.mkdir(destDir, { recursive: true })
  const blobStore = createLocalFsBlobStore({ baseDir: destDir })
  return { cacheRoot, stateDir, blobStore }
}

/**
 * @param {{ storage: any, blobStore: BlobStore }} deps
 */
async function makeSink({ storage, blobStore }) {
  const provider = createTableFormatProvider()
  return provider.createSink(
    /** @type {any} */ ({
      name: 'iceberg-local-only-test',
      plugin: { name: '@hypaware/format-iceberg', version: '1.0.0' },
      paths: { rootDir: '/', stateDir: '/', cacheDir: '/', tempDir: '/' },
      log: makeLog(),
      sinkInstanceConfig: { schedule: '* * * * *' },
      query: {
        listDatasets: () => [DATASET],
        getDataset: () => ({ schema: { columns: COLUMNS } }),
        registerDataset() {},
      },
      storage,
      blobStore,
      encoder: makeEncoder(),
    })
  )
}

/**
 * Rows land under a client-routed segment (`source=<client>`) the cache
 * derives at flush time (`resolveClientName` / `resolveSourceSegments`),
 * not under the path `appendRows` was called with — so the partition's
 * real `tablePath` must be discovered after flushing, exactly as the sink
 * driver does.
 *
 * @param {any} storage
 */
async function discoverTablePath(storage) {
  const discovered = await storage.discoverCachePartitions({ datasets: [DATASET] })
  const partition = discovered[0]
  if (!partition) throw new Error(`discoverTablePath: no partition found for dataset ${DATASET}`)
  return /** @type {string} */ (partition.path)
}

/**
 * @param {string} tableUrl
 * @param {BlobStore} blobStore
 */
async function readCommittedRows(tableUrl, blobStore) {
  const { resolver, lister } = await createBlobStoreIO(blobStore)
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  return /** @type {Record<string, unknown>[]} */ (await icebergRead({ tableUrl, metadata, resolver }))
}

test('the committed Iceberg snapshot excludes rows from a local-only directory', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-iceberg-local-only-'))
  try {
    const { cacheRoot, stateDir, blobStore } = await freshFixture(baseDir)
    const orgDir = path.join(baseDir, 'repos', 'org-repo')
    const personalDir = path.join(baseDir, 'repos', 'personal')
    await writeLocalOnlyDirs({ stateDir, dirs: [personalDir] })

    const resolver = createUsagePolicyResolver({ localOnlyListPath: localOnlyListPath(stateDir) })
    const storage = createQueryStorageService({ cacheRoot, usagePolicyResolver: resolver })
    await storage.appendRows(storage.cacheTablePath(DATASET), /** @type {any} */ (COLUMNS), [
      { id: 1n, cwd: orgDir },
      { id: 2n, cwd: personalDir },
      { id: 3n, cwd: orgDir },
    ])
    await storage.flushAll({ force: true })
    const tablePath = await discoverTablePath(storage)

    const sink = await makeSink({ storage, blobStore })
    const result = await sink.exportBatch(
      /** @type {any} */ ({ batchId: 'batch-1', partitions: [{ dataset: DATASET, tablePath }] }),
      /** @type {any} */ ({})
    )
    assert.equal(result.status, 'exported')

    const rows = await readCommittedRows(tableUrlForBlobPrefix(`iceberg/datasets/${DATASET}`), blobStore)
    assert.equal(rows.length, 2, 'the local-only row never reaches the committed snapshot')
    assert.deepEqual(rows.map((r) => String(r.id)).sort(), ['1', '3'])
    assert.ok(!rows.some((r) => r.cwd === personalDir), 'no committed row carries the local-only cwd')
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true })
  }
})

test('unaffected when no local-only list is configured: every row commits, as before', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-iceberg-local-only-'))
  try {
    const { cacheRoot, blobStore } = await freshFixture(baseDir)
    const cwd = path.join(baseDir, 'repos', 'only-repo')

    // No `usagePolicyResolver` at all — mirrors every caller that predates
    // LLP 0070/local-only, and every existing iceberg-export test/smoke.
    const storage = createQueryStorageService({ cacheRoot })
    await storage.appendRows(storage.cacheTablePath(DATASET), /** @type {any} */ (COLUMNS), [
      { id: 1n, cwd },
      { id: 2n, cwd },
    ])
    await storage.flushAll({ force: true })
    const tablePath = await discoverTablePath(storage)

    const sink = await makeSink({ storage, blobStore })
    const result = await sink.exportBatch(
      /** @type {any} */ ({ batchId: 'batch-1', partitions: [{ dataset: DATASET, tablePath }] }),
      /** @type {any} */ ({})
    )
    assert.equal(result.status, 'exported')

    const rows = await readCommittedRows(tableUrlForBlobPrefix(`iceberg/datasets/${DATASET}`), blobStore)
    assert.equal(rows.length, 2, 'no resolver configured means nothing is withheld')
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true })
  }
})
