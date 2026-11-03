// @ts-check

/**
 * Config for the `@hypaware/goose` plugin's own `[goose]` block: the
 * validator, plus the resolvers the source and the backfill provider share.
 * Every key is optional; a missing section means defaults:
 *
 *   - `enabled`       boolean, static kill switch for the ongoing poll
 *                      source. `hyp backfill goose` stays available either
 *                      way, and the source idles when no `sessions.db`
 *                      exists regardless of this flag.
 *   - `sessions_db`   string, overrides the resolved `sessions.db` path.
 *   - `poll_interval` number (ms) or a duration string (`"60s"`, `"5m"`).
 *   - `backfill`      the kernel-generic `{ on_join?, window_days? }` policy
 *                      block (LLP 0037), validated by the shared helper.
 *
 * The validator is pure and dependency-free: it returns a
 * `ValidationResult` so it plugs straight into
 * `ctx.configRegistry.registerSection` and is callable from tests without
 * spinning up observability.
 *
 * @ref LLP 0570#config [implements]: the `[hermes]` key set and validation
 *   (LLP 0122#config), with `state_db` renamed `sessions_db`.
 *
 * @import { PluginActivationContext, ValidationError, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 */

import os from 'node:os'
import path from 'node:path'

import { validateBackfillSection } from '../../codex/src/config.js'

/** Manifest `config_sections[].section` name this validator backs. */
export const GOOSE_CONFIG_SECTION = 'goose'

/** Default poll interval when config carries none: LLP 0570#config's `poll_interval = "60s"`. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000

/** Duration string shape `poll_interval` accepts: an integer plus an `ms`/`s`/`m`/`h` suffix. */
export const DURATION_RE = /^(\d+)(ms|s|m|h)$/

const KNOWN_KEYS = new Set(['enabled', 'sessions_db', 'poll_interval', 'backfill'])

/**
 * Validate the `@hypaware/goose` plugin config slice.
 *
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validateGooseConfig(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ pointer: '', message: 'goose config must be an object' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)

  /** @type {ValidationError[]} */
  const errors = [...validateBackfillSection(raw.backfill, '/backfill')]

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push({ pointer: '/enabled', message: 'enabled must be a boolean' })
  }

  if (raw.sessions_db !== undefined) {
    if (typeof raw.sessions_db !== 'string' || raw.sessions_db.trim().length === 0) {
      errors.push({ pointer: '/sessions_db', message: 'sessions_db must be a non-empty string' })
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
      errors.push({ pointer: `/${key}`, message: `unknown goose config key '${key}'` })
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true }
}

/**
 * Resolve the effective `enabled` state from a `[goose]` config slice
 * already known to be valid. Anything other than an explicit `false`
 * resolves to enabled: the source idles on its own when no `sessions.db`
 * exists, so the default has nothing to gate against until the operator
 * opts out.
 *
 * @param {unknown} config
 * @returns {boolean}
 */
export function resolveGooseEnabled(config) {
  if (config === undefined || config === null || typeof config !== 'object' || Array.isArray(config)) return true
  const raw = /** @type {Record<string, unknown>} */ (config)
  return raw.enabled !== false
}

/** @param {Pick<PluginActivationContext, 'env'>} ctx @returns {string} */
export function resolveHomeDir(ctx) {
  return ctx.env.HOME ?? os.homedir()
}

/**
 * Resolve the `sessions.db` path: `sessions_db` if set, then
 * `$GOOSE_PATH_ROOT/data/sessions/sessions.db` when that variable is set in
 * the daemon's environment and absolute, then
 * `~/.local/share/goose/sessions/sessions.db`. Only resolves; a path that
 * does not exist is the source's to report.
 *
 * @ref LLP 0570#config [implements]: one default for Linux and macOS (Mac
 *   Part A observed it on macOS), and no fallback to the older
 *   `~/Library/Application Support/Block/goose/` location.
 *
 * @param {Pick<PluginActivationContext, 'config' | 'env'>} ctx
 * @param {string} homeDir
 * @returns {string}
 */
export function resolveSessionsDbPath(ctx, homeDir) {
  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const raw = config.sessions_db
  if (typeof raw === 'string' && raw.trim().length > 0) return expandHome(raw.trim(), homeDir)
  const root = ctx.env.GOOSE_PATH_ROOT
  if (typeof root === 'string' && path.isAbsolute(root)) {
    return path.join(root, 'data', 'sessions', 'sessions.db')
  }
  return path.join(homeDir, '.local', 'share', 'goose', 'sessions', 'sessions.db')
}

/** @param {string} raw @param {string} homeDir @returns {string} */
function expandHome(raw, homeDir) {
  if (raw === '~') return homeDir
  if (raw.startsWith('~/')) return path.join(homeDir, raw.slice(2))
  return raw
}

/**
 * Resolve `poll_interval` from config. A plain number is milliseconds; a
 * string requires an explicit `ms`/`s`/`m`/`h` suffix. Anything else falls
 * back to {@link DEFAULT_POLL_INTERVAL_MS}.
 *
 * @param {Pick<PluginActivationContext, 'config'>} ctx
 * @returns {number}
 */
export function resolvePollIntervalMs(ctx) {
  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const raw = config.poll_interval
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw)
  if (typeof raw === 'string') {
    const match = DURATION_RE.exec(raw.trim())
    if (match) {
      const amount = Number(match[1])
      const unitMs = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]]
      if (amount > 0 && unitMs !== undefined) return amount * unitMs
    }
  }
  return DEFAULT_POLL_INTERVAL_MS
}
