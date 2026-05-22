// @ts-check

import { getTracer, SpanStatusCode } from '../../../../src/core/observability/index.js'

import { createBlobStoreIO, pathToKey, tableUrlForBlobPrefix } from './blob-io.js'
import { commitBatch, probeTable } from './commit.js'
import { loadMarker, markerKey, markerSubsumedBySnapshot, writeMarker } from './state.js'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').BlobStore} BlobStore */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').ColumnSpec} ColumnSpec */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').ExportBatch} ExportBatch */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').ExportOptions} ExportOptions */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').ExportResult} ExportResult */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').QueryPartition} QueryPartition */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').QueryRegistry} QueryRegistry */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').QueryStorageService} QueryStorageService */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').Sink} Sink */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').SinkEncoder} SinkEncoder */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').TableFormatCreateContext} TableFormatCreateContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').TableFormatProvider} TableFormatProvider */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginLogger} PluginLogger */

const PLUGIN_NAME = '@hypaware/format-iceberg'
const FORMAT = 'iceberg'
const DEFAULT_PREFIX = 'iceberg/datasets'

/**
 * Build the table-format provider. Returns a `TableFormatProvider` the
 * sink registry resolves through the `hypaware.table-format` capability.
 *
 * @returns {TableFormatProvider}
 */
export function createTableFormatProvider() {
  return {
    format: FORMAT,
    supports: ['queryable'],
    async createSink(ctx) {
      validateCreateContext(ctx)
      return buildSink(ctx)
    },
  }
}

/**
 * @param {TableFormatCreateContext} ctx
 */
function validateCreateContext(ctx) {
  if (!ctx.blobStore || typeof ctx.blobStore.putObject !== 'function') {
    throw newError(
      'iceberg_blob_store_missing',
      `${PLUGIN_NAME}: createSink received no BlobStore`
    )
  }
  if (!ctx.encoder || typeof ctx.encoder.encodePartition !== 'function') {
    throw newError(
      'iceberg_encoder_missing',
      `${PLUGIN_NAME}: createSink received no inner encoder (expected hypaware.encoder@^1.0.0)`
    )
  }
  // V1 leverages icebird's intrinsic parquet writer so the data files
  // sitting under each table are always parquet. A non-parquet encoder
  // pin is rejected up-front so config-time validation has a clean
  // error_kind to fail with.
  if (ctx.encoder.format !== 'parquet') {
    throw newError(
      'iceberg_encoder_missing',
      `${PLUGIN_NAME}: V1 supports parquet data files only (got encoder.format='${ctx.encoder.format}')`
    )
  }
}

/**
 * @param {TableFormatCreateContext} ctx
 * @returns {Sink}
 */
function buildSink(ctx) {
  const config = ctx.sinkInstanceConfig ?? {}
  const prefix = resolvePrefix(config)
  const log = ctx.log

  const exportSpanAttrs = blobStoreDestinationAttrs(ctx.blobStore)
  return {
    /**
     * @param {ExportBatch} batch
     * @param {ExportOptions} _opts
     * @returns {Promise<ExportResult>}
     */
    async exportBatch(batch, _opts) {
      const tracer = getTracer('plugin.format-iceberg')
      return tracer.startActiveSpan(
        'iceberg.export_batch',
        {
          attributes: {
            hyp_component: 'sink',
            hyp_plugin: PLUGIN_NAME,
            hyp_sink_instance: ctx.name,
            hyp_sink_format: FORMAT,
            hyp_batch_id: batch.batchId,
            status: 'ok',
            ...exportSpanAttrs,
          },
        },
        async (span) => {
          try {
            const grouped = groupByDataset(batch.partitions)
            let bytesWritten = 0
            let partitionsExported = 0
            /** @type {QueryPartition[]} */
            const failures = []

            for (const [dataset, partitions] of grouped) {
              try {
                const result = await exportDataset({
                  ctx,
                  batch,
                  dataset,
                  partitions,
                  prefix,
                  log,
                })
                bytesWritten += result.bytesWritten
                partitionsExported += result.partitionsExported
              } catch (err) {
                for (const partition of partitions) failures.push(partition)
                const errorKind = readErrorKind(err) ?? 'iceberg_commit_failed'
                const message = err instanceof Error ? err.message : String(err)
                log.warn('iceberg.export_dataset.failed', {
                  hyp_plugin: PLUGIN_NAME,
                  hyp_sink_instance: ctx.name,
                  hyp_dataset: dataset,
                  hyp_batch_id: batch.batchId,
                  error_kind: errorKind,
                  message,
                })
              }
            }

            const status = failures.length === 0 ? 'exported' : (partitionsExported > 0 ? 'partial' : 'failed')
            span.setAttribute('partitions_exported', partitionsExported)
            span.setAttribute('bytes_written', bytesWritten)
            span.setAttribute('status', status === 'exported' ? 'ok' : status)
            if (status === 'failed') {
              span.setStatus({ code: SpanStatusCode.ERROR, message: 'all dataset commits failed' })
              span.setAttribute('error_kind', 'iceberg_commit_failed')
            }
            return {
              status,
              partitionsExported,
              bytesWritten,
              retryPartitions: failures.length > 0 ? failures : undefined,
            }
          } catch (err) {
            const errorKind = readErrorKind(err) ?? 'iceberg_commit_failed'
            const message = err instanceof Error ? err.message : String(err)
            span.setStatus({ code: SpanStatusCode.ERROR, message })
            span.setAttribute('status', 'failed')
            span.setAttribute('error_kind', errorKind)
            log.error('iceberg.export_batch.failed', {
              hyp_plugin: PLUGIN_NAME,
              hyp_sink_instance: ctx.name,
              hyp_batch_id: batch.batchId,
              error_kind: errorKind,
              message,
            })
            throw err
          } finally {
            span.end()
          }
        }
      )
    },
    async close() {},
  }
}

