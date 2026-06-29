// @ts-check

import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'

import { encodePartition, clusterColumnsForDataset } from 'hypaware/core/sinks'

import { createLocalFsBlobStore, resolveExportsBaseDir } from './blob-store.js'

/**
 * @import { ExportBatch, ExportOptions, ExportResult, PluginActivationContext, QueryPartition, QueryRegistry, QueryStorageService, Sink, SinkCreateContext, SinkEncodedBlob, SinkEncoder } from '../../../../collectivus-plugin-kernel-types.js'
 */

const PLUGIN_NAME = '@hypaware/local-fs'
const PLUGIN_VERSION = '1.0.0'

/**
 * Activate `@hypaware/local-fs`. Provides the `hypaware.blob-store@1`
 * capability as a full `BlobStore` (put/get/list/delete) AND contributes
 * a `local-fs` sink that writes encoded partition bytes under
 * `<config.dir>/<dataset>/<partition>/`. The sink contribution is
 * untouched by the BlobStore migration: existing
 * encoder-writer + local-fs sinks keep working unchanged.
 *
 * BlobStore base directory resolution:
 *  1. `ctx.config.exports_dir` (plugin section pin)
 *  2. `<HYP_HOME>/exports`
 *  3. `<homedir()>/.hyp/exports`
 *
 * The sink closes over the activation context so its `exportBatch` can
 * (a) look up dataset schemas through `ctx.query.getDataset` and
 * (b) stream cache rows through `ctx.storage.readRows`: both inputs
 * are then handed to the paired encoder via the kernel's
 * `sink.encode_partition` helper.
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0014#bytes-flow-down-semantics-flow-up [implements]: provides hypaware.blob-store, never knows its bytes' format
 */
export async function activate(ctx) {
  const baseDir = resolveExportsBaseDir({ pluginConfig: ctx.config, env: ctx.env })
  await fs.mkdir(baseDir, { recursive: true })
  const blobStore = createLocalFsBlobStore({ baseDir })
  ctx.provideCapability('hypaware.blob-store', PLUGIN_VERSION, blobStore)

  ctx.sinks.register({
    name: 'local-fs',
    plugin: PLUGIN_NAME,
    supports: ['queryable'],
    /**
     * @param {SinkCreateContext} sinkCtx
     * @returns {Promise<Sink>}
     */
    async create(sinkCtx) {
      const dir = typeof sinkCtx.config?.dir === 'string' ? sinkCtx.config.dir : ''
      if (!dir) {
        throw new Error(`${PLUGIN_NAME}: sinks.${sinkCtx.name}.config.dir is required`)
      }
      const encoder = sinkCtx.encoder
      if (!encoder) {
        throw new Error(`${PLUGIN_NAME}: blob sink requires an encoder via SinkCreateContext.encoder`)
      }
      await fs.mkdir(dir, { recursive: true })

      const sink = buildSink({
        baseDir: dir,
        encoder,
        sinkCtx,
        query: ctx.query,
        storage: ctx.storage,
      })
      return sink
    },
  })
}

/**
 * @param {{
 *   baseDir: string,
 *   encoder: SinkEncoder,
 *   sinkCtx: SinkCreateContext,
 *   query: QueryRegistry,
 *   storage: QueryStorageService,
 * }} args
 * @returns {Sink}
 */
function buildSink({ baseDir, encoder, sinkCtx, query, storage }) {
  return {
    /**
     * @param {ExportBatch} batch
     * @param {ExportOptions} _opts
     * @returns {Promise<ExportResult>}
     */
    async exportBatch(batch, _opts) {
      let bytesWritten = 0
      let exported = 0
      /** @type {QueryPartition[]} */
      const failures = []
      for (const partition of batch.partitions) {
        try {
          const columns = lookupColumns(query, partition.dataset)
          if (partition.tablePath) {
            await flushPartition(storage, partition.tablePath, 'sink_export')
          }
          const rows = openRows(storage, partition)
          const blob = await encodePartition(encoder, partition, {
            log: sinkCtx.log,
            tempDir: sinkCtx.paths.tempDir,
            columns,
            rows,
            clusterColumns: clusterColumnsForDataset(query, partition.dataset),
            sinkInstance: sinkCtx.name,
            plugin: PLUGIN_NAME,
          })
          const destPath = await writeBlob(baseDir, partition, blob)
          bytesWritten += blob.bytesWritten ?? 0
          exported += 1
          sinkCtx.log.debug('local-fs.export_partition.ok', {
            hyp_plugin: PLUGIN_NAME,
            hyp_dataset: partition.dataset,
            hyp_sink_instance: sinkCtx.name,
            hyp_sink_filename: blob.filename,
            bytes_written: blob.bytesWritten ?? 0,
            dest_path: destPath,
          })
        } catch (err) {
          failures.push(partition)
          const message = err instanceof Error ? err.message : String(err)
          sinkCtx.log.warn('local-fs.export_partition.failed', {
            hyp_plugin: PLUGIN_NAME,
            hyp_dataset: partition.dataset,
            hyp_sink_instance: sinkCtx.name,
            message,
          })
        }
      }
      return {
        status: failures.length === 0 ? 'exported' : 'partial',
        partitionsExported: exported,
        bytesWritten,
        retryPartitions: failures.length > 0 ? failures : undefined,
      }
    },
    async close() {},
  }
}

