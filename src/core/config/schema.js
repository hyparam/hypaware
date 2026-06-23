// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, getLogger, withSpan } from '../observability/index.js'

/**
 * @import { BlobSinkConfigInstance, ConfigRegistry, ConfigSectionRegistration, HypAwareV2Config, JsonObject, PluginConfigInstance, PluginName, QueryCacheConfig, QueryConfig, RequestSinkConfigInstance, SinkConfigInstance, SinkInstanceConfig, ValidationError, ValidationResult } from '../../../collectivus-plugin-kernel-types.d.ts'
 */

/**
 * @import {
 *   ConfigLoadErrorKind,
 *   LoadConfigFailure,
 *   LoadConfigResult,
 *   LoadConfigSuccess,
 *   LocalConfigWriteGuard,
 * } from './types.d.ts'
 */

/**
 * Default basename for the v2 config file relative to `HYP_HOME`.
 * The path is `<HYP_HOME>/hypaware-config.json` per design §Setup
 * and Onboarding.
 */
export const CONFIG_BASENAME = 'hypaware-config.json'

/**
 * Resolve the default config path under `HYP_HOME`. Callers that want
 * to support a `--path` flag or `HYP_CONFIG` env override should do
 * that themselves and only fall back to this helper.
 *
 * @param {string} hypHome
 * @returns {string}
 */
export function defaultConfigPath(hypHome) {
  return path.join(hypHome, CONFIG_BASENAME)
}

/**
 * Guard a write to the user-owned **local** config layer
 * (`hypaware-config.json`) so `init` cannot silently clobber it — the
 * remaining, non-destructive half of #111 (`join` no longer writes here;
 * `init` still can). Behaviour:
 *
 * - **No existing config** → proceed.
 * - **Existing config, non-interactive** (no `confirmOverwrite`): refuse
 *   unless `force`; on `force`, copy the current file to
 *   `hypaware-config.json.bak-<ts>` first, then proceed.
 * - **Existing config, interactive** (`confirmOverwrite` supplied):
 *   prompt; on confirm, back up and proceed; on decline, abort.
 *
 * The helper only decides + backs up; the caller performs the write.
 *
 * @param {{
 *   targetPath: string,
 *   force?: boolean,
 *   confirmOverwrite?: (targetPath: string) => Promise<boolean>,
 *   now?: () => number,
 * }} args
 * @returns {Promise<LocalConfigWriteGuard>}
 * @ref LLP 0031#local-layer-writers [implements] — init overwrite safety: refuse / --force / backup (non-interactive), prompt (interactive)
 */
export async function prepareLocalConfigWrite({ targetPath, force, confirmOverwrite, now }) {
  let exists = true
  try {
    await fs.access(targetPath)
  } catch {
    exists = false
  }
  if (!exists) return { proceed: true }

  if (confirmOverwrite) {
    const confirmed = await confirmOverwrite(targetPath)
    if (!confirmed) {
      return { proceed: false, message: `keeping existing config at ${targetPath}` }
    }
  } else if (!force) {
    return {
      proceed: false,
      message:
        `refusing to overwrite existing config at ${targetPath} — ` +
        `pass --force to replace it (a timestamped .bak copy is written first)`,
    }
  }

  const stamp = new Date((now ?? Date.now)()).toISOString().replace(/[:.]/g, '-')
  const backupPath = `${targetPath}.bak-${stamp}`
  await fs.copyFile(targetPath, backupPath)
  return { proceed: true, backupPath }
}

/**
 * Read and shape-validate a v2 config file from disk.
 *
 * Emits a `config.load` span carrying `config_path` and (on success)
 * `plugin_count`, `sink_count`. On failure the span is marked `failed`
 * and tagged with `error_kind`, and a `config.load_failed` log row is
 * emitted with the same `error_kind` so smoke assertions can match
 * either the span or the log.
 *
 * @param {string} configPath
 * @returns {Promise<LoadConfigResult>}
 */
