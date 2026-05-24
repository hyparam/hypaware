// @ts-check

import { Buffer } from 'node:buffer'

import { encodePartition } from 'hypaware/core/sinks'

import {
  createS3BlobStore,
  createUnconfiguredS3BlobStore,
  defaultS3BlobStoreClientFactory,
} from './blob-store.js'
import { validateS3SinkConfig } from './config.js'
import { defaultClientFactory } from './client.js'
import { classifyAwsError, describeS3ErrorKind } from './errors.js'
import { keyIsWithinPrefix, renderObjectKey } from './keys.js'

/**
 * @import { ExportBatch, ExportOptions, ExportResult, PluginActivationContext, QueryPartition, QueryRegistry, QueryStorageService, Sink, SinkCreateContext, SinkEncoder } from '../../../../collectivus-plugin-kernel-types'
 * @import { S3BlobStoreClientFactory } from './blob-store.js'
 * @import { S3ClientFactory, S3ClientHandle } from './client.js'
 * @import { S3SinkConfig } from './config.js'
 * @import { S3ErrorKind } from './errors.js'
 */

const PLUGIN_NAME = '@hypaware/s3'
const PLUGIN_VERSION = '1.0.0'

/**
 * Activate `@hypaware/s3`. Provides `hypaware.blob-store@1` as a full
 * `BlobStore` (put/get/list/delete; put supports `ifNoneMatch` via
 * S3's `If-None-Match` header) AND contributes a single `s3` sink. The
 * sink contribution is untouched by the BlobStore migration — existing
 * encoder-writer + s3 sinks keep working unchanged.
 *
 * BlobStore resolution:
 *  - If `plugins[].config` for `@hypaware/s3` carries a `bucket`, the
 *    activation builds a real BlobStore against it using the validated
 *    config shape. Test wiring may inject a fake client factory by
 *    setting `ctx.config.__blobStoreClientFactory`.
 *  - If no `bucket` is configured at plugin level, activation provides
 *    a sentinel BlobStore that throws an actionable error on any call
 *    — the capability is still discoverable but its use without
 *    configuration is a programming error, not a silent fallback.
 *
 * Test/smoke wiring can override the sink's client factory by passing
 * `clientFactory` on `SinkCreateContext.config` (under the
 * intentionally-prefixed key `__clientFactory`). Production configs
 * never carry this key — it lives outside the validated config shape
 * specifically so it cannot be set from JSON config files.
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  const blobStore = await resolveBlobStore(ctx)
  ctx.provideCapability('hypaware.blob-store', PLUGIN_VERSION, blobStore)

  ctx.sinks.register({
    name: 's3',
    plugin: PLUGIN_NAME,
    supports: ['queryable'],
    /**
     * @param {SinkCreateContext} sinkCtx
     * @returns {Promise<Sink>}
     */
    async create(sinkCtx) {
      const validation = validateS3SinkConfig(sinkCtx.config ?? {})
      if (!validation.ok) {
        const first = validation.errors[0]
        sinkCtx.log.error('s3.client.init.failed', {
          hyp_plugin: PLUGIN_NAME,
          hyp_sink_instance: sinkCtx.name,
          error_kind: first.errorKind,
          pointer: first.pointer,
          message: first.message,
        })
        throw new Error(`${PLUGIN_NAME}: ${first.errorKind} at ${first.pointer || '/'}: ${first.message}`)
      }
      const config = validation.config

      const encoder = sinkCtx.encoder
      if (!encoder) {
        throw new Error(`${PLUGIN_NAME}: blob sink requires an encoder via SinkCreateContext.encoder`)
      }

      const clientFactory = resolveClientFactory(sinkCtx)
      const { client, credential_source_kind } = await clientFactory({
        region: config.region,
        profile: config.profile,
        endpoint_url: config.endpoint_url,
        force_path_style: config.force_path_style,
        env: process.env,
      })

      sinkCtx.log.info('s3.client.init', {
        hyp_plugin: PLUGIN_NAME,
        hyp_sink_instance: sinkCtx.name,
        bucket: config.bucket,
        prefix: config.prefix,
        region: config.region ?? '',
        endpoint_url: config.endpoint_url ?? '',
        force_path_style: config.force_path_style === true,
        credential_source_kind,
      })

      return buildSink({
        config,
        client,
        encoder,
        sinkCtx,
        query: ctx.query,
        storage: ctx.storage,
      })
    },
  })
}

