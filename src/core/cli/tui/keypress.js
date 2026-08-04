// @ts-check

/**
 * Pure reducer for the TUI primitives. The runtime (runtime.js) is
 * responsible for capturing raw key events and routing them through
 * here; this module performs no I/O and never reads from `process.*`.
 *
 * State is intentionally serializable so reducer behavior can be
 * exhaustively driven by synthetic key events in unit tests.
 */

/**
 * @import { Key, MultiselectState, SelectState, TextState, State } from '../../../../src/core/cli/tui/types.js'
 */

/**
 * Apply a single key event to a state and return the next state. Pure:
 * never mutates `state`, never performs I/O.
 *
 * @param {State} state
 * @param {Key} key
 * @returns {State}
 */
export function reduce(state, key) {
  if (state.status !== 'active') return state
  if (key.ctrl && key.name === 'c') {
    return cancelledOf(state)
  }
  if (key.name === 'escape') {
    // Back is opt-in per prompt: only the wizard's step prompts set
    // `allowBack`, so escape keeps meaning cancel everywhere else.
    // Ctrl+C (above) cancels regardless.
    // @ref LLP 0186#esc-back [implements]: escape settles as `backed` on an allowBack prompt; ctrl+c stays the cancel
    if (state.allowBack) return /** @type {State} */ ({ ...state, status: 'backed' })
    return cancelledOf(state)
  }
  switch (state.kind) {
    case 'multiselect': return reduceMultiselect(state, key)
    case 'select':      return reduceSelect(state, key)
    case 'text':        return reduceText(state, key)
  }
}

/**
 * @param {State} state
 * @returns {State}
 */
function cancelledOf(state) {
  return /** @type {State} */ ({ ...state, status: 'cancelled' })
}

/**
 * @param {MultiselectState} state
 * @param {Key} key
 * @returns {MultiselectState}
 */
function reduceMultiselect(state, key) {
  const n = state.options.length
  // The Submit row sits one past the last option (cursor === n): a visible
  // way to finish for people who would not guess that enter confirms from
  // anywhere. Enter keeps its confirm-from-anywhere meaning.
  const rows = n + 1
  if (key.name === 'return') {
    return confirmMultiselect(state)
  }
  switch (key.name) {
    case 'up':
    case 'k':
      return { ...state, cursor: (state.cursor - 1 + rows) % rows, error: undefined }
    case 'down':
    case 'j':
      return { ...state, cursor: (state.cursor + 1) % rows, error: undefined }
    case 'space': {
      // Space on the Submit row activates it, like pressing a button.
      if (state.cursor === n) return confirmMultiselect(state)
      const cur = state.options[state.cursor]
      // A disabled row (e.g. a fleet-locked source) is context-only: the
      // cursor can rest on it, but toggling is a no-op.
      if (cur.disabled) return { ...state, error: undefined }
      const opts = state.options.slice()
      opts[state.cursor] = { ...cur, checked: !cur.checked }
      return { ...state, options: opts, error: undefined }
    }
    case 'a': {
      // Select-all ignores disabled rows: they keep their fixed checked
      // state and never flip with the toggleable rows.
      const toggleable = state.options.filter((o) => !o.disabled)
      const allChecked = toggleable.length > 0 && toggleable.every((o) => o.checked)
      const opts = state.options.map((o) => (o.disabled ? o : { ...o, checked: !allChecked }))
      return { ...state, options: opts, error: undefined }
    }
  }
  if (key.name && /^[1-9]$/.test(key.name)) {
    const idx = Number.parseInt(key.name, 10) - 1
    if (idx >= 0 && idx < n) {
      return { ...state, cursor: idx, error: undefined }
    }
  }
  return state
}

/**
 * Settle a multiselect as resolved, or reject with a bounds error while
 * staying active. Shared by enter (anywhere) and space/enter on the
 * Submit row.
 *
 * @param {MultiselectState} state
 * @returns {MultiselectState}
 */
function confirmMultiselect(state) {
  const selected = state.options.filter((o) => o.checked).length
  const min = state.bounds?.min ?? 0
  const max = state.bounds?.max
  if (selected < min) {
    return { ...state, error: `select at least ${min}` }
  }
  if (typeof max === 'number' && selected > max) {
    return { ...state, error: `select at most ${max}` }
  }
  return { ...state, status: 'resolved', error: undefined }
}

/**
 * @param {SelectState} state
 * @param {Key} key
 * @returns {SelectState}
 */
function reduceSelect(state, key) {
  const n = state.options.length
  if (n === 0) return state
  switch (key.name) {
    case 'up':
    case 'k':
      return { ...state, cursor: (state.cursor - 1 + n) % n }
    case 'down':
    case 'j':
      return { ...state, cursor: (state.cursor + 1) % n }
    case 'return':
      return { ...state, status: 'resolved' }
  }
  return state
}

/**
 * @param {TextState} state
 * @param {Key} key
 * @returns {TextState}
 */
function reduceText(state, key) {
  if (key.name === 'return') {
    const effective = state.value.length > 0 ? state.value : (state.default ?? '')
    if (state.validate) {
      const err = state.validate(effective)
      if (err !== null && err !== undefined && err !== '') {
        return { ...state, error: err }
      }
    }
    return { ...state, value: effective, status: 'resolved', error: undefined }
  }
  if (key.name === 'backspace') {
    if (state.value.length === 0) return state
    return { ...state, value: state.value.slice(0, -1), error: undefined }
  }
  if (key.sequence && !key.ctrl && !key.meta) {
    const code = key.sequence.charCodeAt(0)
    if (code >= 32 && code !== 127) {
      return { ...state, value: state.value + key.sequence, error: undefined }
    }
  }
  return state
}
