// @ts-check

import test from 'node:test'
import assert from 'node:assert/strict'

import { reduce } from '../../../../src/core/cli/tui/keypress.js'

/**
 * @import { MultiselectState, SelectState, TextState, ConfirmState } from '../../../../src/core/cli/tui/types.js'
 */

/** @returns {MultiselectState} */
function multiselectState(overrides = {}) {
  return {
    kind: 'multiselect',
    title: 'pick',
    options: [
      { value: 'a', label: 'A', checked: false },
      { value: 'b', label: 'B', checked: false },
      { value: 'c', label: 'C', checked: false },
    ],
    cursor: 0,
    status: 'active',
    ...overrides,
  }
}

/** @returns {SelectState} */
function selectState(overrides = {}) {
  return {
    kind: 'select',
    title: 'pick',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
      { value: 'c', label: 'C' },
    ],
    cursor: 0,
    status: 'active',
    ...overrides,
  }
}

/** @returns {TextState} */
function textState(overrides = {}) {
  return {
    kind: 'text',
    title: 'name',
    value: '',
    mask: false,
    status: 'active',
    ...overrides,
  }
}

/** @returns {ConfirmState} */
function confirmState(overrides = {}) {
  return {
    kind: 'confirm',
    title: 'go?',
    default: true,
    status: 'active',
    ...overrides,
  }
}

test('reduce: ctrl+c cancels any active state', () => {
  for (const s of [multiselectState(), selectState(), textState(), confirmState()]) {
    const next = reduce(s, { name: 'c', ctrl: true })
    assert.equal(next.status, 'cancelled')
  }
})

test('reduce: escape cancels any active state', () => {
  for (const s of [multiselectState(), selectState(), textState(), confirmState()]) {
    const next = reduce(s, { name: 'escape' })
    assert.equal(next.status, 'cancelled')
  }
})

test('reduce: terminal states ignore further input', () => {
  const resolved = { ...multiselectState(), status: /** @type {const} */ ('resolved') }
  const cancelled = { ...multiselectState(), status: /** @type {const} */ ('cancelled') }
  assert.strictEqual(reduce(resolved, { name: 'down' }), resolved)
  assert.strictEqual(reduce(cancelled, { name: 'space' }), cancelled)
})

test('multiselect: arrow down moves cursor and wraps', () => {
  let s = multiselectState({ cursor: 0 })
  s = /** @type {any} */ (reduce(s, { name: 'down' }))
  assert.equal(s.cursor, 1)
  s = /** @type {any} */ (reduce(s, { name: 'down' }))
  assert.equal(s.cursor, 2)
  s = /** @type {any} */ (reduce(s, { name: 'down' }))
  assert.equal(s.cursor, 0)
})

test('multiselect: arrow up wraps to last option', () => {
  const s = multiselectState({ cursor: 0 })
  const next = /** @type {any} */ (reduce(s, { name: 'up' }))
  assert.equal(next.cursor, 2)
})

test('multiselect: j and k are aliases for down and up', () => {
  let s = multiselectState({ cursor: 1 })
  s = /** @type {any} */ (reduce(s, { name: 'k' }))
  assert.equal(s.cursor, 0)
  s = /** @type {any} */ (reduce(s, { name: 'j' }))
  assert.equal(s.cursor, 1)
})

test('multiselect: space toggles current option', () => {
  let s = multiselectState({ cursor: 1 })
  s = /** @type {any} */ (reduce(s, { name: 'space' }))
  assert.equal(s.options[1].checked, true)
  assert.equal(s.options[0].checked, false)
  assert.equal(s.options[2].checked, false)
  s = /** @type {any} */ (reduce(s, { name: 'space' }))
  assert.equal(s.options[1].checked, false)
})

test('multiselect: a toggles all on then all off', () => {
  let s = multiselectState()
  s = /** @type {any} */ (reduce(s, { name: 'a' }))
  assert.deepEqual(s.options.map((/** @type {any} */ o) => o.checked), [true, true, true])
  s = /** @type {any} */ (reduce(s, { name: 'a' }))
  assert.deepEqual(s.options.map((/** @type {any} */ o) => o.checked), [false, false, false])
})

test('multiselect: a with mixed selection checks all', () => {
  const s = multiselectState({
    options: [
      { value: 'a', label: 'A', checked: true },
      { value: 'b', label: 'B', checked: false },
    ],
  })
  const next = /** @type {any} */ (reduce(s, { name: 'a' }))
  assert.deepEqual(next.options.map((/** @type {any} */ o) => o.checked), [true, true])
})

test('multiselect: digit keys 1-3 jump to in-range index', () => {
  const s = multiselectState()
  for (let i = 1; i <= 3; i++) {
    const next = /** @type {any} */ (reduce(s, { name: String(i) }))
    assert.equal(next.cursor, i - 1)
  }
})

test('multiselect: digit out of range is a no-op', () => {
  const s = multiselectState()
  const next = reduce(s, { name: '9' })
  assert.strictEqual(next, s)
})

test('multiselect: enter without bounds resolves', () => {
  let s = multiselectState()
  s = /** @type {any} */ (reduce(s, { name: 'space' }))
  s = /** @type {any} */ (reduce(s, { name: 'return' }))
  assert.equal(s.status, 'resolved')
})

