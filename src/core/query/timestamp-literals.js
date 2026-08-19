// @ts-check

/**
 * @import { ExprNode, SelectStatement, Statement } from 'squirreling/src/ast.js'
 * @import { QueryRegistry } from '../../../hypaware-plugin-kernel-types.js'
 */

/** Comparison operators that take an implicit literal coercion in SQL. */
const COMPARISON_OPS = new Set(['=', '==', '!=', '<>', '<', '>', '<=', '>='])

/**
 * The shapes squirreling's `toDate` (and icebird's mirror of it) accept: an
 * ISO date, optionally with a time and a zone. The separator is captured so a
 * space-separated SQL timestamp literal can be normalized to `T` before it
 * reaches either parser, which both require the `T`.
 *
 * Seconds are optional: `2026-08-18T21:00` is a legal ISO instant that both
 * evaluators already parse (each only regex-tests the `YYYY-MM-DD` prefix and
 * then hands the whole string to `new Date`), so refusing it here would turn
 * a form that works as a typed literal into an error as a bare one.
 */
const TIMESTAMP_LITERAL = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * A string literal that cannot be read as a timestamp, in a position where
 * SQL requires it to be one. Refusing is the point: the alternative is an
 * empty result set that reads as "nothing matched".
 *
 * @ref LLP 0272#refuse-uncoercible [implements]: an uncoercible literal is an error, never an empty result
 */
export class TimestampLiteralError extends Error {
  /**
   * @param {string} column
   * @param {string} literal
   */
  constructor(column, literal) {
    super(
      `cannot compare TIMESTAMP column '${column}' to the string literal ` +
      `'${literal}': a timestamp literal must look like YYYY-MM-DD, ` +
      'YYYY-MM-DDTHH:MM, YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DDTHH:MM:SSZ'
    )
    this.name = 'TimestampLiteralError'
    this.code = 'timestamp_literal_uncoercible'
    this.column = column
    this.literal = literal
  }
}

/**
 * Rewrite every bare string literal that a comparison puts opposite a
 * TIMESTAMP column into an explicit `CAST(... AS TIMESTAMP)` node, in place.
 *
 * SQL gives a character literal the type of whatever it is compared against;
 * neither the engine nor the pushdown converter does that on its own, so
 * `ts >= '2026-08-18T21:00:00Z'` compares a Date to a string. That is false
 * for every row in the engine and prunes every row group in the pushdown, so
 * the query returns nothing on data that matches (issue #860). The rewritten
 * `cast` node is the exact shape a typed literal (`TIMESTAMP '...'`) already
 * parses to, which both evaluators fold identically.
 *
 * @param {Statement} statement parsed by squirreling; mutated in place
 * @param {QueryRegistry} registry
 * @returns {Statement} the same statement, for call-site convenience
 * @ref LLP 0272 [implements]: string literals are typed by the column they are compared against, before the pushdown sees them
 */
export function coerceTimestampLiterals(statement, registry) {
  rewriteStatement(statement, registry, new Set())
  return statement
}

/**
 * @param {Statement} statement
 * @param {QueryRegistry} registry
 * @param {Set<string>} shadowed table names bound to a CTE rather than a dataset
 */
function rewriteStatement(statement, registry, shadowed) {
  if (statement.type === 'with') {
    // A CTE is visible to its siblings that follow it and to the outer query,
    // and it shadows any dataset of the same name. Held lower-cased because
    // squirreling resolves a CTE reference case-insensitively (it keys its CTE
    // plans by `name.toLowerCase()`): a case-sensitive shadow set would let
    // `WITH Msgs ... FROM msgs` borrow a dataset's schema for columns the CTE
    // actually supplies.
    const inner = new Set(shadowed)
    for (const cte of statement.ctes) {
      rewriteStatement(cte.query, registry, inner)
      inner.add(cte.name.toLowerCase())
    }
    rewriteStatement(statement.query, registry, inner)
    return
  }
  if (statement.type === 'compound') {
    rewriteStatement(statement.left, registry, shadowed)
    rewriteStatement(statement.right, registry, shadowed)
    return
  }
  rewriteSelect(statement, registry, shadowed)
}

/**
 * @param {SelectStatement} select
 * @param {QueryRegistry} registry
 * @param {Set<string>} shadowed
 */
