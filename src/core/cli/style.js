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
 * The text without its style escapes: what a reader sees, and what a
 * matcher has to compare against. {@link paintLine} paints a *prefix*, so a
 * classified diagnostic carries a reset in the middle of its own sentence
 * and no longer contains the string it was written from.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripSgr(text) {
  return text.replace(ANSI_SGR, '')
}

/**
 * Visible width of one line, ignoring style escapes. Measured in code
 * units, which matches column count for the Latin text, box glyphs and
 * middots the CLI prints.
 *
 * @param {string} line - a single line, without its trailing newline
 * @returns {number}
 */
export function visibleWidth(line) {
  return stripSgr(line).length
}

// East Asian Wide (W) and Fullwidth (F) blocks, as [first, last] code
// points: the characters a terminal draws two columns wide. Block-level
// rather than the full per-character table, which is the trade a no-
// dependency rule makes; emoji are matched by property below instead.
const WIDE_RANGES = [
  [0x1100, 0x115f], // Hangul Jamo initials
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compatibility, CJK compatibility
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth ASCII variants
  [0xffe0, 0xffe6], // fullwidth signs
  [0x20000, 0x3fffd], // CJK Extensions B onward (planes 2 and 3)
]

// Emoji drawn as emoji by default occupy two columns.
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u

// Combining and enclosing marks (accents, variation selectors) and the
// zero-width format characters draw on the cell before them.
const ZERO_WIDTH = /[\p{Mn}\p{Me}\u200b-\u200f\u2060-\u2064\ufeff]/u

// A zero-width joiner fuses two pictographs into one drawn glyph; between
// anything else it joins nothing, and both sides keep their width.
const ZWJ = 0x200d
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u

// Printable ASCII only: the common case, measured without a code-point walk.
const PLAIN_ASCII = /^[\x20-\x7e]*$/

/**
 * Columns one code point occupies: 0, 1 or 2. See {@link displayWidth}.
 *
 * @param {number} cp
 * @returns {number}
 */
export function codePointWidth(cp) {
  if (cp < 0x7f) return cp < 0x20 ? 0 : 1
  const ch = String.fromCodePoint(cp)
  if (ZERO_WIDTH.test(ch)) return 0
  if (EMOJI_PRESENTATION.test(ch)) return 2
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp < lo) break
    if (cp <= hi) return 2
  }
  return 1
}

/**
 * Terminal columns a line occupies, ignoring style escapes, for text that
 * may hold CJK, emoji or combining marks. {@link visibleWidth} counts code
 * units, which is right for the CLI's own Latin chrome but not for captured
 * labels: a model, repo or tool name can carry any of these.
 *
 * The rule, in order: printable ASCII is one column; combining and
 * enclosing marks, variation selectors and the zero-width format
 * characters are zero; a pictograph joined to the pictograph before it by
 * a zero-width joiner is zero, so a joined emoji sequence counts as its
 * first emoji (a joiner between other characters joins nothing); East
 * Asian Wide and
 * Fullwidth blocks ({@link WIDE_RANGES}) and default-emoji-presentation
 * characters are two; everything else is one. Not handled: a regional-
 * indicator pair (a flag) measures four where most terminals draw two.
 *
 * @param {string} text
 * @returns {number}
 */
export function displayWidth(text) {
  const plain = stripSgr(text)
  if (PLAIN_ASCII.test(plain)) return plain.length
  const step = widthStepper()
  let width = 0
  for (const ch of plain) width += step(/** @type {number} */ (ch.codePointAt(0)))
  return width
}

/**
 * A counter fed one code point at a time that returns each one's columns
 * under the {@link displayWidth} rule, for a caller that has to stop part
 * way along a string. It carries only whether the last drawn code point
 * was a pictograph and whether a joiner followed it.
 *
 * @returns {(cp: number) => number}
 */
export function widthStepper() {
  let pictograph = false
  let joined = false
  return (cp) => {
    const isPictograph = cp >= 0x7f && PICTOGRAPHIC.test(String.fromCodePoint(cp))
    const width = joined && isPictograph ? 0 : codePointWidth(cp)
    joined = cp === ZWJ && pictograph
    // Marks and selectors sit on the glyph before them, so they leave the
    // pictograph state as it was.
    if (width > 0 || isPictograph) pictograph = isPictograph
    return width
  }
}

/**
 * How many *physical* terminal rows one logical line occupies. A line
 * wider than the terminal soft-wraps onto further rows, and an empty line
 * still occupies one. `columns` omitted means "do not know", which falls
 * back to the 80 the rest of the CLI assumes.
 *
 * Shared rather than local so the two places that have to agree about one
 * frame's height - the renderer deciding how many option rows fit, and the
 * runtime deciding how far to move the cursor back up - measure it the
 * same way.
 *
 * @param {string} line - a single line, without its trailing newline
 * @param {number} [columns]
 * @returns {number}
 */
export function lineRows(line, columns) {
  const width = typeof columns === 'number' && columns > 0 ? columns : 80
  const len = visibleWidth(line)
  return len === 0 ? 1 : Math.ceil(len / width)
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

/** The hook a colorized wrap answers to, keyed so nothing reaches it by guessing. */
const RESYNC = Symbol('colorizeStderr.resyncLineStart')

/**
 * Tell a colorized stream the terminal is back at a line start.
 *
 * {@link colorizeStderr} infers the cursor from its own writes, which is the
 * whole truth only while it is the only thing writing to the terminal. The
 * wizard's relay of a piped `hyp sync` is not: that child's send confirm ends
 * without a newline, and the answer - with the newline the tty echoes beside
 * it - reaches the terminal without passing through here, so the child's next
 * diagnostic lands at a real line start this wrap reads as mid-sentence and
 * {@link paintChunk}'s gate leaves plain.
 *
 * A no-op on an unwrapped stream, which is every stream not painting anyway.
 *
 * @param {{ write(chunk: string): unknown }} stream
 */
export function resyncLineStart(stream) {
  const hook = /** @type {any} */ (stream)[RESYNC]
  if (typeof hook === 'function') hook()
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
  const resync = () => { atLineStart = true }
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
          if (prop === RESYNC) return resync
          const value = Reflect.get(t, prop, t)
          return typeof value === 'function' ? value.bind(t) : value
        },
      })
    )
  )
}
