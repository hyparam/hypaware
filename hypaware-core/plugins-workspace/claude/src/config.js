// @ts-check

/**
 * Config validation for the `@hypaware/claude` plugin's own `config`
 * block. It validates the optional `backfill` sub-object that drives
 * backfill-on-join (`{ on_join, window_days }`), the optional `attach`
 * sub-object that drives attach-on-join (`{ on_join }`), and the
 * optional `telemetry` sub-object that places the Claude telemetry
 * listener (`{ listen_host, listen_port }`). Every
 * other key (e.g. `proxy`) passes through untouched so existing configs
 * keep working; there is no top-level `backfill`/`attach` section and
 * nothing new for core to validate.
 *
 * Pure and dependency-free: it returns a `ValidationResult` so it plugs
 * straight into `ctx.configRegistry.registerSection` and is callable from
 * tests without spinning up observability.
 *
 * @import { ValidationError, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 */

/** Manifest `config_sections[].section` name this validator backs. */
export const CLAUDE_CONFIG_SECTION = 'claude'

/**
 * Validate the `@hypaware/claude` plugin config slice. Only the optional
 * `backfill` and `attach` policy blocks are checked; unknown sibling keys
 * are ignored so the validator stays additive over the existing config
 * surface.
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
  const errors = [
    ...validateBackfillSection(raw.backfill, '/backfill'),
    ...validateAttachSection(raw.attach, '/attach'),
    ...validateTelemetrySection(raw.telemetry, '/telemetry'),
  ]
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

/**
 * Validate the optional `telemetry` block: where the Claude telemetry
 * listener binds. `listen_host` is a string, `listen_port` an integer in
 * `0..65535` where `0` asks for a dynamic port. Both optional; unknown
 * keys are rejected so a typo (`listen_ports`) surfaces instead of
 * silently leaving the listener on its default port while attach writes
 * the address the operator meant.
 *
 * @ref LLP 0257#registration [implements]: the listener's port is config with a
 *   default, and `0` requests a dynamic port
 *
 * @param {unknown} value
 * @param {string} pointer  JSON-pointer prefix for the `telemetry` object
 * @returns {ValidationError[]}
 */
export function validateTelemetrySection(value, pointer) {
  /** @type {ValidationError[]} */
  const errors = []
  if (value === undefined) return errors
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ pointer, message: 'telemetry must be an object' })
    return errors
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  if (raw.listen_host !== undefined && (typeof raw.listen_host !== 'string' || raw.listen_host.length === 0)) {
    errors.push({
      pointer: `${pointer}/listen_host`,
      message: 'telemetry.listen_host must be a non-empty string',
    })
  }
  if (raw.listen_port !== undefined) {
    const port = raw.listen_port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
      errors.push({
        pointer: `${pointer}/listen_port`,
        message: 'telemetry.listen_port must be an integer between 0 and 65535',
      })
    }
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'listen_host' && key !== 'listen_port') {
      errors.push({ pointer: `${pointer}/${key}`, message: `unknown telemetry key '${key}'` })
    }
  }
  return errors
}

/**
 * Validate the optional `attach` policy block on a client-adapter plugin's
 * config: `on_join` (whether the daemon auto-attaches this client when a
 * joined host confirms a central config that enables it, boolean,
 * default true). Optional; unknown keys are rejected so a typo
 * (`on_joins`) surfaces instead of being silently ignored. Pure: the
 * caller chooses where the returned pointers mount.
 *
 * @ref LLP 0045#part-4-per-plugin-attach-config--status-surface [implements]:
 *   attach.on_join rides the client adapter's own config block, validated
 *   by this plugin's config-section validator beside validateBackfillSection;
 *   no top-level/core schema.
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