function rewriteSelect(select, registry, shadowed) {
  // Nested scopes first: each one resolves its own columns against its own
  // FROM, so a subquery never borrows this select's types.
  if (select.from?.type === 'subquery') rewriteStatement(select.from.query, registry, shadowed)
  for (const join of select.joins) {
    if (join.subquery) rewriteStatement(join.subquery.query, registry, shadowed)
  }
  const exprs = selectExprs(select)
  for (const expr of exprs) rewriteExprStatements(expr, registry, shadowed)

  // Every clause this select holds, not just WHERE: the same
  // Date-against-string comparison is false for every row wherever it sits,
  // so `select case when ts > '...' then 1 end` and `order by ts > '...'`
  // fail the same silent way the reported WHERE did.
  const scope = timestampScope(select, registry, shadowed)
  if (scope.agreed.size > 0) {
    for (const expr of exprs) rewriteExpr(expr, scope)
  }
}

/**
 * Every expression this select holds directly, in any clause. Used to reach
 * the nested statements they carry, wherever they sit.
 *
 * @param {SelectStatement} select
 * @returns {ExprNode[]}
 */
function selectExprs(select) {
  /** @type {ExprNode[]} */
  const exprs = []
  for (const column of select.columns) {
    if (column.type === 'derived') exprs.push(column.expr)
  }
  if (select.where) exprs.push(select.where)
  if (select.having) exprs.push(select.having)
  exprs.push(...select.groupBy)
  for (const item of select.orderBy) exprs.push(item.expr)
  for (const join of select.joins) {
    if (join.on) exprs.push(join.on)
    if (join.fromFunction) exprs.push(...join.fromFunction.args)
  }
  if (select.from?.type === 'function') exprs.push(...select.from.args)
  return exprs
}

/**
 * The TIMESTAMP columns this select's base tables declare, two ways: the
 * names every base table in scope agrees are TIMESTAMP (for an unqualified
 * reference), and the names each base table declares under its own name and
 * alias (for a qualified one). A name two tables type differently is dropped
 * rather than guessed at, and a relation the registry cannot name at all (a
 * derived table, a CTE, a table function) contributes nothing, so `s.ts`
 * against such a relation is never typed from an unrelated dataset that
 * happens to share the column name: a wrong coercion returns wrong rows,
 * which is the failure this exists to end.
 *
 * @param {SelectStatement} select
 * @param {QueryRegistry} registry
 * @param {Set<string>} shadowed
 * @returns {{ agreed: Set<string>, byRelation: Map<string, Set<string>> }}
 */
function timestampScope(select, registry, shadowed) {
  /** @type {{ table: string, alias?: string }[]} */
  const tables = []
  if (select.from?.type === 'table') tables.push({ table: select.from.table, alias: select.from.alias })
  for (const join of select.joins) {
    if (join.table && !join.subquery && !join.fromFunction) tables.push({ table: join.table, alias: join.alias })
  }

  /** @type {Map<string, boolean>} */
  const seenTypes = new Map()
  /** @type {Map<string, Set<string>>} */
  const byRelation = new Map()
  for (const { table, alias } of tables) {
    if (shadowed.has(table.toLowerCase())) continue
    // `?.columns` rather than a bare deref: a registration that hands the
    // kernel a malformed schema must not turn every query touching it into a
    // TypeError, the same way `hyp backfill` reads it.
    const columns = registry.getDataset(table)?.schema?.columns
    if (!columns) continue
    /** @type {Set<string>} */
    const declared = new Set()
    for (const column of columns) {
      const isTimestamp = column.type === 'TIMESTAMP'
      if (isTimestamp) declared.add(column.name)
      const seen = seenTypes.get(column.name)
      seenTypes.set(column.name, seen === undefined ? isTimestamp : seen && isTimestamp)
    }
    byRelation.set(table.toLowerCase(), declared)
    if (alias) byRelation.set(alias.toLowerCase(), declared)
  }

  /** @type {Set<string>} */
  const agreed = new Set()
  for (const [name, isTimestamp] of seenTypes) {
    if (isTimestamp) agreed.add(name)
  }
  return { agreed, byRelation }
}

/**
 * Nested statements an expression can carry. Each resolves against its own
 * FROM, so it is rewritten as a statement rather than with the enclosing
 * select's columns.
 *
 * @param {ExprNode} node
 * @param {QueryRegistry} registry
 * @param {Set<string>} shadowed
 */
