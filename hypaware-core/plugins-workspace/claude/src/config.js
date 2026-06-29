// @ts-check

/**
 * Config validation for the `@hypaware/claude` plugin's own `config`
 * block. v1 validates only the optional `backfill` sub-object that drives
 * backfill-on-join: `{ on_join, window_days }`. Every other key (e.g.
 * `proxy`) passes through untouched so existing configs keep working;
 * there is no top-level `backfill` section and nothing new for core to
 * validate.
 *
 * Pure and dependency-free: it returns a `ValidationResult` so it plugs
 * straight into `ctx.configRegistry.registerSection` and is callable from
 * tests without spinning up observability.
 *
 * @import { ValidationError, ValidationResult } from '../../../../collectivus-plugin-kernel-types.d.ts'
 */

/** Manifest `config_sections[].section` name this validator backs. */
export const CLAUDE_CONFIG_SECTION = 'claude'

/**
 * Validate the `@hypaware/claude` plugin config slice. Only the optional
 * `backfill` policy block is checked; unknown sibling keys are ignored so
 * the validator stays additive over the existing config surface.
 *
 * @ref LLP 0037#per-plugin-config-kernel-generic-reconciler [implements]:
 *   backfill policy ({ on_join, window_days }) lives in and is validated
 *   by the source plugin's own config section; the kernel reconciler adds
 *   no top-level schema.
 *
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validateClaudeConfig(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ pointer: '', message: 'claude config must be an object' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  const errors = validateBackfillSection(raw.backfill, '/backfill')
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true }
}

/**
 * Validate the optional `backfill` policy block shared by every
 * backfill-capable source plugin: `on_join` (whether to import on join,
 * boolean) and `window_days` (how far back, positive integer). Both are
 * optional; unknown keys are rejected so a typo (`window_day`) surfaces
 * instead of being silently ignored. Pure: the caller chooses where the
 * returned pointers mount.
 *
 * @param {unknown} value
 * @param {string} pointer  JSON-pointer prefix for the `backfill` object
 * @returns {ValidationError[]}
 */
export function validateBackfillSection(value, pointer) {
  /** @type {ValidationError[]} */
  const errors = []
  if (value === undefined) return errors
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ pointer, message: 'backfill must be an object' })
    return errors
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  if (raw.on_join !== undefined && typeof raw.on_join !== 'boolean') {
    errors.push({ pointer: `${pointer}/on_join`, message: 'backfill.on_join must be a boolean' })
  }
  if (raw.window_days !== undefined) {
    const days = raw.window_days
    if (typeof days !== 'number' || !Number.isInteger(days) || days <= 0) {
      errors.push({
        pointer: `${pointer}/window_days`,
        message: 'backfill.window_days must be a positive integer',
      })
    }
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'on_join' && key !== 'window_days') {
      errors.push({ pointer: `${pointer}/${key}`, message: `unknown backfill key '${key}'` })
    }
  }
  return errors
}
