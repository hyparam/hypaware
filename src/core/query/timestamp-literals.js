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
 */
const TIMESTAMP_LITERAL = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2})?)?$/

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
      'YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DDTHH:MM:SSZ'
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
    // and it shadows any dataset of the same name.
    const inner = new Set(shadowed)
    for (const cte of statement.ctes) {
      rewriteStatement(cte.query, registry, inner)
      inner.add(cte.name)
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
  for (const expr of selectExprs(select)) rewriteExprStatements(expr, registry, shadowed)

  const timestampColumns = timestampColumnsInScope(select, registry, shadowed)
  if (timestampColumns.size > 0) {
    if (select.where) rewriteExpr(select.where, timestampColumns)
    if (select.having) rewriteExpr(select.having, timestampColumns)
    for (const join of select.joins) {
      if (join.on) rewriteExpr(join.on, timestampColumns)
    }
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
 * Column names this select's base tables agree are TIMESTAMP. A name two
 * tables in scope type differently is dropped rather than guessed at: a wrong
 * coercion returns wrong rows, which is the failure this exists to end.
 *
 * @param {SelectStatement} select
 * @param {QueryRegistry} registry
 * @param {Set<string>} shadowed
 * @returns {Set<string>}
 */
function timestampColumnsInScope(select, registry, shadowed) {
  /** @type {string[]} */
  const tables = []
  if (select.from?.type === 'table') tables.push(select.from.table)
  for (const join of select.joins) {
    if (join.table && !join.subquery && !join.fromFunction) tables.push(join.table)
  }

  /** @type {Map<string, boolean>} */
  const agreed = new Map()
  for (const table of tables) {
    if (shadowed.has(table)) continue
    const schema = registry.getDataset(table)?.schema
    if (!schema) continue
    for (const column of schema.columns) {
      const isTimestamp = column.type === 'TIMESTAMP'
      const seen = agreed.get(column.name)
      agreed.set(column.name, seen === undefined ? isTimestamp : seen && isTimestamp)
    }
  }

  /** @type {Set<string>} */
  const names = new Set()
  for (const [name, isTimestamp] of agreed) {
    if (isTimestamp) names.add(name)
  }
  return names
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
 * @param {Set<string>} timestampColumns
 */
function rewriteExpr(node, timestampColumns) {
  if (node.type === 'binary' && COMPARISON_OPS.has(node.op)) {
    const column = timestampOperand(node.left, timestampColumns)
    if (column) node.right = coerceOperand(node.right, column)
    else {
      const flipped = timestampOperand(node.right, timestampColumns)
      if (flipped) node.left = coerceOperand(node.left, flipped)
    }
  }
  if (node.type === 'in valuelist') {
    const column = timestampOperand(node.expr, timestampColumns)
    if (column) node.values = node.values.map((value) => coerceOperand(value, column))
  }
  // A nested statement is skipped here on purpose: its columns resolve against
  // its own FROM, so `rewriteExprStatements` types it in its own scope rather
  // than borrowing this select's.
  for (const child of childExprs(node)) rewriteExpr(child, timestampColumns)
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
 * The column name if this operand is a bare reference to a TIMESTAMP column
 * in scope, otherwise undefined. A qualified reference matches on its bare
 * name: aliases are not resolved here, and the scope set already required
 * every table in scope to agree on the type.
 *
 * @param {ExprNode} node
 * @param {Set<string>} timestampColumns
 * @returns {string | undefined}
 */
function timestampOperand(node, timestampColumns) {
  if (node.type !== 'identifier') return undefined
  return timestampColumns.has(node.name) ? node.name : undefined
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
