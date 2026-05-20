/**
 * @import { QueryFormat, QueryResultSet } from './types.js'
 */

/**
 * @param {QueryResultSet} result
 * @param {QueryFormat} format
 * @returns {string}
 */
export function renderResult(result, format) {
  switch (format) {
  case 'json':
    return JSON.stringify(result.rows, jsonReplacer, 2) + '\n'
  case 'jsonl':
    return result.rows.map((row) => JSON.stringify(row, jsonReplacer)).join('\n') + (result.rows.length ? '\n' : '')
  case 'markdown':
    return renderMarkdown(result)
  case 'table':
  default:
    return renderTable(result)
  }
}

/**
 * @param {unknown} _key
 * @param {unknown} value
 * @returns {unknown}
 */
export function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  return value
}

/**
 * @param {QueryResultSet} result
 * @returns {string}
 */
function renderTable(result) {
  const columns = result.columns.length > 0
    ? result.columns
    : inferColumns(result.rows)
  if (columns.length === 0) return '(no rows)\n'
  if (result.rows.length === 0) return columns.join('  ') + '\n(no rows)\n'
  const formattedRows = result.rows.map((row) => {
    /** @type {Record<string, string>} */
    const out = {}
    for (const column of columns) out[column] = formatCell(row[column])
    return out
  })
  const widths = columns.map((column) => {
    let width = column.length
    for (const row of formattedRows) width = Math.max(width, row[column]?.length ?? 0)
    return Math.min(width, 80)
  })
  const lines = [
    columns.map((column, i) => column.padEnd(widths[i])).join('  ').trimEnd(),
    columns.map((_, i) => '-'.repeat(widths[i])).join('  ').trimEnd(),
  ]
  for (const row of formattedRows) {
    lines.push(columns.map((column, i) => truncate(row[column] ?? '', widths[i]).padEnd(widths[i])).join('  ').trimEnd())
  }
  return lines.join('\n') + '\n'
}

/**
 * @param {QueryResultSet} result
 * @returns {string}
 */
function renderMarkdown(result) {
  const columns = result.columns.length > 0
    ? result.columns
    : inferColumns(result.rows)
  if (columns.length === 0) return '\n'
  const lines = [
    `| ${columns.map(escapeMarkdown).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ]
  for (const row of result.rows) {
    lines.push(`| ${columns.map((column) => escapeMarkdown(formatCell(row[column]))).join(' | ')} |`)
  }
  return lines.join('\n') + '\n'
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {string[]}
 */
function inferColumns(rows) {
  const columns = new Set()
  for (const row of rows) {
    for (const column of Object.keys(row)) columns.add(column)
  }
  return [...columns]
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function formatCell(value) {
  if (value === undefined || value === null) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'object') return JSON.stringify(value, jsonReplacer)
  return String(value)
}

/**
 * @param {string} value
 * @param {number} width
 * @returns {string}
 */
function truncate(value, width) {
  if (value.length <= width) return value
  if (width <= 1) return value.slice(0, width)
  if (width <= 3) return value.slice(0, width)
  return value.slice(0, width - 3) + '...'
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeMarkdown(value) {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
