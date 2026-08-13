// @ts-check

/**
 * Convert a squirreling `WHERE` clause AST into a hyparquet
 * `ParquetQueryFilter` (a MongoDB-style predicate) so the scan can push
 * the predicate down to the parquet reader. Returns `undefined` whenever
 * the expression cannot be fully and faithfully converted. The caller
 * must then leave `appliedWhere` false and let the SQL engine filter the
 * rows itself. Note that the engine's own filter is two-valued for NULLs,
 * so declining is a correctness *fallback*, not a correctness *guarantee*:
 * on a nullable column it can still return rows SQL's three-valued logic
 * excludes, and it does so for every negation of an UNKNOWN subtree
 * (`NOT (col LIKE 'a%')` over a nullable column, issue #734). Prefer a
 * faithful filter over a decline where one exists: a predicate that is
 * UNKNOWN for every row is faithfully pushable as hyparquet's never-match
 * even though it looks like nothing worth pushing.
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
 * @ref LLP 0098 [implements]: the engine trusts `appliedWhere` and never
 * re-judges a claimed predicate, so a predicate that matches nothing is worth
 * converting rather than declining: the decline is not a no-op, it is a
 * handoff to a two-valued filter that answers the negation wrong.
 *
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
    // De Morgan: NOT (a OR b) === (NOT a) AND (NOT b), which holds in Kleene
    // three-valued logic too. The obvious `$nor` wrapper does not: hyparquet
    // evaluates it as a two-valued complement, reporting "no child matched"
    // as a match, so a row that is UNKNOWN for every disjunct sails past
    // every leaf guard. Pushing the negation into the children instead lets
    // each leaf carry its own `$ne: null`, and `$and` prunes on row-group
    // statistics where `$nor` never can.
    const leftFilter = convertExpr(left, negate)
    const rightFilter = convertExpr(right, negate)
    if (!leftFilter || !rightFilter) return undefined
    return negate ? { $and: [leftFilter, rightFilter] } : { $or: [leftFilter, rightFilter] }
  }
  const { column, value, flipped } = extractColumnAndValue(left, right)
  if (column === undefined || value === undefined) return undefined
  // A comparison against a NULL literal (`col = NULL`, `col < NULL`,
  // `NULL >= col`, `col LIKE NULL`) is UNKNOWN for every row under
  // three-valued logic: no row is TRUE, NULL rows included, and no amount of
  // negation rescues one, since `NOT UNKNOWN` is UNKNOWN. So it matches
  // nothing whatever `negate` says, which is `$in: []`, the same never-match
  // `convertInValues` pushes for `col NOT IN (…, NULL)` (see there for why
  // hyparquet reads an empty `$in` as "no row, no row group").
  //
  // Pushing beats declining even where the engine happens to agree. Its WHERE
  // is two-valued (a comparison with a NULL operand is FALSE, not UNKNOWN,
  // and unary `NOT` is JS `!`), so it answers `col = NULL` right by accident
  // and every negation of it wrong: `NOT (col = NULL)` returned every row
  // (issue #734). Pushing also prunes on row-group statistics, which the
  // fallback never can. `IS NULL`, the predicate this shape gets mistaken
  // for, goes through the unary path and is unaffected.
  //
  // Only comparisons and LIKE take this branch. Arithmetic and `||` against a
  // NULL literal are never TRUE either, but they are values rather than
  // predicates, and a WHERE made of one is exotic enough not to widen the
  // claim for.
  if (value === null) {
    if (!isComparisonOp(op) && op !== 'LIKE') return undefined
    return { [column]: { $in: [] } }
  }
  // LIKE against anything else has no parquet-filter equivalent; let the
  // engine handle it. That fallback is only NULL-correct while the LIKE is
  // not negated (issue #734 tracks the rest, which needs three-valued logic
  // in the engine itself).
  if (op === 'LIKE') return undefined

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
 * A per-leaf guard is only sound because every negation is pushed down to a
 * leaf: `convertBinary` uses De Morgan for both `AND` and `OR`, and each leaf
 * absorbs the negation itself (`mapOperator` for comparisons, `convertExpr`
 * for `IS NULL` / `IS NOT NULL`, `convertInValues` for `IN`). Any wrapper
 * that complements a subtree wholesale, such as `$nor`, evaluates two-valued
 * and hands back the rows its children left UNKNOWN, defeating the guards
 * underneath it. Keep negation at the leaves.
 *
 * @ref LLP 0098 [constrained-by]: pushdown may only claim
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
  // `col NOT IN (…, NULL)` matches no row: it is FALSE for a row equal to one
  // of the listed values and UNKNOWN for every other row (no value can be
  // proven distinct from NULL), so no row is TRUE. `$in: []` is hyparquet's
  // never-match: `matchesIn` folds an empty target list to `[].some(…)`, which
  // is false, and `canSkipStats`'s `$in` branch folds it to `[].every(…)`,
  // which is true, so every row group is skipped on statistics alone. Pushing
  // it is also what keeps the answer right: squirreling's own `WHERE` is
  // two-valued for NULLs, so handing the predicate back returns the very rows
  // it excludes.
  if (negate && values.some((value) => value === null)) return { [node.expr.name]: { $in: [] } }
  // A NULL member of a list that is NOT negated is dropped instead. It can
  // never make the disjunction TRUE (`col = NULL` is UNKNOWN for every row)
  // and the guard below already excludes NULL rows, so the row set is
  // identical either way, but carrying it costs pruning: `canSkipStats` orders
  // every `$in` member against the chunk bounds through `compareParquetValues`,
  // which returns `undefined` for a non-string against a BYTE_ARRAY bound, and
  // one undecidable member makes the whole `every` fail. A string column
  // filtered on `IN ('zz', NULL)` therefore reads every row group it could
  // have skipped. When every member is NULL the list drops to `$in: []`, which
  // is exactly what `col IN (NULL)` means. (Nothing is dropped on the negated
  // path: a negated list holding a NULL returned above.)
  const pushed = values.filter((value) => value !== null)
  return { [node.expr.name]: { $ne: null, [negate ? '$nin' : '$in']: pushed } }
}