/**
 * @param {QueryStorageService} storage
 * @param {string} tablePath
 * @param {string} reason
 */
async function flushPartition(storage, tablePath, reason) {
  const extended = /** @type {QueryStorageService & { flushTable?: (tablePath: string, opts?: { reason?: string, force?: boolean }) => Promise<unknown> }} */ (storage)
  if (typeof extended.flushTable === 'function') {
    await extended.flushTable(tablePath, { force: true, reason })
  }
}

/**
 * Resolve a dataset's column schema. Encoders that need typed coercion
 * (parquet) consume it; encoders that don't (jsonl) can still leave it
 * undefined. Unknown datasets return an empty list rather than throwing
 * so an unknown dataset's partition becomes an empty-rows encode rather
 * than an outbox failure that masks the real issue.
 *
 * @param {QueryRegistry} query
 * @param {string} datasetName
 */
function lookupColumns(query, datasetName) {
  const dataset = query.getDataset(datasetName)
  if (!dataset || !dataset.schema || !Array.isArray(dataset.schema.columns)) return []
  return dataset.schema.columns
}

/**
 * Open the partition's cache rows as an async iterable. When the
 * partition lacks a `tablePath` (or the table doesn't exist yet on
 * disk), yield nothing instead of throwing: the encoder will land an
 * empty file at the expected path, which is the right behavior for a
 * registered-but-empty partition.
 *
 * @param {QueryStorageService} storage
 * @param {QueryPartition} partition
 * @returns {AsyncIterable<Record<string, unknown>>}
 */
function openRows(storage, partition) {
  if (!partition.tablePath) return emptyAsyncIterable()
  if (!storage.tableExists(partition.tablePath)) return emptyAsyncIterable()
  return storage.readRows(partition.tablePath)
}

/** @returns {AsyncIterable<Record<string, unknown>>} */
function emptyAsyncIterable() {
  return {
    async *[Symbol.asyncIterator]() {},
  }
}

/**
 * Persist the encoded bytes under
 * `<baseDir>/<dataset>/<partition-segment>/<blob.filename>`. Streams
 * are concatenated in memory before the write because the smoke pipes
 * 50-row files; a future streaming refactor lives behind the same
 * interface.
 *
 * @param {string} baseDir
 * @param {QueryPartition} partition
 * @param {SinkEncodedBlob} blob
 * @returns {Promise<string>}
 */
async function writeBlob(baseDir, partition, blob) {
  const partitionDir = path.join(baseDir, partition.dataset, partitionSegment(partition))
  await fs.mkdir(partitionDir, { recursive: true })
  const destPath = path.join(partitionDir, blob.filename)
  /** @type {Uint8Array} */
  let bytes
  if (blob.bytes instanceof Uint8Array) {
    bytes = blob.bytes
  } else {
    /** @type {Uint8Array[]} */
    const chunks = []
    for await (const chunk of blob.bytes) chunks.push(chunk)
    bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
  }
  await fs.writeFile(destPath, bytes)
  return destPath
}

/**
 * Render `partition.partition` into a stable directory segment of the
 * form `key1=value1,key2=value2`. Empty/missing partition keys fall
 * back to `all` so partition-less datasets still get a deterministic
 * directory. Characters outside `[A-Za-z0-9._=,-]` are replaced with
 * `_` so partition values cannot escape the dataset directory.
 *
 * @param {QueryPartition} partition
 */
function partitionSegment(partition) {
  const entries = Object.entries(partition.partition ?? {})
  if (entries.length === 0) return 'all'
  return entries
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
    .replace(/[^A-Za-z0-9._=,-]/g, '_')
}
