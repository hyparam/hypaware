// @ts-check

/**
 * @import { ScannableDataSource } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ScanColumnOptions, ScanColumnResults, SqlPrimitive } from 'squirreling/src/types.js'
 */

/**
 * Normalize the two legal `scanColumn` returns into `ScanColumnResults`.
 * Squirreling >= 0.15 lets a source return either the flagged shape or the
 * legacy bare `AsyncIterable` of chunks; every kernel wrapper that consumes
 * an inner source's `scanColumn` must go through this shim, because a legacy
 * implementation predates `where` and can only claim its hints applied when
 * no predicate was requested. Mirrors squirreling's own boundary
 * normalization so a legacy plugin source composes with the flagged wrappers.
 *
 * @param {AsyncIterable<ArrayLike<SqlPrimitive>> | ScanColumnResults} result
 * @param {ScanColumnOptions} options
 * @returns {ScanColumnResults}
 */
export function normalizeScanColumn(result, options) {
  if ('chunks' in result) return result
  return {
    chunks: () => result,
    appliedWhere: !options.where,
    appliedLimitOffset: !options.where,
  }
}

/**
 * Stream one column of a source that offers `scanColumn`, through the shim
 * above, or one null per row when the source does not physically carry the
 * column (a column declared after the partition was written, LLP 0032). A
 * parquet-backed source throws on a column it cannot find, so the request
 * never reaches it: a column the source does carry stands in, and only its
 * row count is used. That keeps deletes, a pushed predicate and any limit
 * honest, which a `numRows` fill could not: icebird omits `numRows` when the
 * snapshot holds position deletes, and no count survives a `where` anyway.
 *
 * `options.where` must already be pushable against this source (the caller's
 * schema gate); it can name the absent column only if the caller failed that.
 *
 * @param {ScannableDataSource} source has `scanColumn`; callers gate on it
 * @param {ScanColumnOptions} options
 * @returns {ScanColumnResults}
 */
export function scanColumnOrNulls(source, options) {
  const scanColumn = /** @type {NonNullable<ScannableDataSource['scanColumn']>} */ (source.scanColumn)
  if (source.columns.includes(options.column)) return normalizeScanColumn(scanColumn(options), options)
  const column = source.columns[0]
  if (column === undefined) {
    return { appliedWhere: true, appliedLimitOffset: true, async *chunks() {} }
  }
  const proxy = { ...options, column }
  const inner = normalizeScanColumn(scanColumn(proxy), proxy)
  return {
    appliedWhere: inner.appliedWhere,
    appliedLimitOffset: inner.appliedLimitOffset,
    async *chunks() {
      for await (const chunk of inner.chunks()) yield new Array(chunk.length).fill(null)
    },
  }
}
