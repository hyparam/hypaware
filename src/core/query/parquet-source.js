// @ts-check

import { parquetReadObjects, parquetSchema } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { asyncRow } from 'squirreling'

import { whereToParquetFilter } from './parquet-pushdown.js'

/**
 * @import { AsyncBuffer, FileMetaData } from 'hyparquet'
 * @import { AsyncDataSource, ScanOptions, ScanResults, SqlPrimitive } from 'squirreling/src/types.js'
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
 * @returns {AsyncDataSource}
 */
export function parquetDataSource(file, metadata) {
  const schema = parquetSchema(metadata)
  return {
    numRows: Number(metadata.num_rows),
    columns: schema.children.map((c) => c.element.name),
    /**
     * @param {ScanOptions} hints
     * @returns {ScanResults}
     */
    scan(hints) {
      const filter = hints.where ? whereToParquetFilter(hints.where) : undefined
      const appliedWhere = Boolean(filter)
      // Only claim LIMIT/OFFSET pushdown when no WHERE is involved.
      // With a WHERE present the engine owns LIMIT/OFFSET so it applies
      // them to the *filtered* result rather than to raw row positions.
      const appliedLimitOffset = !hints.where
      // When a filter is pushed down it may reference columns outside the
      // engine's projection; read all columns so hyparquet can evaluate
      // it, and let the engine project. Without a filter, honor the
      // requested projection.
      const readColumns = filter ? undefined : hints.columns

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
