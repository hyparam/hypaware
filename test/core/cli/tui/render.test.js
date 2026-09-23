// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { render } from '../../../../src/core/cli/tui/render.js'
import { countPhysicalRows } from '../../../../src/core/cli/tui/runtime.js'

const COLOR_RE = /\x1b\[\d{1,3}(;\d{1,3})*m/

test('multiselect: NO_COLOR frame contains no SGR escapes', () => {
  /** @type {any} */
  const state = {
    kind: 'multiselect',
    title: 'pick',
    options: [
      { value: 'a', label: 'A', checked: true },
      { value: 'b', label: 'B', checked: false, summary: 'detail b' },
    ],
    cursor: 1,
    status: 'active',
  }
  const out = render(state, { color: false })
  assert.doesNotMatch(out, COLOR_RE)
})

test('multiselect: colored frame contains at least one SGR escape', () => {
  /** @type {any} */
  const state = {
    kind: 'multiselect',
    title: 'pick',
    options: [{ value: 'a', label: 'A', checked: false }],
    cursor: 0,
    status: 'active',
  }
  const out = render(state, { color: true })
  assert.match(out, COLOR_RE)
})

test('multiselect: cursor row uses pointer ">", others use space', () => {
  /** @type {any} */
  const state = {
    kind: 'multiselect',
    title: 'pick',
    options: [
      { value: 'a', label: 'A', checked: false },
      { value: 'b', label: 'B', checked: true },
      { value: 'c', label: 'C', checked: false },
    ],
    cursor: 1,
    status: 'active',
  }
  const lines = render(state, { color: false }).split('\n')
  assert.ok(lines.some((l) => l.startsWith('  [ ] A')))
  assert.ok(lines.some((l) => l.startsWith('> [x] B')))
  assert.ok(lines.some((l) => l.startsWith('  [ ] C')))
})

test('multiselect: a disabled row renders its label and checkbox', () => {
  /** @type {any} */
  const state = {
    kind: 'multiselect',
    title: 'pick',
    options: [
      { value: 'locked', label: 'Claude · set by your team', checked: true, disabled: true },
      { value: 'b', label: 'B', checked: false },
    ],
    cursor: 0,
    status: 'active',
  }
  const lines = render(state, { color: false }).split('\n')
  assert.ok(lines.some((l) => l.includes('[x] Claude · set by your team')))
})

test('multiselect: a disabled row under the cursor renders dim, not the cyan cursor color', () => {
  /** @type {any} */
  const state = {
    kind: 'multiselect',
    title: 'pick',
    options: [{ value: 'locked', label: 'Locked', checked: true, disabled: true }],
    cursor: 0,
    status: 'active',
  }
  const out = render(state, { color: true })
  // Dim (2m), never the cursor cyan (36m), even though the cursor rests on it.
  assert.match(out, /\x1b\[2m/)
  assert.doesNotMatch(out, /\x1b\[36m/)
})

test('multiselect: summary lines appear under labels when set', () => {
  /** @type {any} */
  const state = {
    kind: 'multiselect',
    title: 'pick',
    options: [
      { value: 'a', label: 'A', checked: false, summary: 'detail of A' },
      { value: 'b', label: 'B', checked: false },
    ],
    cursor: 1,
    status: 'active',
  }
  const out = render(state, { color: false })
  assert.match(out, /  \[ \] A\n      detail of A\n/)
})

test('multiselect: empty options renders title + hint + submit row without option rows', () => {
  /** @type {any} */
  const state = {
    kind: 'multiselect',
    title: 'nothing',
    options: [],
    cursor: 0,
    status: 'active',
  }
  const out = render(state, { color: false })
  assert.match(out, /^nothing\n/)
  assert.doesNotMatch(out, /\[x\]|\[ \] /)
  // With no options the cursor rests on the submit row.
  assert.match(out, /> \[ Submit \]\n/)
})

test('multiselect: submit row renders below the options, pointer-free when not focused', () => {
  /** @type {any} */
  const state = {
    kind: 'multiselect',
    title: 'pick',
    options: [
      { value: 'a', label: 'A', checked: true },
      { value: 'b', label: 'B', checked: false },
    ],
    cursor: 0,
    status: 'active',
  }
  const lines = render(state, { color: false }).split('\n')
  const submitIdx = lines.findIndex((l) => l === '  [ Submit ]')
  const lastOptionIdx = lines.findIndex((l) => l.includes('[ ] B'))
  assert.ok(submitIdx > lastOptionIdx, 'submit row must render after the options')
  assert.equal(lines[submitIdx - 1], '', 'submit row is separated by a blank line')
})

test('multiselect: submit row carries the pointer when the cursor is on it', () => {
  /** @type {any} */
  const state = {
    kind: 'multiselect',
    title: 'pick',
    options: [
      { value: 'a', label: 'A', checked: true },
      { value: 'b', label: 'B', checked: false },
    ],
    cursor: 2,
    status: 'active',
  }
  const lines = render(state, { color: false }).split('\n')
  assert.ok(lines.some((l) => l === '> [ Submit ]'))
  assert.ok(lines.every((l) => !l.startsWith('> [x]') && !l.startsWith('> [ ] ')))
})

test('multiselect: error line is included when set', () => {
  /** @type {any} */
  const state = {
    kind: 'multiselect',
    title: 'pick',
    options: [{ value: 'a', label: 'A', checked: false }],
    cursor: 0,
    status: 'active',
    error: 'select at least 1',
  }
  const out = render(state, { color: false })
  assert.match(out, /select at least 1/)
})

test('multiselect: frame ends with a single trailing newline', () => {
  /** @type {any} */
  const state = {
    kind: 'multiselect',
    title: 'pick',
    options: [{ value: 'a', label: 'A', checked: false }],
    cursor: 0,
    status: 'active',
  }
  const out = render(state, { color: false })
  assert.ok(out.endsWith('\n'))
  assert.ok(!out.endsWith('\n\n'))
})

test('select: renders pointer-and-label rows', () => {
  /** @type {any} */
  const state = {
    kind: 'select',
    title: 'choose',
    options: [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ],
    cursor: 1,
    status: 'active',
  }
  const out = render(state, { color: false })
  assert.match(out, /^choose\n/)
  assert.match(out, /  Alpha\n/)
  assert.match(out, /> Beta\n/)
})

test('text: render shows "> " followed by the value', () => {
  /** @type {any} */
  const state = {
    kind: 'text',
    title: 'name',
    value: 'phil',
    mask: false,
    status: 'active',
  }
  const out = render(state, { color: false })
  assert.match(out, /> phil\n/)
})

test('text: render masks value when mask is true', () => {
  /** @type {any} */
  const state = {
    kind: 'text',
    title: 'token',
    value: 'sek',
    mask: true,
    status: 'active',
  }
  const out = render(state, { color: false })
  assert.match(out, /> \*\*\*\n/)
  assert.doesNotMatch(out, /sek/)
})

test('text: default hint shown when value is empty', () => {
  /** @type {any} */
  const state = {
    kind: 'text',
    title: 'name',
    value: '',
    default: 'fallback',
    mask: false,
    status: 'active',
  }
  const out = render(state, { color: false })
  assert.match(out, /\(default: fallback\)/)
})

test('text: default hint disappears once value is typed', () => {
  /** @type {any} */
  const state = {
    kind: 'text',
    title: 'name',
    value: 'p',
    default: 'fallback',
    mask: false,
    status: 'active',
  }
  const out = render(state, { color: false })
  assert.doesNotMatch(out, /\(default: fallback\)/)
})



test('render: hint override replaces default hint line', () => {
  /** @type {any} */
  const state = {
    kind: 'multiselect',
    title: 'pick',
    hint: 'CUSTOM HINT',
    options: [{ value: 'a', label: 'A', checked: false }],
    cursor: 0,
    status: 'active',
  }
  const out = render(state, { color: false })
  assert.match(out, /CUSTOM HINT/)
  assert.doesNotMatch(out, /space toggle/)
})

// Context lines (LLP 0190): the wizard's defaults gates list what they are
// about to accept between the title and the hint, verbatim and unstyled.
test('render: items render verbatim between the title and the hint', () => {
  /** @type {any} */
  const state = {
    kind: 'select',
    title: 'HypAware will record:',
    items: ['  Claude Code', '  OpenClaw · set by your team'],
    options: [{ value: 'accept', label: 'Record all' }],
    cursor: 0,
    status: 'active',
  }
  const lines = render(state, { color: false }).split('\n')
  assert.equal(lines[0], 'HypAware will record:')
  assert.equal(lines[1], '  Claude Code')
  assert.equal(lines[2], '  OpenClaw · set by your team')
  assert.match(lines[3], /enter pick/)
})

// The frame (LLP 0198 #frame): the closing ask draws as its own screen.
test('box: frame is wrapped in a border, every row padded to one width', () => {
  /** @type {any} */
  const state = {
    kind: 'select',
    title: 'Ask your first question',
    box: true,
    options: [
      { value: 'a', label: 'What AI tasks cost the most tokens this week?' },
      { value: 'b', label: 'Not now' },
    ],
    cursor: 0,
    status: 'active',
  }
  const lines = render(state, { color: false }).split('\n')
  lines.pop() // trailing newline
  assert.match(lines[0], /^╭─+╮$/)
  assert.match(lines[lines.length - 1], /^╰─+╯$/)
  const width = lines[0].length
  for (const line of lines.slice(1, -1)) {
    assert.equal(line.length, width, `row is padded to the frame width: ${JSON.stringify(line)}`)
    assert.ok(line.startsWith('│ ') && line.endsWith(' │'), `row is bordered: ${JSON.stringify(line)}`)
  }
  assert.ok(lines.some((l) => l.includes('> What AI tasks cost the most tokens this week?')))
})

test('box: a frame wider than the terminal is dropped, not soft-wrapped', () => {
  /** @type {any} */
  const state = {
    kind: 'select',
    title: 'Ask your first question',
    box: true,
    options: [{ value: 'a', label: 'What AI tasks cost the most tokens this week?' }],
    cursor: 0,
    status: 'active',
  }
  const out = render(state, { color: false, columns: 20 })
  assert.doesNotMatch(out, /[╭╮╰╯│]/)
  assert.match(out, /^Ask your first question\n/)
})

test('box: border width measures visible columns, not style escapes', () => {
  /** @type {any} */
  const state = {
    kind: 'select',
    title: 'Pick',
    box: true,
    options: [{ value: 'a', label: 'Alpha' }],
    cursor: 0,
    status: 'active',
  }
  const plain = render(state, { color: false }).split('\n')[0]
  const colored = render(state, { color: true }).split('\n')[0]
  assert.equal(colored.replace(/\x1b\[[0-9;]*m/g, '').length, plain.length)
})

test('box: an unboxed state renders exactly as it did before the field existed', () => {
  /** @type {any} */
  const state = {
    kind: 'select',
    title: 'Pick one',
    options: [{ value: 'a', label: 'A' }],
    cursor: 0,
    status: 'active',
  }
  const out = render(state, { color: false, columns: 80 })
  assert.equal(out, render(state, { color: false }))
  assert.doesNotMatch(out, /[╭╮╰╯│]/)
})

test('render: a state without items renders exactly as it does today', () => {
  /** @type {any} */
  const state = {
    kind: 'select',
    title: 'Pick one',
    options: [{ value: 'a', label: 'A' }],
    cursor: 0,
    status: 'active',
  }
  const lines = render(state, { color: false }).split('\n')
  assert.equal(lines[0], 'Pick one')
  assert.match(lines[1], /enter pick/)
})

/**
 * The picker `hyp report fix` builds (LLP 0414 #listing-is-the-picker): one
 * option per listed report, label and summary each, boxed. The only select
 * whose height is set by server data rather than by the code.
 *
 * @param {number} count
 * @param {number} cursor
 * @returns {any}
 */
function reportPicker(count, cursor) {
  return {
    kind: 'select',
    box: true,
    title: 'Which report?',
    options: Array.from({ length: count }, (_, i) => ({
      value: `r${String(i).padStart(2, '0')}`,
      label: `rec-${String(i).padStart(2, '0')}`,
      summary: `2026-09-01  team/weekly  3 recommendations (${i})`,
    })),
    cursor,
    status: 'active',
  }
}

test('select: a frame taller than the terminal is windowed to fit it', () => {
  for (const rows of [24, 40]) {
    const frame = render(reportPicker(60, 0), { color: false, columns: 80, rows })
    const drawn = countPhysicalRows(frame, 80)
    // One row under the terminal, not level with it: the frame ends in a
    // newline, so a frame that filled the height exactly would scroll its own
    // top row away before the runtime's cursor-up could reach it.
    assert.ok(drawn <= rows - 1, `frame of ${drawn} rows must fit a terminal of ${rows}`)
    // Not windowed to nothing: the terminal's height is what it fills.
    assert.ok(drawn > rows / 2, `frame of ${drawn} rows uses the terminal of ${rows}`)
  }
})

test('select: the option under the cursor stays drawn as the cursor leaves the window', () => {
  for (const cursor of [0, 7, 30, 58, 59]) {
    const frame = render(reportPicker(60, cursor), { color: false, columns: 80, rows: 24 })
    const label = `rec-${String(cursor).padStart(2, '0')}`
    assert.ok(
      frame.split('\n').some((l) => l.includes(`> ${label}`)),
      `cursor row ${label} is drawn`,
    )
    assert.ok(countPhysicalRows(frame, 80) <= 23, `cursor ${cursor} keeps the frame inside the terminal`)
  }
})

test('select: a windowed frame says which options it is showing', () => {
  const frame = render(reportPicker(60, 0), { color: false, columns: 80, rows: 24 })
  assert.match(frame, /showing 1-\d+ of 60/)
})

test('select: options that all fit render whole, with no window line', () => {
  const frame = render(reportPicker(4, 0), { color: false, columns: 80, rows: 24 })
  assert.equal(frame, render(reportPicker(4, 0), { color: false, columns: 80 }))
  assert.doesNotMatch(frame, /showing/)
})

test('select: the window line is charged at the rows it takes, not a flat one', () => {
  // On a narrow terminal 'showing 11-13 of 20' wraps onto two rows.
  // Charging it a flat one put the frame back level with the terminal,
  // which is the exact height the reserved cursor row exists to stay
  // under: the runtime then rewinds by the whole terminal height after it
  // has scrolled, and the cursor-up clamps inside the frame again.
  //
  // Only frames that drop more than nothing are in scope. A frame whose
  // chrome plus one option already exceeds the height has no window to
  // choose and is over whatever the legend costs.
  let checked = 0
  for (const columns of [16, 18, 20, 24, 30]) {
    for (const rows of [10, 12, 14]) {
      const frame = render(
        {
          kind: 'select',
          title: 'Pick',
          options: Array.from({ length: 20 }, (_, i) => ({ value: `v${i}`, label: `L${i}` })),
          cursor: 10,
          status: 'active',
        },
        { color: false, columns, rows },
      )
      const shown = /showing (\d+)-(\d+) of 20/.exec(frame)
      assert.ok(shown, `${columns}x${rows} is windowed`)
      if (Number(shown[2]) - Number(shown[1]) + 1 < 2) continue
      checked += 1
      const drawn = countPhysicalRows(frame, columns)
      assert.ok(drawn <= rows - 1, `${columns}x${rows}: frame of ${drawn} rows must leave the cursor row free`)
    }
  }
  assert.ok(checked >= 5, `expected several windowed frames to check, got ${checked}`)
})

test('select: an unknown terminal height renders every option, as before', () => {
  const frame = render(reportPicker(60, 0), { color: false, columns: 80 })
  for (let i = 0; i < 60; i++) {
    assert.ok(frame.includes(`rec-${String(i).padStart(2, '0')}`), `option ${i} is drawn`)
  }
  assert.doesNotMatch(frame, /showing/)
})
