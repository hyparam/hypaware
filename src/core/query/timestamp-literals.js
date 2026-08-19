// @ts-check

/**
 * @import { ExprNode, SelectStatement, Statement } from 'squirreling/src/ast.js'
 * @import { QueryRegistry } from '../../../hypaware-plugin-kernel-types.js'
 * @import { InferredColumn, RelationRef, TimestampScope } from '../../../src/core/query/types.js'
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
  rewriteStatement(statement, registry, new Map(), undefined)
  return statement
}

/**
 * @param {Statement} statement
 * @param {QueryRegistry} registry
 * @param {Map<string, InferredColumn[] | undefined>} ctes table names bound to a CTE rather than a dataset, each mapped to the columns its body was proved to expose (absent value: not provable)
 * @param {TimestampScope | undefined} outer enclosing scope, for a correlated reference
 */
function rewriteStatement(statement, registry, ctes, outer) {
  if (statement.type === 'with') {
    // A CTE is visible to its siblings that follow it and to the outer query,
    // and it shadows any dataset of the same name. Held lower-cased because
    // squirreling resolves a CTE reference case-insensitively (it keys its CTE
    // plans by `name.toLowerCase()`): a case-sensitive shadow set would let
    // `WITH Msgs ... FROM msgs` borrow a dataset's schema for columns the CTE
    // actually supplies.
    const inner = new Map(ctes)
    for (const cte of statement.ctes) {
      // A CTE body cannot reference the query it is attached to, so it never
      // inherits the correlated scope the attached query may have.
      rewriteStatement(cte.query, registry, inner, undefined)
      inner.set(cte.name.toLowerCase(), inferColumns(cte.query, registry, inner))
    }
    rewriteStatement(statement.query, registry, inner, outer)
    return
  }
  if (statement.type === 'compound') {
    rewriteStatement(statement.left, registry, ctes, outer)
    rewriteStatement(statement.right, registry, ctes, outer)
    return
  }
  rewriteSelect(statement, registry, ctes, outer)
}

/**
 * @param {SelectStatement} select
 * @param {QueryRegistry} registry
 * @param {Map<string, InferredColumn[] | undefined>} ctes
 * @param {TimestampScope | undefined} outer
 */
