// @ts-check

/**
 * @import { State, MultiselectState, SelectState, TextState, MultiSelectOption, MultiSelectSpec, SelectSpecOption, SelectSpec, TextSpec } from '../../../../src/core/cli/tui/types.js'
 */

import process from 'node:process'

import { run, PromptCancelledError } from './runtime.js'

export { PromptCancelledError }

/**
 * Render an interactive multi-select prompt with checkbox toggling and
 * resolve to the array of `value`s the user confirmed, in the order
 * they appear in `options`.
 *
 * @param {MultiSelectSpec} spec
 * @returns {Promise<Array<string|number>>}
 */
export async function multiselect(spec) {
  /** @type {MultiselectState} */
  const initial = {
    kind: 'multiselect',
    title: spec.title,
    options: spec.options.map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.summary !== undefined ? { summary: o.summary } : {}),
      checked: !!o.checked,
      ...(o.disabled ? { disabled: true } : {}),
    })),
    cursor: 0,
    status: 'active',
    ...(spec.hint !== undefined ? { hint: spec.hint } : {}),
    ...(spec.bounds !== undefined ? { bounds: spec.bounds } : {}),
  }
  const io = resolveIo(spec)
  const final = /** @type {MultiselectState} */ (await run(initial, io))
  return final.options.filter((o) => o.checked).map((o) => o.value)
}

/**
 * Render a single-select prompt and resolve to the selected `value`.
 *
 * @param {SelectSpec} spec
 * @returns {Promise<string|number>}
 */
export async function select(spec) {
  if (spec.options.length === 0) {
    throw new Error('select() requires at least one option')
  }
  const defaultIdx = spec.default !== undefined
    ? Math.max(0, spec.options.findIndex((o) => o.value === spec.default))
    : 0
  /** @type {SelectState} */
  const initial = {
    kind: 'select',
    title: spec.title,
    options: spec.options.map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.summary !== undefined ? { summary: o.summary } : {}),
    })),
    cursor: defaultIdx,
    status: 'active',
    ...(spec.hint !== undefined ? { hint: spec.hint } : {}),
  }
  const io = resolveIo(spec)
  const final = /** @type {SelectState} */ (await run(initial, io))
  return final.options[final.cursor].value
}

/**
 * Render a single-line text prompt and resolve to the string the user
 * confirmed. When `default` is set and the user presses enter with an
 * empty buffer, the default is returned.
 *
 * @param {TextSpec} spec
 * @returns {Promise<string>}
 */
export async function text(spec) {
  /** @type {TextState} */
  const initial = {
    kind: 'text',
    title: spec.title,
    value: '',
    mask: spec.mask === true,
    status: 'active',
    ...(spec.hint !== undefined ? { hint: spec.hint } : {}),
    ...(spec.default !== undefined ? { default: spec.default } : {}),
    ...(spec.validate !== undefined ? { validate: spec.validate } : {}),
  }
  const io = resolveIo(spec)
  const final = /** @type {TextState} */ (await run(initial, io))
  return final.value
}

/**
 * @param {{ stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, env?: NodeJS.ProcessEnv, clearOnResolve?: boolean }} spec
 * @returns {{ stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, env?: NodeJS.ProcessEnv, clearOnResolve?: boolean }}
 */
function resolveIo(spec) {
  return {
    stdin:  spec.stdin  ?? process.stdin,
    stdout: spec.stdout ?? process.stdout,
    ...(spec.env !== undefined ? { env: spec.env } : {}),
    ...(spec.clearOnResolve ? { clearOnResolve: true } : {}),
  }
}