export async function loadConfigFile(configPath) {
  const log = getLogger('config')
  return withSpan(
    'config.load',
    {
      [Attr.COMPONENT]: 'config',
      [Attr.OPERATION]: 'config.load',
      config_path: configPath,
    },
    async (span) => {
      /** @type {string} */
      let raw
      try {
        raw = await fs.readFile(configPath, 'utf8')
      } catch (err) {
        const code = err && /** @type {NodeJS.ErrnoException} */ (err).code
        const errorKind = code === 'ENOENT' ? 'config_missing' : 'config_unreadable'
        const message = code === 'ENOENT'
          ? `config not found at ${configPath}`
          : `failed to read config ${configPath}: ${describeError(err)}`
        span.setAttribute('error_kind', errorKind)
        span.setAttribute('status', 'failed')
        log.error('config.load_failed', {
          config_path: configPath,
          [Attr.ERROR_KIND]: errorKind,
          message,
        })
        return { ok: false, errorKind, message, configPath }
      }

      /** @type {unknown} */
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        const errorKind = 'config_invalid_json'
        const message = `config is not valid JSON: ${describeError(err)}`
        span.setAttribute('error_kind', errorKind)
        span.setAttribute('status', 'failed')
        log.error('config.load_failed', {
          config_path: configPath,
          [Attr.ERROR_KIND]: errorKind,
          message,
        })
        return { ok: false, errorKind, message, configPath }
      }

      const shape = parseConfigShape(parsed)
      if (!shape.ok) {
        const errorKind = 'config_invalid_shape'
        span.setAttribute('error_kind', errorKind)
        span.setAttribute('status', 'failed')
        for (const e of shape.errors) {
          log.error('config.shape_error', {
            config_path: configPath,
            [Attr.ERROR_KIND]: errorKind,
            pointer: e.pointer,
            message: e.message,
          })
        }
        return {
          ok: false,
          errorKind,
          message: shape.errors[0]?.message ?? 'config shape invalid',
          configPath,
          errors: shape.errors,
        }
      }

      span.setAttribute('plugin_count', shape.config.plugins?.length ?? 0)
      span.setAttribute('sink_count', Object.keys(shape.config.sinks ?? {}).length)
      span.setAttribute('status', 'ok')
      return { ok: true, config: shape.config, configPath }
    },
    { component: 'config' }
  )
}

/**
 * Pure shape validator for parsed JSON. The well-formed result holds a
 * `HypAwareV2Config` that downstream cross-plugin validation can lean
 * on. Failures are returned as a list of `{pointer, message}` records
 * so the caller can re-emit them per validation error.
 *
 * @param {unknown} value
 * @returns {{ ok: true, config: HypAwareV2Config } | { ok: false, errors: ValidationError[] }}
 * @ref LLP 0010#no-mode-field [implements] — v2 shape: version must be 2, explicit plugins[], no mode/role label
 */
