import { executeSql, parseSql } from 'squirreling'

/**
 * @import { AsyncDataSource, AsyncRow, QueryResults, SqlPrimitive, Statement } from 'squirreling'
 */

/**
 * @typedef {Record<string, SqlPrimitive>[]} SqlRows
 */

/**
 * @typedef {{
 *   limit: number,
 *   query: Statement,
 * }} RandomSamplePlan
 */

/**
 * @param {Statement} statement
 * @returns {Statement}
 */
function cloneStatement(statement) {
  return JSON.parse(JSON.stringify(statement))
}

/**
 * @param {Statement} statement
 * @returns {(import('squirreling').SelectStatement & { orderBy: Array<{ expr?: { type?: string, funcName?: string } }> }) | undefined}
 */
function topLevelSelect(statement) {
  if (statement.type === 'select') return statement
  if (statement.type === 'with') return topLevelSelect(statement.query)
  return undefined
}

/**
 * @param {ReturnType<typeof topLevelSelect>} select
 * @returns {boolean}
 */
function hasRandomOrder(select) {
  if (!select || select.orderBy.length !== 1) return false
  const expr = select.orderBy[0]?.expr
  return expr?.type === 'function' && expr.funcName?.toUpperCase() === 'RANDOM'
}

/**
 * @param {string | Statement} query
 * @returns {RandomSamplePlan | undefined}
 */
export function getRandomSamplePlan(query) {
  const statement = typeof query === 'string' ? parseSql({ query }) : query
  const select = topLevelSelect(statement)
  if (!hasRandomOrder(select) || select?.limit === undefined || select.limit <= 0 || select.offset !== undefined) {
    return undefined
  }

  const cloned = cloneStatement(statement)
  const clonedSelect = topLevelSelect(cloned)
  if (!clonedSelect) return undefined
  clonedSelect.orderBy = []
  clonedSelect.limit = undefined

  return {
    limit: select.limit,
    query: cloned,
  }
}

/**
 * @param {AsyncRow} row
 * @returns {AsyncRow}
 */
function memoizeAsyncRow(row) {
  /** @type {Map<string, Promise<SqlPrimitive>>} */
  const cellCache = new Map()
  return {
    ...row,
    cells: Object.fromEntries(Object.entries(row.cells).map(([column, accessor]) => [column, () => {
      if (!cellCache.has(column)) cellCache.set(column, accessor())
      return cellCache.get(column)
    }])),
  }
}

/**
 * @param {AsyncRow[]} rows
 */
function shuffleRows(rows) {
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rows[i], rows[j]] = [rows[j], rows[i]]
  }
}

/**
 * @param {{
 *   tables: Record<string, AsyncDataSource | SqlRows>,
 *   query: string | Statement,
 *   plan?: RandomSamplePlan,
 * }} args
 * @returns {AsyncGenerator<AsyncRow>}
 */
async function* executeRandomSampleRows(args) {
  const { plan } = args
  if (!plan) {
    yield* executeSql({ tables: args.tables, query: args.query }).rows()
    return
  }

  /** @type {AsyncRow[]} */
  const sample = []
  let seen = 0
  for await (const row of executeSql({ tables: args.tables, query: plan.query }).rows()) {
    seen++
    if (sample.length < plan.limit) {
      sample.push(row)
      continue
    }

    const replacementIndex = Math.floor(Math.random() * seen)
    if (replacementIndex < plan.limit) {
      sample[replacementIndex] = row
    }
  }

  shuffleRows(sample)
  for (const row of sample.map(memoizeAsyncRow)) {
    yield row
  }
}

/**
 * Execute SQL, replacing top-level `ORDER BY RANDOM() LIMIT n` with reservoir
 * sampling so the executor does not need to materialize and sort every row.
 *
 * @param {{
 *   tables: Record<string, AsyncDataSource | SqlRows>,
 *   query: string | Statement,
 * }} params
 * @returns {QueryResults}
 */
export function executeSqlWithRandomSample(params) {
  const plan = getRandomSamplePlan(params.query)
  const baseResults = executeSql({
    tables: params.tables,
    query: plan?.query ?? params.query,
  })

  return {
    columns: baseResults.columns,
    rows: () => executeRandomSampleRows({ ...params, plan }),
    numRows: baseResults.numRows,
    maxRows: baseResults.maxRows,
  }
}