test('multiselect: enter below bounds.min sets error and stays active', () => {
  const s = multiselectState({ bounds: { min: 2 } })
  const next = /** @type {any} */ (reduce(s, { name: 'return' }))
  assert.equal(next.status, 'active')
  assert.match(next.error, /at least 2/)
})

test('multiselect: enter above bounds.max sets error and stays active', () => {
  /** @type {any} */
  let s = multiselectState({
    bounds: { max: 1 },
    options: [
      { value: 'a', label: 'A', checked: true },
      { value: 'b', label: 'B', checked: true },
    ],
    cursor: 0,
  })
  s = reduce(s, { name: 'return' })
  assert.equal(s.status, 'active')
  assert.match(s.error, /at most 1/)
})

test('multiselect: bounds error clears on next cursor move', () => {
  /** @type {any} */
  let s = multiselectState({ bounds: { min: 1 }, cursor: 0 })
  s = reduce(s, { name: 'return' })
  assert.ok(s.error)
  s = reduce(s, { name: 'down' })
  assert.equal(s.error, undefined)
})

test('multiselect: empty options + enter with bounds.min still rejects', () => {
  /** @type {any} */
  const s = multiselectState({ options: [], bounds: { min: 1 } })
  const next = /** @type {any} */ (reduce(s, { name: 'return' }))
  assert.equal(next.status, 'active')
  assert.match(next.error, /at least 1/)
})

test('select: cursor moves and wraps; enter resolves', () => {
  let s = selectState({ cursor: 0 })
  s = /** @type {any} */ (reduce(s, { name: 'up' }))
  assert.equal(s.cursor, 2)
  s = /** @type {any} */ (reduce(s, { name: 'down' }))
  assert.equal(s.cursor, 0)
  s = /** @type {any} */ (reduce(s, { name: 'return' }))
  assert.equal(s.status, 'resolved')
})

test('select: space does not toggle (single-select has no toggle)', () => {
  const s = selectState()
  const next = reduce(s, { name: 'space' })
  assert.strictEqual(next, s)
})

test('text: printable characters append to value', () => {
  let s = textState()
  s = /** @type {any} */ (reduce(s, { sequence: 'p' }))
  s = /** @type {any} */ (reduce(s, { sequence: 'h' }))
  s = /** @type {any} */ (reduce(s, { sequence: 'i' }))
  s = /** @type {any} */ (reduce(s, { sequence: 'l' }))
  assert.equal(s.value, 'phil')
})

test('text: backspace removes the last char and stops at empty', () => {
  let s = textState({ value: 'abc' })
  s = /** @type {any} */ (reduce(s, { name: 'backspace' }))
  assert.equal(s.value, 'ab')
  s = /** @type {any} */ (reduce(s, { name: 'backspace' }))
  s = /** @type {any} */ (reduce(s, { name: 'backspace' }))
  assert.equal(s.value, '')
  const noop = reduce(s, { name: 'backspace' })
  assert.strictEqual(noop, s)
})

test('text: control characters are ignored as input', () => {
  const s = textState()
  const next = reduce(s, { sequence: '\x1b[A' })
  assert.strictEqual(next, s)
  const next2 = reduce(s, { sequence: 'x', ctrl: true })
  assert.strictEqual(next2, s)
})

test('text: enter without validate resolves with current value', () => {
  const s = textState({ value: 'hi' })
  const next = /** @type {any} */ (reduce(s, { name: 'return' }))
  assert.equal(next.status, 'resolved')
  assert.equal(next.value, 'hi')
})

test('text: enter on empty value applies default', () => {
  const s = textState({ default: 'fallback' })
  const next = /** @type {any} */ (reduce(s, { name: 'return' }))
  assert.equal(next.status, 'resolved')
  assert.equal(next.value, 'fallback')
})

test('text: enter when validate rejects sets error and stays active', () => {
  const s = textState({ value: '', validate: (v) => (v.length === 0 ? 'required' : null) })
  const next = /** @type {any} */ (reduce(s, { name: 'return' }))
  assert.equal(next.status, 'active')
  assert.equal(next.error, 'required')
})

test('text: mask flag does not change the value field; only render relies on it', () => {
  let s = textState({ mask: true })
  s = /** @type {any} */ (reduce(s, { sequence: 's' }))
  s = /** @type {any} */ (reduce(s, { sequence: 'e' }))
  s = /** @type {any} */ (reduce(s, { sequence: 'c' }))
  assert.equal(s.value, 'sec')
  assert.equal(s.mask, true)
})

test('confirm: y and Y resolve to true', () => {
  for (const ch of ['y', 'Y']) {
    const s = confirmState({ default: false })
    const next = /** @type {any} */ (reduce(s, { sequence: ch }))
    assert.equal(next.status, 'resolved')
    assert.equal(next.value, true)
  }
})

test('confirm: n and N resolve to false', () => {
  for (const ch of ['n', 'N']) {
    const s = confirmState({ default: true })
    const next = /** @type {any} */ (reduce(s, { sequence: ch }))
    assert.equal(next.status, 'resolved')
    assert.equal(next.value, false)
  }
})

test('confirm: enter resolves with default', () => {
  for (const def of [true, false]) {
    const s = confirmState({ default: def })
    const next = /** @type {any} */ (reduce(s, { name: 'return' }))
    assert.equal(next.status, 'resolved')
    assert.equal(next.value, def)
  }
})

test('confirm: other letters are no-ops', () => {
  const s = confirmState()
  const next = reduce(s, { sequence: 'a' })
  assert.strictEqual(next, s)
})