/**
 * Resolve the S3 client factory. Production sinks fall through to
 * `defaultClientFactory`. Tests and the hermetic smoke can inject a
 * fake by attaching `__clientFactory` to `sinkCtx.config`. The key is
 * intentionally non-JSON-shaped (double-underscore prefix) so a
 * malicious config file cannot use it to swap clients.
 *
 * @param {SinkCreateContext} sinkCtx
 * @returns {S3ClientFactory}
 */
function resolveClientFactory(sinkCtx) {
  const injected = /** @type {{ __clientFactory?: S3ClientFactory } | undefined} */ (
    /** @type {unknown} */ (sinkCtx.config)
  )
  if (injected && typeof injected.__clientFactory === 'function') {
    return injected.__clientFactory
  }
  return defaultClientFactory
}

/**
 * @param {{
 *   config: S3SinkConfig,
 *   client: S3ClientHandle,
 *   encoder: SinkEncoder,
 *   sinkCtx: SinkCreateContext,
 *   query: QueryRegistry,
 *   storage: QueryStorageService,
 * }} args
 * @returns {Sink}
 */
function buildSink({ config, client, encoder, sinkCtx, query, storage }) {
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
      /** @type {S3ErrorKind | undefined} */
      let lastConfigFailure
      for (const partition of batch.partitions) {
        try {
          const columns = lookupColumns(query, partition.dataset)
          if (partition.tablePath) {
            await flushPartition(storage, partition.tablePath, 'sink_export')
          }
          const rows = openRows(storage, partition)
          let blob
          try {
            blob = await encodePartition(encoder, partition, {
              log: sinkCtx.log,
              tempDir: sinkCtx.paths.tempDir,
              columns,
              rows,
              sinkInstance: sinkCtx.name,
              plugin: PLUGIN_NAME,
            })
          } catch (err) {
            throw tagError(err, 'encoder_failed')
          }
          const objectKey = renderObjectKey({
            prefix: config.prefix,
            partition,
            filename: blob.filename,
          })
          if (!keyIsWithinPrefix({ prefix: config.prefix, dataset: partition.dataset, key: objectKey })) {
            throw new Error(`${PLUGIN_NAME}: rendered key '${objectKey}' is outside prefix '${config.prefix}'`)
          }
          const body = await materializeBytes(blob.bytes)
          const putInput = {
            Bucket: config.bucket,
            Key: objectKey,
            Body: body,
            ContentLength: body.byteLength,
          }
          if (config.storage_class) putInput.StorageClass = config.storage_class
          if (config.server_side_encryption) putInput.ServerSideEncryption = config.server_side_encryption
          if (encoder.format === 'parquet') putInput.ContentType = 'application/vnd.apache.parquet'
          else if (encoder.format === 'jsonl') putInput.ContentType = 'application/jsonl'

          await client.putObject(putInput)
          const partitionBytes = blob.bytesWritten ?? body.byteLength
          bytesWritten += partitionBytes
          exported += 1
          sinkCtx.log.info('s3.put_object', {
            hyp_plugin: PLUGIN_NAME,
            hyp_sink_instance: sinkCtx.name,
            hyp_dataset: partition.dataset,
            hyp_sink_format: encoder.format,
            bucket: config.bucket,
            prefix: config.prefix,
            object_key: objectKey,
            bytes_written: partitionBytes,
            row_count: blob.rowCount ?? 0,
            status: 'ok',
          })
        } catch (err) {
          failures.push(partition)
          const errorKind = errorKindFor(err)
          if (isTerminalErrorKind(errorKind)) {
            lastConfigFailure = errorKind
          }
          sinkCtx.log.warn('s3.put_object.failed', {
            hyp_plugin: PLUGIN_NAME,
            hyp_sink_instance: sinkCtx.name,
            hyp_dataset: partition.dataset,
            hyp_sink_format: encoder.format,
            bucket: config.bucket,
            prefix: config.prefix,
            error_kind: errorKind,
            message: describeS3ErrorKind(errorKind),
            status: 'failed',
          })
        }
      }
      if (lastConfigFailure !== undefined) {
        // Only the partitions that actually failed should be retried.
        // Without this, the driver's fallback in src/core/sinks/driver.js
        // outboxes every partition in the batch — including ones already
        // PUT to S3 — when a terminal error trips mid-batch.
        return {
          status: 'failed',
          partitionsExported: exported,
          bytesWritten,
          retryPartitions: failures,
          error: describeS3ErrorKind(lastConfigFailure),
        }
      }
      return {
        status: failures.length === 0 ? 'exported' : 'partial',
        partitionsExported: exported,
        bytesWritten,
        retryPartitions: failures.length > 0 ? failures : undefined,
      }
    },
    async close() {
      try {
        client.destroy()
      } catch {
        // best-effort during shutdown
      }
    },
  }
}

