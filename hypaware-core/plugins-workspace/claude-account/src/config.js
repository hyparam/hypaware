// @ts-check

/**
 * Config validation for the `@hypaware/claude-account` plugin's
 * `claude_account` section. Pure and dependency-free so it plugs into
 * `ctx.configRegistry.registerSection` and is callable from tests.
 *
 * @import { ValidationError, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ClaudeAccountMode } from './types.js'
 */

/** Manifest `config_sections[].section` name this validator backs. */
export const CLAUDE_ACCOUNT_CONFIG_SECTION = 'claude_account'

/** @type {ReadonlyArray<ClaudeAccountMode>} */
export const CLAUDE_ACCOUNT_MODES = Object.freeze(['org_key', 'subscription'])

/**
 * Default when the section omits `mode`: the personal-machine posture,
 * where the user signs in with their own account. Fleets that want the
 * org key say so centrally.
 *
 * @ref LLP 0117#mode-is-fleet-policy: a central config naming this section locks the mode via the central-wins merge
 */
export const DEFAULT_MODE = 'subscription'

/**
 * Validate the `claude_account` config slice. Unknown keys are rejected
 * so a typo (`api_key_evn`) surfaces instead of silently degrading to
 * "not signed in".
 *
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validateClaudeAccountConfig(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ pointer: '', message: 'claude_account config must be an object' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  /** @type {ValidationError[]} */
  const errors = []

  if (raw.mode !== undefined && !CLAUDE_ACCOUNT_MODES.includes(/** @type {ClaudeAccountMode} */ (raw.mode))) {
    errors.push({
      pointer: '/mode',
      message: `mode must be one of ${CLAUDE_ACCOUNT_MODES.join(', ')}`,
    })
  }
  for (const key of ['api_key', 'api_key_env']) {
    const v = raw[key]
    if (v !== undefined && (typeof v !== 'string' || v.length === 0)) {
      errors.push({ pointer: `/${key}`, message: `${key} must be a non-empty string` })
    }
  }
  if (raw.api_key !== undefined && raw.api_key_env !== undefined) {
    errors.push({ pointer: '/api_key', message: 'api_key and api_key_env are mutually exclusive' })
  }
  if (raw.mode === 'org_key' && raw.api_key === undefined && raw.api_key_env === undefined) {
    errors.push({ pointer: '/mode', message: "mode 'org_key' requires api_key or api_key_env" })
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'mode' && key !== 'api_key' && key !== 'api_key_env') {
      errors.push({ pointer: `/${key}`, message: `unknown claude_account key '${key}'` })
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true }
}

/**
 * Resolve the effective mode from a validated config slice.
 *
 * @param {Record<string, unknown> | undefined} config
 * @returns {ClaudeAccountMode}
 */
export function resolveMode(config) {
  const mode = config?.mode
  return CLAUDE_ACCOUNT_MODES.includes(/** @type {ClaudeAccountMode} */ (mode))
    ? /** @type {ClaudeAccountMode} */ (mode)
    : DEFAULT_MODE
}
