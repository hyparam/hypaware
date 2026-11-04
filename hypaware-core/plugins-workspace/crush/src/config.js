// @ts-check

/**
 * Config for the `@hypaware/crush` plugin's own `[crush]` block: the
 * validator, plus the resolvers the source and the backfill provider share.
 * Every key is optional; a missing section means defaults:
 *
 *   - `enabled`       boolean, static kill switch for the ongoing poll
 *                      source. `hyp backfill crush` stays available either
 *                      way, and the source idles when no database is found
 *                      regardless of this flag.
 *   - `data_dirs`     array of strings, extra `.crush` data dirs to poll
 *                      beside the ones `projects.json` lists. A leading `~`
 *                      is expanded at resolve time, not by the validator.
 *   - `poll_interval` number (ms) or a duration string (`"60s"`, `"5m"`).
 *   - `backfill`      the kernel-generic `{ on_join?, window_days? }` policy
 *                      block (LLP 0037), validated by the shared helper.
 *
 * The validator is pure and dependency-free: it returns a
 * `ValidationResult` so it plugs straight into
 * `ctx.configRegistry.registerSection` and is callable from tests without
 * spinning up observability.
 *
 * @ref LLP 0573#config [implements]: the goose key set with `sessions_db`
 *   replaced by a bounded `data_dirs` list, since Crush keeps a database per
 *   project.
 *
 * @import { PluginActivationContext, ValidationError, ValidationResult } from '../../../../hypaware-plugin-kernel-types.js'
 */

import os from 'node:os'
import path from 'node:path'

import { validateBackfillSection } from '../../codex/src/config.js'

/** Manifest `config_sections[].section` name this validator backs. */
export const CRUSH_CONFIG_SECTION = 'crush'

/** Default poll interval when config carries none: LLP 0573#config's `poll_interval = "60s"`. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000

/** Duration string shape `poll_interval` accepts: an integer plus an `ms`/`s`/`m`/`h` suffix. */
export const DURATION_RE = /^(\d+)(ms|s|m|h)$/

/** Most `data_dirs` entries a config may carry (LLP 0573#config). */
export const MAX_DATA_DIRS = 256

const KNOWN_KEYS = new Set(['enabled', 'data_dirs', 'poll_interval', 'backfill'])

/**
 * Validate the `@hypaware/crush` plugin config slice.
 *
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validateCrushConfig(value) {
  if (value === undefined || value === null) return { ok: true }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ pointer: '', message: 'crush config must be an object' }] }
  }
  const raw = /** @type {Record<string, unknown>} */ (value)

  /** @type {ValidationError[]} */
  const errors = [...validateBackfillSection(raw.backfill, '/backfill')]

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push({ pointer: '/enabled', message: 'enabled must be a boolean' })
  }

  if (raw.data_dirs !== undefined) {
    const dirs = raw.data_dirs
    if (!Array.isArray(dirs)) {
      errors.push({ pointer: '/data_dirs', message: 'data_dirs must be an array of paths' })
    } else if (dirs.length > MAX_DATA_DIRS) {
      errors.push({ pointer: '/data_dirs', message: `data_dirs holds at most ${MAX_DATA_DIRS} entries` })
    } else {
      dirs.forEach((dir, i) => {
        if (typeof dir !== 'string' || dir.trim().length === 0) {
          errors.push({ pointer: `/data_dirs/${i}`, message: 'each data_dirs entry must be a non-empty string' })
        }
      })
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
      errors.push({ pointer: `/${key}`, message: `unknown crush config key '${key}'` })
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true }
}

/**
 * Resolve the effective `enabled` state from a `[crush]` config slice
 * already known to be valid. Anything other than an explicit `false`
 * resolves to enabled: the source idles on its own when no database is
 * found, so the default has nothing to gate against until the operator
 * opts out.
 *
 * @param {unknown} config
 * @returns {boolean}
 */
export function resolveCrushEnabled(config) {
  if (config === undefined || config === null || typeof config !== 'object' || Array.isArray(config)) return true
  const raw = /** @type {Record<string, unknown>} */ (config)
  return raw.enabled !== false
}

/** @param {Pick<PluginActivationContext, 'env'>} ctx @returns {string} */
export function resolveHomeDir(ctx) {
  return ctx.env.HOME ?? os.homedir()
}

/**
 * Resolve the `projects.json` index path: `$CRUSH_GLOBAL_DATA/projects.json`
 * when that variable is set in the daemon's environment and absolute, then
 * `$XDG_DATA_HOME/crush/projects.json` on the same condition, then
 * `~/.local/share/crush/projects.json`. Only resolves; an index that does not
 * exist is discovery's to report.
 *
 * @ref LLP 0573#config [implements]: only an absolute variable counts; a
 *   daemon under launchd or systemd sees neither, so those users set
 *   `data_dirs`.
 *
 * @param {Pick<PluginActivationContext, 'env'>} ctx
 * @param {string} homeDir
 * @returns {string}
 */
export function resolveIndexPath(ctx, homeDir) {
  const globalData = ctx.env.CRUSH_GLOBAL_DATA
  if (typeof globalData === 'string' && path.isAbsolute(globalData)) {
    return path.join(globalData, 'projects.json')
  }
  const xdg = ctx.env.XDG_DATA_HOME
  if (typeof xdg === 'string' && path.isAbsolute(xdg)) {
    return path.join(xdg, 'crush', 'projects.json')
  }
  return path.join(homeDir, '.local', 'share', 'crush', 'projects.json')
}

/**
 * Resolve `data_dirs` from config, with a leading `~` expanded. Entries are
 * kept in config order and are not checked for existence or absoluteness
 * here: discovery counts a relative or missing one as stale.
 *
 * @param {Pick<PluginActivationContext, 'config'>} ctx
 * @param {string} homeDir
 * @returns {string[]}
 */
export function resolveDataDirs(ctx, homeDir) {
  const config = /** @type {Record<string, unknown>} */ (ctx.config ?? {})
  const raw = config.data_dirs
  if (!Array.isArray(raw)) return []
  /** @type {string[]} */
  const out = []
  for (const dir of raw.slice(0, MAX_DATA_DIRS)) {
    if (typeof dir === 'string' && dir.trim().length > 0) out.push(expandHome(dir.trim(), homeDir))
  }
  return out
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
