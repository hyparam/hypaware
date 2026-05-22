// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { render } from '../../../../src/core/cli/tui/render.js'

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

test('multiselect: empty options renders title + hint without rows', () => {
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
  assert.equal(out.split('\n').filter((l) => l.startsWith('>') || l.startsWith(' ')).length, 0)
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

test('confirm: render shows [Y/n] when default is true', () => {
  /** @type {any} */
  const state = {
    kind: 'confirm',
    title: 'go?',
    default: true,
    status: 'active',
  }
  const out = render(state, { color: false })
  assert.match(out, /\[Y\/n\]/)
})

test('confirm: render shows [y/N] when default is false', () => {
  /** @type {any} */
  const state = {
    kind: 'confirm',
    title: 'go?',
    default: false,
    status: 'active',
  }
  const out = render(state, { color: false })
  assert.match(out, /\[y\/N\]/)
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
