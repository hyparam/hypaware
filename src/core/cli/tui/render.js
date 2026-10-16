// @ts-check

/**
 * Pure frame builder. Given a reducer state, returns the full string
 * that should be written to stdout to display the current frame.
 *
 * The returned string ends with a trailing newline. Lines are joined
 * with `\n` (no `\r\n`; runtime uses raw mode where `\n` advances a
 * row without resetting the column, and the runtime emits an explicit
 * `\r` before redrawing).
 *
 * No I/O. No reads from `process.*`.
 */

/**
 * @import { State, MultiselectState, SelectState, TextState, RenderOpts } from '../../../../src/core/cli/tui/types.js'
 */

// The palette is shared, not local: this module and the query overview each
// used to carry their own copy, which is how the CLI ended up with a red
// that only prompts knew about and no yellow anywhere.
// @ref LLP 0189#palette [implements]: one ANSI table for the whole CLI
import { ANSI, boxed, lineRows, paint } from '../style.js'

/**
 * Open a frame with the prompt's chrome: the optional position line
 * (dim, LLP 0135 #progress) above the bold title. Every kind renders it
 * the same way, and a state without one produces exactly the frame it
 * produced before the field existed.
 *
 * A prompt whose headline was already printed above it (the returning
 * gate, whose summary block carries the only headline) omits `title`
 * and gets no line at all, rather than a blank bold one.
 *
 * @ref LLP 0135#progress [implements]: the breadcrumb is its own dim line above the title, never folded into the title itself
 *
 * @param {State} state
 * @param {RenderOpts} opts
 * @returns {string[]}
 */
function chromeLines(state, opts) {
  const lines = []
  if (state.progress) lines.push(paint(state.progress, ANSI.dim, opts.color))
  if (state.title) lines.push(paint(state.title, ANSI.bold, opts.color))
  // Context lines (LLP 0190): rendered verbatim, unstyled, one per entry -
  // a caller lists what a screen is about here rather than cramming it
  // into the title. The wizard gates that drove this no longer use it
  // (LLP 0201 #gate puts their copy in the option rows); the first-ask
  // screen is the remaining caller.
  for (const item of state.items ?? []) lines.push(item)
  return lines
}

/**
 * Build the frame: the kind's own lines, optionally inside a border.
 *
 * The border is a whole-frame property, not a per-kind one, which is why
 * the join lives here rather than in the three builders: a boxed prompt is
 * the same prompt with a rectangle around it, and no kind should have to
 * know how to draw one.
 *
 * @param {State} state
 * @param {RenderOpts} opts
 * @returns {string}
 */
export function render(state, opts) {
  const lines = frameLines(state, opts)
  const framed = state.box
    ? boxed(lines, { color: opts.color, ...(opts.columns !== undefined ? { columns: opts.columns } : {}) })
    : lines
  return framed.join('\n') + '\n'
}

/**
 * @param {State} state
 * @param {RenderOpts} opts
 * @returns {string[]}
 */
function frameLines(state, opts) {
  switch (state.kind) {
    case 'multiselect': return renderMultiselect(state, opts)
    case 'select':      return renderSelect(state, opts)
    case 'text':        return renderText(state, opts)
  }
}

const DEFAULT_HINT = {
  multiselect: 'space toggle · a all · enter confirm · esc cancel',
  select:      'up/down · enter pick · esc cancel',
  text:        'enter confirm · esc cancel',
}

// An allowBack prompt (LLP 0191) tells the truth about what escape does
// there: it steps back one screen instead of cancelling.
const DEFAULT_HINT_BACK = {
  multiselect: 'space toggle · a all · enter confirm · esc back',
  select:      'up/down · enter pick · esc back',
  text:        'enter confirm · esc back',
}

/**
 * The kind's default key-help line, honest about escape's meaning on
 * this prompt. An explicit `hint` still wins.
 *
 * @param {State} state
 * @returns {string}
 */
function defaultHint(state) {
  return (state.allowBack ? DEFAULT_HINT_BACK : DEFAULT_HINT)[state.kind]
}

/**
 * @param {MultiselectState} state
 * @param {RenderOpts} opts
 * @returns {string[]}
 */
function renderMultiselect(state, opts) {
  const lines = chromeLines(state, opts)
  lines.push(paint(state.hint ?? defaultHint(state), ANSI.dim, opts.color))
  lines.push('')
  state.options.forEach((o, i) => {
    const cursor = i === state.cursor
    const pointer = cursor ? '>' : ' '
    const box = o.checked ? '[x]' : '[ ]'
    const row = `${pointer} ${box} ${o.label}`
    if (o.disabled) {
      // Read-only rows render dimmed even under the cursor so their locked
      // status stays legible.
      lines.push(paint(row, ANSI.dim, opts.color))
    } else if (cursor) {
      lines.push(paint(row, ANSI.cyan, opts.color))
    } else if (o.checked) {
      lines.push(paint(row, ANSI.green, opts.color))
    } else {
      lines.push(row)
    }
    if (o.summary && o.summary !== o.label) {
      lines.push(paint(`      ${o.summary}`, ANSI.dim, opts.color))
    }
  })
  // The Submit row (cursor === options.length) makes finishing visible
  // instead of relying on people knowing enter confirms from anywhere.
  // Bracketed so it reads as a button, not another checkbox row; bold
  // cyan under the cursor, plain otherwise (dim would read as locked).
  const onSubmit = state.cursor === state.options.length
  const submitRow = `${onSubmit ? '>' : ' '} [ Submit ]`
  lines.push('')
  lines.push(onSubmit ? paint(submitRow, `${ANSI.bold}${ANSI.cyan}`, opts.color) : submitRow)
  if (state.error) {
    lines.push(paint(state.error, ANSI.red, opts.color))
  }
  return lines
}

