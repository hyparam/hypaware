// @ts-check

import { validateAttachSection, validateBackfillSection } from '../../codex/src/config.js'

/** @import { ValidationError, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js' */

export const OPENCODE_CONFIG_SECTION = 'opencode'
export const DEFAULT_OPENCODE_PORT = 4320

/** @param {unknown} value @returns {ValidationResult} */
export function validateOpenCodeConfig(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ pointer: '', message: 'opencode config must be an object' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  /** @type {ValidationError[]} */
  const errors = [
    ...validateBackfillSection(raw.backfill, '/backfill'),
    ...validateAttachSection(raw.attach, '/attach'),
  ]
  if (raw.listen_port !== undefined) {
    if (!Number.isInteger(raw.listen_port) || Number(raw.listen_port) < 1 || Number(raw.listen_port) > 65535) {
      errors.push({ pointer: '/listen_port', message: 'listen_port must be an integer from 1 to 65535' })
    }
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'backfill' && key !== 'attach' && key !== 'listen_port') {
      errors.push({ pointer: `/${key}`, message: `unknown opencode key '${key}'` })
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}

/** @param {Record<string, unknown>} config */
export function opencodeListenPort(config) {
  return Number.isInteger(config.listen_port) ? Number(config.listen_port) : DEFAULT_OPENCODE_PORT
}
