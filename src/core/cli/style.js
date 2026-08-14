// @ts-check

/**
 * The one place the CLI decides what a colour means.
 *
 * Two components used to carry private `ANSI` maps (the TUI frame builder
 * and the query overview), and the ~250 diagnostic writes outside them
 * carried none at all: severity was encoded only in a leading word
 * (`error:`, `warning:`, `note:`). This module owns the palette both
 * components now import, and classifies those leading words so a run's
 * diagnostics are coloured without every write site having to remember.
 *
 * It owns the CLI's shared *chrome* on the same grounds: the palette, and
 * the one frame shape ({@link boxed}) that both the TUI's prompts and the
 * printed blocks draw when a block needs to read as its own screen.
 *
 * @ref LLP 0189#palette [implements]: one palette, one severity vocabulary, applied at the stream
 */

import { useColor } from './stdio.js'

export const ANSI = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  reset: '\x1b[0m',
}

/**
 * @param {string} text
 * @param {string} sgr
 * @param {boolean} on
 * @returns {string}
 */
export function paint(text, sgr, on) {
  return on ? `${sgr}${text}${ANSI.reset}` : text
}

// Only `\x1b[...m` (SGR) sequences are emitted by this CLI, and they are the
// ones that occupy no columns.
const ANSI_SGR = /\x1b\[[0-9;]*m/g

/**
 * Visible width of one line, ignoring style escapes. Measured in code
 * units, which matches column count for the Latin text, box glyphs and
 * middots the CLI prints.
 *
 * @param {string} line - a single line, without its trailing newline
 * @returns {number}
 */
export function visibleWidth(line) {
  return line.replace(ANSI_SGR, '').length
}

/** The one frame shape: rounded, single-ruled, to match the dim `─` rules. */
const BOX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }

/**
 * Draw a border around a block of lines.
 *
 * The border is dim so it separates without competing: the frame's job is
 * to say "this is one screen", and the content inside keeps whatever
 * emphasis it already had. It is also a shape rather than a colour, so the
 * separation survives `NO_COLOR` and a colour-blind reader
 * (`@ref LLP 0135#disclosure`).
 *
 * A frame wider than the terminal would soft-wrap into a broken rectangle,
 * which is worse than no frame at all, so a block that does not fit is
 * returned unframed. `columns` omitted means "do not know", and an unknown
 * width never suppresses the frame.
 *
 * @param {string[]} lines - already-styled content lines, no trailing newlines
 * @param {{ color: boolean, columns?: number }} opts
 * @returns {string[]}
 */
export function boxed(lines, { color, columns }) {
  if (lines.length === 0) return lines
  const width = Math.max(...lines.map(visibleWidth))
  if (typeof columns === 'number' && columns > 0 && width + 4 > columns) return lines
  const rule = BOX.h.repeat(width + 2)
  const edge = paint(BOX.v, ANSI.dim, color)
  return [
    paint(`${BOX.tl}${rule}${BOX.tr}`, ANSI.dim, color),
    ...lines.map((line) => `${edge} ${line}${' '.repeat(width - visibleWidth(line))} ${edge}`),
    paint(`${BOX.bl}${rule}${BOX.br}`, ANSI.dim, color),
  ]
}

/**
 * Severity rules, in order; the first match wins. Each pattern captures the
 * *prefix* to paint, never the whole line: messages carry paths, quoted
 * config fragments and multi-line repair hints, and a fully-red paragraph
 * is harder to read than a plain one. Colouring the prefix alone also keeps
 * the `NO_COLOR` output byte-identical to what shipped before.
 *
 * Colour is always the second encoding, never the only one - the leading
 * word survives a pipe, a monochrome terminal, and a colour-blind reader.
 *
 * @ref LLP 0189#rules [implements]: prefix-only painting, ordered first-match
 * @ref LLP 0135#disclosure [constrained-by]: colour may never be the sole encoding of a distinction
 */
