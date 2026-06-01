// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { activate } from '../../hypaware-core/plugins-workspace/s3/src/index.js'

/**
 * Build a stub `PluginActivationContext` capturing the datasets the
 * plugin registers and recording every `listObjects` call the injected
 * S3 client sees. The recorded `Bucket`/`Prefix` reveal how
 * `buildQuerySourceBlobStore` rooted each query source — the
 * Iceberg-critical `(bucket, root-prefix)` split — without reaching into
 * the BlobStore internals.
 *
 * @param {Record<string, unknown>} config
 */
function makeCtx(config) {
  /** @type {any[]} */
  const datasets = []
  /** @type {Array<{ Bucket?: string, Prefix?: string }>} */
  const listCalls = []

  // S3CommandsHandle stub: listObjects records its input and ends
  // iteration immediately (no Contents, no continuation token).
  const client = {
    async listObjects(/** @type {{ Bucket?: string, Prefix?: string }} */ input) {
      listCalls.push(input)
      return { Contents: [] }
    },
    async getObject() {
      return { Body: undefined }
    },
    async putObject() {
      return {}
    },
    async deleteObject() {},
  }
  // The activation reads `__blobStoreClientFactory` off plugin config to
  // avoid loading the real AWS SDK. It is called once for the plugin
  // BlobStore and once per query source; all share this recording client.
  const withFactory = { __blobStoreClientFactory: async () => client, ...config }

  /** @type {any} */
  const ctx = {
    config: withFactory,
    env: {},
    provideCapability() {},
    sinks: { register() {} },
    query: {
      registerDataset(/** @type {any} */ d) {
        datasets.push(d)
      },
      getDataset: () => undefined,
      listDatasets: () => [],
    },
    storage: {
      tableExists: () => false,
      readRows: () => ({ async *[Symbol.asyncIterator]() {} }),
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return { ctx, datasets, listCalls }
}

test('activate fails at boot when query_sources is malformed', async () => {
  const { ctx } = makeCtx({ bucket: 'b', prefix: 'p', query_sources: 'not-an-array' })
  await assert.rejects(() => activate(ctx), /s3_query_source_invalid/)
})

test('activate fails at boot when a query source has no resolvable bucket', async () => {
  // No plugin-level bucket and no source-level bucket → cannot root the
  // BlobStore, so activation throws rather than registering a broken
  // dataset that would only fail at query time.
  const { ctx } = makeCtx({
    query_sources: [{ name: 'events', format: 'parquet', prefix: 'exports/events' }],
  })
  await assert.rejects(() => activate(ctx), /query_source 'events' has no bucket/)
})

test('activate registers nothing when query_sources is absent', async () => {
  const { ctx, datasets } = makeCtx({ bucket: 'b', prefix: 'p' })
  await activate(ctx)
  assert.equal(datasets.length, 0)
})

test('same-bucket query source inherits the plugin prefix as its root', async () => {
  // source omits `bucket` → reads the plugin's own bucket, so the
  // BlobStore must be rooted at the plugin prefix and `source.prefix` is
  // relative to it. The list Prefix proves the inheritance:
  // `<plugin.prefix>/<source.prefix>/`.
  const { ctx, datasets, listCalls } = makeCtx({
    bucket: 'data-bucket',
    prefix: 'hyp/exports',
    query_sources: [{ name: 'events', format: 'parquet', prefix: 'events' }],
  })
  await activate(ctx)
  assert.equal(datasets.length, 1)
  assert.equal(datasets[0].name, 'events')

  await datasets[0].discoverPartitions({ config: { version: 2 }, scope: { limit: 1000 } })
  const call = listCalls.at(-1)
  assert.equal(call?.Bucket, 'data-bucket')
  assert.equal(call?.Prefix, 'hyp/exports/events/', 'plugin prefix is inherited as the root')
})

test('bucket-override query source drops the plugin prefix and roots at the source prefix', async () => {
  // source supplies its own `bucket` → the plugin prefix must NOT be
  // prepended; `source.prefix` is the full in-bucket path.
  const { ctx, datasets, listCalls } = makeCtx({
    bucket: 'plugin-bucket',
    prefix: 'hyp/exports',
    query_sources: [
      { name: 'events', format: 'parquet', prefix: 'datasets/events', bucket: 'other-bucket' },
    ],
  })
  await activate(ctx)
  assert.equal(datasets.length, 1)

  await datasets[0].discoverPartitions({ config: { version: 2 }, scope: { limit: 1000 } })
  const call = listCalls.at(-1)
  assert.equal(call?.Bucket, 'other-bucket')
  assert.equal(call?.Prefix, 'datasets/events/', 'plugin prefix must not leak into an overridden bucket')
})

test('activate registers one dataset per valid query source', async () => {
  const { ctx, datasets } = makeCtx({
    bucket: 'data-bucket',
    prefix: 'hyp/exports',
    query_sources: [
      { name: 'events', format: 'parquet', prefix: 'events' },
      { name: 'ai_gw', format: 'iceberg', prefix: 'iceberg/ai_gw' },
    ],
  })
  await activate(ctx)
  assert.deepEqual(
    datasets.map((d) => d.name),
    ['events', 'ai_gw']
  )
})
