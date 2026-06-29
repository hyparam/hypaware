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
 * @typedef {Object} Key
 * @property {string} [name]      Special name: 'up', 'down', 'space',
 *                                 'return', 'escape', 'backspace', or a
 *                                 single character ('a', '1', ...).
 * @property {string} [sequence]  Raw character(s): used for printable
 *                                 text input in `text` mode and the y/n
 *                                 chars in `confirm` mode.
 * @property {boolean} [ctrl]
 * @property {boolean} [shift]
 * @property {boolean} [meta]
 */

/**
 * @typedef {Object} MultiselectOption
 * @property {string|number} value
 * @property {string} label
 * @property {string} [summary]
 * @property {boolean} checked
 */

/**
 * @typedef {Object} MultiselectState
 * @property {'multiselect'} kind
 * @property {string} title
 * @property {string} [hint]
 * @property {MultiselectOption[]} options
 * @property {number} cursor
 * @property {{ min?: number, max?: number }} [bounds]
 * @property {'active'|'resolved'|'cancelled'} status
 * @property {string} [error]
 */

/**
 * @typedef {Object} SelectOption
 * @property {string|number} value
 * @property {string} label
 * @property {string} [summary]
 */

/**
 * @typedef {Object} SelectState
 * @property {'select'} kind
 * @property {string} title
 * @property {string} [hint]
 * @property {SelectOption[]} options
 * @property {number} cursor
 * @property {'active'|'resolved'|'cancelled'} status
 */

/**
 * @typedef {Object} TextState
 * @property {'text'} kind
 * @property {string} title
 * @property {string} [hint]
 * @property {string} [default]
 * @property {string} value
 * @property {boolean} mask
 * @property {((v: string) => string | null)} [validate]
 * @property {'active'|'resolved'|'cancelled'} status
 * @property {string} [error]
 */

/**
 * @typedef {Object} ConfirmState
 * @property {'confirm'} kind
 * @property {string} title
 * @property {string} [hint]
 * @property {boolean} default
 * @property {boolean} [value]    Set when resolved.
 * @property {'active'|'resolved'|'cancelled'} status
 */

/** @typedef {MultiselectState|SelectState|TextState|ConfirmState} State */

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
    return cancelledOf(state)
  }
  switch (state.kind) {
    case 'multiselect': return reduceMultiselect(state, key)
    case 'select':      return reduceSelect(state, key)
    case 'text':        return reduceText(state, key)
    case 'confirm':     return reduceConfirm(state, key)
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
  if (key.name === 'return') {
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
  if (n === 0) return state
  switch (key.name) {
    case 'up':
    case 'k':
      return { ...state, cursor: (state.cursor - 1 + n) % n, error: undefined }
    case 'down':
    case 'j':
      return { ...state, cursor: (state.cursor + 1) % n, error: undefined }
    case 'space': {
      const opts = state.options.slice()
      const cur = opts[state.cursor]
      opts[state.cursor] = { ...cur, checked: !cur.checked }
      return { ...state, options: opts, error: undefined }
    }
    case 'a': {
      const allChecked = state.options.every((o) => o.checked)
      const opts = state.options.map((o) => ({ ...o, checked: !allChecked }))
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

/**
 * @param {ConfirmState} state
 * @param {Key} key
 * @returns {ConfirmState}
 */
function reduceConfirm(state, key) {
  if (key.sequence === 'y' || key.sequence === 'Y') {
    return { ...state, status: 'resolved', value: true }
  }
  if (key.sequence === 'n' || key.sequence === 'N') {
    return { ...state, status: 'resolved', value: false }
  }
  if (key.name === 'return') {
    return { ...state, status: 'resolved', value: state.default }
  }
  return state
}
