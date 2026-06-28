// @ts-check

import { Attr, withSpan } from '../observability/index.js'

/**
 * @import { ColumnSpec, QueryPartition, QueryRegistry, SinkEncodeContext, SinkEncodedBlob, SinkEncoder } from '../../../collectivus-plugin-kernel-types.js'
 */

/**
 * Derive the cluster columns for a dataset from its Iceberg partition fields
 * (e.g. `conversation_id`/`cwd`/`date`). Blob destinations pass these into the
 * encode context so columnar encoders can keep each row group low-cardinality
 * — which keeps wide, heavily-repeated columns (`tools`, `system_text`)
 * dictionary-encoded instead of falling back to PLAIN. Returns undefined for
 * datasets without a partition declaration (encoders then use default row
 * grouping). Shared by the `local-fs` and `s3` blob destinations.
 *
 * @param {QueryRegistry} query
 * @param {string} dataset
 * @returns {string[] | undefined}
 */
export function clusterColumnsForDataset(query, dataset) {
  const reg = /** @type {{ cachePartitioning?: { iceberg?: { fields?: Array<{ column?: unknown }> } } }} */ (
    query.getDataset(dataset)
  )
  const fields = reg?.cachePartitioning?.iceberg?.fields
  if (!Array.isArray(fields)) return undefined
  const cols = fields
    .map((f) => f.column)
    .filter(/** @returns {c is string} */ (c) => typeof c === 'string' && c.length > 0)
  return cols.length > 0 ? cols : undefined
}

/**
 * Wrap a single `encoder.encodePartition` call in a
 * `sink.encode_partition` span. Blob-sink `Sink.exportBatch`
 * implementations use this so the kernel — not each plugin — owns the
 * observability contract for encoder calls (format/extension/row_count/
 * bytes_written attributes, status, error_kind).
 *
 * The helper records `bytes_written` from whichever of the encoder's
 * declared `bytesWritten` (preferred) or the in-memory `bytes` byteLength
 * is available, so plugins that stream chunks via `AsyncIterable` only
 * need to set `bytesWritten` once after the stream drains.
 *
 * `columns` and `rows`, when supplied, are forwarded onto the encoder's
 * `SinkEncodeContext`. The destination passes them after reading the
 * partition's schema (from `ctx.query`) and streaming rows (from
 * `ctx.storage.readRows`); encoders that don't need typed schema or row
 * access (e.g. trivial fixtures) leave them undefined.
 *
 * @param {SinkEncoder} encoder
 * @param {QueryPartition} partition
 * @param {SinkEncodeContext & { sinkInstance?: string, plugin?: string }} ctx
 * @returns {Promise<SinkEncodedBlob>}
 */
export async function encodePartition(encoder, partition, ctx) {
  return withSpan(
    'sink.encode_partition',
    {
      [Attr.COMPONENT]: 'sinks',
      [Attr.OPERATION]: 'sink.encode_partition',
      [Attr.DATASET]: partition.dataset,
      [Attr.SINK_INSTANCE]: ctx.sinkInstance ?? '',
      [Attr.PLUGIN]: ctx.plugin ?? '',
      hyp_sink_format: encoder.format,
      hyp_sink_extension: encoder.extension,
      status: 'ok',
    },
    async (span) => {
      const blob = await encoder.encodePartition(partition, {
        log: ctx.log,
        tempDir: ctx.tempDir,
        columns: ctx.columns,
        rows: ctx.rows,
        clusterColumns: ctx.clusterColumns,
      })
      const rowCount = blob.rowCount ?? 0
      const bytesWritten = blob.bytesWritten ?? bytesLengthOf(blob.bytes)
      span.setAttribute('row_count', rowCount)
      span.setAttribute('bytes_written', bytesWritten)
      span.setAttribute('hyp_sink_filename', blob.filename)
      return blob
    },
    { component: 'sinks' }
  )
}

/**
 * Best-effort byte length for the in-memory case. Async iterables can't
 * be sized without consuming, so plugins that stream are expected to set
 * `bytesWritten` after their stream drains.
 *
 * @param {Uint8Array | AsyncIterable<Uint8Array>} bytes
 */
function bytesLengthOf(bytes) {
  if (bytes instanceof Uint8Array) return bytes.byteLength
  // ArrayBufferView (Buffer is also a Uint8Array, handled above; check
  // generally for typed arrays just in case future encoders use them).
  if (bytes && typeof /** @type {any} */ (bytes).byteLength === 'number') {
    return /** @type {{ byteLength: number }} */ (/** @type {unknown} */ (bytes)).byteLength
  }
  return 0
}
