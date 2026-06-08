// @ts-check

/**
 * Convert a squirreling `WHERE` clause AST into a hyparquet
 * `ParquetQueryFilter` (a MongoDB-style predicate) so the scan can push
 * the predicate down to the parquet reader. Returns `undefined` whenever
 * the expression cannot be fully and faithfully converted — the caller
 * must then leave `appliedWhere` false and let the SQL engine filter the
 * rows itself.
 *
 * Ported from the Hyperparam app (`lib/tools/parquetPushdownFilter.ts`),
 * which drives the same squirreling + hyparquet stack. The node-type
 * discriminants match `squirreling@0.12` (`unary`, `binary`,
 * `in valuelist`, `cast`, `identifier`, `literal`).
 *
 * @import { BinaryNode, BinaryOp, ComparisonOp, ExprNode, InValuesNode, SqlPrimitive } from 'squirreling/src/types.js'
 * @import { ParquetQueryFilter } from 'hyparquet'
 */

/**
 * @param {ExprNode | undefined} where
 * @returns {ParquetQueryFilter | undefined}
 */
export function whereToParquetFilter(where) {
  if (!where) return undefined
  return convertExpr(where, false)
}

/**
 * @param {ExprNode} node
 * @param {boolean} negate
 * @returns {ParquetQueryFilter | undefined}
 */
function convertExpr(node, negate) {
  if (node.type === 'unary' && node.op === 'NOT') {
    return convertExpr(node.argument, !negate)
  }
  if (node.type === 'unary' && (node.op === 'IS NULL' || node.op === 'IS NOT NULL')) {
    if (node.argument.type !== 'identifier') return undefined
    const isNull = (node.op === 'IS NULL') !== negate
    return { [node.argument.name]: { [isNull ? '$eq' : '$ne']: null } }
  }
  if (node.type === 'binary') {
    return convertBinary(node, negate)
  }
  if (node.type === 'in valuelist') {
    return convertInValues(node, negate)
  }
  if (node.type === 'cast') {
    return convertExpr(node.expr, negate)
  }
  // Non-convertible node types (functions, subqueries, CASE, …) fall
  // through to undefined so the engine applies the predicate itself.
  return undefined
}

/**
 * @param {BinaryNode} node
 * @param {boolean} negate
 * @returns {ParquetQueryFilter | undefined}
 */
function convertBinary(node, negate) {
  const { op, left, right } = node
  if (op === 'AND') {
    const leftFilter = convertExpr(left, negate)
    const rightFilter = convertExpr(right, negate)
    if (!leftFilter || !rightFilter) return undefined
    // De Morgan: NOT (a AND b) === (NOT a) OR (NOT b)
    return negate ? { $or: [leftFilter, rightFilter] } : { $and: [leftFilter, rightFilter] }
  }
  if (op === 'OR') {
    // `$nor` already expresses NOT(a OR b), so the children are converted
    // un-negated and the wrapper carries the negation — propagating
    // `negate` into them as well would double-negate.
    const leftFilter = convertExpr(left, false)
    const rightFilter = convertExpr(right, false)
    if (!leftFilter || !rightFilter) return undefined
    return negate ? { $nor: [leftFilter, rightFilter] } : { $or: [leftFilter, rightFilter] }
  }
  // LIKE has no parquet-filter equivalent; let the engine handle it.
  if (op === 'LIKE') return undefined

  const { column, value, flipped } = extractColumnAndValue(left, right)
  if (column === undefined || value === undefined) return undefined

  const mongoOp = mapOperator(op, flipped, negate)
  if (!mongoOp) return undefined
  return { [column]: { [mongoOp]: value } }
}

/**
 * Pull a `column op literal` (or `literal op column`) shape out of a
 * binary node's operands. Returns `flipped: true` when the literal was
 * on the left so the caller can mirror the comparison operator.
 *
 * @param {ExprNode} left
 * @param {ExprNode} right
 * @returns {{ column: string | undefined, value: SqlPrimitive | undefined, flipped: boolean }}
 */
function extractColumnAndValue(left, right) {
  if (left.type === 'identifier' && right.type === 'literal') {
    return { column: left.name, value: coerceBigInt(right.value), flipped: false }
  }
  if (left.type === 'literal' && right.type === 'identifier') {
    return { column: right.name, value: coerceBigInt(left.value), flipped: true }
  }
  return { column: undefined, value: undefined, flipped: false }
}

/**
 * @param {BinaryOp} op
 * @param {boolean} flipped
 * @param {boolean} negate
 * @returns {'$lt' | '$lte' | '$gt' | '$gte' | '$eq' | '$ne' | undefined}
 */
function mapOperator(op, flipped, negate) {
  if (!isComparisonOp(op)) return undefined
  let mapped = op
  if (negate) mapped = neg(mapped)
  if (flipped) mapped = flip(mapped)
  if (mapped === '<') return '$lt'
  if (mapped === '<=') return '$lte'
  if (mapped === '>') return '$gt'
  if (mapped === '>=') return '$gte'
  if (mapped === '=' || mapped === '==') return '$eq'
  return '$ne'
}

/**
 * @param {ComparisonOp} op
 * @returns {ComparisonOp}
 */
function neg(op) {
  if (op === '<') return '>='
  if (op === '<=') return '>'
  if (op === '>') return '<='
  if (op === '>=') return '<'
  if (op === '=' || op === '==') return '!='
  // negation of `!=` / `<>` is equality
  return '='
}

/**
 * @param {ComparisonOp} op
 * @returns {ComparisonOp}
 */
function flip(op) {
  if (op === '<') return '>'
  if (op === '<=') return '>='
  if (op === '>') return '<'
  if (op === '>=') return '<='
  return op
}

/**
 * @param {string} op
 * @returns {op is ComparisonOp}
 */
function isComparisonOp(op) {
  return op === '=' || op === '==' || op === '!=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>='
}

/**
 * Coerce integer literals to `bigint` so they compare equal to parquet
 * INT64 columns, which hyparquet decodes as `bigint`. Non-integer and
 * non-number values pass through unchanged.
 *
 * @param {SqlPrimitive} value
 * @returns {SqlPrimitive}
 */
function coerceBigInt(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
  return value
}

/**
 * @param {InValuesNode} node
 * @param {boolean} negate
 * @returns {ParquetQueryFilter | undefined}
 */
function convertInValues(node, negate) {
  if (node.expr.type !== 'identifier') return undefined
  /** @type {SqlPrimitive[]} */
  const values = []
  for (const val of node.values) {
    if (val.type !== 'literal') return undefined
    values.push(coerceBigInt(val.value))
  }
  return { [node.expr.name]: { [negate ? '$nin' : '$in']: values } }
}
