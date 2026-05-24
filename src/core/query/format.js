// @ts-check

/** @import { QueryResultSet, QueryFormat } from './types.d.ts' */

/**
 * Render a query result set into the requested output format.
 *
 * Formats:
 * - `json`     pretty-printed JSON array
 * - `jsonl`    one JSON object per line, trailing newline if any rows
 * - `markdown` GitHub-flavoured table
 * - `table`    fixed-width text table (default)
 *
 * @param {QueryResultSet} result
 * @param {QueryFormat} format
 * @returns {string}
 */
export function renderResult(result, format) {
  switch (format) {
    case 'json':
      return JSON.stringify(result.rows, jsonReplacer, 2) + '\n'
    case 'jsonl':
      return (
        result.rows.map((row) => JSON.stringify(row, jsonReplacer)).join('\n') +
        (result.rows.length ? '\n' : '')
      )
    case 'markdown':
      return renderMarkdown(result)
    case 'table':
    default:
      return renderTable(result)
  }
}

/**
 * JSON replacer that serializes the values Iceberg returns but
 * `JSON.stringify` cannot handle natively (BigInt → string, Date → ISO
 * timestamp). Exported so the `hyp query sql` command emits exactly
 * the same JSON as the smoke test asserts against.
 *
 * @param {unknown} _key
 * @param {unknown} value
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
  const columns = result.columns.length > 0 ? result.columns : inferColumns(result.rows)
  if (columns.length === 0) return '(no rows)\n'
  if (result.rows.length === 0) return columns.join('  ') + '\n(no rows)\n'

  const cells = result.rows.map((row) => {
    /** @type {Record<string, string>} */
    const out = {}
    for (const column of columns) out[column] = formatCell(row[column])
    return out
  })
  const widths = columns.map((column) => {
    let width = column.length
    for (const row of cells) width = Math.max(width, row[column]?.length ?? 0)
    return Math.min(width, 80)
  })

  const lines = [
    columns.map((column, i) => column.padEnd(widths[i])).join('  ').trimEnd(),
    columns.map((_, i) => '-'.repeat(widths[i])).join('  ').trimEnd(),
  ]
  for (const row of cells) {
    lines.push(columns.map((column, i) => row[column].padEnd(widths[i])).join('  ').trimEnd())
  }
  return lines.join('\n') + '\n'
}

/**
 * @param {QueryResultSet} result
 * @returns {string}
 */
function renderMarkdown(result) {
  const columns = result.columns.length > 0 ? result.columns : inferColumns(result.rows)
  if (columns.length === 0) return '_(no rows)_\n'
  const header = '| ' + columns.join(' | ') + ' |'
  const divider = '| ' + columns.map(() => '---').join(' | ') + ' |'
  if (result.rows.length === 0) return [header, divider, '_(no rows)_'].join('\n') + '\n'
  const body = result.rows.map((row) => {
    return '| ' + columns.map((c) => mdEscape(formatCell(row[c]))).join(' | ') + ' |'
  })
  return [header, divider, ...body].join('\n') + '\n'
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {string[]}
 */
function inferColumns(rows) {
  if (rows.length === 0) return []
  return Object.keys(rows[0])
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatCell(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value, jsonReplacer)
  return String(value)
}

/**
 * Pipe characters break Markdown tables; backslash-escape them.
 *
 * @param {string} value
 */
function mdEscape(value) {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
