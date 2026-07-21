// @ts-check

/**
 * Config validation for the `@hypaware/hermes` plugin's own `[hermes]`
 * config block. All three keys are optional; a missing section means
 * defaults (LLP 0122#config):
 *
 *   - `enabled`       boolean, static kill switch for the ongoing poll
 *                      source. `hyp backfill hermes` stays available either
 *                      way, and the source itself idles cleanly (spec R9)
 *                      when no `state.db` exists regardless of this flag.
 *   - `state_db`      string, overrides the default
 *                      `<home>/.hermes/state.db` path (profiles/tests).
 *   - `poll_interval` number (ms) or a duration string (`"60s"`, `"5m"`),
 *                      the ongoing-capture lag bound (spec R6).
 *
 * Pure and dependency-free: it returns a `ValidationResult` so it plugs
 * straight into `ctx.configRegistry.registerSection` and is callable from
 * tests without spinning up observability.
 *
 * @ref LLP 0122#config [implements]: `[hermes]` section shape (`enabled`,
 *   `state_db`, `poll_interval`), all optional.
 *
 * @import { ValidationError, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 */

import { DURATION_RE } from './source.js'

/** Manifest `config_sections[].section` name this validator backs. */
export const HERMES_CONFIG_SECTION = 'hermes'

const KNOWN_KEYS = new Set(['enabled', 'state_db', 'poll_interval'])

/**
 * Validate the `@hypaware/hermes` plugin config slice.
 *
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validateHermesConfig(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ pointer: '', message: 'hermes config must be an object' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)

  /** @type {ValidationError[]} */
  const errors = []

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push({ pointer: '/enabled', message: 'enabled must be a boolean' })
  }

  if (raw.state_db !== undefined) {
    if (typeof raw.state_db !== 'string' || raw.state_db.trim().length === 0) {
      errors.push({ pointer: '/state_db', message: 'state_db must be a non-empty string' })
    }
  }

  if (raw.poll_interval !== undefined) {
    const interval = raw.poll_interval
    const validNumber = typeof interval === 'number' && Number.isFinite(interval) && interval > 0
    const validString = typeof interval === 'string' && DURATION_RE.test(interval.trim())
    if (!validNumber && !validString) {
      errors.push({
        pointer: '/poll_interval',
        message: "poll_interval must be a positive number of milliseconds or a duration string like '60s'",
      })
    }
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      errors.push({ pointer: `/${key}`, message: `unknown hermes config key '${key}'` })
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true }
}

/**
 * Resolve the effective `enabled` state from a `[hermes]` config slice
 * already known to be valid (post `validateHermesConfig`). Missing or
 * anything other than an explicit `false` resolves to enabled: the source
 * itself idles cleanly (spec R9) when no `state.db` is present, so the
 * config default has nothing to gate against until the operator opts out.
 *
 * @ref LLP 0122#config [implements]: `enabled` is a static override, not a
 *   file-presence check; that check already lives in the source's own probe.
 *
 * @param {unknown} config
 * @returns {boolean}
 */
export function resolveHermesEnabled(config) {
  if (config === undefined || config === null || typeof config !== 'object' || Array.isArray(config)) return true
  const raw = /** @type {Record<string, unknown>} */ (config)
  return raw.enabled !== false
}