/**
 * @param {{
 *   ctx: TableFormatCreateContext,
 *   batch: ExportBatch,
 *   dataset: string,
 *   partitions: QueryPartition[],
 *   prefix: string,
 *   log: PluginLogger,
 * }} input
 * @returns {Promise<{ partitionsExported: number, bytesWritten: number, status: 'committed' | 'skipped' }>}
 */
async function exportDataset({ ctx, batch, dataset, partitions, prefix, log }) {
  const columns = resolveColumns(ctx.query, dataset)
  if (columns.length === 0) {
    log.warn('iceberg.dataset.no_schema', {
      hyp_plugin: PLUGIN_NAME,
      hyp_sink_instance: ctx.name,
      hyp_dataset: dataset,
    })
    // No schema means no commit; the cache layer would have rejected
    // the rows already, but treat the partition as a no-op so the
    // batch doesn't fail loudly for unrelated datasets.
    return { partitionsExported: partitions.length, bytesWritten: 0, status: 'skipped' }
  }

  const blobPrefix = joinKeys(pathToKey(prefix), sanitizeDataset(dataset))
  const tableUrl = tableUrlForBlobPrefix(blobPrefix)
  // Track the most recent metadata.json write so the commit span can
  // surface the S3 ETag for that specific commit. Data-file writes set
  // `lastWrite` too but the commit span's ETag attribute should reflect
  // the metadata.json commit (the actual transaction boundary).
  /** @type {{ key: string, etag: string | undefined } | undefined} */
  let lastMetadataWrite
  const { resolver, lister } = await createBlobStoreIO(ctx.blobStore, {
    onWrite(event) {
      if (event.key.endsWith('.metadata.json')) {
        lastMetadataWrite = { key: event.key, etag: event.etag }
      }
    },
  })
  const destinationAttrs = blobStoreDestinationAttrs(ctx.blobStore)
  const markerPath = markerKey(prefix, ctx.name, dataset, batch.batchId)
  const tracer = getTracer('plugin.format-iceberg')

  // Drain rows up-front so the commit span only fires once we've
  // already paid the IO cost. `storage.flushTable` is called per
  // partition so any pending cache buffer lands before we read.
  /** @type {Record<string, unknown>[]} */
  const rows = []
  let rowsLoaded = 0
  for (const partition of partitions) {
    if (partition.tablePath) {
      await flushIfSupported(ctx.storage, partition.tablePath, 'iceberg_export')
    }
    const iterable = openRows(ctx.storage, partition)
    for await (const row of iterable) {
      rows.push(row)
      rowsLoaded += 1
    }
  }

  // Probe the table and check the marker before staging anything.
  const priorState = await tracer.startActiveSpan(
    'iceberg.table.load',
    {
      attributes: {
        hyp_plugin: PLUGIN_NAME,
        hyp_sink_instance: ctx.name,
        hyp_dataset: dataset,
        hyp_batch_id: batch.batchId,
        status: 'ok',
        ...destinationAttrs,
      },
    },
    async (span) => {
      try {
        const state = await probeTable(tableUrl, resolver, lister)
        span.setAttribute('table_exists', state.exists)
        if (state.currentSnapshotId) span.setAttribute('snapshot_id', state.currentSnapshotId)
        return state
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        span.setStatus({ code: SpanStatusCode.ERROR, message })
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', readErrorKind(err) ?? 'iceberg_metadata_read_failed')
        throw err
      } finally {
        span.end()
      }
    }
  )

  const existingMarker = await loadMarker(ctx.blobStore, markerPath)
  if (markerSubsumedBySnapshot(existingMarker, priorState.currentSnapshotId)) {
    log.info('iceberg.marker.skip', {
      hyp_plugin: PLUGIN_NAME,
      hyp_sink_instance: ctx.name,
      hyp_dataset: dataset,
      hyp_batch_id: batch.batchId,
      snapshot_id: existingMarker?.snapshotId,
    })
    return { partitionsExported: partitions.length, bytesWritten: 0, status: 'skipped' }
  }

  // Empty batches still emit a no-op trace + marker so a partition
  // with zero ready rows doesn't leave the batch in a half-state.
  if (rows.length === 0) {
    log.debug('iceberg.export_dataset.empty', {
      hyp_plugin: PLUGIN_NAME,
      hyp_sink_instance: ctx.name,
      hyp_dataset: dataset,
      hyp_batch_id: batch.batchId,
    })
    if (priorState.currentSnapshotId) {
      await writeMarker(ctx.blobStore, markerPath, {
        dataset,
        batchId: batch.batchId,
        partition: collectPartitionKeys(partitions),
        rowCount: 0,
        bytesWritten: 0,
        dataFiles: [],
        snapshotId: priorState.currentSnapshotId,
        metadataVersion: '',
        committedAt: new Date().toISOString(),
      })
    }
    return { partitionsExported: partitions.length, bytesWritten: 0, status: 'skipped' }
  }

  const commitSpanName = priorState.exists ? 'iceberg.snapshot.commit' : 'iceberg.table.create'
  const commit = await tracer.startActiveSpan(
    commitSpanName,
    {
      attributes: {
        hyp_plugin: PLUGIN_NAME,
        hyp_sink_instance: ctx.name,
        hyp_dataset: dataset,
        hyp_batch_id: batch.batchId,
        encoder_format: ctx.encoder.format,
        row_count: rowsLoaded,
        status: 'ok',
        ...destinationAttrs,
      },
    },
    async (span) => {
      try {
        const result = await commitBatch(
          { tableUrl, columns, rows, resolver, lister },
          { exists: priorState.exists, metadata: priorState.metadata }
        )
        span.setAttribute('snapshot_id', result.snapshotId)
        span.setAttribute('metadata_version', result.metadataVersion)
        span.setAttribute('data_file_count', result.dataFiles.length)
        span.setAttribute('bytes_written', result.bytesWritten)
        if (lastMetadataWrite?.etag) span.setAttribute('etag', lastMetadataWrite.etag)
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const errorKind = readErrorKind(err) ?? 'iceberg_commit_failed'
        span.setStatus({ code: SpanStatusCode.ERROR, message })
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', errorKind)
        // Sister log so consumers don't have to walk the trace tree to
        // see the failure name.
        log.warn('iceberg.snapshot.commit_failed', {
          hyp_plugin: PLUGIN_NAME,
          hyp_sink_instance: ctx.name,
          hyp_dataset: dataset,
          hyp_batch_id: batch.batchId,
          error_kind: errorKind,
          message,
          ...destinationAttrs,
        })
        throw err
      } finally {
        span.end()
      }
    }
  )

  await writeMarker(ctx.blobStore, markerPath, {
    dataset,
    batchId: batch.batchId,
    partition: collectPartitionKeys(partitions),
    rowCount: commit.rowCount || rowsLoaded,
    bytesWritten: commit.bytesWritten,
    dataFiles: commit.dataFiles,
    snapshotId: commit.snapshotId,
    metadataVersion: commit.metadataVersion,
    committedAt: new Date().toISOString(),
  })

  log.debug('iceberg.export_dataset.ok', {
    hyp_plugin: PLUGIN_NAME,
    hyp_sink_instance: ctx.name,
    hyp_dataset: dataset,
    hyp_batch_id: batch.batchId,
    snapshot_id: commit.snapshotId,
    row_count: commit.rowCount || rowsLoaded,
    bytes_written: commit.bytesWritten,
  })

  return {
    partitionsExported: partitions.length,
    bytesWritten: commit.bytesWritten,
    status: 'committed',
  }
}

