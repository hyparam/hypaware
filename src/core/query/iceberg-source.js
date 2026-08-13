// @ts-check

// hyparquet publishes `./src/*.js` in its `exports` map, the same deep-import
// route the cache already takes into icebird (`store.js`, `stream_append.js`).
// `matchFilter` is the exact evaluator hyparquet runs over a
// `ParquetQueryFilter` inside the parquet read, so re-applying it here agrees
// with the pushdown by construction instead of by a second implementation.
import { matchFilter } from 'hyparquet/src/filter.js'

import { whereToParquetFilter } from './parquet-pushdown.js'
import { normalizeScanColumn } from './scan-column.js'
import { whereColumns } from './union-source.js'

/**
 * @import { ParquetQueryFilter } from 'hyparquet'
 * @import { AsyncDataSource, AsyncRow, ScanColumnOptions, ScanColumnResults, ScanOptions, ScanResults, SqlPrimitive } from 'squirreling/src/types.js'
 */

/**
 * Wrap an `icebergDataSource` so the rows it yields answer to THIS repo's
 * WHERE converter (`parquet-pushdown.js`) rather than to icebird's
 * (`icebird/src/sql/whereFilter.js`).
 *
 * icebird's converter is wrong three ways on nullable columns, and its data
 * source reports `appliedWhere: true` for all three, so the engine never
 * re-judges the rows and the wrong answer is final (issue #744):
 *
 *  - a comparison against a NULL literal converts to `IS NULL` semantics
 *    (`ts = NULL` becomes `{ts: {$eq: null}}` and returns the NULL rows; SQL
 *    says no row is TRUE, NULL rows included);
 *  - relational operators push bare, with no `$ne: null` guard, and
 *    hyparquet evaluates them with raw JavaScript comparison, which coerces
 *    NULL to 0, so NULL rows sail past a negative bound (`neg > -400`);
 *  - a negated OR converts to `$nor`, a two-valued complement, so a row that
 *    is UNKNOWN for every disjunct is reported as a match.
 *
 * `icebergDataSource` accepts no pre-built filter (its only predicate input
 * is the `where` AST on the scan hints, which it converts itself), so the
 * repair is applied one layer out: the wrapper converts the predicate with
 * this repo's converter and matches every emitted row against the result.
 *
 * The predicate is still forwarded to icebird, but as a **pruning hint
 * only**. That is sound because icebird's filter can only ever be a superset
 * of SQL's answer: every leaf it emits contains every row the leaf is TRUE
 * for and no row the leaf is FALSE for (on rows with no NULL in a referenced
 * column its conversion is exactly SQL, and NULL rows are only ever added),
 * and that invariant survives `$and`, `$or` and even `$nor`, whose
 * complement can only drop rows a child matched. File pruning
 * (`fileMightMatch` / `partitionMightMatch`) and hyparquet's row-group and
 * page skipping are inclusive projections of that same filter, so nothing
 * SQL selects is dropped before the wrapper's own match runs. Keeping the
 * hint is what stops the fix from costing the pruning LLP 0098 relies on.
 *
 * `limit`/`offset` are never forwarded alongside a `where`: icebird would cap
 * the scan at `offset + limit` rows matching ITS filter, and this wrapper
 * then narrows further, which under-returns. The wrapper applies the slice
 * itself over the rows that actually match, and reports
 * `appliedLimitOffset` accordingly, so early termination survives too (a
 * consumer that stops reading returns the inner generator, which ends the
 * file walk).
 *
 * When this repo's converter declines the predicate the wrapper claims
 * nothing: `appliedWhere: false` hands the judgement back to the engine,
 * whose WHERE is two-valued and still wrong for a negated UNKNOWN subtree
 * (issue #734). That is the milder, already-tracked failure, and it is what
 * the parquet-file path does for the same predicates.
 *
 * @ref LLP 0221#wrapper [implements]: the cache path answers to the kernel's
 * converter; icebird's keeps only the pruning it is safe for.
 * @param {AsyncDataSource} source
 * @returns {AsyncDataSource}
 */
