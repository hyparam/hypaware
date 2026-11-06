// @ts-check

import { validateAttachSection } from '../../codex/src/config.js'

/** @import { ValidationError, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js' */

export const LANGGRAPH_CONFIG_SECTION = 'langgraph'
export const DEFAULT_LANGGRAPH_PORT = 4323

/** @param {unknown} value @returns {ValidationResult} */
export function validateLangGraphConfig(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ pointer: '', message: 'langgraph config must be an object' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  /** @type {ValidationError[]} */
  const errors = [
    ...validateAttachSection(raw.attach, '/attach'),
  ]
  if (raw.listen_port !== undefined) {
    if (!Number.isInteger(raw.listen_port) || Number(raw.listen_port) < 1 || Number(raw.listen_port) > 65535) {
      errors.push({ pointer: '/listen_port', message: 'listen_port must be an integer from 1 to 65535' })
    }
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'attach' && key !== 'listen_port') {
      errors.push({ pointer: `/${key}`, message: `unknown langgraph key '${key}'` })
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}

/** @param {Record<string, unknown>} config */
export function langgraphListenPort(config) {
  return Number.isInteger(config.listen_port) ? Number(config.listen_port) : DEFAULT_LANGGRAPH_PORT
}