export function parseConfigShape(value) {
  /** @type {ValidationError[]} */
  const errors = []

  if (!isPlainObject(value)) {
    errors.push({ pointer: '', message: 'config must be a JSON object' })
    return { ok: false, errors }
  }

  const root = /** @type {Record<string, unknown>} */ (value)
  if (root.version !== 2) {
    errors.push({ pointer: '/version', message: 'version must be exactly 2' })
  }

  /** @type {PluginConfigInstance[]|undefined} */
  let plugins
  if (root.plugins !== undefined) {
    if (!Array.isArray(root.plugins)) {
      errors.push({ pointer: '/plugins', message: 'plugins must be an array' })
    } else {
      plugins = []
      for (let i = 0; i < root.plugins.length; i += 1) {
        const entry = root.plugins[i]
        const pointer = `/plugins/${i}`
        const checked = parsePluginEntry(entry, pointer, errors)
        if (checked) plugins.push(checked)
      }
    }
  }

  /** @type {Record<string, SinkConfigInstance>|undefined} */
  let sinks
  if (root.sinks !== undefined) {
    if (!isPlainObject(root.sinks)) {
      errors.push({ pointer: '/sinks', message: 'sinks must be an object keyed by instance name' })
    } else {
      sinks = {}
      for (const [name, entry] of Object.entries(/** @type {Record<string, unknown>} */ (root.sinks))) {
        if (!isNonEmptyString(name)) {
          errors.push({ pointer: '/sinks', message: 'sink instance names must be non-empty strings' })
          continue
        }
        const pointer = `/sinks/${name}`
        const checked = parseSinkEntry(entry, pointer, errors)
        if (checked) sinks[name] = checked
      }
    }
  }

  /** @type {QueryConfig|undefined} */
  let query
  if (root.query !== undefined) {
    if (!isPlainObject(root.query)) {
      errors.push({ pointer: '/query', message: 'query must be an object' })
    } else {
      query = parseQueryConfig(/** @type {Record<string, unknown>} */ (root.query), '/query', errors)
    }
  }

  /** @type {Record<string, string>|undefined} */
  let disambiguate
  if (root.disambiguate !== undefined) {
    if (!isPlainObject(root.disambiguate)) {
      errors.push({ pointer: '/disambiguate', message: 'disambiguate must be a map of capability name -> plugin name' })
    } else {
      disambiguate = {}
      for (const [cap, plugin] of Object.entries(/** @type {Record<string, unknown>} */ (root.disambiguate))) {
        if (!isNonEmptyString(plugin)) {
          errors.push({
            pointer: `/disambiguate/${cap}`,
            message: 'disambiguate values must be non-empty plugin name strings',
          })
          continue
        }
        disambiguate[cap] = plugin
      }
    }
  }

  for (const key of Object.keys(root)) {
    if (!RECOGNIZED_TOP_KEYS.has(key)) {
      errors.push({ pointer: `/${key}`, message: `unrecognized top-level key '${key}'` })
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  /** @type {HypAwareV2Config} */
  const config = { version: 2 }
  if (plugins) config.plugins = plugins
  if (sinks) config.sinks = sinks
  if (query) config.query = query
  if (disambiguate) config.disambiguate = disambiguate
  return { ok: true, config }
}

const RECOGNIZED_TOP_KEYS = new Set(['version', 'plugins', 'sinks', 'query', 'disambiguate'])

/**
 * Build the kernel `ConfigRegistry`. Plugins call `registerSection`
 * during activation to attach a validator to a `config_sections[]`
 * entry from their manifest. Cross-plugin validation in
 * `src/core/config/validate.js` invokes `validatePluginConfig` for
 * every entry under `HypAwareV2Config.plugins[]`.
 *
 * Each per-plugin validator emits one `config.section_error` log row
 * per returned `ValidationError`, matching the bead contract that
 * "each per-plugin validator emits one log per validation error".
 *
 * @returns {ConfigRegistry & {
 *   list: () => ConfigSectionRegistration[],
 *   getDefaults: (plugin: PluginName) => JsonObject|undefined,
 * }}
 * @ref LLP 0010#validation [implements] — each plugin validates its own config section through this registry
 */
export function createConfigRegistry() {
  /** @type {Map<PluginName, ConfigSectionRegistration>} */
  const sections = new Map()
  const log = getLogger('config')

  /** @param {ConfigSectionRegistration} registration */
  function registerSection(registration) {
    if (!registration || typeof registration !== 'object') {
      throw new TypeError('ConfigRegistry.registerSection: registration must be an object')
    }
    if (!isNonEmptyString(registration.plugin)) {
      throw new TypeError('ConfigRegistry.registerSection: plugin is required')
    }
    if (!isNonEmptyString(registration.section)) {
      throw new TypeError(`ConfigRegistry.registerSection: '${registration.plugin}' missing section`)
    }
    if (typeof registration.validate !== 'function') {
      throw new TypeError(`ConfigRegistry.registerSection: '${registration.plugin}' missing validate()`)
    }
    if (sections.has(registration.plugin)) {
      throw new Error(
        `ConfigRegistry.registerSection: plugin '${registration.plugin}' already registered a section`
      )
    }
    sections.set(registration.plugin, registration)
  }

  /**
   * @param {PluginName} pluginName
   * @param {unknown} config
   * @returns {ValidationResult}
   */
  function validatePluginConfig(pluginName, config) {
    const reg = sections.get(pluginName)
    if (!reg) {
      // No registered section means the kernel has nothing plugin-specific
      // to enforce — return ok so cross-plugin validation can proceed.
      return { ok: true }
    }
    const result = reg.validate(config, { pluginName, pointer: `/plugins/<${pluginName}>/config` })
    if (!result.ok) {
      for (const e of result.errors) {
        log.error('config.section_error', {
          [Attr.PLUGIN]: pluginName,
          [Attr.ERROR_KIND]: 'config_section_invalid',
          pointer: e.pointer,
          message: e.message,
        })
      }
    }
    return result
  }

  function list() {
    return Array.from(sections.values())
  }

  /** @param {PluginName} plugin */
  function getDefaults(plugin) {
    const reg = sections.get(plugin)
    if (!reg || typeof reg.defaults !== 'function') return undefined
    return reg.defaults()
  }

  return { registerSection, validatePluginConfig, list, getDefaults }
}

/* ---------- helpers ---------- */

/**
 * @param {unknown} entry
 * @param {string} pointer
 * @param {ValidationError[]} errors
 * @returns {PluginConfigInstance|undefined}
 */
function parsePluginEntry(entry, pointer, errors) {
  if (!isPlainObject(entry)) {
    errors.push({ pointer, message: 'plugin entry must be an object' })
    return undefined
  }
  const obj = /** @type {Record<string, unknown>} */ (entry)
  if (!isNonEmptyString(obj.name)) {
    errors.push({ pointer: `${pointer}/name`, message: 'name (plugin name) is required' })
    return undefined
  }
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
    errors.push({ pointer: `${pointer}/enabled`, message: 'enabled must be a boolean when present' })
  }
  if (obj.config !== undefined && !isPlainObject(obj.config)) {
    errors.push({ pointer: `${pointer}/config`, message: 'config must be an object when present' })
  }
  // Pin fields set by centrally-served configs (LLP 0025). Optional in
  // hand-written configs; the apply engine enforces them when present.
  for (const key of /** @type {const} */ (['version', 'artifact_hash', 'source'])) {
    if (obj[key] !== undefined && !isNonEmptyString(obj[key])) {
      errors.push({ pointer: `${pointer}/${key}`, message: `${key} must be a non-empty string when present` })
    }
  }
  /** @type {PluginConfigInstance} */
  const out = { name: obj.name }
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled
  if (isPlainObject(obj.config)) out.config = /** @type {JsonObject} */ (obj.config)
  if (isNonEmptyString(obj.version)) out.version = obj.version
  if (isNonEmptyString(obj.artifact_hash)) out.artifact_hash = obj.artifact_hash
  if (isNonEmptyString(obj.source)) out.source = obj.source
  return out
}

/**
 * @param {unknown} entry
 * @param {string} pointer
 * @param {ValidationError[]} errors
 * @returns {SinkConfigInstance|undefined}
 * @ref LLP 0014#config-two-shapes [implements] — blob sink = writer+destination; request sink = one-piece plugin; never both
 */
function parseSinkEntry(entry, pointer, errors) {
  if (!isPlainObject(entry)) {
    errors.push({ pointer, message: 'sink entry must be an object' })
    return undefined
  }
  const obj = /** @type {Record<string, unknown>} */ (entry)
  const hasWriter = obj.writer !== undefined
  const hasDestination = obj.destination !== undefined
  const hasPlugin = obj.plugin !== undefined

  if (hasPlugin && (hasWriter || hasDestination)) {
    // Caught more rigorously in validate.js with error_kind=request_sink_invalid_keys.
    // Still flag here so shape errors don't leak through as obviously malformed configs.
    errors.push({
      pointer,
      message: 'sink instance cannot combine writer/destination with plugin',
    })
  }

  if (hasWriter || hasDestination) {
    if (!isNonEmptyString(obj.writer)) {
      errors.push({ pointer: `${pointer}/writer`, message: 'writer (plugin name) is required for blob sinks' })
    }
    if (!isNonEmptyString(obj.destination)) {
      errors.push({ pointer: `${pointer}/destination`, message: 'destination (plugin name) is required for blob sinks' })
    }
    if (obj.config !== undefined && !isPlainObject(obj.config)) {
      errors.push({ pointer: `${pointer}/config`, message: 'config must be an object when present' })
    }
    if (!isNonEmptyString(obj.writer) || !isNonEmptyString(obj.destination)) return undefined
    /** @type {BlobSinkConfigInstance} */
    const out = { writer: obj.writer, destination: obj.destination }
    if (isPlainObject(obj.config)) {
      out.config = /** @type {SinkInstanceConfig} */ (obj.config)
    }
    return out
  }

  if (hasPlugin) {
    if (!isNonEmptyString(obj.plugin)) {
      errors.push({ pointer: `${pointer}/plugin`, message: 'plugin (plugin name) is required for request sinks' })
      return undefined
    }
    if (obj.config !== undefined && !isPlainObject(obj.config)) {
      errors.push({ pointer: `${pointer}/config`, message: 'config must be an object when present' })
    }
    /** @type {RequestSinkConfigInstance} */
    const out = { plugin: obj.plugin }
    if (isPlainObject(obj.config)) {
      out.config = /** @type {SinkInstanceConfig} */ (obj.config)
    }
    return out
  }

  errors.push({
    pointer,
    message: 'sink must specify either writer+destination (blob) or plugin (request)',
  })
  return undefined
}

/**
 * Parse the local-only `query{}` block: `cache`, plus the remote-attach
 * `remotes` map + `default_remote` (LLP 0033 §targets). Lives in the
 * structurally local-only section, so the central layer can never inject a
 * remote target (LLP 0031).
 *
 * @param {Record<string, unknown>} obj
 * @param {string} pointer
 * @param {ValidationError[]} errors
 * @returns {QueryConfig}
 */
function parseQueryConfig(obj, pointer, errors) {
  /** @type {QueryConfig} */
  const result = {}

  if (obj.cache !== undefined) {
    if (!isPlainObject(obj.cache)) {
      errors.push({ pointer: `${pointer}/cache`, message: 'query.cache must be an object' })
    } else {
      const cache = parseQueryCacheConfig(/** @type {Record<string, unknown>} */ (obj.cache), `${pointer}/cache`, errors)
      if (cache) result.cache = cache
    }
  }

  // remotes{} — named MCP targets for `--remote`. The URL is non-secret and
  // committable; the token is never config (secrets-never-in-config).
  if (obj.remotes !== undefined) {
    if (!isPlainObject(obj.remotes)) {
      errors.push({ pointer: `${pointer}/remotes`, message: 'query.remotes must be an object keyed by target name' })
    } else {
      /** @type {Record<string, { url: string }>} */
      const remotes = {}
      for (const [name, entry] of Object.entries(/** @type {Record<string, unknown>} */ (obj.remotes))) {
        const tp = `${pointer}/remotes/${name}`
        if (!isNonEmptyString(name)) {
          errors.push({ pointer: `${pointer}/remotes`, message: 'remote target names must be non-empty strings' })
          continue
        }
        if (!isPlainObject(entry)) {
          errors.push({ pointer: tp, message: 'remote target must be an object with a url' })
          continue
        }
        const url = /** @type {Record<string, unknown>} */ (entry).url
        if (!isNonEmptyString(url)) {
          errors.push({ pointer: `${tp}/url`, message: 'remote target url is required and must be a non-empty string' })
          continue
        }
        if (!/^https?:\/\//.test(url)) {
          errors.push({ pointer: `${tp}/url`, message: 'remote target url must be an http(s) URL' })
          continue
        }
        remotes[name] = { url }
      }
      if (Object.keys(remotes).length > 0) result.remotes = remotes
    }
  }

  // default_remote must name a defined target, so `--remote` with no arg
  // never silently resolves to nothing.
  if (obj.default_remote !== undefined) {
    if (!isNonEmptyString(obj.default_remote)) {
      errors.push({ pointer: `${pointer}/default_remote`, message: 'query.default_remote must be a non-empty string' })
    } else if (!result.remotes || !Object.prototype.hasOwnProperty.call(result.remotes, obj.default_remote)) {
      errors.push({ pointer: `${pointer}/default_remote`, message: `query.default_remote '${obj.default_remote}' is not a defined remote target` })
    } else {
      result.default_remote = obj.default_remote
    }
  }

  return result
}

/**
 * Parse the `query.cache` sub-block.
 *
 * @param {Record<string, unknown>} cache
 * @param {string} pointer
 * @param {ValidationError[]} errors
 * @returns {QueryCacheConfig|undefined}
 */
function parseQueryCacheConfig(cache, pointer, errors) {
  /** @type {QueryCacheConfig} */
  const out = {}
  if (cache.dir !== undefined) {
    if (!isNonEmptyString(cache.dir)) {
      errors.push({ pointer: `${pointer}/dir`, message: 'query.cache.dir must be a non-empty string' })
    } else {
      out.dir = cache.dir
    }
  }
  if (cache.retention !== undefined) {
    if (!isPlainObject(cache.retention)) {
      errors.push({ pointer: `${pointer}/retention`, message: 'query.cache.retention must be an object' })
    } else {
      const ret = /** @type {Record<string, unknown>} */ (cache.retention)
      if (typeof ret.default_days !== 'number' || !Number.isFinite(ret.default_days) || ret.default_days < 0) {
        errors.push({
          pointer: `${pointer}/retention/default_days`,
          message: 'query.cache.retention.default_days must be a non-negative number',
        })
      }
      /** @type {Record<string, number>|undefined} */
      let datasets
      if (ret.datasets !== undefined) {
        if (!isPlainObject(ret.datasets)) {
          errors.push({
            pointer: `${pointer}/retention/datasets`,
            message: 'query.cache.retention.datasets must be an object of dataset name -> days',
          })
        } else {
          datasets = {}
          for (const [ds, days] of Object.entries(/** @type {Record<string, unknown>} */ (ret.datasets))) {
            if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
              errors.push({
                pointer: `${pointer}/retention/datasets/${ds}`,
                message: 'dataset retention must be a non-negative number of days',
              })
              continue
            }
            datasets[ds] = days
          }
        }
      }
      out.retention = {
        default_days: typeof ret.default_days === 'number' ? ret.default_days : 0,
        ...(datasets ? { datasets } : {}),
      }
    }
  }
  if (cache.maintenance !== undefined) {
    if (!isPlainObject(cache.maintenance)) {
      errors.push({ pointer: `${pointer}/maintenance`, message: 'query.cache.maintenance must be an object' })
    } else {
      const m = /** @type {Record<string, unknown>} */ (cache.maintenance)
      /** @type {import('../../../collectivus-plugin-kernel-types.d.ts').QueryCacheMaintenanceConfig} */
      const maint = {}
      if (m.enabled !== undefined) {
        if (typeof m.enabled !== 'boolean') {
          errors.push({ pointer: `${pointer}/maintenance/enabled`, message: 'must be a boolean' })
        } else {
          maint.enabled = m.enabled
        }
      }
      for (const key of /** @type {const} */ ([
        'interval_minutes', 'target_file_bytes', 'min_snapshots_to_keep',
        'max_snapshot_age_hours', 'compact_file_count', 'compact_avg_file_bytes',
        'compact_batch_bytes', 'max_tick_ms',
      ])) {
        if (m[key] !== undefined) {
          if (typeof m[key] !== 'number' || !Number.isFinite(/** @type {number} */ (m[key])) || /** @type {number} */ (m[key]) < 0) {
            errors.push({ pointer: `${pointer}/maintenance/${key}`, message: `must be a non-negative number` })
          } else {
            maint[key] = /** @type {number} */ (m[key])
          }
        }
      }
      out.maintenance = maint
    }
  }
  return out
}

/** @param {unknown} v */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

/** @param {unknown} err */
function describeError(err) {
  return err instanceof Error ? err.message : String(err)
}
