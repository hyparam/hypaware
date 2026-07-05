// @ts-check

import { Buffer } from 'node:buffer'
import zlib from 'node:zlib'

import { getTracer, SpanStatusCode } from '../../../../src/core/observability/index.js'

/**
 * @import { PluginActivationContext, QueryPartition, SinkEncodeContext, SinkEncodedBlob, SinkEncoder } from '../../../../hypaware-plugin-kernel-types.js'
 */

const PLUGIN_NAME = '@hypaware/format-jsonl'
const PLUGIN_VERSION = '1.0.0'
const FORMAT = 'jsonl'
const EXTENSION = 'jsonl.gz'
const COMPRESSION = 'GZIP'

/**
 * Activate `@hypaware/format-jsonl`. Registers the `hypaware.encoder@1`
 * capability with a gzipped JSONL encoder. The encoder's `supports`
 * list is empty by design: pairing JSONL with `@hypaware/local-fs`
 * resolves to a non-queryable sink (the design's "Parquet+local-fs is
 * queryable, JSONL+local-fs is not" rule). It is still useful as a
 * grep-friendly archive sink.
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  /** @type {SinkEncoder} */
  const encoder = {
    format: FORMAT,
    extension: EXTENSION,
    supports: [],
    encodePartition,
  }
  ctx.provideCapability('hypaware.encoder', PLUGIN_VERSION, encoder)
}

/**
 * Encode a partition's rows as gzipped JSONL. Emits an
 * `encoder.encode_jsonl` span with `row_count`, `bytes_written`,
 * `compression`, plus `error_kind` on the failure path.
 *
 * @param {QueryPartition} partition
 * @param {SinkEncodeContext} ctx
 * @returns {Promise<SinkEncodedBlob>}
 */
async function encodePartition(partition, ctx) {
  const tracer = getTracer('plugin.format-jsonl')
  return tracer.startActiveSpan(
    'encoder.encode_jsonl',
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
        if (!ctx.rows) {
          throw newEncoderError(
            'encoder_missing_rows',
            'format-jsonl: SinkEncodeContext.rows must be provided by the blob destination'
          )
        }
        const lines = []
        let rowCount = 0
        for await (const row of ctx.rows) {
          lines.push(JSON.stringify(row, replacer))
          rowCount++
        }
        const text = lines.length === 0 ? '' : lines.join('\n') + '\n'
        const compressed = zlib.gzipSync(Buffer.from(text, 'utf8'))
        const bytes = new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength)

        const filename = `${partitionFilename(partition)}.${EXTENSION}`
        span.setAttribute('row_count', rowCount)
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
        ctx.log.error('encoder.encode_jsonl.failed', {
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
 * JSON.stringify replacer that renders bigints as their numeric string
 * (otherwise JSON.stringify throws on BigInt). Date instances become
 * ISO strings so the JSONL output stays grep-friendly and round-trips
 * via `Date.parse`.
 *
 * @param {string} _key
 * @param {unknown} value
 */
function replacer(_key, value) {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  return value
}

/**
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
