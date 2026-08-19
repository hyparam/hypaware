// @ts-check

/**
 * @import { ExprNode, SelectStatement, Statement } from 'squirreling/src/ast.js'
 * @import { QueryRegistry } from '../../../hypaware-plugin-kernel-types.js'
 * @import { TimestampScope } from '../../../src/core/query/types.js'
 */

/** Comparison operators that take an implicit literal coercion in SQL. */
const COMPARISON_OPS = new Set(['=', '==', '!=', '<>', '<', '>', '<=', '>='])

/**
 * Calls whose result carries the type of an argument, and which argument
 * positions carry it. `undefined` means every argument does. A bound written
 * on such a call is a bound on the column underneath it, and it fails the
 * same silent way a bare column did: `having max(message_created_at) >= '...'`
 * is the idiom `docs/ACCEPTANCE.md` itself uses, and `HAVING` almost always
 * holds an aggregate rather than a bare reference.
 *
 * Positions matter. `min_by(value, key)` takes only `value`'s type, so typing
 * a literal from `key` would coerce it against the wrong column, which is the
 * wrong-rows failure this rewrite exists to avoid. Functions that change the
 * type (`epoch`, `extract`, `date_diff`, `cast`) are absent on purpose.
 *
 * @type {Map<string, number[] | undefined>}
 * @ref LLP 0272#scope [implements]: a bound on a type-preserving call is a bound on the column under it
 */
const TYPE_PRESERVING_ARGS = new Map([
  ['MIN', undefined],
  ['MAX', undefined],
  ['ANY_VALUE', undefined],
  ['COALESCE', undefined],
  ['NULLIF', undefined],
  ['GREATEST', undefined],
  ['LEAST', undefined],
  ['MIN_BY', [0]],
  ['ARG_MIN', [0]],
  ['MAX_BY', [0]],
  ['ARG_MAX', [0]],
  ['LAG', [0, 2]],
  ['LEAD', [0, 2]],
  ['DATE_TRUNC', [1]],
])

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
  rewriteStatement(statement, registry, new Set(), undefined)
  return statement
}

/**
 * @param {Statement} statement
 * @param {QueryRegistry} registry
 * @param {Set<string>} shadowed table names bound to a CTE rather than a dataset
 * @param {TimestampScope | undefined} outer enclosing scope, for a correlated reference
 */
function rewriteStatement(statement, registry, shadowed, outer) {
  if (statement.type === 'with') {
    // A CTE is visible to its siblings that follow it and to the outer query,
    // and it shadows any dataset of the same name. Held lower-cased because
    // squirreling resolves a CTE reference case-insensitively (it keys its CTE
    // plans by `name.toLowerCase()`): a case-sensitive shadow set would let
    // `WITH Msgs ... FROM msgs` borrow a dataset's schema for columns the CTE
    // actually supplies.
    const inner = new Set(shadowed)
    for (const cte of statement.ctes) {
      // A CTE body cannot reference the query it is attached to, so it never
      // inherits the correlated scope the attached query may have.
      rewriteStatement(cte.query, registry, inner, undefined)
      inner.add(cte.name.toLowerCase())
    }
    rewriteStatement(statement.query, registry, inner, outer)
    return
  }
  if (statement.type === 'compound') {
    rewriteStatement(statement.left, registry, shadowed, outer)
    rewriteStatement(statement.right, registry, shadowed, outer)
    return
  }
  rewriteSelect(statement, registry, shadowed, outer)
}

/**
 * @param {SelectStatement} select
 * @param {QueryRegistry} registry
 * @param {Set<string>} shadowed
 * @param {TimestampScope | undefined} outer
 */
