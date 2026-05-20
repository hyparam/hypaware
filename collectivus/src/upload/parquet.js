import { rowsToColumns } from './schema.js'

/**
 * @import { Signal } from './upload.d.ts'
 */

/**
 * Convert normalized rows to a Parquet file. Lazy-loads hyparquet-writer
 * so the optional dep is only required when uploads are configured.
 *
 * `partitionDimensions` selects between the v1 (legacy) and v2 (multi-tenant)
 * schemas — when it includes `'gateway_id'`, every row is required to carry
 * a `_partition.gateway_id` tag and the parquet output gains a
 * non-null `gateway_id` column. See `src/upload/schema.js` for details.
 *
 * @param {Signal} signal
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {ReadonlyArray<string>} [partitionDimensions]
 * @returns {Promise<Uint8Array>}
 */
export async function rowsToParquet(signal, rows, partitionDimensions) {
  const { parquetWriteBuffer } = await import('hyparquet-writer')
  const columnData = rowsToColumns(signal, rows, partitionDimensions)
  const arrayBuffer = parquetWriteBuffer({ columnData })
  return new Uint8Array(arrayBuffer)
}
