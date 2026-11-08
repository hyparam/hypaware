// @ts-check

/**
 * @import { ScannableDataSource } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExprNode, RelationSchema } from 'squirreling'
 */

/**
 * The names of the columns a schema types as date (squirreling's TIMESTAMP).
 *
 * @param {RelationSchema | undefined} schema
 * @returns {Set<string>}
 */
export function dateColumns(schema) {
  return new Set(schema?.fields.filter((f) => f.dataType.type === 'date').map((f) => f.name) ?? [])
}

/**
 * True when the predicate compares one of `columns` with a string literal,
 * directly or in an IN list, anywhere under AND/OR/NOT.
 *
 * @param {ExprNode} node
 * @param {Set<string>} columns
 * @returns {boolean}
 */
export function comparesStringToColumn(node, columns) {
  if (!columns.size) return false
  /** @param {ExprNode} expr */
  const isColumn = (expr) => expr.type === 'identifier' && columns.has(expr.name)
  /** @param {ExprNode} expr */
  const isString = (expr) => expr.type === 'literal' && typeof expr.value === 'string'
  if (node.type === 'binary') {
    if (node.op === 'AND' || node.op === 'OR') {
      return comparesStringToColumn(node.left, columns) || comparesStringToColumn(node.right, columns)
    }
    return isColumn(node.left) && isString(node.right) || isString(node.left) && isColumn(node.right)
  }
  if (node.type === 'unary') return comparesStringToColumn(node.argument, columns)
  if (node.type === 'in valuelist') return isColumn(node.expr) && node.values.some(isString)
  return false
}

/**
 * Wrap a typed source so a WHERE that still compares a string literal with
 * one of its timestamp columns is never pushed into it. A wrapper or drifted
 * union that drops the schema can hand such a bound down untyped; the source
 * would compare Date cells to the string, match nothing, and report the
 * filter applied. Withheld, the engine evaluates it, typing the literal per
 * row. Typed bounds (squirreling's CAST) still push. A source with no
 * timestamp columns is returned unchanged.
 *
 * @param {ScannableDataSource} source
 * @returns {ScannableDataSource}
 */
export function withheldStringTimestampBounds(source) {
  const columns = dateColumns(source.schema)
  if (!columns.size) return source
  /** @param {ExprNode | undefined} where */
  const raw = (where) => where !== undefined && comparesStringToColumn(where, columns)
  /** @type {ScannableDataSource} */
  const wrapped = {
    ...source,
    scan(options) {
      if (!raw(options.where)) return source.scan(options)
      // Without a WHERE the source would claim LIMIT/OFFSET over unfiltered
      // rows, so withhold those and that claim too, and let the engine slice.
      return { ...source.scan({ ...options, where: undefined, limit: undefined, offset: undefined }), appliedLimitOffset: false }
    },
  }
  const { scanColumn, prepareScan } = source
  if (scanColumn) {
    wrapped.scanColumn = (options) => raw(options.where)
      ? scanColumn({ ...options, where: undefined, limit: undefined, offset: undefined })
      : scanColumn(options)
  }
  if (prepareScan) {
    wrapped.prepareScan = (request) => {
      if (!raw(request.filter)) return prepareScan(request)
      const prepared = prepareScan({ ...request, filter: undefined, limit: undefined, offset: undefined, topK: undefined })
      return {
        ...prepared,
        residual: { filter: request.filter, limit: request.limit, offset: request.offset },
        properties: { ...prepared.properties, exactRows: undefined },
      }
    }
  }
  return wrapped
}
