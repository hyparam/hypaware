// @ts-check

import os from 'node:os'
import path from 'node:path'

import { Attr, getLogger } from '../observability/index.js'
import { createCapabilityRegistry } from '../registry/capabilities.js'
import { createCommandRegistry } from '../registry/commands.js'
import { createQueryRegistry } from '../registry/datasets.js'
import { createQueryStorageService } from '../cache/storage.js'

/** @typedef {import('../../../collectivus-plugin-kernel-types').ActivePlugin} ActivePlugin */
/** @typedef {import('../../../collectivus-plugin-kernel-types').CapabilityName} CapabilityName */
/** @typedef {import('../../../collectivus-plugin-kernel-types').CapabilityRegistry} CapabilityRegistry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').CommandRegistry} CommandRegistry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').ConfigRegistry} ConfigRegistry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').InitPresetRegistry} InitPresetRegistry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').JsonObject} JsonObject */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PermissionContext} PermissionContext */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginActivationContext} PluginActivationContext */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginLogger} PluginLogger */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginManifest} PluginManifest */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginName} PluginName */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginPaths} PluginPaths */
/** @typedef {import('../../../collectivus-plugin-kernel-types').PluginPermission} PluginPermission */
/** @typedef {import('../../../collectivus-plugin-kernel-types').QueryRegistry} QueryRegistry */
/** @typedef {import('../cache/storage.js').ExtendedQueryStorageService} ExtendedQueryStorageService */
/** @typedef {import('../../../collectivus-plugin-kernel-types').SemverRange} SemverRange */
/** @typedef {import('../../../collectivus-plugin-kernel-types').SemverVersion} SemverVersion */
/** @typedef {import('../../../collectivus-plugin-kernel-types').SinkRegistry} SinkRegistry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').SkillRegistry} SkillRegistry */
/** @typedef {import('../../../collectivus-plugin-kernel-types').SourceRegistry} SourceRegistry */

/**
 * The kernel-side aggregate that activation contexts facade over.
 * Registries beyond `capabilities`, `commands`, `query`, and
 * `storage` are still Phase-2 placeholders; later phases promote
 * each one in place without touching this surface.
 *
 * @typedef {Object} KernelRuntime
 * @property {ReturnType<typeof createCapabilityRegistry>} capabilities
 * @property {ReturnType<typeof createCommandRegistry>} commands
 * @property {ConfigRegistry} configRegistry
 * @property {SourceRegistry} sources
 * @property {SinkRegistry} sinks
 * @property {QueryRegistry} query
 * @property {ExtendedQueryStorageService} storage
 * @property {string} cacheRoot
 * @property {SkillRegistry} skills
 * @property {InitPresetRegistry} initPresets
 */

/**
 * Build the kernel-global registries shared across an activation pass.
 * Each kernel boot creates a fresh runtime so smoke flows are
 * independent. Capabilities, commands, query, and storage are wired
 * to real implementations; the remaining registries land in their
 * respective phases without touching this surface.
 *
 * `cacheRoot` is the on-disk location of the intrinsic Iceberg cache
 * (the kernel-owned `<HYP_HOME>/hypaware/cache` by default; the
 * dispatcher passes the resolved path).
 *
 * @param {{
 *   capabilityRegistry?: ReturnType<typeof createCapabilityRegistry>,
 *   commandRegistry?: ReturnType<typeof createCommandRegistry>,
 *   queryRegistry?: QueryRegistry,
 *   storage?: ExtendedQueryStorageService,
 *   cacheRoot?: string,
 * }} [opts]
 * @returns {KernelRuntime}
 */
export function createKernelRuntime(opts = {}) {
  const cacheRoot = opts.cacheRoot ?? opts.storage?.cacheRoot ?? defaultCacheRoot()
  const storage = opts.storage ?? createQueryStorageService({ cacheRoot })
  return {
    capabilities: opts.capabilityRegistry ?? createCapabilityRegistry(),
    commands: opts.commandRegistry ?? createCommandRegistry(),
    configRegistry: createPhase2ConfigRegistry(),
    sources: createPhase2SourceRegistry(),
    sinks: createPhase2SinkRegistry(),
    query: opts.queryRegistry ?? createQueryRegistry(),
    storage,
    cacheRoot: storage.cacheRoot,
    skills: createPhase2SkillRegistry(),
    initPresets: createPhase2InitPresetRegistry(),
  }
}

/**
 * Fallback cache root when the dispatcher hasn't computed one yet.
 * Activation pathways that build their own runtime in tests can
 * still override it through `opts.cacheRoot`.
 */
function defaultCacheRoot() {
  const hypHome = process.env.HYP_HOME || path.join(os.homedir(), '.hyp')
  return path.join(hypHome, 'hypaware', 'cache')
}

