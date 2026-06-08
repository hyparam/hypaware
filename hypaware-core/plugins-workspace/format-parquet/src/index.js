// @ts-check

import zlib from 'node:zlib'

import { rowsToColumnSources } from './columns.js'
import { getTracer, SpanStatusCode } from '../../../../src/core/observability/index.js'

/**
 * @import { ColumnSpec, JsonObject, PluginActivationContext, PluginLogger, QueryPartition, SinkEncodeContext, SinkEncodedBlob, SinkEncoder } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

const PLUGIN_NAME = '@hypaware/format-parquet'
const PLUGIN_VERSION = '1.0.0'
const FORMAT = 'parquet'
const EXTENSION = 'parquet'
const DEFAULT_CODEC = 'SNAPPY'
const DEFAULT_ZSTD_LEVEL = 3

// Codecs this encoder can emit. SNAPPY is supplied by hyparquet-writer's
// own default compressors; ZSTD is wired here via Node's built-in zlib
// (Node >= 22.15 / 23.8). Reads are covered by `hyparquet-compressors`,
// which the query path already wires (see query/parquet-source.js).
const ZSTD_AVAILABLE = typeof zlib.zstdCompressSync === 'function'

/**
 * Resolve the encode settings from the plugin's validated config slice.
 * `codec` defaults to SNAPPY; `ZSTD` is honoured only when the runtime
 * exposes `zlib.zstdCompressSync`, otherwise it degrades to SNAPPY with a
 * warning so an old-Node install never hard-fails on a config it can't
 * satisfy. `page_size` (bytes) is passed through to control the writer's
 * dictionary/page split; leaving it unset uses the hyparquet-writer
 * default (1 MiB).
 *
 * @param {JsonObject | undefined} config
 * @param {PluginLogger} log
 * @returns {{ codec: 'SNAPPY' | 'ZSTD', compressors: Record<string, (bytes: Uint8Array) => Uint8Array> | undefined, pageSize: number | undefined }}
 */
export function resolveEncodeSettings(config, log) {
  const requested = String(config?.codec ?? DEFAULT_CODEC).toUpperCase()
  const pageSizeRaw = config?.page_size
  const pageSize =
    typeof pageSizeRaw === 'number' && Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.floor(pageSizeRaw)
      : undefined

  if (requested === 'ZSTD') {
    if (!ZSTD_AVAILABLE) {
      log.warn('encoder.codec_unavailable', {
        hyp_plugin: PLUGIN_NAME,
        requested_codec: 'ZSTD',
        fallback_codec: DEFAULT_CODEC,
        message: 'zlib.zstdCompressSync not available on this Node runtime; falling back to SNAPPY',
      })
      return { codec: DEFAULT_CODEC, compressors: undefined, pageSize }
    }
    const levelRaw = config?.zstd_level
    const level =
      typeof levelRaw === 'number' && Number.isFinite(levelRaw) ? Math.floor(levelRaw) : DEFAULT_ZSTD_LEVEL
    return { codec: 'ZSTD', compressors: { ZSTD: makeZstdCompressor(level) }, pageSize }
  }

  if (requested !== 'SNAPPY') {
    log.warn('encoder.codec_unknown', {
      hyp_plugin: PLUGIN_NAME,
      requested_codec: requested,
      fallback_codec: DEFAULT_CODEC,
      message: `unknown codec '${requested}'; falling back to SNAPPY`,
    })
  }
  // SNAPPY: hyparquet-writer provides its own snappy compressor by default.
  return { codec: DEFAULT_CODEC, compressors: undefined, pageSize }
}

/**
 * Build a page compressor that runs Node's synchronous zstd at the given
 * level. Returns a `Uint8Array` view of the compressed page so the value
 * matches the writer's `compressors[codec](bytes) => Uint8Array` contract.
 *
 * @param {number} level
 * @returns {(bytes: Uint8Array) => Uint8Array}
 */
function makeZstdCompressor(level) {
  const params = { [zlib.constants.ZSTD_c_compressionLevel]: level }
  return (bytes) => {
    const out = zlib.zstdCompressSync(bytes, { params })
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  }
}

/**
 * Activate `@hypaware/format-parquet`. Registers the `hypaware.encoder@1`
 * capability with a Parquet encoder. The encoder pairs with any
 * `hypaware.blob-store` (e.g. `@hypaware/local-fs`); the blob destination
 * is responsible for materializing partition rows out of the cache and
 * for writing the encoded bytes once this encoder hands them back.
 *
 * @param {PluginActivationContext} ctx
 * @ref LLP 0014#queryable-sinks [implements] — parquet encoder declares `queryable`; lights up only paired with a blob store
 */
export async function activate(ctx) {
  const settings = resolveEncodeSettings(ctx.config, ctx.log)
  ctx.log.info('encoder.activated', {
    hyp_plugin: PLUGIN_NAME,
    codec: settings.codec,
    page_size: settings.pageSize ?? null,
  })
  /** @type {SinkEncoder} */
  const encoder = {
    format: FORMAT,
    extension: EXTENSION,
    supports: ['queryable'],
    encodePartition: (partition, encodeCtx) => encodePartition(partition, encodeCtx, settings),
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
 * @param {{ codec: 'SNAPPY' | 'ZSTD', compressors: Record<string, (bytes: Uint8Array) => Uint8Array> | undefined, pageSize: number | undefined }} settings
 * @returns {Promise<SinkEncodedBlob>}
 */
async function encodePartition(partition, ctx, settings) {
  const tracer = getTracer('plugin.format-parquet')
  return tracer.startActiveSpan(
    'encoder.encode_parquet',
    {
      attributes: {
        'hyp_component': 'encoder',
        'hyp_plugin': PLUGIN_NAME,
        'hyp_dataset': partition.dataset,
        'hyp_sink_format': FORMAT,
        'hyp_sink_extension': EXTENSION,
        compression: settings.codec,
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
        /** @type {{ columnData: any, codec: 'SNAPPY' | 'ZSTD', compressors?: Record<string, (bytes: Uint8Array) => Uint8Array>, pageSize?: number }} */
        const writeOpts = { columnData, codec: settings.codec }
        if (settings.compressors) writeOpts.compressors = settings.compressors
        if (settings.pageSize) writeOpts.pageSize = settings.pageSize
        const arrayBuffer = parquetWriteBuffer(writeOpts)
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