function rewriteSelect(select, registry, shadowed, outer) {
  const scope = timestampScope(select, registry, shadowed, outer)

  // Nested scopes first. A relation in FROM or JOIN resolves entirely against
  // its own tables and cannot see this select's, so it gets no outer scope; a
  // subquery in expression position can be correlated, so it gets this one.
  if (select.from?.type === 'subquery') rewriteStatement(select.from.query, registry, shadowed, undefined)
  for (const join of select.joins) {
    if (join.subquery) rewriteStatement(join.subquery.query, registry, shadowed, undefined)
  }
  const exprs = selectExprs(select)
  for (const expr of exprs) rewriteExprStatements(expr, registry, shadowed, scope)

  // Every clause this select holds, not just WHERE: the same
  // Date-against-string comparison is false for every row wherever it sits,
  // so `select case when ts > '...' then 1 end` and `order by ts > '...'`
  // fail the same silent way the reported WHERE did.
  //
  // Unconditionally: a select whose own tables declare no TIMESTAMP (or whose
  // in-scope tables contradict each other, emptying `agreed`) can still hold a
  // qualified reference into a relation that does, or a correlated one into an
  // enclosing scope. `rewriteExpr` is a no-op when nothing resolves.
  for (const expr of exprs) rewriteExpr(expr, scope)
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
 * Every relation is still recorded in `bound`, schema or not, so a qualifier
 * this select binds stops the correlated walk into `outer` instead of
 * borrowing an enclosing relation that happens to share the alias.
 *
 * @param {SelectStatement} select
 * @param {QueryRegistry} registry
 * @param {Set<string>} shadowed
 * @param {TimestampScope | undefined} outer
 * @returns {TimestampScope}
 */
function timestampScope(select, registry, shadowed, outer) {
  /** @type {{ table: string, alias?: string }[]} */
  const tables = []
  /** @type {Set<string>} */
  const bound = new Set()
  /** @param {string | undefined} name */
  const bind = (name) => {
    if (name) bound.add(name.toLowerCase())
  }
  if (select.from?.type === 'table') {
    tables.push({ table: select.from.table, alias: select.from.alias })
  } else if (select.from) {
    bind(select.from.alias)
  }
  for (const join of select.joins) {
    if (join.table && !join.subquery && !join.fromFunction) {
      tables.push({ table: join.table, alias: join.alias })
    } else {
      bind(join.alias)
      bind(join.subquery?.alias)
      bind(join.fromFunction?.alias)
    }
  }
  for (const { table, alias } of tables) {
    bind(table)
    bind(alias)
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
  return { agreed, byRelation, bound, outer }
}

/**
 * Nested statements an expression can carry. Each resolves against its own
 * FROM first, with the enclosing scope behind it for a correlated reference.
 *
 * @param {ExprNode} node
 * @param {QueryRegistry} registry
 * @param {Set<string>} shadowed
 * @param {TimestampScope} scope the enclosing select's scope
 */
function rewriteExprStatements(node, registry, shadowed, scope) {
  if (node.type === 'in') {
    rewriteExprStatements(node.expr, registry, shadowed, scope)
    rewriteStatement(node.subquery, registry, shadowed, scope)
    return
  }
  if (node.type === 'subquery' || node.type === 'exists' || node.type === 'not exists') {
    rewriteStatement(node.subquery, registry, shadowed, scope)
    return
  }
  for (const child of childExprs(node)) rewriteExprStatements(child, registry, shadowed, scope)
}

/**
 * @param {ExprNode} node
 * @param {TimestampScope} scope
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
 * The column name if this operand carries the type of a TIMESTAMP column in
 * scope, otherwise undefined. A qualified reference is resolved through its
 * qualifier, so `s.message_created_at` against a joined derived table stays a
 * string comparison even when a base table in the same scope declares that
 * name TIMESTAMP; an unqualified one falls back to the names every base table
 * agrees on. A type-preserving call is looked through to the argument that
 * carries its type, so `max(ts)` types like `ts` does.
 *
 * @param {ExprNode} node
 * @param {TimestampScope} scope
 * @returns {string | undefined}
 */
function timestampOperand(node, scope) {
  if (node.type === 'identifier') {
    if (node.prefix === undefined) return scope.agreed.has(node.name) ? node.name : undefined
    return qualifiedIsTimestamp(node.prefix.toLowerCase(), node.name, scope) ? node.name : undefined
  }
  if (node.type === 'function' || node.type === 'window') {
    for (const arg of typeCarryingArgs(node.funcName, node.args)) {
      const column = timestampOperand(arg, scope)
      if (column) return column
    }
  }
  return undefined
}

/**
 * The arguments whose type this call's result takes, empty when the call is
 * not type-preserving.
 *
 * @param {string} funcName
 * @param {ExprNode[]} args
 * @returns {ExprNode[]}
 */
function typeCarryingArgs(funcName, args) {
  const name = funcName.toUpperCase()
  if (!TYPE_PRESERVING_ARGS.has(name)) return []
  const positions = TYPE_PRESERVING_ARGS.get(name)
  if (!positions) return args
  return positions.map((index) => args[index]).filter((arg) => arg !== undefined)
}

/**
 * Whether a qualified reference names a TIMESTAMP column, resolved through
 * the scope chain: this select's relations first, then the enclosing ones,
 * which is how SQL resolves a correlated reference from inside an `EXISTS`
 * or `IN` subquery. A qualifier this select binds ends the walk even when its
 * schema is unknown (a CTE, a derived table), so an inner alias never borrows
 * an enclosing relation that happens to share its name.
 *
 * @param {string} prefix lower-cased qualifier
 * @param {string} name
 * @param {TimestampScope} scope
 * @returns {boolean}
 * @ref LLP 0272#scope [implements]: a qualified reference resolves through its qualifier, outward
 */
function qualifiedIsTimestamp(prefix, name, scope) {
  /** @type {TimestampScope | undefined} */
  let current = scope
  while (current !== undefined) {
    const declared = current.byRelation.get(prefix)
    if (declared) return declared.has(name)
    if (current.bound.has(prefix)) return false
    current = current.outer
  }
  return false
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