export function withSqlCorrectWhere(source) {
  /** @type {AsyncDataSource} */
  const wrapped = {
    numRows: source.numRows,
    columns: source.columns,
    /**
     * @param {ScanOptions} options
     * @returns {ScanResults}
     */
    scan(options) {
      const where = options?.where
      if (!where) return source.scan(options)
      const plan = planWhere(where, options.columns ?? source.columns)
      // `limit`/`offset` are only meaningful after the real filter, so they
      // never ride along with the forwarded pruning hint.
      const inner = source.scan({ ...options, limit: undefined, offset: undefined })
      if (!plan) {
        return { appliedWhere: false, appliedLimitOffset: false, rows: () => inner.rows() }
      }
      const { filter, columns } = plan
      const limit = options.limit ?? Infinity
      const offset = options.offset ?? 0
      return {
        appliedWhere: true,
        appliedLimitOffset: true,
        async *rows() {
          if (limit <= 0) return
          let skipped = 0
          let emitted = 0
          for await (const row of inner.rows()) {
            if (!(await rowMatches(row, filter, columns))) continue
            if (skipped < offset) {
              skipped += 1
              continue
            }
            yield row
            emitted += 1
            if (emitted >= limit) return
          }
        },
      }
    },
  }

  // The column stream is the engine's filtered-aggregate fast path (LLP 0098),
  // and it has to keep claiming `appliedWhere` or the engine drops back to
  // materializing a row per value, which is the latency class that decision
  // removed. Two shapes, because a chunk of values can only answer a predicate
  // over its own column:
  //
  //  - predicate over the scanned column: filter the value chunks in place;
  //  - predicate over any other column: read rows carrying the scanned column
  //    AND the predicate's columns through `scan` above (hyparquet reads the
  //    filter's columns for its own matching anyway) and project the scanned
  //    column back out in bounded batches.
  //
  // @ref LLP 0098#wrapper-duties [constrained-by]: a wrapper reports the hints
  // it can prove it applied, and never slices a stream whose predicate it did
  // not apply.
  if (typeof source.scanColumn === 'function') {
    const innerScanColumn = source.scanColumn
    /**
     * @param {ScanColumnOptions} options
     * @returns {ScanColumnResults}
     */
    wrapped.scanColumn = (options) => {
      const { column, where, signal } = options
      if (!where) return normalizeScanColumn(innerScanColumn(options), options)
      const plan = planWhere(where, source.columns)
      // Same discipline as `scan`: forward the predicate for pruning, never
      // the slice. The engine already withholds `limit`/`offset` from a
      // filtered `scanColumn`; a direct caller gets the same treatment.
      const declined = () => {
        const innerOptions = { column, where, signal }
        const result = normalizeScanColumn(innerScanColumn(innerOptions), innerOptions)
        return { appliedWhere: false, appliedLimitOffset: false, chunks: () => result.chunks() }
      }
      if (!plan) return declined()
      const { filter, columns } = plan

      if (columns.size === 1 && columns.has(column)) {
        const innerOptions = { column, where, signal }
        const result = normalizeScanColumn(innerScanColumn(innerOptions), innerOptions)
        return {
          appliedWhere: true,
          appliedLimitOffset: false,
          async *chunks() {
            for await (const chunk of result.chunks()) {
              /** @type {SqlPrimitive[]} */
              const kept = []
              for (let i = 0; i < chunk.length; i++) {
                if (matchFilter({ [column]: chunk[i] }, filter, false)) kept.push(chunk[i])
              }
              if (kept.length > 0) yield kept
            }
          },
        }
      }

      const scanColumns = [column, ...[...columns].filter((c) => c !== column)]
      const scan = wrapped.scan({ columns: scanColumns, where, signal })
      if (!scan.appliedWhere) return declined()
      return {
        appliedWhere: true,
        appliedLimitOffset: false,
        async *chunks() {
          /** @type {SqlPrimitive[]} */
          let batch = []
          for await (const row of scan.rows()) {
            batch.push(await cellValue(row, column))
            if (batch.length >= COLUMN_BATCH_ROWS) {
              yield batch
              batch = []
            }
          }
          if (batch.length > 0) yield batch
        },
      }
    }
  }

  return wrapped
}

/**
 * Values per chunk when a column stream is rebuilt from a row scan. Peak
 * memory is one batch of one column's values, which keeps LLP 0055's bound
 * (a row group's worth of values) rather than materializing the stream.
 */
const COLUMN_BATCH_ROWS = 1024

/**
 * Decide whether the wrapper can own `where` over a stream carrying
 * `available` columns. Returns the converted filter and the columns it reads,
 * or `undefined` when the predicate must be handed back to the engine.
 *
 * The projection gate matters because a scan emits exactly the columns it was
 * asked for: matching a row against a filter on a column the row does not
 * carry would read `undefined` and answer nonsense. Squirreling folds the
 * WHERE columns into the projection it hands to `scan()`, so the gate is a
 * guard against direct callers rather than a path the engine takes.
 *
 * @param {NonNullable<ScanOptions['where']>} where
 * @param {readonly string[]} available
 * @returns {{ filter: ParquetQueryFilter, columns: Set<string> } | undefined}
 */
function planWhere(where, available) {
  const filter = whereToParquetFilter(where)
  if (!filter) return undefined
  // `null` means the predicate holds a construct whose column set can't be
  // enumerated locally (a qualified identifier, a subquery). Both converters
  // would key such a filter by a name the row may not carry, so decline.
  const columns = whereColumns(where)
  if (!columns) return undefined
  const have = new Set(available)
  for (const column of columns) {
    if (!have.has(column)) return undefined
  }
  return { filter, columns }
}

/**
 * @param {AsyncRow} row
 * @param {string} column
 * @returns {Promise<SqlPrimitive>}
 */
async function cellValue(row, column) {
  if (row.resolved && column in row.resolved) return row.resolved[column]
  const cell = await row.cells[column]?.()
  return cell ?? null
}

/**
 * @param {AsyncRow} row
 * @param {ParquetQueryFilter} filter
 * @param {Set<string>} columns
 * @returns {Promise<boolean>}
 */
async function rowMatches(row, filter, columns) {
  let record = row.resolved
  if (!record) {
    /** @type {Record<string, SqlPrimitive>} */
    const resolved = {}
    for (const column of columns) resolved[column] = await row.cells[column]?.()
    record = resolved
  }
  // `filterStrict: false` is the convention the parquet read already uses
  // (`parquet-source.js`, icebird's `readDataFile`): permissive across the
  // bigint/number split a SQL integer literal lands on.
  return matchFilter(record, filter, false)
}