/**
 * Group partitions by dataset; preserves input order within a dataset.
 *
 * @param {QueryPartition[]} partitions
 * @returns {Map<string, QueryPartition[]>}
 */
function groupByDataset(partitions) {
  /** @type {Map<string, QueryPartition[]>} */
  const out = new Map()
  for (const partition of partitions) {
    const bucket = out.get(partition.dataset)
    if (bucket) bucket.push(partition)
    else out.set(partition.dataset, [partition])
  }
  return out
}

/**
 * @param {QueryStorageService} storage
 * @param {string} tablePath
 * @param {string} reason
 */
async function flushIfSupported(storage, tablePath, reason) {
  const extended = /** @type {QueryStorageService & { flushTable?: (path: string, opts?: { reason?: string, force?: boolean }) => Promise<unknown> }} */ (
    storage
  )
  if (typeof extended.flushTable === 'function') {
    try {
      await extended.flushTable(tablePath, { force: true, reason })
    } catch {
      // Best-effort flush; commit will still see whatever rows landed.
    }
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
 * @param {QueryRegistry} query
 * @param {string} dataset
 * @returns {readonly ColumnSpec[]}
 */
function resolveColumns(query, dataset) {
  const reg = query.getDataset(dataset)
  if (!reg || !reg.schema || !Array.isArray(reg.schema.columns)) return []
  return reg.schema.columns
}

/**
 * @param {QueryPartition[]} partitions
 * @returns {Record<string, string>}
 */
function collectPartitionKeys(partitions) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const partition of partitions) {
    for (const [k, v] of Object.entries(partition.partition ?? {})) {
      // Preserve the first non-empty value per key — different
      // partitions may share the same key (e.g. `partition=all`).
      if (typeof v === 'string' && v.length > 0 && !(k in out)) out[k] = v
    }
  }
  return out
}

