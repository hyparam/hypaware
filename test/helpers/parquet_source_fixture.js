// @ts-check

/**
 * In-memory parquet fixtures shared by the query-layer tests.
 *
 * `parquetDataSource` needs a real `AsyncBuffer` over real parquet bytes, so
 * every test that wants a faithful partition (as opposed to a hand-rolled
 * `AsyncDataSource`) has to write one. Two files had drifted byte-identical
 * copies of this; keep the one copy here so a fixture fix reaches both.
 */

import { parquetMetadataAsync } from 'hyparquet'
import { parquetWriteBuffer } from 'hyparquet-writer'

import { parquetDataSource } from '../../src/core/query/parquet-source.js'
import { rowsToColumnSources } from '../../hypaware-core/plugins-workspace/format-parquet/src/columns.js'

/**
 * @import { AsyncBuffer } from 'hyparquet'
 * @import { ScannableDataSource } from '../../hypaware-plugin-kernel-types.js'
 * @import { SqlPrimitive } from 'squirreling'
 * @import { ColumnSpec } from '../../hypaware-plugin-kernel-types.js'
 */

/**
 * @param {Uint8Array} bytes
 * @returns {AsyncBuffer}
 */
export function asyncBufferFromBytes(bytes) {
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
 * Build an in-memory parquet file from `rows` and wrap it as a data source,
 * the same shape a committed cache partition takes.
 *
 * @param {ColumnSpec[]} columns
 * @param {Record<string, SqlPrimitive>[]} rows
 * @param {{ rowGroupSize?: number }} [options] `rowGroupSize` forces multi-row-group iteration
 * @returns {Promise<ScannableDataSource>}
 */
export async function parquetSourceFromRows(columns, rows, options = {}) {
  const columnData = rowsToColumnSources(columns, rows)
  const arrayBuffer = parquetWriteBuffer({
    columnData,
    codec: 'SNAPPY',
    rowGroupSize: options.rowGroupSize,
  })
  const file = asyncBufferFromBytes(new Uint8Array(arrayBuffer))
  return parquetDataSource(file, await parquetMetadataAsync(file))
}
