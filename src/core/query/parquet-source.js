// @ts-check

import { parquetReadObjects, parquetSchema } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { asyncRow } from 'squirreling'

import { whereToParquetFilter } from './parquet-pushdown.js'
import { comparesStringToColumn, dateColumns } from './string-timestamp-bounds.js'

/**
 * @import { AsyncBuffer, FileMetaData, SchemaTree } from 'hyparquet'
 * @import { ScannableDataSource } from '../../../hypaware-plugin-kernel-types.js'
 * @import { RelationSchema, ScanOptions, ScanResults, SqlPrimitive, SqlType } from 'squirreling'
 */

/**
 * Build a squirreling `AsyncDataSource` over a single parquet file,
 * reading lazily one row group at a time through hyparquet. `WHERE`
 * predicates that convert cleanly are pushed down to the parquet reader;
 * `LIMIT`/`OFFSET` are pushed down only when there is no `WHERE` (see
 * below).
 *
 * Ported from the Hyperparam app (`lib/tools/parquetDataSource.ts`),
 * which drives the same squirreling + hyparquet stack. Two deliberate
 * departures from the browser original:
 *
 *  - The web worker + 128 MB LRU row-group cache are dropped. HypAware
 *    runs in a daemon/CLI and reads synchronously via
 *    `parquetReadObjects`; row-group caching can return later as an
 *    optimization.
 *  - `LIMIT`/`OFFSET` pushdown is gated on the absence of a `WHERE`
 *    clause. The original pushed row-group-relative limits even when a
 *    filter was active, which can under-return rows when the filter is
 *    selective. Here, when a `WHERE` is present we read every row group
 *    (with the filter applied) and let the engine apply `LIMIT`/`OFFSET`
 *    over the filtered stream: correct, at the cost of not early-stopping.
 *
 * @param {AsyncBuffer} file
 * @param {FileMetaData} metadata
 * @returns {ScannableDataSource}
 */
export function parquetDataSource(file, metadata) {
  const schema = parquetSchema(metadata)
  const columns = schema.children.map((c) => c.element.name)
  const physicalColumns = new Set(columns)
  /** @type {RelationSchema} */
  const relationSchema = {
    fields: schema.children.map((child, id) => ({
      id,
      name: child.element.name,
      dataType: sqlType(child),
      nullable: child.element.repetition_type !== 'REQUIRED',
    })),
  }
  const timestampColumns = dateColumns(relationSchema)
  return {
    numRows: Number(metadata.num_rows),
    columns,
    // Types let squirreling cast a string bound on a timestamp column to
    // TIMESTAMP before it reaches scan(), so the pushed filter prunes.
    schema: relationSchema,
    /**
     * @param {ScanOptions} hints
     * @returns {ScanResults}
     */
    scan(hints) {
      // A wrapper or drifted union that drops the schema can still hand down a
      // raw string bound on a timestamp column. hyparquet would compare Date
      // cells to the string and match nothing, so leave that WHERE to the
      // engine, which types the literal per row.
      const pushable = hints.where && !comparesStringToColumn(hints.where, timestampColumns)
      const filter = pushable ? whereToParquetFilter(hints.where) : undefined
      const appliedWhere = Boolean(filter)
      // Only claim LIMIT/OFFSET pushdown when no WHERE is involved.
      // With a WHERE present the engine owns LIMIT/OFFSET so it applies
      // them to the *filtered* result rather than to raw row positions.
      const appliedLimitOffset = !hints.where
      // Honor the requested projection whether or not a filter is pushed
      // down. A filter may reference columns outside the projection, but
      // hyparquet unions its own `columnsNeededForFilter` into the read
      // plan and deletes the extras from the returned rows, so passing the
      // narrow projection is safe. Reading all columns instead would decode
      // every payload column on any filtered scan. Because the emitted row
      // set is now exactly `columns`, a caller that wraps this scan and
      // reports its own `appliedWhere: false` (letting the engine re-apply
      // the predicate over rows this scan already returned, as `unionSources`
      // does) must include the predicate's columns in `columns`, or the
      // engine has nothing to re-filter on.
      // hyparquet >= 1.29 rejects a projected name absent from the physical
      // schema. Keep the scan physical here; the union pads requested columns
      // the partition lacks after this source yields its rows.
      // @ref LLP 0241#alignment [constrained-by]: drifted columns are padded above the physical parquet read
      const readColumns = hints.columns?.filter((column) => physicalColumns.has(column))

      return {
        appliedWhere,
        appliedLimitOffset,
        async *rows() {
          let groupStart = 0
          let remainingLimit = appliedLimitOffset ? (hints.limit ?? Infinity) : Infinity
          for (const rowGroup of metadata.row_groups) {
            if (hints.signal?.aborted) throw abortError()
            const rowCount = Number(rowGroup.num_rows)

            let safeOffset = 0
            let safeLimit = rowCount
            if (appliedLimitOffset) {
              if (hints.offset !== undefined && groupStart < hints.offset) {
                safeOffset = Math.min(rowCount, hints.offset - groupStart)
              }
              safeLimit = Math.min(rowCount - safeOffset, remainingLimit)
              // Past the requested window: nothing further to read.
              if (safeLimit <= 0 && safeOffset < rowCount) break
            }
            // Whole row group skipped by OFFSET.
            if (safeOffset === rowCount) {
              groupStart += rowCount
              continue
            }

            const rowStart = groupStart + safeOffset
            const rowEnd = rowStart + safeLimit

            const data = await parquetReadObjects({
              file,
              metadata,
              rowStart,
              rowEnd,
              columns: readColumns,
              filter,
              filterStrict: false,
              useOffsetIndex: safeOffset > 0 || safeLimit < rowCount,
              compressors,
            })

            if (data.length > 0) {
              const columns = Object.keys(data[0])
              for (const row of data) {
                yield asyncRow(/** @type {Record<string, SqlPrimitive>} */ (row), columns)
              }
            }

            remainingLimit -= data.length
            groupStart += rowCount
          }
        },
      }
    },
  }
}

/**
 * @returns {Error}
 */
function abortError() {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

/**
 * The SQL type hyparquet's default conversion produces for a top-level column:
 * Date for timestamp and date annotations (and legacy INT96), string for
 * string annotations. Everything else, nested columns included, stays unknown.
 *
 * @param {SchemaTree} node
 * @returns {SqlType}
 */
function sqlType(node) {
  if (node.children.length) return { type: 'unknown' }
  const { type, converted_type: converted, logical_type: logical } = node.element
  if (logical?.type === 'TIMESTAMP' || logical?.type === 'DATE' || type === 'INT96' ||
    converted === 'TIMESTAMP_MILLIS' || converted === 'TIMESTAMP_MICROS' || converted === 'DATE') {
    return { type: 'date' }
  }
  if (logical?.type === 'STRING' || converted === 'UTF8') return { type: 'string' }
  return { type: 'unknown' }
}
