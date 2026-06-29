// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { createSinkRegistry } from '../../src/core/registry/sinks.js'
import { validateConfig, firstPartyPluginMetadata } from '../../src/core/config/validate.js'

/**
 * @import { BlobStore, Sink, SinkEncoder, TableFormatProvider } from '../../collectivus-plugin-kernel-types.js'
 */

/**
 * @returns {SinkEncoder}
 */
function makeEncoder({ format = 'parquet', extension = 'parquet', supports = ['queryable'] } = {}) {
  return {
    format,
    extension,
    supports,
    async encodePartition(partition) {
      const bytes = new TextEncoder().encode(`${partition.dataset}-bytes`)
      return { filename: `${partition.dataset}.${extension}`, bytes, bytesWritten: bytes.byteLength, rowCount: 1 }
    },
  }
}

/**
 * @returns {BlobStore}
 */
function makeBlobStore() {
  /** @type {Map<string, Uint8Array>} */
  const objects = new Map()
  return {
    kind: 'memory',
    async putObject(input) {
      const bytes = input.body instanceof Uint8Array ? input.body : new Uint8Array()
      objects.set(input.key, bytes)
      return { key: input.key }
    },
    async getObject(input) {
      const bytes = objects.get(input.key)
      if (!bytes) return null
      return { body: Readable.from([bytes]), contentLength: bytes.byteLength }
    },
    listObjects() {
      return { async *[Symbol.asyncIterator]() {} }
    },
    async deleteObject() {},
  }
}

/**
 * @returns {TableFormatProvider}
 */
function makeTableFormatProvider({ format = 'iceberg', supports = ['queryable'] } = {}) {
  return {
    format,
    supports,
    async createSink(ctx) {
      // Record dispatch inputs on the sink so the test can assert on them.
      /** @type {Sink & { _ctx?: any }} */
      const sink = {
        _ctx: {
          name: ctx.name,
          encoderFormat: ctx.encoder.format,
          blobStoreKind: ctx.blobStore.kind,
          sinkInstanceConfig: ctx.sinkInstanceConfig,
        },
        async exportBatch(_batch) {
          // Round-trip one byte through the blob store so the test can
          // observe that the table-format sink reaches its destination.
          await ctx.blobStore.putObject({
            key: `${format}/_test/marker.bin`,
            body: new Uint8Array([0xab]),
          })
          return { status: 'exported', partitionsExported: 0, bytesWritten: 1 }
        },
        async close() {},
      }
      return sink
    },
  }
}