/**
 * @param {unknown} err
 * @param {S3ErrorKind} kind
 */
function tagError(err, kind) {
  /** @type {Error & { __hypErrorKind?: S3ErrorKind }} */
  const wrapped = err instanceof Error ? err : new Error(String(err))
  wrapped.__hypErrorKind = kind
  return wrapped
}

/**
 * @param {unknown} err
 * @returns {S3ErrorKind}
 */
function errorKindFor(err) {
  if (err && typeof err === 'object' && '__hypErrorKind' in err) {
    const tagged = /** @type {{ __hypErrorKind?: S3ErrorKind }} */ (err)
    if (tagged.__hypErrorKind) return tagged.__hypErrorKind
  }
  return classifyAwsError(err)
}

/**
 * Configuration / credential / region-mismatch / bucket-missing errors
 * are not transient — retrying the same partition will fail the same
 * way next tick. Return `status=failed` so the sink driver does not
 * loop on them.
 *
 * @param {S3ErrorKind} kind
 */
function isTerminalErrorKind(kind) {
  return (
    kind === 's3_credentials_missing' ||
    kind === 's3_bucket_missing' ||
    kind === 's3_region_mismatch' ||
    kind === 's3_access_denied' ||
    kind === 's3_config_invalid'
  )
}

/**
 * @param {QueryRegistry} query
 * @param {string} datasetName
 */
function lookupColumns(query, datasetName) {
  const dataset = query.getDataset(datasetName)
  if (!dataset || !dataset.schema || !Array.isArray(dataset.schema.columns)) return []
  return dataset.schema.columns
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
 * S3's `PutObject` API works best with a known-length payload. Drain
 * streaming encoders into a single `Uint8Array` here so we can supply
 * `ContentLength` and a deterministic body to the SDK.
 *
 * @param {Uint8Array | AsyncIterable<Uint8Array>} bytes
 * @returns {Promise<Uint8Array>}
 */
async function materializeBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes
  /** @type {Uint8Array[]} */
  const chunks = []
  for await (const chunk of bytes) chunks.push(chunk)
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0]
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
}

/**
 * Build the s3 plugin's BlobStore from plugin-level config. When no
 * `bucket` is configured the activation provides a sentinel BlobStore
 * — callers see a clear `s3_blob_store_unconfigured` error instead of
 * the capability silently no-op-ing.
 *
 * @param {PluginActivationContext} ctx
 */
async function resolveBlobStore(ctx) {
  const config = /** @type {Record<string, unknown> | undefined} */ (ctx.config)
  if (!config || typeof config.bucket !== 'string' || config.bucket.length === 0) {
    return createUnconfiguredS3BlobStore()
  }
  // Reuse the sink-config validator so plugin-level config goes through
  // the same shape checks (storage class, endpoint url, etc.).
  const validation = validateS3SinkConfig(config)
  if (!validation.ok) {
    const first = validation.errors[0]
    ctx.log.error('s3.blob_store.config_invalid', {
      hyp_plugin: PLUGIN_NAME,
      error_kind: first.errorKind,
      pointer: first.pointer,
      message: first.message,
    })
    return createUnconfiguredS3BlobStore()
  }
  const validated = validation.config
  const factory = /** @type {{ __blobStoreClientFactory?: S3BlobStoreClientFactory }} */ (
    /** @type {unknown} */ (config)
  ).__blobStoreClientFactory ?? defaultS3BlobStoreClientFactory
  const client = await factory({
    region: validated.region,
    profile: validated.profile,
    endpoint_url: validated.endpoint_url,
    force_path_style: validated.force_path_style,
    env: ctx.env,
  })
  return createS3BlobStore({
    bucket: validated.bucket,
    prefix: validated.prefix,
    client,
  })
}
