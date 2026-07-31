// @ts-check

/**
 * Config validation for the `@hypaware/openclaw` plugin's own `config`
 * block. v1 validates the optional `attach` sub-object that drives
 * attach-on-join, `{ on_join }`, and the optional `backfill` sub-object
 * that drives backfill-on-join and Lane B's scheduled sweep, `{ on_join,
 * window_days, sweep_cron, quiesce_ms }`. Every other key passes through
 * untouched so existing configs keep working; there is nothing new for
 * core to validate.
 *
 * Pure: it returns a `ValidationResult` so it plugs straight into
 * `ctx.configRegistry.registerSection` and is callable from tests without
 * spinning up observability. `sweep_cron` reuses core's shared 5-field
 * cron grammar (`isCronExpression`) rather than inventing a second
 * parser, so a malformed schedule is rejected the same way a sink's
 * `config.schedule` is.
 *
 * @import { ValidationError, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 */

import { isCronExpression } from '../../../../src/core/config/validate.js'

/** Manifest `config_sections[].section` name this validator backs. */
export const OPENCLAW_CONFIG_SECTION = 'openclaw'

/**
 * Validate the `@hypaware/openclaw` plugin config slice. The optional
 * `attach` and `backfill` policy blocks are checked; unknown sibling
 * keys are ignored so the validator stays additive over the existing
 * config surface.
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
  const errors = [
    ...validateAttachSection(raw.attach, '/attach'),
    ...validateBackfillSection(raw.backfill, '/backfill'),
  ]
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
 * @ref LLP 0045#part-4-per-plugin-attach-config--status-surface [implements]:
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

/**
 * Validate the optional `backfill` policy block shared by every
 * backfill-capable source plugin: `on_join` (whether to import on join,
 * boolean), `window_days` (how far back, positive integer), `sweep_cron`
 * (Lane B's scheduled-sweep cadence, a 5-field cron expression), and
 * `quiesce_ms` (how recently-modified a session file must be to skip a
 * sweep, non-negative integer milliseconds). All four are optional;
 * unknown keys are rejected so a typo (`window_day`) surfaces instead of
 * being silently ignored. Pure: the caller chooses where the returned
 * pointers mount.
 *
 * Started as a same-shape copy of `@hypaware/codex`'s validator of the
 * same name (no plugin in this codebase imports another plugin's `src/`
 * at runtime, so each backfill-capable plugin holds its own
 * independently-editable copy); `sweep_cron`/`quiesce_ms` are OpenClaw's
 * own Lane B additions (LLP 0170#decision, LLP 0172#4.2) and are not
 * mirrored onto codex's copy, so the two are no longer byte-identical.
 *
 * @ref LLP 0157#backfill [implements]: the plugin-owned `backfill` policy
 *   (`on_join`, `window_days`) declared and validated in the plugin's own
 *   config section (LLP 0037 [constrained-by]).
 * @ref LLP 0170#decision [implements]: `sweep_cron` and `quiesce_ms` are
 *   tunable in the plugin's own `backfill` config section, validated
 *   together so the unknown-key rejection loop never sees one land ahead
 *   of the other.
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
  if (raw.sweep_cron !== undefined) {
    const cron = raw.sweep_cron
    if (typeof cron !== 'string' || !isCronExpression(cron)) {
      errors.push({
        pointer: `${pointer}/sweep_cron`,
        message: 'backfill.sweep_cron must be a valid 5-field cron expression',
      })
    }
  }
  if (raw.quiesce_ms !== undefined) {
    const ms = raw.quiesce_ms
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) {
      errors.push({
        pointer: `${pointer}/quiesce_ms`,
        message: 'backfill.quiesce_ms must be a non-negative integer',
      })
    }
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'on_join' && key !== 'window_days' && key !== 'sweep_cron' && key !== 'quiesce_ms') {
      errors.push({ pointer: `${pointer}/${key}`, message: `unknown backfill key '${key}'` })
    }
  }
  return errors
}
