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

// Row-group clustering. hyparquet-writer keeps a column dictionary-encoded
// only while a row group's DISTINCT values fit under its ~1 MiB dictionary-
// page cap. Columns denormalized onto every row but constant per conversation
// (e.g. `tools`, `system_text`) explode to PLAIN — re-storing every copy in
// full — once a single row group spans the whole partition's distinct values.
// Bounding each row group to a small number of distinct cluster keys (and a
// max row count) keeps the dictionary alive. The dictionary decision depends
// on the distinct-value COUNT, not row order, and the source rows already
// arrive grouped by conversation, so no sort is needed.
const DEFAULT_MAX_CLUSTER_KEYS = 16
const DEFAULT_MAX_ROWS_PER_GROUP = 50_000
// Hard ceiling on how many estimated row bytes accumulate in one in-memory
// group before it is written out as a row group and freed. This is the knob
// that bounds peak heap during a sink force: the encoder never holds more than
// ~one group (plus its columnar copy) at once, instead of materializing the
// whole partition. Independent of blob size, so a fat-`tools` partition cannot
// push a group into the gigabytes.
const DEFAULT_MAX_GROUP_BYTES = 32 * 1024 * 1024
// Mirrors hyparquet-writer's own default page size (1 MiB).
const DEFAULT_PAGE_SIZE = 1024 * 1024

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
        const columns = ctx.columns
        const sourceRows = ctx.rows
        const { ByteWriter, ParquetWriter, schemaFromColumnData } = await import('hyparquet-writer')

        // Derive a stable schema from the declared column types (not from the
        // data) so we can write row groups incrementally — never holding more
        // than one cluster group of rows (plus its columnar copy) in memory.
        // This is what stops `hyp sink force` on a large partition from OOMing
        // while materializing the whole partition at once.
        const schema = schemaFromColumnData({ columnData: rowsToColumnSources(columns, []) })
        const writer = new ByteWriter()
        const pq = new ParquetWriter({
          writer,
          schema,
          codec: settings.codec,
          compressors: settings.compressors,
        })
        const pageSize = settings.pageSize ?? DEFAULT_PAGE_SIZE
        const clusterColumns = ctx.clusterColumns && ctx.clusterColumns.length > 0 ? ctx.clusterColumns : null

        let rowCount = 0
        let rowGroupCount = 0
        /** @type {Record<string, unknown>[]} */
        let group = []
        let groupBytes = 0
        /** @type {Set<string> | null} */
        let groupKeys = clusterColumns ? new Set() : null

        // Each flush is exactly one Parquet row group. useDictionary runs per
        // row group, so a low-cardinality group keeps wide repeated columns
        // (`tools`, `system_text`) dictionary-encoded rather than PLAIN.
        const flushGroup = () => {
          if (group.length === 0) return
          pq.write({ columnData: rowsToColumnSources(columns, group), rowGroupSize: group.length, pageSize })
          rowCount += group.length
          rowGroupCount++
          group = []
          groupBytes = 0
          if (groupKeys) groupKeys = new Set()
        }

        for await (const row of sourceRows) {
          // Estimate the row up front so the byte cap is checked *before* the
          // row is added. Otherwise groupBytes only reflects rows already in the
          // group, and a fat blob (20-30 MB) can push the group an entire row
          // past DEFAULT_MAX_GROUP_BYTES before the next iteration flushes.
          const rowBytes = estimateRowBytes(row)
          const wouldOverflowBytes = group.length > 0 && groupBytes + rowBytes > DEFAULT_MAX_GROUP_BYTES
          if (clusterColumns && groupKeys) {
            const key = clusterKeyOf(row, clusterColumns)
            const overflowKeys = !groupKeys.has(key) && groupKeys.size >= DEFAULT_MAX_CLUSTER_KEYS
            if (group.length > 0 && (overflowKeys || group.length >= DEFAULT_MAX_ROWS_PER_GROUP || wouldOverflowBytes)) {
              flushGroup()
            }
            groupKeys.add(key)
          } else if (group.length > 0 && (group.length >= DEFAULT_MAX_ROWS_PER_GROUP || wouldOverflowBytes)) {
            flushGroup()
          }
          group.push(row)
          groupBytes += rowBytes
        }
        flushGroup()

        pq.finish()
        const bytes = new Uint8Array(writer.getBuffer())

        const filename = `${partitionFilename(partition)}.${EXTENSION}`
        span.setAttribute('row_count', rowCount)
        span.setAttribute('row_group_count', rowGroupCount)
        span.setAttribute('bytes_written', bytes.byteLength)
        span.setAttribute('hyp_sink_filename', filename)
        span.setStatus({ code: SpanStatusCode.OK })

        return {
          filename,
          bytes,
          bytesWritten: bytes.byteLength,
          rowCount,
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
 * Cheap, allocation-free estimate of a row's in-memory footprint in bytes.
 * Used only to bound how much a group accumulates before it is flushed as a
 * row group, so precision matters less than never under-counting a fat blob.
 * Mirrors the cache compactor's estimator.
 *
 * @param {Record<string, unknown>} row
 * @returns {number}
 */
function estimateRowBytes(row) {
  let total = 0
  for (const value of Object.values(row)) total += estimateValueBytes(value)
  return total
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function estimateValueBytes(value) {
  if (value === null || value === undefined) return 0
  switch (typeof value) {
    case 'string':
      return value.length * 2 // JS strings are UTF-16 internally
    case 'number':
      return 8
    case 'bigint':
      return 16
    case 'boolean':
      return 4
    case 'object': {
      if (value instanceof Uint8Array) return value.byteLength
      let total = 0
      if (Array.isArray(value)) {
        for (const item of value) total += estimateValueBytes(item)
        return total
      }
      for (const [k, v] of Object.entries(value)) {
        total += k.length * 2 + estimateValueBytes(v)
      }
      return total
    }
    default:
      return 0
  }
}

/**
 * Stable grouping key from a row's cluster columns. Consistent for equal
 * tuples; never persisted. NUL-separated to keep distinct tuples distinct.
 *
 * @param {Record<string, unknown>} row
 * @param {readonly string[]} clusterColumns
 * @returns {string}
 */
function clusterKeyOf(row, clusterColumns) {
  let key = ''
  for (const col of clusterColumns) {
    const v = row[col]
    const part = typeof v === 'string'
      ? v
      : typeof v === 'bigint'
        ? v.toString()
        : JSON.stringify(v ?? null)
    key += part + '\u0000'
  }
  return key
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
