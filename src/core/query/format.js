// @ts-check

/**
 * @import { ContextControls, ContextControlsResult, QueryFormat, QueryResultSet } from '../../../src/core/query/types.js'
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
  const clip = (/** @type {Record<string, unknown>} */ row) => (maxCell ? truncateRow(row, maxCell) : row)

  // No budget: every row is emitted, so all of them must be truncated.
  if (!maxBytes) {
    const rows = maxCell ? result.rows.map(clip) : result.rows
    return { result: { columns: result.columns, rows }, notice: undefined }
  }

  // Budget: truncate lazily, one source row at a time, and stop as soon as
  // the budget is exceeded — so a broad query never pays to truncate rows
  // that would be dropped anyway. Always emit at least one row.
  /** @type {Record<string, unknown>[]} */
  const kept = []
  let bytes = 0
  for (const row of result.rows) {
    const clipped = clip(row)
    bytes += rowBytes(clipped)
    if (bytes > maxBytes && kept.length > 0) break
    kept.push(clipped)
  }

  const dropped = result.rows.length - kept.length
  const notice =
    dropped > 0
      ? `notice: showing ${kept.length} of ${result.rows.length} rows (${maxBytes}B row-data budget; ` +
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

/**
 * Decide what a SQL query emits for a completed result, without doing any
 * IO — so the spill-vs-inline behavior is unit-testable. The caller (the
 * `query sql` verb's `render`, or `hyp mcp`) performs the actual writes.
 *
 * - Spill mode (`output` set): the full, un-capped result is rendered for
 *   the file (lossless), and stdout gets only a compact receipt.
 * - Inline mode: context controls cap the result; stdout gets the capped
 *   render and the "rows withheld" notice (if any) goes to stderr, so
 *   stdout stays valid in every format.
 *
 * @param {{ columns: string[], rows: Record<string, unknown>[] }} full
 * @param {{ format: QueryFormat, output: string | undefined, maxCell: number, maxBytes: number }} opts
 * @returns {{ stdout: string, stderr: string, file?: { path: string, content: string } }}
 */
export function buildQuerySqlOutput(full, opts) {
  if (opts.output) {
    // Render the file content once and reuse it for both the file and the
    // receipt's byte count — large dumps are exactly the `--output` case,
    // so a second full serialization is wasted work and peak memory.
    const content = renderResult(full, opts.format)
    return {
      stdout: renderSpillReceipt(opts.output, full, content),
      stderr: '',
      file: { path: opts.output, content },
    }
  }
  const { result: capped, notice } = applyContextControls(full, {
    maxCell: opts.maxCell,
    maxBytes: opts.maxBytes,
  })
  return {
    stdout: renderResult(capped, opts.format),
    stderr: notice ? `${notice}\n` : '',
  }
}

/**
 * Render the stdout receipt for `--output` spill mode: where the full
 * result went, its shape, and a small truncated preview so the caller can
 * sanity-check without ingesting the file.
 *
 * @param {string} outputPath
 * @param {{ columns: string[], rows: Record<string, unknown>[] }} full
 * @param {string} content  the already-rendered file content (sized for the receipt)
 * @returns {string}
 */
function renderSpillReceipt(outputPath, full, content) {
  const bytes = Buffer.byteLength(content)
  const cols = full.columns.length > 0 ? full.columns : Object.keys(full.rows[0] ?? {})
  const lines = [
    `wrote ${full.rows.length} rows · ${cols.length} cols · ${bytes}B → ${outputPath}`,
  ]
  if (cols.length > 0) lines.push(`schema: ${cols.join(', ')}`)
  const previewRows = full.rows.slice(0, 3)
  if (previewRows.length > 0) {
    const { result: preview } = applyContextControls(
      { columns: full.columns, rows: previewRows },
      { maxCell: 80, maxBytes: 0 }
    )
    lines.push(`preview (first ${previewRows.length}, cells clipped):`)
    lines.push(renderResult(preview, 'jsonl').trimEnd())
  }
  return lines.join('\n') + '\n'
}