const RULES = [
  // Continuation lines (`  → hint`, `  repair: …`, `  expected one of: …`)
  // belong to the diagnostic above them and are deliberately left plain:
  // painting them repeats a severity the reader has already been told.
  { pattern: /^[ \t]/, sgr: null },
  // Case-insensitive because the codebase spells these three ways and all
  // three mean the same thing: `error:` (most commands), `Error: …` from a
  // thrown exception's own message, and the shouted `WARNING:` the plugin
  // install confirmation uses for broad permissions and unpinned branches.
  // Those last are the warnings that most need to be yellow.
  { pattern: /^(error:)/i, sgr: ANSI.red },
  { pattern: /^(warning:)/i, sgr: ANSI.yellow },
  { pattern: /^(note:|tip:)/, sgr: ANSI.dim },
  { pattern: /^(usage:)/, sgr: ANSI.dim },
  // `hyp <cmd>: <message>` is this CLI's spelling of the Unix `prog: msg`
  // diagnostic, so on stderr it means failure - except a cancellation, which
  // the user chose. `hyp init: cancelled` is a non-zero exit that nothing
  // went wrong in, and red would say otherwise.
  { pattern: /^(hyp(?: [\w-]+)*:)(?!\s*cancelled\s*$)/, sgr: ANSI.red },
  // `daemon restart failed:`, `attach claude failed:`, `Joining failed:` -
  // the same diagnostic shape without the `hyp` prefix.
  { pattern: /^([^:]*\bfailed:)/, sgr: ANSI.red },
]

/**
 * Paint one whole line's severity prefix. A line with no recognised prefix
 * is returned unchanged, so unclassified output is plain rather than
 * guessed at.
 *
 * @param {string} line - a single line, without its trailing newline
 * @returns {string}
 */
export function paintLine(line) {
  if (!line) return line
  for (const rule of RULES) {
    const match = rule.pattern.exec(line)
    if (!match) continue
    if (!rule.sgr || !match[1]) return line
    return `${paint(match[1], rule.sgr, true)}${line.slice(match[1].length)}`
  }
  return line
}

/**
 * Paint every line in a chunk that begins at a real line boundary.
 *
 * `atLineStart` carries the previous chunk's state: a write that does not
 * end in a newline leaves the next chunk mid-line, and the continuation
 * must not be re-classified as if it were a fresh diagnostic.
 *
 * @param {string} text
 * @param {boolean} atLineStart
 * @returns {string}
 */
export function paintChunk(text, atLineStart) {
  const parts = text.split('\n')
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 || atLineStart) parts[i] = paintLine(parts[i])
  }
  return parts.join('\n')
}

/**
 * Wrap a stderr-shaped stream so severity prefixes are coloured on the way
 * out, or return it untouched when colour is off.
 *
 * Applying this at the stream rather than at each write site is the whole
 * point: `dispatch` binds stderr once and hands it to every command, core
 * and plugin alike, so one wrap colours all of them and a new diagnostic
 * cannot forget to opt in. It also means a captured-and-replayed blob (the
 * wizard tees stderr, `action_attach` collects warnings) is classified when
 * it finally reaches the terminal, not at the site that buffered it.
 *
 * The wrap is a Proxy rather than a `{ write }` object so `isTTY`,
 * `columns`, `on` and the rest of the stream surface survive it - callers
 * that probe those (the TUI, `installStreamErrorHandlers`) must not see a
 * degraded stream.
 *
 * @ref LLP 0189#choke-point [implements]: colour is applied where stderr is bound, not at ~250 write sites
 *
 * @template T
 * @param {T} stream
 * @param {Record<string, string | undefined>} [env]
 * @returns {T}
 */
export function colorizeStderr(stream, env) {
  if (!useColor(stream, env)) return stream
  const target = /** @type {{ write(chunk: string, ...rest: unknown[]): unknown }} */ (
    /** @type {unknown} */ (stream)
  )
  let atLineStart = true
  /** @param {unknown} chunk @param {...unknown} rest */
  const write = (chunk, ...rest) => {
    // Only strings are classified. A Buffer write on stderr is raw bytes
    // (the TUI's frame escapes, a piped payload) and is passed through.
    if (typeof chunk !== 'string') return target.write(/** @type {any} */ (chunk), ...rest)
    const painted = paintChunk(chunk, atLineStart)
    atLineStart = chunk.endsWith('\n')
    return target.write(painted, ...rest)
  }
  return /** @type {T} */ (
    /** @type {unknown} */ (
      new Proxy(/** @type {object} */ (/** @type {unknown} */ (stream)), {
        get(t, prop, _receiver) {
          if (prop === 'write') return write
          const value = Reflect.get(t, prop, t)
          return typeof value === 'function' ? value.bind(t) : value
        },
      })
    )
  )
}
