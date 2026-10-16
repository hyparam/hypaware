// @ts-check

import { validateAttachSection } from '../../codex/src/config.js'
import { validateBackfillSection } from '../../claude/src/config.js'

/** @import { ValidationResult } from '../../../../hypaware-plugin-kernel-types.js' */

export const PI_CONFIG_SECTION = 'pi'
export const DEFAULT_PI_PORT = 4322

/** @param {unknown} value @returns {ValidationResult} */
export function validatePiConfig(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ pointer: '', message: 'pi config must be an object' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  const errors = [...validateAttachSection(raw.attach, '/attach'), ...validateBackfillSection(raw.backfill, '/backfill')]
  if (raw.listen_port !== undefined && (!Number.isInteger(raw.listen_port) || Number(raw.listen_port) < 1 || Number(raw.listen_port) > 65535)) {
    errors.push({ pointer: '/listen_port', message: 'listen_port must be an integer from 1 to 65535' })
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'attach' && key !== 'listen_port' && key !== 'backfill') errors.push({ pointer: `/${key}`, message: `unknown pi key '${key}'` })
  }
  return errors.length ? { ok: false, errors } : { ok: true }
}

/** @param {Record<string, unknown>} config */
export function piListenPort(config) {
  return Number.isInteger(config.listen_port) ? Number(config.listen_port) : DEFAULT_PI_PORT
}
