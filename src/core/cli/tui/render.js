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
// @ref LLP 0183#palette [implements]: one ANSI table for the whole CLI
import { ANSI, paint } from '../style.js'

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
  // Context lines (LLP 0185): rendered verbatim, unstyled, one per entry -
  // the defaults gates list what they are about to accept here rather
  // than cramming it into the title.
  for (const item of state.items ?? []) lines.push(item)
  return lines
}

/**
 * @param {State} state
 * @param {RenderOpts} opts
 * @returns {string}
 */
export function render(state, opts) {
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

// An allowBack prompt (LLP 0186) tells the truth about what escape does
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
  return lines.join('\n') + '\n'
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
 */
function renderSelect(state, opts) {
  const lines = chromeLines(state, opts)
  lines.push(paint(state.hint ?? defaultHint(state), ANSI.dim, opts.color))
  lines.push('')
  state.options.forEach((o, i) => {
    const cursor = i === state.cursor
    const pointer = cursor ? '>' : ' '
    const row = `${pointer} ${o.label}`
    lines.push(cursor ? paint(row, `${ANSI.bold}${ANSI.cyan}`, opts.color) : paint(row, ANSI.dim, opts.color))
    if (o.summary && o.summary !== o.label) {
      lines.push(paint(`    ${o.summary}`, ANSI.dim, opts.color))
    }
  })
  return lines.join('\n') + '\n'
}

/**
 * @param {TextState} state
 * @param {RenderOpts} opts
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
  return lines.join('\n') + '\n'
}