/**
 * Materialize a `PluginActivationContext` for a single plugin. The
 * returned object delegates registry calls to the kernel runtime but
 * forces `hyp_plugin` onto every emission, so a misbehaving plugin
 * cannot impersonate a different one.
 *
 * @param {object} args
 * @param {KernelRuntime}    args.runtime
 * @param {ActivePlugin}     args.plugin
 * @param {PluginPaths}      args.paths
 * @param {JsonObject}       [args.config]
 * @param {NodeJS.ProcessEnv} [args.env]
 * @returns {PluginActivationContext}
 */
export function createActivationContext({ runtime, plugin, paths, config, env }) {
  const pluginName = plugin.name
  const log = createPluginLogger(pluginName)
  const permissions = createPermissionContext(pluginName, plugin.manifest.permissions ?? [])
  const capabilities = createCapabilitiesFacade(pluginName, runtime.capabilities)

  /** @type {PluginActivationContext} */
  const ctx = {
    plugin,
    config: config ?? {},
    env: env ?? process.env,
    paths,
    log,
    permissions,
    capabilities,
    commands: runtime.commands,
    configRegistry: runtime.configRegistry,
    sources: runtime.sources,
    sinks: runtime.sinks,
    query: runtime.query,
    storage: runtime.storage,
    skills: runtime.skills,
    initPresets: runtime.initPresets,
    /**
     * @template T
     * @param {CapabilityName} name
     * @param {SemverRange} [range]
     * @returns {T}
     */
    requireCapability(name, range) {
      return /** @type {T} */ (runtime.capabilities.require(pluginName, name, range))
    },
    /**
     * @template T
     * @param {CapabilityName} name
     * @param {SemverVersion} version
     * @param {T} value
     */
    provideCapability(name, version, value) {
      runtime.capabilities.provide(pluginName, name, version, value)
    },
  }
  return ctx
}

/**
 * Per-plugin logger that injects `hyp_plugin=<name>` into every
 * emission. Routes through `getLogger('plugin')` so all plugin-side
 * logs land with `hyp_component=plugin`.
 *
 * @param {PluginName} pluginName
 * @returns {PluginLogger}
 */
function createPluginLogger(pluginName) {
  const base = getLogger('plugin')
  /**
   * @param {Record<string, unknown> | undefined} fields
   */
  function withPlugin(fields) {
    return { ...(fields ?? {}), [Attr.PLUGIN]: pluginName }
  }
  return {
    debug(message, fields) { base.debug(message, withPlugin(fields)) },
    info(message, fields)  { base.info(message,  withPlugin(fields)) },
    warn(message, fields)  { base.warn(message,  withPlugin(fields)) },
    error(message, fields) { base.error(message, withPlugin(fields)) },
  }
}

/**
 * Build a per-plugin permission context backed by the manifest's
 * declared permissions. Phase 2 has no interactive grant flow, so
 * `request(p)` resolves true only if the permission was pre-granted in
 * the manifest.
 *
 * @param {PluginName} pluginName
 * @param {PluginPermission[]} granted
 * @returns {PermissionContext}
 */
function createPermissionContext(pluginName, granted) {
  const set = new Set(granted)
  return {
    has(permission) { return set.has(permission) },
    require(permission) {
      if (!set.has(permission)) {
        throw new Error(`plugin '${pluginName}' lacks required permission '${permission}'`)
      }
    },
    request(permission) {
      return Promise.resolve(set.has(permission))
    },
  }
}

/**
 * Per-plugin facade over the global capability registry. `provide` and
 * `require` always pass the activating plugin's name regardless of
 * what the plugin claims; `has` and `list` are read-only and forwarded
 * unchanged.
 *
 * @param {PluginName} pluginName
 * @param {ReturnType<typeof createCapabilityRegistry>} registry
 * @returns {CapabilityRegistry}
 */
function createCapabilitiesFacade(pluginName, registry) {
  return {
    provide(_provider, name, version, value) {
      registry.provide(pluginName, name, version, value)
    },
    require(_requester, name, range) {
      return registry.require(pluginName, name, range)
    },
    has(name, range) { return registry.has(name, range) },
    list() { return registry.list() },
  }
}

/* ----- Phase 2 placeholder registries ----- */
/* Each registry below is a no-op shell that conforms to the kernel
 * type contract. Later phases swap in real implementations without
 * touching the activation surface. */

/** @returns {ConfigRegistry} */
function createPhase2ConfigRegistry() {
  return {
    registerSection() {},
    validatePluginConfig() { return { ok: true } },
  }
}

/** @returns {SourceRegistry} */
function createPhase2SourceRegistry() {
  return {
    register() {},
    get() { return undefined },
    list() { return [] },
  }
}

/** @returns {SinkRegistry} */
function createPhase2SinkRegistry() {
  return {
    register() {},
    get() { return undefined },
    list() { return [] },
  }
}

/** @returns {SkillRegistry} */
function createPhase2SkillRegistry() {
  return {
    register() {},
    list() { return [] },
  }
}

/** @returns {InitPresetRegistry} */
function createPhase2InitPresetRegistry() {
  return {
    register() {},
    get() { return undefined },
    list() { return [] },
  }
}
