// @ts-check

/**
 * Config validation for the `@hypaware/claude-desktop` plugin's
 * `claude_desktop` section. Pure and dependency-free.
 *
 * @import { ValidationError, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 */

/** Manifest `config_sections[].section` name this validator backs. */
export const CLAUDE_DESKTOP_CONFIG_SECTION = 'claude_desktop'

/**
 * Validate the `claude_desktop` config slice. Unknown keys are
 * rejected so typos surface at apply time, not as a silently wrong
 * rendered profile.
 *
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validateClaudeDesktopConfig(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ pointer: '', message: 'claude_desktop config must be an object' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  /** @type {ValidationError[]} */
  const errors = []

  if (raw.models !== undefined) {
    const ok = Array.isArray(raw.models)
      && raw.models.length > 0
      && raw.models.every((m) => typeof m === 'string' && m.length > 0)
    if (!ok) {
      errors.push({ pointer: '/models', message: 'models must be a non-empty array of non-empty strings' })
    }
  }
  for (const key of ['endpoint', 'helper_path', 'bundle_id']) {
    const v = raw[key]
    if (v !== undefined && (typeof v !== 'string' || v.length === 0)) {
      errors.push({ pointer: `/${key}`, message: `${key} must be a non-empty string` })
    }
  }
  for (const key of Object.keys(raw)) {
    if (!['models', 'endpoint', 'helper_path', 'bundle_id'].includes(key)) {
      errors.push({ pointer: `/${key}`, message: `unknown claude_desktop key '${key}'` })
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true }
}
