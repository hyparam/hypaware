// @ts-check

/**
 * @import { ContextControls, ContextControlsResult, QueryFormat, QueryResultSet } from './types.d.ts'
 */

/**
 * Bound a result set's context footprint before it is rendered to a
 * model or terminal. Two independent axes:
 *
 *   1. per-cell truncation — recursively clip every string value to
 *      `maxCell` code points, appending a greppable `…(+N)` marker so
 *      the elision is visible and its size known. Only strings shrink;
 *      numbers/booleans/null pass through unchanged, so `--format json`
 *      output stays valid and same-typed.
 *   2. row budget — drop trailing rows once the cumulative serialized
 *      *row-data* size (compact JSON per row, i.e. the jsonl payload)
 *      exceeds `maxBytes`, so a wide or long result cannot flood the
 *      caller's context. This measures the underlying data — the
 *      dominant, format-independent context cost — not the final
 *      rendered output, which adds modest per-format overhead (JSON
 *      array syntax and indentation, table padding, markdown escaping).
 *      At least one row is always kept.
 *
 * Returns the capped result plus an optional one-line `notice` (meant
 * for stderr, so it never corrupts stdout output) naming exactly what
 * was withheld and how to retrieve the full set. A control of `0`
 * disables that axis. Pure: the input result is not mutated.
 *
 * @param {QueryResultSet} result
 * @param {ContextControls} controls
 * @returns {ContextControlsResult}
 */
export function applyContextControls(result, controls) {
  const maxCell = controls.maxCell > 0 ? controls.maxCell : 0
  const maxBytes = controls.maxBytes > 0 ? controls.maxBytes : 0

  const truncated = maxCell ? result.rows.map((row) => truncateRow(row, maxCell)) : result.rows

  if (!maxBytes) {
    return { result: { columns: result.columns, rows: truncated }, notice: undefined }
  }

  /** @type {Record<string, unknown>[]} */
  const kept = []
  let bytes = 0
  for (const row of truncated) {
    bytes += rowBytes(row)
    // Always emit at least one row; stop once the budget is exceeded.
    if (bytes > maxBytes && kept.length > 0) break
    kept.push(row)
  }

  const dropped = truncated.length - kept.length
  const notice =
    dropped > 0
      ? `notice: showing ${kept.length} of ${truncated.length} rows (${maxBytes}B row-data budget; ` +
        `rendered output may be larger); use --output <file> for the full result, --max-bytes 0 to disable, or aggregate/LIMIT`
      : undefined
  return { result: { columns: result.columns, rows: kept }, notice }
}

/**
 * Truncate every value of one row, returning a new row object.
 *
 * @param {Record<string, unknown>} row
 * @param {number} maxCell
 * @returns {Record<string, unknown>}
 */
function truncateRow(row, maxCell) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of Object.keys(row)) out[key] = truncateValue(row[key], maxCell)
  return out
}

/**
 * Recursively clip string leaves to `maxCell` code points. Objects and
 * arrays are rebuilt (not mutated); `Date` is treated as a scalar leaf
 * so it round-trips through `jsonReplacer` unchanged.
 *
 * @param {unknown} value
 * @param {number} maxCell
 * @returns {unknown}
 */
function truncateValue(value, maxCell) {
  if (typeof value === 'string') return clipString(value, maxCell)
  if (Array.isArray(value)) return value.map((v) => truncateValue(v, maxCell))
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(value)) out[key] = truncateValue(/** @type {Record<string, unknown>} */ (value)[key], maxCell)
    return out
  }
  return value
}

/**
 * Clip a string to `maxCell` code points (never splitting a multibyte
 * character) and append `…(+N)` where N is the number of code points
 * removed. Returns the input unchanged when it already fits.
 *
 * @param {string} value
 * @param {number} maxCell
 * @returns {string}
 */
function clipString(value, maxCell) {
  const points = Array.from(value)
  if (points.length <= maxCell) return value
  return points.slice(0, maxCell).join('') + `…(+${points.length - maxCell})`
}

/**
 * Serialized byte size of one row, used for the context budget. Mirrors
 * the `jsonl` encoding so the budget tracks what a JSON-consuming caller
 * actually receives.
 *
 * @param {Record<string, unknown>} row
 * @returns {number}
 */
function rowBytes(row) {
  try {
    return Buffer.byteLength(JSON.stringify(row, jsonReplacer))
  } catch {
    return Buffer.byteLength(String(row))
  }
}

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
