// @ts-check

import os from 'node:os'
import path from 'node:path'

import { validateAttachSection, validateBackfillSection } from '../../codex/src/config.js'

/**
 * @import { ValidationError, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 */

export const DEFAULT_ANTIGRAVITY_CLI_SUBDIR = path.join('.gemini', 'antigravity-cli')
export const DEFAULT_ANTIGRAVITY_DESKTOP_SUBDIR = path.join('.gemini', 'antigravity')
export const DEFAULT_POLL_INTERVAL = '30s'
const POLL_INTERVAL_RE = /^([1-9]\d*)(ms|s|m)$/

const ALLOWED_KEYS = new Set([
  'enabled',
  'app_data_dir',
  'poll_interval',
  'attach',
  'backfill',
])

/**
 * Validate the `antigravity` or `antigravity_desktop` config section (or the
 * plugin's inline `plugins[].config`).
 *
 * Accepted keys:
 *  - `enabled?: boolean`
 *  - `app_data_dir?: string` (non-empty path to the Antigravity appDataDir)
 *  - `poll_interval?: string` (`<positive-int>(ms|s|m)`, default `'30s'`)
 *  - `attach?: { on_join?: boolean }`
 *  - `backfill?: { on_join?: boolean, window_days?: number | null, sweep_cron?: string | false | null }`
 *
 * @param {unknown} value
 * @param {string} [sectionName]
 * @returns {ValidationResult}
 */
export function validateAntigravityConfig(value, sectionName = 'antigravity') {
  if (value === undefined || value === null) return { ok: true }
  if (!isPlainObject(value)) {
    return {
      ok: false,
      errors: [{ pointer: '', message: `${sectionName} config must be an object` }],
    }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)
  /** @type {ValidationError[]} */
  const errors = [
    ...validateAttachSection(raw.attach, '/attach'),
    ...validateBackfillSection(raw.backfill, '/backfill'),
  ]

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push({
      pointer: '/enabled',
      message: `${sectionName}.enabled must be a boolean`,
    })
  }

  if (raw.app_data_dir !== undefined) {
    if (typeof raw.app_data_dir !== 'string' || raw.app_data_dir.trim().length === 0) {
      errors.push({
        pointer: '/app_data_dir',
        message: `${sectionName}.app_data_dir must be a non-empty string`,
      })
    }
  }

  if (raw.poll_interval !== undefined) {
    const validNumber = typeof raw.poll_interval === 'number' && Number.isFinite(raw.poll_interval) && raw.poll_interval > 0
    const validString = typeof raw.poll_interval === 'string' && POLL_INTERVAL_RE.test(raw.poll_interval)
    if (!validNumber && !validString) {
      errors.push({
        pointer: '/poll_interval',
        message: `${sectionName}.poll_interval must match <positive-int>(ms|s|m) (e.g. '30s', '5m', '500ms')`,
      })
    }
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push({
        pointer: `/${key}`,
        message: `unknown ${sectionName} key '${key}'`,
      })
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}

/**
 * Parse a validated `poll_interval` duration string (`30s`, `5m`, `500ms`) into
 * milliseconds. Falls back to 30_000ms (`30s`) if unset or invalid.
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function parsePollIntervalMs(raw) {
  const text = typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_POLL_INTERVAL
  const match = POLL_INTERVAL_RE.exec(text)
  if (!match) return 30_000
  const n = Number(match[1])
  const unit = match[2]
  if (unit === 'ms') return n
  if (unit === 's') return n * 1000
  return n * 60_000
}

/**
 * Resolve the effective Antigravity `appDataDir` path.
 *
 * Precedence:
 *  1. `config.app_data_dir` when non-empty (`~/...` expanded against `homeDir`)
 *  2. `<homeDir>/<defaultAppDataSubdir>` (`.gemini/antigravity-cli` for CLI,
 *     `.gemini/antigravity` for Desktop)
 *
 * @param {{
 *   config?: Record<string, unknown> | null,
 *   env?: NodeJS.ProcessEnv,
 *   homeDir?: string,
 *   defaultAppDataSubdir?: string,
 * }} [opts]
 * @returns {string}
 */
export function resolveAntigravityAppDataDir(opts = {}) {
  const env = opts.env ?? process.env
  const home = opts.homeDir ?? env.HOME ?? os.homedir()
  const subdir = opts.defaultAppDataSubdir ?? DEFAULT_ANTIGRAVITY_CLI_SUBDIR
  const configured = opts.config && typeof opts.config.app_data_dir === 'string'
    ? opts.config.app_data_dir.trim()
    : ''
  if (configured.length > 0) {
    return expandHome(configured, home)
  }
  return path.resolve(home, subdir)
}

/**
 * @param {string} p
 * @param {string} home
 * @returns {string}
 */
function expandHome(p, home) {
  if (p === '~') return path.resolve(home)
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.resolve(home, p.slice(2))
  }
  return path.resolve(p)
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