test('instantiate table-format sink wires blobStore + encoder + config into createSink', async () => {
  const registry = createSinkRegistry()
  const encoder = makeEncoder()
  const blobStore = makeBlobStore()
  const provider = makeTableFormatProvider()

  const handle = await registry.instantiate({
    kind: 'table-format',
    instanceName: 'iceberg-test',
    tableFormat: provider,
    writerPlugin: '@hypaware/format-iceberg',
    destinationPlugin: '@hypaware/local-fs',
    blobStore,
    encoder,
    config: { schedule: '* * * * *', encoder: '@hypaware/format-parquet' },
    plugin: {
      name: '@hypaware/format-iceberg',
      version: '1.0.0',
      manifest: {
        schema_version: 1,
        name: '@hypaware/format-iceberg',
        version: '1.0.0',
        hypaware_api: '^1.0.0',
        runtime: 'node',
        entrypoint: './index.js',
      },
      rootDir: '/tmp/iceberg',
    },
    paths: {
      rootDir: '/tmp/iceberg',
      stateDir: '/tmp/state',
      cacheDir: '/tmp/cache',
      tempDir: '/tmp/temp',
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    query: /** @type {any} */ ({ listDatasets: () => [], getDataset: () => undefined, registerDataset() {} }),
    storage: /** @type {any} */ ({
      cacheRoot: '/tmp/cache',
      cacheTablePath: () => '',
      appendRows: async () => {},
      tableExists: () => false,
      tableUrl: () => '',
      async *readRows() {},
    }),
  })

  assert.equal(handle.kind, 'table-format')
  assert.equal(handle.writer, '@hypaware/format-iceberg')
  assert.equal(handle.destination, '@hypaware/local-fs')
  assert.equal(handle.tableFormat, 'iceberg')
  assert.deepEqual(handle.supports, ['queryable'])

  const captured = /** @type {any} */ (handle.sink)._ctx
  assert.equal(captured.name, 'iceberg-test')
  assert.equal(captured.blobStoreKind, 'memory')
  assert.equal(captured.encoderFormat, 'parquet')
  assert.equal(captured.sinkInstanceConfig.encoder, '@hypaware/format-parquet')

  const result = await handle.sink.exportBatch(
    { batchId: 't1', partitions: [] },
    { format: 'iceberg', schedule: '* * * * *' },
  )
  assert.equal(result.status, 'exported')
})

test('instantiate table-format sink intersects supports tags between provider and encoder', async () => {
  const registry = createSinkRegistry()
  const provider = makeTableFormatProvider({ supports: ['queryable'] })
  // Encoder that does NOT advertise queryable. The resolved sink should
  // drop the tag (the queryable-only-when-both-agree rule).
  const encoder = makeEncoder({ format: 'jsonl', extension: 'jsonl', supports: [] })
  const handle = await registry.instantiate({
    kind: 'table-format',
    instanceName: 'iceberg-jsonl',
    tableFormat: provider,
    writerPlugin: '@hypaware/format-iceberg',
    destinationPlugin: '@hypaware/local-fs',
    blobStore: makeBlobStore(),
    encoder,
    config: { schedule: '* * * * *' },
    plugin: /** @type {any} */ ({ name: '@hypaware/format-iceberg', version: '1.0.0' }),
    paths: /** @type {any} */ ({ rootDir: '/tmp/i', stateDir: '/tmp/s', cacheDir: '/tmp/c', tempDir: '/tmp/t' }),
    log: { debug() {}, info() {}, warn() {}, error() {} },
    query: /** @type {any} */ ({ listDatasets: () => [] }),
    storage: /** @type {any} */ ({ cacheRoot: '/tmp/c', tableExists: () => false }),
  })
  assert.deepEqual(handle.supports, [])
})

test('instantiate table-format sink rejects missing blobStore / encoder / provider', async () => {
  const registry = createSinkRegistry()
  const provider = makeTableFormatProvider()
  const encoder = makeEncoder()

  await assert.rejects(
    () =>
      registry.instantiate(/** @type {any} */ ({
        kind: 'table-format',
        instanceName: 'bad-no-provider',
        tableFormat: undefined,
        writerPlugin: '@hypaware/format-iceberg',
        destinationPlugin: '@hypaware/local-fs',
        blobStore: makeBlobStore(),
        encoder,
        config: {},
        plugin: { name: '@hypaware/format-iceberg', version: '1.0.0' },
        paths: { rootDir: '/', stateDir: '/', cacheDir: '/', tempDir: '/' },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        query: { listDatasets: () => [] },
        storage: { cacheRoot: '/' },
      })),
    /missing createSink/,
  )

  await assert.rejects(
    () =>
      registry.instantiate(/** @type {any} */ ({
        kind: 'table-format',
        instanceName: 'bad-no-encoder',
        tableFormat: provider,
        writerPlugin: '@hypaware/format-iceberg',
        destinationPlugin: '@hypaware/local-fs',
        blobStore: makeBlobStore(),
        encoder: undefined,
        config: {},
        plugin: { name: '@hypaware/format-iceberg', version: '1.0.0' },
        paths: { rootDir: '/', stateDir: '/', cacheDir: '/', tempDir: '/' },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        query: { listDatasets: () => [] },
        storage: { cacheRoot: '/' },
      })),
    /requires an inner encoder/,
  )

  await assert.rejects(
    () =>
      registry.instantiate(/** @type {any} */ ({
        kind: 'table-format',
        instanceName: 'bad-no-blobstore',
        tableFormat: provider,
        writerPlugin: '@hypaware/format-iceberg',
        destinationPlugin: '@hypaware/local-fs',
        blobStore: undefined,
        encoder,
        config: {},
        plugin: { name: '@hypaware/format-iceberg', version: '1.0.0' },
        paths: { rootDir: '/', stateDir: '/', cacheDir: '/', tempDir: '/' },
        log: { debug() {}, info() {}, warn() {}, error() {} },
        query: { listDatasets: () => [] },
        storage: { cacheRoot: '/' },
      })),
    /requires a BlobStore/,
  )
})

test('validateConfig accepts table-format writer + blob destination', async () => {
  const result = await validateConfig({
    version: 2,
    plugins: [
      { name: '@hypaware/format-iceberg' },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/format-parquet' },
    ],
    sinks: {
      iceberg_lake: {
        writer: '@hypaware/format-iceberg',
        destination: '@hypaware/local-fs',
        config: { schedule: '0 * * * *', encoder: '@hypaware/format-parquet' },
      },
    },
  })
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2))
})

