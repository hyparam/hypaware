// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadManifest, validateManifest } from '../../src/core/manifest.js'
import {
  V1_BUNDLED_PLUGIN_ALLOWLIST,
  discoverBundledPlugins,
} from '../../src/core/runtime/bundled.js'
import { firstPartyPluginMetadata } from '../../src/core/config/validate.js'
import { createTableFormatProvider } from '../../hypaware-core/plugins-workspace/format-iceberg/src/table-format.js'

/**
 * @import { HypError } from '../../collectivus-plugin-kernel-types.js'
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const PLUGIN_DIR = path.join(REPO_ROOT, 'hypaware-core', 'plugins-workspace', 'format-iceberg')

test('format-iceberg manifest is valid', async () => {
  const result = await loadManifest(PLUGIN_DIR)
  assert.equal(result.ok, true, JSON.stringify(result, null, 2))
  assert.equal(result.manifest.name, '@hypaware/format-iceberg')
  assert.equal(result.manifest.version, '1.0.0')
  // The kernel relies on these provide/require shapes for sink dispatch.
  assert.deepEqual(result.manifest.provides?.capabilities, { 'hypaware.table-format': '1.0.0' })
  assert.deepEqual(result.manifest.requires?.capabilities, {
    'hypaware.blob-store': '^1.0.0',
    'hypaware.encoder': '^1.0.0',
  })
})

test('format-iceberg manifest passes the pure validator', async () => {
  const raw = await fs.readFile(path.join(PLUGIN_DIR, 'hypaware.plugin.json'), 'utf8')
  const parsed = JSON.parse(raw)
  const validation = validateManifest(parsed)
  assert.equal(validation.ok, true)
})

test('format-iceberg is on the V1 bundled allowlist', () => {
  assert.ok(
    V1_BUNDLED_PLUGIN_ALLOWLIST.has('@hypaware/format-iceberg'),
    'expected @hypaware/format-iceberg in V1_BUNDLED_PLUGIN_ALLOWLIST so it appears in `hyp plugin list`'
  )
})

test('discoverBundledPlugins surfaces format-iceberg from the workspace', async () => {
  const result = await discoverBundledPlugins()
  const names = result.loaded.map((entry) => entry.manifest.name)
  assert.ok(names.includes('@hypaware/format-iceberg'),
    `expected loaded names to include @hypaware/format-iceberg, got ${names.join(', ')}`)
  // The unknown-directory bin must NOT contain our plugin even when the
  // allowlist or excludeSet changes, the discovery scan goes through
  // the allowlist branch.
  assert.ok(
    !result.unknownDirs.some((dir) => dir.endsWith('format-iceberg')),
    'expected format-iceberg to be on the allowlist, not the unknown directory list'
  )
})

test('firstPartyPluginMetadata records the iceberg requires/provides matrix', () => {
  const entry = firstPartyPluginMetadata().get('@hypaware/format-iceberg')
  assert.ok(entry, 'metadata table must include @hypaware/format-iceberg for sink validation')
  assert.deepEqual(entry.provides, { 'hypaware.table-format': '1.0.0' })
  assert.deepEqual(entry.requires, {
    'hypaware.blob-store': '^1.0.0',
    'hypaware.encoder': '^1.0.0',
  })
})

test('createTableFormatProvider returns the expected capability shape', () => {
  const provider = createTableFormatProvider()
  assert.equal(provider.format, 'iceberg')
  assert.deepEqual(provider.supports, ['queryable'])
  assert.equal(typeof provider.createSink, 'function')
})

test('TableFormatProvider.createSink rejects missing BlobStore / encoder / non-parquet encoder', async () => {
  const provider = createTableFormatProvider()
  const log = { debug() {}, info() {}, warn() {}, error() {} }
  /** @type {any} */
  const baseCtx = {
    name: 'iceberg-test',
    plugin: { name: '@hypaware/format-iceberg', version: '1.0.0' },
    paths: { rootDir: '/', stateDir: '/', cacheDir: '/', tempDir: '/' },
    log,
    sinkInstanceConfig: { schedule: '* * * * *' },
    query: { listDatasets: () => [], getDataset: () => undefined, registerDataset() {} },
    storage: {
      cacheRoot: '/',
      cacheTablePath: () => '',
      appendRows: async () => {},
      tableExists: () => false,
      tableUrl: () => '',
      readRows: async function* () {},
    },
  }

  // No BlobStore.
  await assert.rejects(
    provider.createSink({
      ...baseCtx,
      blobStore: undefined,
      encoder: { format: 'parquet', extension: 'parquet', supports: ['queryable'], encodePartition: async () => ({ filename: 'f', bytes: new Uint8Array() }) },
    }),
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_blob_store_missing'
  )

  // No encoder.
  await assert.rejects(
    provider.createSink({
      ...baseCtx,
      blobStore: makeStubBlobStore(),
      encoder: undefined,
    }),
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_encoder_missing'
  )

  // Non-parquet inner encoder.
  await assert.rejects(
    provider.createSink({
      ...baseCtx,
      blobStore: makeStubBlobStore(),
      encoder: { format: 'jsonl', extension: 'jsonl', supports: [], encodePartition: async () => ({ filename: 'f', bytes: new Uint8Array() }) },
    }),
    (err) => /** @type {HypError} */ (err).hypErrorKind === 'iceberg_encoder_missing'
  )
})

function makeStubBlobStore() {
  return /** @type {any} */ ({
    kind: 'memory',
    async putObject() { return { key: '' } },
    async getObject() { return null },
    listObjects() { return { async *[Symbol.asyncIterator]() {} } },
    async deleteObject() {},
  })
}
