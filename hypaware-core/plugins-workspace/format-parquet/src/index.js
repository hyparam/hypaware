// @ts-check

import { SpanStatusCode, trace } from '@opentelemetry/api'

import { rowsToColumnSources } from './columns.js'

/** @typedef {import('../../../../collectivus-plugin-kernel-types').ColumnSpec} ColumnSpec */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').PluginActivationContext} PluginActivationContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').QueryPartition} QueryPartition */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').SinkEncodeContext} SinkEncodeContext */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').SinkEncodedBlob} SinkEncodedBlob */
/** @typedef {import('../../../../collectivus-plugin-kernel-types').SinkEncoder} SinkEncoder */

const PLUGIN_NAME = '@hypaware/format-parquet'
const PLUGIN_VERSION = '1.0.0'
const FORMAT = 'parquet'
const EXTENSION = 'parquet'
const COMPRESSION = 'SNAPPY'

/**
 * Activate `@hypaware/format-parquet`. Registers the `hypaware.encoder@1`
 * capability with a Parquet encoder. The encoder pairs with any
 * `hypaware.blob-store` (e.g. `@hypaware/local-fs`); the blob destination
 * is responsible for materializing partition rows out of the cache and
 * for writing the encoded bytes once this encoder hands them back.
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  /** @type {SinkEncoder} */
  const encoder = {
    format: FORMAT,
    extension: EXTENSION,
    supports: ['queryable'],
    encodePartition,
  }
  ctx.provideCapability('hypaware.encoder', PLUGIN_VERSION, encoder)
}

/**
 * Encode a partition's rows as a SNAPPY-compressed Parquet file. Emits a
 * `encoder.encode_parquet` span carrying `row_count`, `bytes_written`,
 * and `compression` per the Phase 8.3 SQL contract (and `error_kind`
 * on the failure path so failures stand out next to the green runs).
 *
 * @param {QueryPartition} partition
 * @param {SinkEncodeContext} ctx
 * @returns {Promise<SinkEncodedBlob>}
 */
async function encodePartition(partition, ctx) {
  const tracer = trace.getTracer(PLUGIN_NAME, PLUGIN_VERSION)
  return tracer.startActiveSpan(
    'encoder.encode_parquet',
    {
      attributes: {
        'hyp_component': 'encoder',
        'hyp_plugin': PLUGIN_NAME,
        'hyp_dataset': partition.dataset,
        'hyp_sink_format': FORMAT,
        'hyp_sink_extension': EXTENSION,
        compression: COMPRESSION,
        status: 'ok',
      },
    },
    async (span) => {
      try {
        if (!ctx.columns || ctx.columns.length === 0) {
          throw newEncoderError(
            'encoder_missing_columns',
            'format-parquet: SinkEncodeContext.columns must be provided by the blob destination'
          )
        }
        if (!ctx.rows) {
          throw newEncoderError(
            'encoder_missing_rows',
            'format-parquet: SinkEncodeContext.rows must be provided by the blob destination'
          )
        }
        const rows = await collectRows(ctx.rows)
        const columnData = rowsToColumnSources(ctx.columns, rows)

        const { parquetWriteBuffer } = await import('hyparquet-writer')
        const arrayBuffer = parquetWriteBuffer({ columnData, codec: COMPRESSION })
        const bytes = new Uint8Array(arrayBuffer)

        const filename = `${partitionFilename(partition)}.${EXTENSION}`
        span.setAttribute('row_count', rows.length)
        span.setAttribute('bytes_written', bytes.byteLength)
        span.setAttribute('hyp_sink_filename', filename)
        span.setStatus({ code: SpanStatusCode.OK })

        return {
          filename,
          bytes,
          bytesWritten: bytes.byteLength,
          rowCount: rows.length,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const errorKind = /** @type {Error & { hypErrorKind?: string }} */ (err)?.hypErrorKind ?? 'encoder_failed'
        span.setStatus({ code: SpanStatusCode.ERROR, message })
        span.setAttribute('status', 'failed')
        span.setAttribute('error_kind', errorKind)
        ctx.log.error('encoder.encode_parquet.failed', {
          hyp_plugin: PLUGIN_NAME,
          hyp_dataset: partition.dataset,
          error_kind: errorKind,
          message,
        })
        throw err
      } finally {
        span.end()
      }
    }
  )
}

/**
 * Drain an async iterable of rows into an in-memory array. The Phase 8.3
 * smoke writes 50 rows, so a single-array buffer is fine; larger
 * deployments lean on the row-group splitting inside hyparquet-writer.
 *
 * @param {AsyncIterable<Record<string, unknown>>} source
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function collectRows(source) {
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for await (const row of source) rows.push(row)
  return rows
}

/**
 * Render `partition.partition` (a key=value bag) into a single
 * filename-safe segment. The default `all` fallback keeps the Phase 5
 * smoke layout intact for partition-less datasets like `dummy_rows`.
 *
 * @param {QueryPartition} partition
 */
function partitionFilename(partition) {
  const entries = Object.entries(partition.partition ?? {})
  if (entries.length === 0) return 'all'
  return entries
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
    .replace(/[^A-Za-z0-9._=,-]/g, '_')
}

/**
 * @param {string} kind
 * @param {string} message
 */
function newEncoderError(kind, message) {
  const err = /** @type {Error & { hypErrorKind?: string }} */ (new Error(message))
  err.hypErrorKind = kind
  return err
}