/**
 * A select's rows carry no marker column: the cursor *is* the selection
 * (unlike multiselect, where `[x]` records state the cursor doesn't), so
 * a radio glyph beside the pointer would only invite people to toggle
 * rows they cannot. Weight does the work instead - the row you are on is
 * bold cyan, the rest dim - which reads as one live choice among options
 * rather than a paragraph of indented lines. Dim is unambiguous here:
 * unlike multiselect it has no locked-row meaning to collide with.
 *
 * @param {SelectState} state
 * @param {RenderOpts} opts
 * @returns {string[]}
 */
function renderSelect(state, opts) {
  const lines = chromeLines(state, opts)
  lines.push(paint(state.hint ?? defaultHint(state), ANSI.dim, opts.color))
  lines.push('')
  const blocks = state.options.map((o, i) => {
    const cursor = i === state.cursor
    const pointer = cursor ? '>' : ' '
    const row = `${pointer} ${o.label}`
    const block = [cursor ? paint(row, `${ANSI.bold}${ANSI.cyan}`, opts.color) : paint(row, ANSI.dim, opts.color)]
    if (o.summary && o.summary !== o.label) {
      block.push(paint(`    ${o.summary}`, ANSI.dim, opts.color))
    }
    return block
  })
  const [start, end] = selectWindow(state, lines, blocks, opts)
  for (let i = start; i < end; i++) lines.push(...blocks[i])
  if (start > 0 || end < blocks.length) {
    // A window that hid rows says so: a picker that renders some of its
    // options without saying so lies about how many there are.
    lines.push(paint(`  showing ${start + 1}-${end} of ${blocks.length}`, ANSI.dim, opts.color))
  }
  return lines
}

/**
 * Which slice of a select's option blocks to draw: a window over the list
 * that always contains the cursor and always leaves the frame inside the
 * terminal.
 *
 * Every select caller but one passes a short fixed set. `hyp report fix`
 * passes one option per listed report, so its frame is sized by how many
 * reports a server published, and a frame taller than the terminal is not
 * merely long: the terminal has already scrolled by the time it lands, the
 * runtime's cursor-up cannot reach the frame's top row any more, and every
 * later keystroke redraws over whatever is left on screen. Bounding the
 * frame here rather than capping the option list at the call site is what
 * keeps the next data-sized caller from rediscovering that.
 *
 * The window is a pure function of the cursor, not remembered scroll
 * state: it grows outward from the cursor's own block, alternating sides
 * so the cursor sits near the middle of the window and the ends of the
 * list fill it. The measure is physical rows, matching what the runtime
 * counts back over, so a wrapped label costs what it actually costs.
 *
 * One row of the terminal is left for the cursor: frames end with a
 * newline, so a frame that filled the terminal exactly would push its own
 * first row off the top.
 *
 * @ref LLP 0414#listing-is-the-picker [constrained-by]: the picker offers one row per listed report, so its height is the server's to set
 *
 * @param {SelectState} state
 * @param {string[]} head
 * @param {string[][]} blocks
 * @param {RenderOpts} opts
 * @returns {[number, number]} half-open range of block indices to draw
 */
function selectWindow(state, head, blocks, opts) {
  /** @type {[number, number]} */
  const all = [0, blocks.length]
  const height = opts.rows
  if (typeof height !== 'number' || blocks.length === 0) return all
  const cost = (/** @type {string[]} */ ls) => ls.reduce((n, l) => n + lineRows(l, opts.columns), 0)
  const limit = Math.max(1, height - 1)
  // A box costs its two border rows; when it is suppressed for width the
  // frame simply comes out two rows under budget.
  const chrome = cost(head) + (state.box ? 2 : 0)
  const sizes = blocks.map(cost)
  if (chrome + sizes.reduce((a, b) => a + b, 0) <= limit) return all
  // Windowed, so the "showing x-y of n" row below the options is charged
  // for - at what it actually measures, not a flat row. On a narrow
  // terminal that row wraps, and a budget that assumed one row puts the
  // frame back level with the terminal, which is the whole off-by-one the
  // reserved row above exists to avoid. Charged at its widest form (every
  // number the block count) so the charge cannot depend on the window it
  // is being used to choose; the most that costs is one option fewer.
  const legend = lineRows(`  showing ${blocks.length}-${blocks.length} of ${blocks.length}`, opts.columns)
  const budget = limit - chrome - legend
  const cursor = Math.min(Math.max(state.cursor, 0), blocks.length - 1)
  let start = cursor
  let end = cursor + 1
  let used = sizes[cursor]
  for (;;) {
    const below = end < blocks.length && used + sizes[end] <= budget
    const above = start > 0 && used + sizes[start - 1] <= budget
    if (!below && !above) break
    if (below && (!above || end - cursor <= cursor - start + 1)) {
      used += sizes[end]
      end += 1
    } else {
      start -= 1
      used += sizes[start]
    }
  }
  return [start, end]
}

/**
 * @param {TextState} state
 * @param {RenderOpts} opts
 * @returns {string[]}
 */
function renderText(state, opts) {
  const lines = chromeLines(state, opts)
  lines.push(paint(state.hint ?? defaultHint(state), ANSI.dim, opts.color))
  lines.push('')
  const shown = state.mask ? '*'.repeat(state.value.length) : state.value
  let body = `> ${shown}`
  if (state.value.length === 0 && state.default) {
    body += paint(`  (default: ${state.default})`, ANSI.dim, opts.color)
  }
  lines.push(body)
  if (state.error) {
    lines.push(paint(state.error, ANSI.red, opts.color))
  }
  return lines
}
