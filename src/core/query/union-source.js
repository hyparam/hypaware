// @ts-check

/**
 * @import { AsyncDataSource, ExprNode } from 'squirreling/src/types.js'
 */

/**
 * Concatenate several `AsyncDataSource`s into one logical source. Columns
 * are unioned, `numRows` summed, and rows yielded partition-by-partition.
 *
 * The union reports `appliedWhere: false` and `appliedLimitOffset: false`,
 * so the SQL engine re-applies both over the merged stream. `limit`/`offset`
 * are stripped from the sub-scans. They are not distributive across a
 * concatenation; a sub-source that honors limit/offset pushdown (e.g. an
 * Iceberg partition) would otherwise drop its first `offset` rows per
 * partition and the engine would skip the offset again on the joined stream,
 * silently losing rows from paginated multi-partition queries.
 *
 * `where` is forwarded to a sub-source as a pushdown optimization **only when
 * that source advertises every column the predicate references**. A
 * heterogeneous union (partitions with additive schema drift) can otherwise
 * push a filter on a column that a given partition physically lacks, and a
 * parquet-backed source throws `parquet filter columns not found` rather than
 * reading the column as null. When a partition can't satisfy the predicate we
 * drop `where` for it and let the engine filter the concatenated stream (it
 * already owns the filter via `appliedWhere: false`). `columns` is always
 * forwarded: projecting an absent column reads as null, never throws.
 *
 * @param {AsyncDataSource[]} sources
 * @returns {AsyncDataSource}
 * @ref LLP 0015#multi-partition-union [constrained-by]: the union must not forward limit/offset or offsets apply twice, nor push a filter a partition can't satisfy
 */
export function unionSources(sources) {
  /** @type {Set<string>} */
  const allColumns = new Set()
  let totalRows = 0
  for (const s of sources) {
    for (const col of s.columns) allColumns.add(col)
    totalRows += s.numRows ?? 0
  }
  /** @type {AsyncDataSource} */
  const union = {
    columns: Array.from(allColumns),
    numRows: totalRows,
    scan(options) {
      // Defends against a runtime scan() with no options even though the
      // AsyncDataSource contract types it as required.
      const base = options ? { ...options, limit: undefined, offset: undefined } : options
      // Columns the predicate touches, computed once; null when `where` is
      // present but references a construct we can't safely push down (a
      // qualified identifier, subquery, or other non-local construct).
      const predicateColumns = base && base.where ? whereColumns(base.where) : undefined
      return {
        appliedWhere: false,
        appliedLimitOffset: false,
        async *rows() {
          for (const source of sources) {
            let subOptions = base
            if (base && base.where && !canPushWhere(source, predicateColumns)) {
              subOptions = { ...base, where: undefined }
            }
            const scan = source.scan(subOptions)
            for await (const row of scan.rows()) {
              yield row
            }
          }
        },
      }
    },
  }
  // The column-stream hook is offered only when EVERY partition can stream
  // the column; a mixed union stays row-based so the engine's fallback owns
  // correctness. Unlike scan(), the scanColumn contract has no
  // appliedLimitOffset escape hatch: the source must fully honor
  // limit/offset itself, so the union applies them over the CONCATENATED
  // stream (they are not distributive across partitions, the same
  // discipline scan() applies). Only the remaining-limit bound is pushed
  // per partition, as an upper-bound optimization that can never change
  // the result.
  // @ref LLP 0055 [implements]: union forwards scanColumn by concatenating per-partition column streams; limit/offset apply to the merged stream
  if (sources.every((s) => typeof s.scanColumn === 'function')) {
    union.scanColumn = ({ column, limit, offset, signal }) => ({
      async *[Symbol.asyncIterator]() {
        let remainingSkip = offset ?? 0
        let remaining = limit ?? Infinity
        for (const source of sources) {
          if (remaining <= 0) return
          signal?.throwIfAborted()
          // A known-empty or fully-skippable partition needs no stream.
          const numRows = source.numRows
          if (numRows !== undefined && numRows <= remainingSkip) {
            remainingSkip -= numRows
            continue
          }
          const scanColumn = /** @type {NonNullable<AsyncDataSource['scanColumn']>} */ (source.scanColumn)
          const chunks = scanColumn({
            column,
            // Per-partition upper bound: this partition can contribute at
            // most the values still owed, including any skip not yet spent.
            limit: remaining === Infinity ? undefined : remainingSkip + remaining,
            signal,
          })
          for await (const chunk of chunks) {
            signal?.throwIfAborted()
            let start = 0
            if (remainingSkip > 0) {
              if (remainingSkip >= chunk.length) {
                remainingSkip -= chunk.length
                continue
              }
              start = remainingSkip
              remainingSkip = 0
            }
            const end = remaining === Infinity
              ? chunk.length
              : Math.min(chunk.length, start + remaining)
            if (start === 0 && end === chunk.length) {
              yield chunk
              remaining -= chunk.length
            } else if (end > start) {
              const slice = []
              for (let i = start; i < end; i++) slice.push(chunk[i])
              yield slice
              remaining -= slice.length
            }
            if (remaining <= 0) break
          }
        }
      },
    })
  }
  return union
}

/**
 * Whether `where` can be pushed to `source`: only when the predicate's column
 * set is fully enumerable and every column it names is present on the source.
 *
 * @param {AsyncDataSource} source
 * @param {Set<string> | null | undefined} predicateColumns
 * @returns {boolean}
 */
function canPushWhere(source, predicateColumns) {
  if (!predicateColumns) return false
  const have = new Set(source.columns)
  for (const col of predicateColumns) {
    if (!have.has(col)) return false
  }
  return true
}

/**
 * Collect the column names a `where` predicate references. Returns null when
 * the predicate contains a construct whose column set can't be safely
 * enumerated locally (a qualified identifier, subquery, or correlated
 * reference). The caller then declines to push the predicate, which is always
 * safe because the engine re-applies it.
 *
 * @param {ExprNode | undefined} where
 * @returns {Set<string> | null}
 */
function whereColumns(where) {
  /** @type {Set<string>} */
  const names = new Set()
  let enumerable = true

  /** @param {ExprNode | undefined} node */
  const walk = (node) => {
    if (!node || !enumerable) return
    switch (node.type) {
      case 'identifier':
        if (node.prefix) {
          enumerable = false
          return
        }
        names.add(node.name)
        return
      case 'literal':
      case 'interval':
      case 'star':
        return
      case 'unary':
        walk(node.argument)
        return
      case 'binary':
        walk(node.left)
        walk(node.right)
        return
      case 'cast':
        walk(node.expr)
        return
      case 'in valuelist':
        walk(node.expr)
        node.values.forEach(walk)
        return
      case 'function':
        node.args.forEach(walk)
        walk(node.filter)
        return
      case 'window':
        node.args.forEach(walk)
        node.partitionBy.forEach(walk)
        node.orderBy.forEach((o) => walk(o.expr))
        return
      case 'case':
        walk(node.caseExpr)
        for (const clause of node.whenClauses) {
          walk(clause.condition)
          walk(clause.result)
        }
        walk(node.elseResult)
        return
      default:
        // subquery / in / exists / not exists / anything new: bail.
        enumerable = false
    }
  }

  walk(where)
  return enumerable ? names : null
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
