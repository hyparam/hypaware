// @ts-check

/**
 * Config validation for the `@hypaware/openclaw` plugin's own `config`
 * block. v1 validates only the optional `attach` sub-object that drives
 * attach-on-join, `{ on_join }`. Unlike the Claude/Codex sections there
 * is no `backfill` block: the plugin registers no backfill provider in
 * v1 (LLP 0109 lists OpenClaw session JSONL import as an open question),
 * so accepting a backfill policy would be dead config surface. Every
 * other key passes through untouched so existing configs keep working;
 * nothing new for core to validate.
 *
 * Pure and dependency-free: it returns a `ValidationResult` so it plugs
 * straight into `ctx.configRegistry.registerSection` and is callable from
 * tests without spinning up observability.
 *
 * @import { ValidationError, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 */

/** Manifest `config_sections[].section` name this validator backs. */
export const OPENCLAW_CONFIG_SECTION = 'openclaw'

/**
 * Validate the `@hypaware/openclaw` plugin config slice. Only the
 * optional `attach` policy block is checked; unknown sibling keys are
 * ignored so the validator stays additive over the existing config
 * surface.
 *
 * @ref LLP 0037#per-plugin-config-kernel-generic-reconciler [implements]:
 *   the client adapter owns and validates its own config section; the
 *   kernel reconciler adds no top-level schema.
 *
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validateOpenclawConfig(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ pointer: '', message: 'openclaw config must be an object' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  const errors = validateAttachSection(raw.attach, '/attach')
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true }
}

/**
 * Validate the optional `attach` policy block on a client-adapter plugin's
 * config: `on_join` (whether the daemon auto-attaches this client when a
 * joined host confirms a central config that enables it, boolean,
 * default true). Optional; unknown keys are rejected so a typo
 * (`on_joins`) surfaces instead of being silently ignored. Pure - the
 * caller chooses where the returned pointers mount.
 *
 * @ref LLP 0045#part-4--per-plugin-attach-config--status-surface [implements]:
 *   attach.on_join rides the client adapter's own config block, validated
 *   by this plugin's config-section validator; no top-level/core schema.
 *
 * @param {unknown} value
 * @param {string} pointer  JSON-pointer prefix for the `attach` object
 * @returns {ValidationError[]}
 */
export function validateAttachSection(value, pointer) {
  /** @type {ValidationError[]} */
  const errors = []
  if (value === undefined) return errors
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ pointer, message: 'attach must be an object' })
    return errors
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  if (raw.on_join !== undefined && typeof raw.on_join !== 'boolean') {
    errors.push({ pointer: `${pointer}/on_join`, message: 'attach.on_join must be a boolean' })
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'on_join') {
      errors.push({ pointer: `${pointer}/${key}`, message: `unknown attach key '${key}'` })
    }
  }
  return errors
}
