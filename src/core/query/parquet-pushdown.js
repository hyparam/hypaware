// @ts-check

/**
 * Convert a squirreling `WHERE` clause AST into a hyparquet
 * `ParquetQueryFilter` (a MongoDB-style predicate) so the scan can push
 * the predicate down to the parquet reader. Returns `undefined` whenever
 * the expression cannot be fully and faithfully converted. The caller
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
    // un-negated and the wrapper carries the negation, propagating
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
  // A comparison against a NULL literal (`col = NULL`, `col < NULL`) is
  // UNKNOWN for every row under three-valued logic, so it matches nothing,
  // NULL rows included. No hyparquet operator says "never match", so hand
  // the predicate back to the engine rather than push a filter that would
  // read as `IS NULL`. `IS NULL` itself goes through the unary path.
  if (value === null) return undefined

  const mongoOp = mapOperator(op, flipped, negate)
  if (!mongoOp) return undefined
  return guardNulls(column, mongoOp, value)
}

/**
 * Add the NULL guard a relational or inequality operator needs.
 *
 * hyparquet's `matchFilter` evaluates `$lt`/`$lte`/`$gt`/`$gte` with raw
 * JavaScript relational operators, which coerce a NULL column value to `0`:
 * `null <= 300n` and `null > -400n` are both true, so NULL rows sail past a
 * bare bound (`>` and `>=` only look safe because a positive bound beats 0).
 * `$ne` negates a failed equality, so NULL passes it too. SQL three-valued
 * logic rejects every one of those rows. `convertInValues` applies the same
 * guard to `$in`/`$nin` for the same reason.
 *
 * The guard is a `$ne: null` conjunct, and it rides inside the same condition
 * object rather than an outer `$and` because `canSkipRowGroup` and
 * `filterPageRanges` disable statistics pruning for any condition a NULL
 * value could satisfy: a bare `{col: {$lte: v}}` reads as NULL-matching and
 * forfeits row-group and page skipping on every chunk holding a NULL, and so
 * does `{$and: [{col: {$ne: null}}, {col: {$lte: v}}]}`, whose bound is still
 * bare inside its own branch. `{col: {$ne: null, $lte: v}}` prunes.
 *
 * `$ne` is the one operator whose guard key collides with its own, so it
 * takes the `$and` form. That costs no pruning in practice: hyparquet only
 * skips on `$ne` when a chunk is constant at the excluded value, and it
 * already declines to skip such a chunk once the column has NULLs in it.
 *
 * `$eq` needs no guard: `equals(null, <non-null>)` is already false, and
 * `$eq: null` is exactly how the `IS NULL` path spells itself.
 *
 * @ref LLP 0098#wrapper-duties [constrained-by]: pushdown may only claim
 * `appliedWhere` for a filter that is faithful to SQL semantics; the engine
 * never re-filters a claimed predicate, so a leak here is a wrong answer.
 *
 * @param {string} column
 * @param {'$lt' | '$lte' | '$gt' | '$gte' | '$eq' | '$ne'} mongoOp
 * @param {SqlPrimitive} value
 * @returns {ParquetQueryFilter}
 */
function guardNulls(column, mongoOp, value) {
  if (mongoOp === '$eq') return { [column]: { $eq: value } }
  if (mongoOp === '$ne') return { $and: [{ [column]: { $ne: null } }, { [column]: { $ne: value } }] }
  return { [column]: { $ne: null, [mongoOp]: value } }
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
  // `col NOT IN (…, NULL)` is UNKNOWN for every row: no value can be proven
  // distinct from NULL, so the predicate matches nothing. Unexpressible as a
  // hyparquet operator, so the engine keeps it. (`col IN (…, NULL)` is fine:
  // the NULL entry can never make the disjunction true, and the `$ne: null`
  // guard below stops it from matching NULL rows.)
  if (negate && values.some((value) => value === null)) return undefined
  return { [node.expr.name]: { $ne: null, [negate ? '$nin' : '$in']: values } }
}
