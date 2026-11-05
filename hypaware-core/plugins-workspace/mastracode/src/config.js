// @ts-check

/**
 * Config for the `@hypaware/mastracode` plugin's own `[mastracode]` block:
 * the validator, plus the resolvers the source and the backfill provider
 * share. Every key is optional; a missing section means defaults:
 *
 *   - `enabled`       boolean, static kill switch for the ongoing poll
 *                      source. `hyp backfill mastracode` stays available
 *                      either way.
 *   - `db_path`       string, overrides the resolved `mastra.db` path.
 *   - `poll_interval` number (ms) or a duration string (`"60s"`, `"5m"`).
 *   - `backfill`      the kernel-generic `{ on_join?, window_days? }` policy
 *                      block (LLP 0037), validated by the shared helper.
 *
 * The validator is pure and dependency-free: it returns a
 * `ValidationResult` so it plugs straight into
 * `ctx.configRegistry.registerSection` and is callable from tests without
 * spinning up observability.
 *
 * @ref LLP 0586#config [implements]: the goose key set (LLP 0570#config),
 *   with `sessions_db` renamed `db_path`.
 *
 * @import { PluginActivationContext, ValidationError, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { MastraDbLocation } from './types.js'
 */

import os from 'node:os'
import path from 'node:path'

import { validateBackfillSection } from '../../codex/src/config.js'

/** Manifest `config_sections[].section` name this validator backs. */
export const MASTRACODE_CONFIG_SECTION = 'mastracode'

/** Default poll interval when config carries none: LLP 0586#config's `poll_interval = "60s"`. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000

/** Duration string shape `poll_interval` accepts: an integer plus an `ms`/`s`/`m`/`h` suffix. */
export const DURATION_RE = /^(\d+)(ms|s|m|h)$/

const KNOWN_KEYS = new Set(['enabled', 'db_path', 'poll_interval', 'backfill'])

/**
 * Validate the `@hypaware/mastracode` plugin config slice.
 *
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validateMastracodeConfig(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ pointer: '', message: 'mastracode config must be an object' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)

  /** @type {ValidationError[]} */
  const errors = [...validateBackfillSection(raw.backfill, '/backfill')]

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push({ pointer: '/enabled', message: 'enabled must be a boolean' })
  }

  if (raw.db_path !== undefined) {
    if (typeof raw.db_path !== 'string' || raw.db_path.trim().length === 0) {
      errors.push({ pointer: '/db_path', message: 'db_path must be a non-empty string' })
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
      errors.push({ pointer: `/${key}`, message: `unknown mastracode config key '${key}'` })
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true }
}

/**
 * Resolve the effective `enabled` state from a `[mastracode]` config slice
 * already known to be valid. Anything other than an explicit `false`
 * resolves to enabled.
 *
 * @param {unknown} config
 * @returns {boolean}
 */
export function resolveMastracodeEnabled(config) {
  if (config === undefined || config === null || typeof config !== 'object' || Array.isArray(config)) return true
  const raw = /** @type {Record<string, unknown>} */ (config)
  return raw.enabled !== false
}

/** @param {Pick<PluginActivationContext, 'env'>} ctx @returns {string} */
export function resolveHomeDir(ctx) {
  return ctx.env.HOME ?? os.homedir()
}

/**
 * Resolve where Mastra Code keeps its store. `MASTRA_DB_URL` in the daemon's
 * environment means a remote store, which is not read even when a local
 * file exists, because that file would be stale. Otherwise the path is the
 * first that applies: `db_path`, an absolute `$MASTRA_DB_PATH`,
 * `$MASTRA_APP_DATA_DIR/mastra.db`, `$XDG_DATA_HOME/mastracode/mastra.db`
 * (each variable only when absolute), then the platform default. Only
 * resolves; a path that does not exist is the source's to report.
 *
 * @ref LLP 0586#detect-platforms [implements]: the per-platform default
 *   lives here, since the manifest's `detect` probe names only the Linux one.
 *
 * @param {Pick<PluginActivationContext, 'config' | 'env'>} ctx
 * @param {string} homeDir
 * @param {NodeJS.Platform} [platform]
 * @returns {MastraDbLocation}
 */
export function resolveMastraDbLocation(ctx, homeDir, platform = process.platform) {
  const env = ctx.env
  if (typeof env.MASTRA_DB_URL === 'string' && env.MASTRA_DB_URL.length > 0) return { kind: 'remote' }
  const p = platform === 'win32' ? path.win32 : path.posix
  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const raw = config.db_path
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return { kind: 'local', path: expandHome(raw.trim(), homeDir, p) }
  }
  /** @param {string | undefined} value @returns {value is string} */
  const absolute = (value) => typeof value === 'string' && p.isAbsolute(value)
  if (absolute(env.MASTRA_DB_PATH)) return { kind: 'local', path: env.MASTRA_DB_PATH }
  if (absolute(env.MASTRA_APP_DATA_DIR)) return { kind: 'local', path: p.join(env.MASTRA_APP_DATA_DIR, 'mastra.db') }
  if (absolute(env.XDG_DATA_HOME)) return { kind: 'local', path: p.join(env.XDG_DATA_HOME, 'mastracode', 'mastra.db') }
  if (platform === 'darwin') {
    return { kind: 'local', path: p.join(homeDir, 'Library', 'Application Support', 'mastracode', 'mastra.db') }
  }
  if (platform === 'win32') {
    const appData = absolute(env.APPDATA) ? env.APPDATA : p.join(homeDir, 'AppData', 'Roaming')
    return { kind: 'local', path: p.join(appData, 'mastracode', 'mastra.db') }
  }
  return { kind: 'local', path: p.join(homeDir, '.local', 'share', 'mastracode', 'mastra.db') }
}

/**
 * @param {string} raw
 * @param {string} homeDir
 * @param {typeof path.posix} p
 * @returns {string}
 */
function expandHome(raw, homeDir, p) {
  if (raw === '~') return homeDir
  if (raw.startsWith('~/') || (p === path.win32 && raw.startsWith('~\\'))) return p.join(homeDir, raw.slice(2))
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
