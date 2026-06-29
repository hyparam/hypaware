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
 * @import { State, MultiselectState, SelectState, TextState, ConfirmState } from './keypress.js'
 */

/**
 * @typedef {Object} RenderOpts
 * @property {boolean} color
 */

const ANSI = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
}

/**
 * @param {string} text
 * @param {string} sgr
 * @param {boolean} on
 */
function paint(text, sgr, on) {
  return on ? `${sgr}${text}${ANSI.reset}` : text
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
    case 'confirm':     return renderConfirm(state, opts)
  }
}

const DEFAULT_HINT = {
  multiselect: 'space toggle · a all · enter confirm · esc cancel',
  select:      'up/down · enter pick · esc cancel',
  text:        'enter confirm · esc cancel',
  confirm:     'y/n · enter accepts default · esc cancel',
}

/**
 * @param {MultiselectState} state
 * @param {RenderOpts} opts
 */
function renderMultiselect(state, opts) {
  const lines = []
  lines.push(paint(state.title, ANSI.bold, opts.color))
  lines.push(paint(state.hint ?? DEFAULT_HINT.multiselect, ANSI.dim, opts.color))
  lines.push('')
  state.options.forEach((o, i) => {
    const cursor = i === state.cursor
    const pointer = cursor ? '>' : ' '
    const box = o.checked ? '[x]' : '[ ]'
    const row = `${pointer} ${box} ${o.label}`
    if (cursor) {
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
  if (state.error) {
    lines.push(paint(state.error, ANSI.red, opts.color))
  }
  return lines.join('\n') + '\n'
}

/**
 * @param {SelectState} state
 * @param {RenderOpts} opts
 */
function renderSelect(state, opts) {
  const lines = []
  lines.push(paint(state.title, ANSI.bold, opts.color))
  lines.push(paint(state.hint ?? DEFAULT_HINT.select, ANSI.dim, opts.color))
  lines.push('')
  state.options.forEach((o, i) => {
    const cursor = i === state.cursor
    const pointer = cursor ? '>' : ' '
    const row = `${pointer} ${o.label}`
    lines.push(cursor ? paint(row, ANSI.cyan, opts.color) : row)
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
  const lines = []
  lines.push(paint(state.title, ANSI.bold, opts.color))
  lines.push(paint(state.hint ?? DEFAULT_HINT.text, ANSI.dim, opts.color))
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

/**
 * @param {ConfirmState} state
 * @param {RenderOpts} opts
 */
function renderConfirm(state, opts) {
  const lines = []
  lines.push(paint(state.title, ANSI.bold, opts.color))
  lines.push(paint(state.hint ?? DEFAULT_HINT.confirm, ANSI.dim, opts.color))
  lines.push('')
  const yn = state.default ? '[Y/n]' : '[y/N]'
  lines.push(`> ${yn}`)
  return lines.join('\n') + '\n'
}