function rewriteSelect(select, registry, ctes, outer) {
  const scope = timestampScope(select, registry, ctes, outer)

  // Nested scopes first. A relation in FROM or JOIN resolves entirely against
  // its own tables and cannot see this select's, so it gets no outer scope; a
  // subquery in expression position can be correlated, so it gets this one.
  if (select.from?.type === 'subquery') rewriteStatement(select.from.query, registry, ctes, undefined)
  for (const join of select.joins) {
    if (join.subquery) rewriteStatement(join.subquery.query, registry, ctes, undefined)
  }
  const exprs = selectExprs(select)
  for (const expr of exprs) rewriteExprStatements(expr, registry, ctes, scope)

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
 * Every relation this select binds, in FROM-then-JOIN order, which is the
 * order a `SELECT *` expands them in. A relation is one of three things: a
 * name (a dataset or a CTE), an inner select (a derived table), or neither (a
 * table function, whose columns nothing here can enumerate).
 *
 * @param {SelectStatement} select
 * @returns {RelationRef[]}
 */
function selectRelations(select) {
  /** @type {RelationRef[]} */
  const relations = []
  const from = select.from
  if (from?.type === 'table') relations.push({ table: from.table, alias: from.alias })
  else if (from?.type === 'subquery') relations.push({ query: from.query, alias: from.alias })
  else if (from) relations.push({ alias: from.alias })
  for (const join of select.joins) {
    if (join.subquery) relations.push({ query: join.subquery.query, alias: join.subquery.alias ?? join.alias })
    else if (join.fromFunction) relations.push({ alias: join.fromFunction.alias ?? join.alias })
    else if (join.table) relations.push({ table: join.table, alias: join.alias })
    else relations.push({ alias: join.alias })
  }
  return relations
}

/**
 * The names a reference can qualify this relation by, lower-cased.
 *
 * @param {RelationRef} relation
 * @returns {string[]}
 */
function relationKeys(relation) {
  /** @type {string[]} */
  const keys = []
  if (relation.table) keys.push(relation.table.toLowerCase())
  if (relation.alias) keys.push(relation.alias.toLowerCase())
  return keys
}

/**
 * The columns a relation exposes, or undefined when they cannot all be read.
 * A dataset answers from its declared schema; a CTE answers from what its body
 * was proved to expose; a derived table is walked here and now.
 *
 * @param {RelationRef} relation
 * @param {QueryRegistry} registry
 * @param {Map<string, InferredColumn[] | undefined>} ctes
 * @returns {InferredColumn[] | undefined}
 * @ref LLP 0280#carry [implements]: a relation the registry cannot name still supplies its columns when the inner select can be read
 */
function relationColumns(relation, registry, ctes) {
  if (relation.query) return inferColumns(relation.query, registry, ctes)
  if (relation.table === undefined) return undefined
  const key = relation.table.toLowerCase()
  if (ctes.has(key)) return ctes.get(key)
  // `?.columns` rather than a bare deref: a registration that hands the kernel
  // a malformed schema must not turn every query touching it into a TypeError,
  // the same way `hyp backfill` reads it.
  const columns = registry.getDataset(relation.table)?.schema?.columns
  if (!columns) return undefined
  return columns.map((column) => ({ name: column.name, isTimestamp: column.type === 'TIMESTAMP' }))
}

/**
 * The columns an inner select exposes, or undefined when any one of them
 * cannot be read. All or nothing on purpose: a partial list would let a name
 * the list happens to omit be typed from an unrelated relation that declares
 * it, which is the wrong-rows failure LLP 0272 exists to prevent, so a
 * relation that cannot be read end to end supplies nothing at all.
 *
 * @param {Statement} statement
 * @param {QueryRegistry} registry
 * @param {Map<string, InferredColumn[] | undefined>} ctes
 * @returns {InferredColumn[] | undefined}
 * @ref LLP 0280#complete [implements]: an inner select supplies its whole column list or none of it
 */
function inferColumns(statement, registry, ctes) {
  if (statement.type === 'with') {
    const inner = new Map(ctes)
    for (const cte of statement.ctes) {
      inner.set(cte.name.toLowerCase(), inferColumns(cte.query, registry, inner))
    }
    return inferColumns(statement.query, registry, inner)
  }
  if (statement.type === 'compound') {
    // A set operation pairs its sides by position, and the pair carries a type
    // only when both sides have it: `union`ing a TIMESTAMP with a STRING gives
    // a column this walk must not call a TIMESTAMP.
    const left = inferColumns(statement.left, registry, ctes)
    const right = inferColumns(statement.right, registry, ctes)
    if (!left || !right || left.length !== right.length) return undefined
    return left.map((column, index) => ({
      name: column.name,
      isTimestamp: column.isTimestamp && right[index].isTimestamp,
    }))
  }
  /** @type {{ keys: string[], columns: InferredColumn[] }[]} */
  const relations = []
  for (const relation of selectRelations(statement)) {
    const columns = relationColumns(relation, registry, ctes)
    if (!columns) return undefined
    relations.push({ keys: relationKeys(relation), columns })
  }
  /** @type {InferredColumn[]} */
  const exposed = []
  for (const column of statement.columns) {
    if (column.type === 'star') {
      if (column.table === undefined) {
        for (const relation of relations) exposed.push(...relation.columns)
        continue
      }
      const qualifier = column.table.toLowerCase()
      const named = relations.find((relation) => relation.keys.includes(qualifier))
      if (!named) return undefined
      exposed.push(...named.columns)
      continue
    }
    const name = column.alias ?? (column.expr.type === 'identifier' ? column.expr.name : undefined)
    if (name === undefined) return undefined
    exposed.push({ name, isTimestamp: exprIsTimestamp(column.expr, relations) })
  }
  return exposed
}

/**
 * Whether an inner select's output column is a TIMESTAMP, resolved against
 * that select's own relations. Only the shapes that provably carry the type
 * answer true: a column reference, a `CAST(... AS TIMESTAMP)`, and a call
 * whose result takes its arguments' type. Everything else answers false,
 * which costs the coercion and never mis-types it.
 *
 * @param {ExprNode} node
 * @param {{ keys: string[], columns: InferredColumn[] }[]} relations
 * @returns {boolean}
 */
function exprIsTimestamp(node, relations) {
  if (node.type === 'identifier') {
    if (node.prefix !== undefined) {
      const qualifier = node.prefix.toLowerCase()
      const named = relations.find((relation) => relation.keys.includes(qualifier))
      return named ? declaresTimestamp(named.columns, node.name) === true : false
    }
    // Unqualified: every relation that declares the name has to call it a
    // TIMESTAMP, and at least one has to declare it. A name no relation
    // declares is a correlated reference out of this select, whose type this
    // walk has no view of.
    let declared = false
    for (const relation of relations) {
      const isTimestamp = declaresTimestamp(relation.columns, node.name)
      if (isTimestamp === undefined) continue
      if (!isTimestamp) return false
      declared = true
    }
    return declared
  }
  if (node.type === 'cast') return node.toType === 'TIMESTAMP'
  if (node.type === 'function' || node.type === 'window') {
    const args = typeCarryingArgs(node.funcName, node.args)
    if (args.length === 0) return false
    return args.every((arg) => exprIsTimestamp(arg, relations))
  }
  return false
}

/**
 * Whether a column list declares this name a TIMESTAMP, or undefined when it
 * does not declare the name at all.
 *
 * @param {InferredColumn[]} columns
 * @param {string} name
 * @returns {boolean | undefined}
 */
function declaresTimestamp(columns, name) {
  const found = columns.find((column) => column.name === name)
  return found === undefined ? undefined : found.isTimestamp
}

/**
 * Nested statements an expression can carry. Each resolves against its own
 * FROM first, with the enclosing scope behind it for a correlated reference.
 *
 * @param {ExprNode} node
 * @param {QueryRegistry} registry
 * @param {Map<string, InferredColumn[] | undefined>} ctes
 * @param {TimestampScope} scope the enclosing select's scope
 */
function rewriteExprStatements(node, registry, ctes, scope) {
  if (node.type === 'in') {
    rewriteExprStatements(node.expr, registry, ctes, scope)
    rewriteStatement(node.subquery, registry, ctes, scope)
    return
  }
  if (node.type === 'subquery' || node.type === 'exists' || node.type === 'not exists') {
    rewriteStatement(node.subquery, registry, ctes, scope)
    return
  }
  for (const child of childExprs(node)) rewriteExprStatements(child, registry, ctes, scope)
}

/**
 * The TIMESTAMP columns this select's relations expose, two ways: the names
 * every relation in scope agrees are TIMESTAMP (for an unqualified
 * reference), and the names each relation exposes under its own name and
 * alias (for a qualified one). A name two relations type differently is
 * dropped rather than guessed at, and a relation whose columns cannot be read
 * (a table function, a CTE over an unregistered table) contributes nothing,
 * so `s.ts` against such a relation is never typed from an unrelated dataset
 * that happens to share the column name: a wrong coercion returns wrong rows,
 * which is the failure this exists to end.
 *
 * Every relation is still recorded in `bound`, columns or not, so a qualifier
 * this select binds stops the correlated walk into `outer` instead of
 * borrowing an enclosing relation that happens to share the alias.
 *
 * @param {SelectStatement} select
 * @param {QueryRegistry} registry
 * @param {Map<string, InferredColumn[] | undefined>} ctes
 * @param {TimestampScope | undefined} outer
 * @returns {TimestampScope}
 */
function timestampScope(select, registry, ctes, outer) {
  /** @type {Set<string>} */
  const bound = new Set()
  /** @type {Map<string, Set<string>>} */
  const byRelation = new Map()
  /** @type {Map<string, boolean>} */
  const seenTypes = new Map()
  for (const relation of selectRelations(select)) {
    const keys = relationKeys(relation)
    for (const key of keys) bound.add(key)
    const columns = relationColumns(relation, registry, ctes)
    if (!columns) continue
    /** @type {Set<string>} */
    const declared = new Set()
    for (const column of columns) {
      if (column.isTimestamp) declared.add(column.name)
      const seen = seenTypes.get(column.name)
      seenTypes.set(column.name, seen === undefined ? column.isTimestamp : seen && column.isTimestamp)
    }
    for (const key of keys) byRelation.set(key, declared)
  }

  /** @type {Set<string>} */
  const agreed = new Set()
  for (const [name, isTimestamp] of seenTypes) {
    if (isTimestamp) agreed.add(name)
  }
  return { agreed, byRelation, bound, outer }
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
 * qualifier, so `s.message_created_at` against a joined relation whose columns
 * cannot be read stays a string comparison even when a base table in the same
 * scope declares that name TIMESTAMP; an unqualified one falls back to the
 * names every relation agrees on. A type-preserving call is looked through to
 * the argument that carries its type, so `max(ts)` types like `ts` does.
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
 * columns are unknown (a table function), so an inner alias never borrows an
 * enclosing relation that happens to share its name.
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
