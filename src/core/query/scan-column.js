// @ts-check

/**
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
