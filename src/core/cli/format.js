// @ts-check

/**
 * Value formatting shared by the CLI's human-facing summaries.
 *
 * The returning gate (`wizard/fork.js`) and `hyp status` both render a
 * one-screen picture of the same install, and a reader who sees `65 MB` on
 * one and `68157440 bytes` on the other has to do arithmetic to know they
 * agree. Same for client names: `Claude Desktop` in the wizard and
 * `claude-desktop` in status are one client, and only one of those spellings
 * is the one the user picked it by.
 *
 * Style (`style.js`) owns colour and frames; this owns the values inside
 * them.
 */

/**
 * Short human byte count (e.g. `65 MB`). Rounds to whole MB/KB so a
 * summary line stays glanceable; a caller that needs the exact figure has
 * `--json`.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytesShort(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round(bytes)} B`
}

/**
 * Thousands separators for the row counts a summary quotes. `1,978` reads
 * as a magnitude at a glance; `1978` reads as a year.
 *
 * @param {number} n
 * @returns {string}
 */
export function formatCount(n) {
  if (!Number.isFinite(n)) return '0'
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Product spellings for the client ids the config uses. Only clients whose
 * casing a user would not guess need an entry; anything else title-cases,
 * which turns `hermes` into `Hermes` correctly and leaves an unknown
 * plugin-contributed client readable rather than absent.
 */
const FRIENDLY_CLIENT_LABELS = /** @type {Record<string, string>} */ ({
  claude: 'Claude',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  openclaw: 'OpenClaw',
  'raw-anthropic': 'Anthropic API',
  'raw-openai': 'OpenAI API',
})

/**
 * @param {string} name client id as it appears in config
 * @returns {string}
 */
export function friendlyClientLabel(name) {
  return FRIENDLY_CLIENT_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Word-wrap plain text to a column count.
 *
 * A block that lays itself out - a framed summary, a label gutter with
 * hanging indents - has to wrap its own content, because the terminal's
 * wrap arrives too late: it breaks at the screen edge, after the frame's
 * right edge has already been placed, which is how a rectangle turns into
 * a staircase. Same for a gutter: a soft-wrapped continuation restarts at
 * column zero, under the label rather than under the text.
 *
 * A token longer than the whole column (a path, a URL, an etag) is broken
 * rather than allowed to push the layout open: a split path is legible, a
 * split frame is not.
 *
 * Input is expected unstyled - callers wrap first and paint after, since
 * an SGR escape inside a token would be measured as visible width here.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string[]} one entry per line, never empty
 */
export function wrapToWidth(text, width) {
  const value = String(text ?? '')
  if (!Number.isFinite(width) || width < 4) return [value]
  /** @type {string[]} */
  const out = []
  for (const paragraph of value.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      let rest = word
      while (rest.length > width) {
        if (line !== '') {
          out.push(line)
          line = ''
        }
        out.push(rest.slice(0, width))
        rest = rest.slice(width)
      }
      if (rest === '' && word !== '') continue
      if (line === '') line = rest
      else if (line.length + 1 + rest.length <= width) line += ` ${rest}`
      else {
        out.push(line)
        line = rest
      }
    }
    out.push(line)
  }
  return out
}