function rewriteExprStatements(node, registry, shadowed) {
  if (node.type === 'in') {
    rewriteExprStatements(node.expr, registry, shadowed)
    rewriteStatement(node.subquery, registry, shadowed)
    return
  }
  if (node.type === 'subquery' || node.type === 'exists' || node.type === 'not exists') {
    rewriteStatement(node.subquery, registry, shadowed)
    return
  }
  for (const child of childExprs(node)) rewriteExprStatements(child, registry, shadowed)
}

/**
 * @param {ExprNode} node
 * @param {{ agreed: Set<string>, byRelation: Map<string, Set<string>> }} scope
 */
function rewriteExpr(node, scope) {
  if (node.type === 'binary' && COMPARISON_OPS.has(node.op)) {
    const column = timestampOperand(node.left, scope)
    if (column) node.right = coerceOperand(node.right, column)
    else {
      const flipped = timestampOperand(node.right, scope)
      if (flipped) node.left = coerceOperand(node.left, flipped)
    }
  }
  if (node.type === 'in valuelist') {
    const column = timestampOperand(node.expr, scope)
    if (column) node.values = node.values.map((value) => coerceOperand(value, column))
  }
  // A nested statement is skipped here on purpose: its columns resolve against
  // its own FROM, so `rewriteExprStatements` types it in its own scope rather
  // than borrowing this select's.
  for (const child of childExprs(node)) rewriteExpr(child, scope)
}

/**
 * Every child expression of a node, excluding nested statements. Both walks
 * share it so a node shape can only be missed once, not twice.
 *
 * @param {ExprNode} node
 * @returns {ExprNode[]}
 */
function childExprs(node) {
  if (node.type === 'binary') return [node.left, node.right]
  if (node.type === 'unary') return [node.argument]
  if (node.type === 'cast') return [node.expr]
  if (node.type === 'subscript') return [node.expr, node.index]
  if (node.type === 'in valuelist') return [node.expr, ...node.values]
  if (node.type === 'in') return [node.expr]
  if (node.type === 'window') return [...node.args, ...node.partitionBy, ...node.orderBy.map((o) => o.expr)]
  if (node.type === 'function') return node.filter ? [...node.args, node.filter] : [...node.args]
  if (node.type === 'case') {
    /** @type {ExprNode[]} */
    const children = node.caseExpr ? [node.caseExpr] : []
    for (const when of node.whenClauses) children.push(when.condition, when.result)
    if (node.elseResult) children.push(node.elseResult)
    return children
  }
  return []
}

/**
 * The column name if this operand is a reference to a TIMESTAMP column in
 * scope, otherwise undefined. A qualified reference is resolved through its
 * qualifier, so `s.message_created_at` against a joined derived table stays a
 * string comparison even when a base table in the same scope declares that
 * name TIMESTAMP; an unqualified one falls back to the names every base table
 * agrees on.
 *
 * @param {ExprNode} node
 * @param {{ agreed: Set<string>, byRelation: Map<string, Set<string>> }} scope
 * @returns {string | undefined}
 */
function timestampOperand(node, scope) {
  if (node.type !== 'identifier') return undefined
  if (node.prefix !== undefined) {
    return scope.byRelation.get(node.prefix.toLowerCase())?.has(node.name) ? node.name : undefined
  }
  return scope.agreed.has(node.name) ? node.name : undefined
}

/**
 * @param {ExprNode} operand
 * @param {string} column
 * @returns {ExprNode}
 */
function coerceOperand(operand, column) {
  if (operand.type !== 'literal' || typeof operand.value !== 'string') return operand
  const normalized = normalizeTimestampLiteral(operand.value)
  if (normalized === undefined) throw new TimestampLiteralError(column, operand.value)
  return {
    type: 'cast',
    toType: 'TIMESTAMP',
    expr: { ...operand, value: normalized },
    positionStart: operand.positionStart,
    positionEnd: operand.positionEnd,
  }
}

/**
 * Normalize a timestamp literal to the form both evaluators parse, or
 * undefined when it is not one. `2026-08-18 21:00:00` is ordinary SQL but
 * neither parser accepts the space, so the separator is rewritten here rather
 * than refused.
 *
 * @param {string} value
 * @returns {string | undefined}
 */
export function normalizeTimestampLiteral(value) {
  const match = TIMESTAMP_LITERAL.exec(value.trim())
  if (!match) return undefined
  const [, day, time, zone] = match
  const normalized = time === undefined ? day : `${day}T${time}${zone ?? ''}`
  return Number.isNaN(new Date(normalized).getTime()) ? undefined : normalized
}