/**
 * Sanitize a dataset name so it cannot escape its parent prefix.
 *
 * @param {string} dataset
 */
function sanitizeDataset(dataset) {
  if (typeof dataset !== 'string' || dataset.length === 0) {
    throw newError('iceberg_data_write_failed', `${PLUGIN_NAME}: dataset name must be non-empty`)
  }
  return dataset.replace(/[^A-Za-z0-9._=,-]/g, '_')
}

/**
 * @param {Record<string, unknown> | undefined} config
 * @returns {string}
 */
function resolvePrefix(config) {
  const raw = config && typeof config.prefix === 'string' ? config.prefix : ''
  if (raw.length === 0) return DEFAULT_PREFIX
  // Defensive: collapse `..` and absolute paths so the prefix stays
  // inside the BlobStore root.
  return raw.replace(/^\/+/, '').replace(/\.\./g, '_')
}

/**
 * @param {...string} parts
 */
function joinKeys(...parts) {
  return parts
    .map((p) => p.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((p) => p.length > 0)
    .join('/')
}

/**
 * @param {unknown} err
 */
function readErrorKind(err) {
  if (!err || typeof err !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (err)
  if (typeof record.hypErrorKind === 'string') return record.hypErrorKind
  return undefined
}

/**
 * @param {string} kind
 * @param {string} message
 */
function newError(kind, message) {
  const err = /** @type {Error & { hypErrorKind: string }} */ (new Error(message))
  err.hypErrorKind = kind
  return err
}

/**
 * Extract destination-shape attributes from a BlobStore for telemetry.
 * The s3 BlobStore surfaces `bucket` and `prefix` as advisory fields;
 * for any other destination kind the returned object is empty so spans
 * remain unchanged.
 *
 * @param {BlobStore} blobStore
 * @returns {Record<string, string>}
 */
function blobStoreDestinationAttrs(blobStore) {
  /** @type {Record<string, string>} */
  const attrs = {}
  if (!blobStore || typeof blobStore.kind !== 'string') return attrs
  attrs.hyp_blob_store_kind = blobStore.kind
  const descriptor = /** @type {{ bucket?: unknown, prefix?: unknown }} */ (blobStore)
  if (typeof descriptor.bucket === 'string' && descriptor.bucket.length > 0) {
    attrs.bucket = descriptor.bucket
  }
  if (typeof descriptor.prefix === 'string' && descriptor.prefix.length > 0) {
    attrs.prefix = descriptor.prefix
  }
  return attrs
}
