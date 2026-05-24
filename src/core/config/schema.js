// @ts-check

import fs from 'node:fs/promises'
import path from 'node:path'

import { Attr, getLogger, withSpan } from '../observability/index.js'

/**
 * @import { BlobSinkConfigInstance, ConfigRegistry, ConfigSectionRegistration, HypAwareV2Config, JsonObject, PluginConfigInstance, PluginName, QueryConfig, RequestSinkConfigInstance, SinkConfigInstance, ValidationError, ValidationResult } from '../../../collectivus-plugin-kernel-types'
 */

/**
 * @import {
 *   ConfigLoadErrorKind,
 *   LoadConfigFailure,
 *   LoadConfigResult,
 *   LoadConfigSuccess,
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
  /** @type {PluginConfigInstance} */
  const out = { name: obj.name }
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled
  if (isPlainObject(obj.config)) out.config = /** @type {JsonObject} */ (obj.config)
  return out
}

/**
 * @param {unknown} entry
 * @param {string} pointer
 * @param {ValidationError[]} errors
 * @returns {SinkConfigInstance|undefined}
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
      out.config = /** @type {import('../../../collectivus-plugin-kernel-types').SinkInstanceConfig} */ (obj.config)
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
      out.config = /** @type {import('../../../collectivus-plugin-kernel-types').SinkInstanceConfig} */ (obj.config)
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
 * @param {Record<string, unknown>} obj
 * @param {string} pointer
 * @param {ValidationError[]} errors
 * @returns {QueryConfig|undefined}
 */
function parseQueryConfig(obj, pointer, errors) {
  if (obj.cache === undefined) return {}
  if (!isPlainObject(obj.cache)) {
    errors.push({ pointer: `${pointer}/cache`, message: 'query.cache must be an object' })
    return undefined
  }
  const cache = /** @type {Record<string, unknown>} */ (obj.cache)
  /** @type {import('../../../collectivus-plugin-kernel-types').QueryCacheConfig} */
  const out = {}
  if (cache.dir !== undefined) {
    if (!isNonEmptyString(cache.dir)) {
      errors.push({ pointer: `${pointer}/cache/dir`, message: 'query.cache.dir must be a non-empty string' })
    } else {
      out.dir = cache.dir
    }
  }
  if (cache.retention !== undefined) {
    if (!isPlainObject(cache.retention)) {
      errors.push({ pointer: `${pointer}/cache/retention`, message: 'query.cache.retention must be an object' })
    } else {
      const ret = /** @type {Record<string, unknown>} */ (cache.retention)
      if (typeof ret.default_days !== 'number' || !Number.isFinite(ret.default_days) || ret.default_days < 0) {
        errors.push({
          pointer: `${pointer}/cache/retention/default_days`,
          message: 'query.cache.retention.default_days must be a non-negative number',
        })
      }
      /** @type {Record<string, number>|undefined} */
      let datasets
      if (ret.datasets !== undefined) {
        if (!isPlainObject(ret.datasets)) {
          errors.push({
            pointer: `${pointer}/cache/retention/datasets`,
            message: 'query.cache.retention.datasets must be an object of dataset name -> days',
          })
        } else {
          datasets = {}
          for (const [ds, days] of Object.entries(/** @type {Record<string, unknown>} */ (ret.datasets))) {
            if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
              errors.push({
                pointer: `${pointer}/cache/retention/datasets/${ds}`,
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
  return { cache: out }
}

/** @param {unknown} v */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** @param {unknown} v */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0
}

/** @param {unknown} err */
function describeError(err) {
  return err instanceof Error ? err.message : String(err)
}
