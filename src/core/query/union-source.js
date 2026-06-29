// @ts-check

/**
 * @import { AsyncDataSource } from 'squirreling/src/types.js'
 */

/**
 * Concatenate several `AsyncDataSource`s into one logical source. Columns
 * are unioned, `numRows` summed, and rows yielded partition-by-partition.
 *
 * The union reports `appliedWhere: false` and `appliedLimitOffset: false`,
 * so the SQL engine re-applies both over the merged stream. `where` and
 * `columns` hints ARE forwarded to the sub-sources (a sub-source may
 * pre-filter or project as an optimization; the engine still re-checks
 * `where`), but `limit`/`offset` are stripped — they are not distributive
 * across a concatenation. A sub-source that honors limit/offset pushdown
 * (e.g. an Iceberg partition) would otherwise drop its first `offset` rows
 * per partition and the engine would skip the offset again on the joined
 * stream, silently losing rows from paginated multi-partition queries.
 *
 * @param {AsyncDataSource[]} sources
 * @returns {AsyncDataSource}
 * @ref LLP 0015#multi-partition-union [constrained-by] — the union must not forward limit/offset or offsets apply twice
 */
export function unionSources(sources) {
  /** @type {Set<string>} */
  const allColumns = new Set()
  let totalRows = 0
  for (const s of sources) {
    for (const col of s.columns) allColumns.add(col)
    totalRows += s.numRows ?? 0
  }
  return {
    columns: Array.from(allColumns),
    numRows: totalRows,
    scan(options) {
      // Defends against a runtime scan() with no options even though the
      // AsyncDataSource contract types it as required.
      const subOptions = options ? { ...options, limit: undefined, offset: undefined } : options
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (const source of sources) {
            const scan = source.scan(subOptions)
            for await (const row of scan.rows()) {
              yield row
            }
          }
        },
      }
    },
  }
}

/**
 * A zero-row `AsyncDataSource` that still advertises a dataset's declared
 * columns, so a SELECT naming any of them validates and reads as empty
 * rather than throwing `ColumnNotFoundError`.
 *
 * @param {string[]} columns
 * @returns {AsyncDataSource}
 */
export function emptySource(columns) {
  return {
    columns,
    numRows: 0,
    scan() {
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {},
      }
    },
  }
}