test('validateConfig rejects table-format writer without blob-store destination', async () => {
  const result = await validateConfig({
    version: 2,
    plugins: [
      { name: '@hypaware/format-iceberg' },
      { name: '@hypaware/central' },
    ],
    sinks: {
      bad: {
        writer: '@hypaware/format-iceberg',
        destination: '@hypaware/central',
        config: { schedule: '* * * * *' },
      },
    },
  })
  assert.equal(result.ok, false)
  const kinds = result.errors.map((e) => e.errorKind).sort()
  assert.ok(kinds.includes('sink_destination_invalid'), JSON.stringify(kinds))
})

test('validateConfig rejects writer providing neither encoder nor table-format', async () => {
  // `@hypaware/ai-gateway` provides hypaware.ai-gateway: neither encoder
  // nor table-format. Using it as a blob-sink writer must surface as
  // sink_writer_invalid, not the generic sink_pair_incompatible kind.
  const result = await validateConfig({
    version: 2,
    plugins: [
      { name: '@hypaware/ai-gateway' },
      { name: '@hypaware/local-fs' },
    ],
    sinks: {
      bogus: {
        writer: '@hypaware/ai-gateway',
        destination: '@hypaware/local-fs',
        config: { schedule: '* * * * *' },
      },
    },
  })
  assert.equal(result.ok, false)
  const kinds = result.errors.map((e) => e.errorKind).sort()
  assert.ok(kinds.includes('sink_writer_invalid'), JSON.stringify(kinds))
})

test('validateConfig rejects table-format sink with unknown inner encoder pin', async () => {
  const result = await validateConfig({
    version: 2,
    plugins: [
      { name: '@hypaware/format-iceberg' },
      { name: '@hypaware/local-fs' },
    ],
    sinks: {
      iceberg_lake: {
        writer: '@hypaware/format-iceberg',
        destination: '@hypaware/local-fs',
        config: { schedule: '* * * * *', encoder: '@unknown/encoder' },
      },
    },
  })
  assert.equal(result.ok, false)
  const kinds = result.errors.map((e) => e.errorKind).sort()
  assert.ok(kinds.includes('sink_plugin_unknown'), JSON.stringify(kinds))
})

test('validateConfig rejects table-format sink whose encoder pin does not provide hypaware.encoder', async () => {
  const result = await validateConfig({
    version: 2,
    plugins: [
      { name: '@hypaware/format-iceberg' },
      { name: '@hypaware/local-fs' },
      { name: '@hypaware/ai-gateway' },
    ],
    sinks: {
      iceberg_lake: {
        writer: '@hypaware/format-iceberg',
        destination: '@hypaware/local-fs',
        config: { schedule: '* * * * *', encoder: '@hypaware/ai-gateway' },
      },
    },
  })
  assert.equal(result.ok, false)
  const kinds = result.errors.map((e) => e.errorKind).sort()
  assert.ok(kinds.includes('sink_encoder_invalid'), JSON.stringify(kinds))
})

test('first-party metadata still routes encoder writers through the legacy sink_pair_incompatible code', async () => {
  // Sanity guard: a writer that provides hypaware.encoder but does NOT
  // require hypaware.blob-store should still produce sink_pair_incompatible
  // (not sink_writer_invalid) so existing tooling that greps for the
  // legacy kind keeps working.
  const known = new Map(firstPartyPluginMetadata())
  known.set(/** @type {any} */ ('@fake/encoder-no-require'), {
    provides: { 'hypaware.encoder': '1.0.0' },
  })
  const result = await validateConfig(
    {
      version: 2,
      plugins: [
        { name: /** @type {any} */ ('@fake/encoder-no-require') },
        { name: '@hypaware/local-fs' },
      ],
      sinks: {
        weird: {
          writer: /** @type {any} */ ('@fake/encoder-no-require'),
          destination: '@hypaware/local-fs',
          config: { schedule: '* * * * *' },
        },
      },
    },
    { knownPlugins: known },
  )
  assert.equal(result.ok, false)
  const kinds = result.errors.map((e) => e.errorKind).sort()
  assert.ok(kinds.includes('sink_pair_incompatible'), JSON.stringify(kinds))
})
