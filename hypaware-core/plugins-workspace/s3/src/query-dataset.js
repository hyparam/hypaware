// @ts-check

import { Buffer } from 'node:buffer'

import { parquetMetadataAsync } from 'hyparquet'
import { parquetDataSource, unionSources, emptySource } from 'hypaware/core/query'

/**
 * @import { AsyncBuffer } from 'hyparquet'
 * @import { AsyncDataSource } from 'squirreling/src/types.js'
 * @import { BlobStore, ColumnSpec, DatasetDataSourceContext, DatasetDiscoveryContext, DatasetRegistration, PluginName, QueryPartition } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { S3QuerySourceConfig } from './types.js'
 */

/**
 * Build a kernel `DatasetRegistration` for one S3-backed query source.
 * The registration closes over the per-source `BlobStore`, so the kernel
 * query path (which only hands datasets the local cache `storage`) never
 * needs to know the data lives in S3.
 *
 * @param {{ source: S3QuerySourceConfig, blobStore: BlobStore, plugin: PluginName }} args
 * @returns {DatasetRegistration}
 */
export function buildS3QueryDataset({ source, blobStore, plugin }) {
  const columns = source.schema ?? []
  return {
    name: source.name,
    plugin,
    schema: { columns },
    /**
     * @param {DatasetDiscoveryContext} _ctx
     * @returns {Promise<QueryPartition[]>}
     */
    discoverPartitions: (_ctx) => discoverPartitions(source, blobStore),
    /**
     * @param {QueryPartition[]} partitions
     * @param {DatasetDataSourceContext} _ctx
     * @returns {Promise<AsyncDataSource>}
     */
    createDataSource: (partitions, _ctx) => createDataSource(source, blobStore, partitions),
  }
}

/**
 * @param {S3QuerySourceConfig} source
 * @param {BlobStore} blobStore
 * @returns {Promise<QueryPartition[]>}
 */
async function discoverPartitions(source, blobStore) {
  if (source.format === 'iceberg') {
    // A single logical partition; the table root is `source.prefix` and
    // `createDataSource` reads it through the Iceberg catalog.
    return [{ dataset: source.name, partition: {} }]
  }
  // parquet: one partition per `.parquet` object under the prefix.
  // List with a trailing slash so the match is bounded to the directory.
  // S3 (and the BlobStore's `listObjects`) treats `prefix` as a bare
  // string match, so listing `exports/events` would also pull in the
  // sibling namespace `exports/events_archive/part.parquet` and union it
  // into the `events` table. `source.prefix` is normalized (no trailing
  // slash) and validated non-empty, so appending `/` is always correct.
  /** @type {QueryPartition[]} */
  const partitions = []
  for await (const entry of blobStore.listObjects({ prefix: `${source.prefix}/` })) {
    if (!entry.key.endsWith('.parquet')) continue
    partitions.push({ dataset: source.name, partition: {}, tableUrl: entry.key })
  }
  // Stable order so multi-file unions and tests are deterministic.
  partitions.sort((a, b) => String(a.tableUrl).localeCompare(String(b.tableUrl)))
  return partitions
}

/**
 * @param {S3QuerySourceConfig} source
 * @param {BlobStore} blobStore
 * @param {QueryPartition[]} partitions
 * @returns {Promise<AsyncDataSource>}
 */
async function createDataSource(source, blobStore, partitions) {
  if (source.format === 'iceberg') {
    return createIcebergDataSource(source, blobStore)
  }
  /** @type {AsyncDataSource[]} */
  const sources = []
  for (const partition of partitions) {
    const key = partition.tableUrl
    if (!key) continue
    const file = await s3AsyncBuffer(blobStore, key)
    const metadata = await parquetMetadataAsync(file)
    sources.push(parquetDataSource(file, metadata))
  }
  if (sources.length === 0) return emptySource(columnNames(source))
  if (sources.length === 1) return sources[0]
  return unionSources(sources)
}

/**
 * Read an Iceberg table from S3 by adapting the BlobStore into the
 * `Resolver`/`Lister` pair icebird speaks, the same path the local
 * cache uses, only the bytes come from S3. The `@hypaware/format-iceberg`
 * adapter and `icebird` are imported lazily so parquet-only deployments
 * never load them.
 *
 * @param {S3QuerySourceConfig} source
 * @param {BlobStore} blobStore
 * @returns {Promise<AsyncDataSource>}
 */
async function createIcebergDataSource(source, blobStore) {
  // Guard against a missing/empty table the way the local cache does
  // (`tableExists` before load). Without it, loading catalog metadata
  // for a table that was never written can throw instead of reading as
  // an empty result.
  if (!(await icebergTableHasMetadata(blobStore, source.prefix))) {
    return emptySource(columnNames(source))
  }
  const { createBlobStoreIO, tableUrlForBlobPrefix } = await import('../../format-iceberg/src/blob-io.js')
  const { icebergDataSource, loadLatestFileCatalogMetadata } = await import('icebird')

  const { resolver, lister } = await createBlobStoreIO(blobStore)
  const tableUrl = tableUrlForBlobPrefix(source.prefix)
  const { metadata } = await loadLatestFileCatalogMetadata({ tableUrl, resolver, lister })
  if (metadata['current-snapshot-id'] === undefined || !metadata.snapshots?.length) {
    return emptySource(columnNames(source))
  }
  return icebergDataSource({ tableUrl, metadata, resolver, lister })
}

/**
 * @param {BlobStore} blobStore
 * @param {string} prefix
 * @returns {Promise<boolean>}
 */
async function icebergTableHasMetadata(blobStore, prefix) {
  for await (const entry of blobStore.listObjects({ prefix: `${prefix}/metadata` })) {
    if (entry.key.endsWith('.metadata.json')) return true
  }
  return false
}

/**
 * Materialize an S3 object into an in-memory `AsyncBuffer`. This reads
 * the whole object (fine for the modest parquet files HypAware writes);
 * range-based reads can be layered on later by extending `getObject`.
 *
 * @param {BlobStore} blobStore
 * @param {string} key
 * @returns {Promise<AsyncBuffer>}
 */
async function s3AsyncBuffer(blobStore, key) {
  const result = await blobStore.getObject({ key })
  if (!result) {
    throw new Error(`@hypaware/s3: query object not found at '${key}'`)
  }
  const bytes = await collectStream(result.body)
  return {
    byteLength: bytes.byteLength,
    slice(start, end) {
      const sliced = bytes.subarray(start, end)
      const out = new ArrayBuffer(sliced.byteLength)
      new Uint8Array(out).set(sliced)
      return out
    },
  }
}

/**
 * @param {S3QuerySourceConfig} source
 * @returns {string[]}
 */
function columnNames(source) {
  return (source.schema ?? []).map((/** @type {ColumnSpec} */ c) => c.name)
}

/**
 * Drain a `getObject` body (Node stream or raw bytes) into one
 * contiguous `Uint8Array`.
 *
 * @param {NodeJS.ReadableStream | Uint8Array | undefined} body
 * @returns {Promise<Uint8Array>}
 */
async function collectStream(body) {
  if (!body) return new Uint8Array(0)
  if (body instanceof Uint8Array) return body
  /** @type {Uint8Array[]} */
  const chunks = []
  for await (const chunk of /** @type {AsyncIterable<unknown>} */ (body)) {
    if (chunk instanceof Uint8Array) chunks.push(chunk)
    else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk))
    else chunks.push(Buffer.from(/** @type {ArrayBufferLike} */ (chunk)))
  }
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0]
  let total = 0
  for (const chunk of chunks) total += chunk.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
