// @ts-check

import os from 'node:os'
import path from 'node:path'

import { Attr, getLogger } from '../observability/index.js'
import { createConfigRegistry } from '../config/schema.js'
import { createCapabilityRegistry } from '../registry/capabilities.js'
import { createClientRegistry } from '../registry/clients.js'
import { createCommandRegistry } from '../registry/commands.js'
import { createQueryRegistry } from '../registry/datasets.js'
import { createVerbRegistry } from '../registry/verbs.js'
import { registerCoreVerbs } from '../cli/core_verbs.js'
import { createBackfillMaterializerRegistry, createBackfillRegistry } from '../registry/backfills.js'
import { createSinkRegistry } from '../registry/sinks.js'
import { createSourceRegistry } from '../registry/sources.js'
import { createQueryStorageService } from '../cache/storage.js'
import { createUsagePolicyResolver } from '../usage-policy/matcher.js'
import { localOnlyListPath } from '../usage-policy/local_only.js'
import { isSafeContributionName } from './contribution_names.js'
import { compareStrings } from '../util/compare_strings.js'

/**
 * @import { ActivePlugin, AgentContribution, AgentRegistry, BackfillMaterializerRegistry, BackfillRegistry, CapabilityName, CapabilityRegistry, ClientRegistry, ConfigControlFacade, InitPresetContribution, InitPresetRegistry, JsonObject, PermissionContext, PluginActivationContext, PluginLogger, PluginName, PluginPaths, PluginPermission, QueryRegistry, SemverRange, SemverVersion, SkillContribution, SkillRegistry, SourceContribution, VerbRegistry } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService, SourceWithholdResolver } from '../../../src/core/cache/types.js'
 * @import { ExtendedSourceRegistry } from '../../../src/core/registry/types.js'
 * @import { KernelRuntime } from '../../../src/core/runtime/types.js'
 */

/**
 * Build the kernel-global registries shared across an activation pass.
 * Each kernel boot creates a fresh runtime so smoke flows are
 * independent. Capabilities, commands, sources, sinks, query, and
 * storage are wired to real implementations; the remaining registries
 * land in their respective phases without touching this surface.
 *
 * `cacheRoot` is the on-disk location of the intrinsic Iceberg cache
 * (the kernel-owned `<HYP_HOME>/hypaware/cache` by default; the
 * dispatcher passes the resolved path).
 *
 * @param {{
 *   capabilityRegistry?: ReturnType<typeof createCapabilityRegistry>,
 *   commandRegistry?: ReturnType<typeof createCommandRegistry>,
 *   queryRegistry?: QueryRegistry,
 *   verbRegistry?: VerbRegistry,
 *   sourceRegistry?: ReturnType<typeof createSourceRegistry>,
 *   sinkRegistry?: ReturnType<typeof createSinkRegistry>,
 *   backfillRegistry?: BackfillRegistry,
 *   backfillMaterializerRegistry?: BackfillMaterializerRegistry,
 *   clientRegistry?: ClientRegistry,
 *   storage?: ExtendedQueryStorageService,
 *   cacheRoot?: string,
 *   configControl?: ConfigControlFacade,
 *   sourceWithholdResolver?: SourceWithholdResolver,
 * }} [opts]
 * @returns {KernelRuntime}
 * @ref LLP 0003#intrinsic-not-plugin-provided [implements]: query + storage are wired in as intrinsic services, not plugin contributions
 */
export function createKernelRuntime(opts = {}) {
  const cacheRoot = opts.cacheRoot ?? opts.storage?.cacheRoot ?? defaultCacheRoot()
  const query = opts.queryRegistry ?? createQueryRegistry()
  const storage = opts.storage ?? createQueryStorageService({
    cacheRoot,
    getDeclaration: (dataset) => query.getDataset(dataset)?.cachePartitioning,
    getSettleHook: (dataset) => query.getDataset(dataset)?.settleBatch,
    // @ref LLP 0070#enforce [implements]: every kernel boot enforces `local-only`
    // at the shared export read. The resolver's second source is the
    // machine-local list under `<stateDir>/usage-policy/`, and `cacheRoot` is
    // `<stateDir>/cache`, so its parent is the state dir the list lives beside.
    usagePolicyResolver: createUsagePolicyResolver({ localOnlyListPath: localOnlyListPath(path.dirname(cacheRoot)) }),
    // @ref LLP 0188#opt-out [implements]: caller-supplied (`bootKernel`,
    // built from the opt-out store + `classifyClientProvenance` + the
    // plugin catalog, since the latter two need the resolved plugin
    // catalog and two-layer config this constructor doesn't have).
    // `undefined` on a machine with no central layer: every current
    // caller of `createKernelRuntime` is untouched until it opts in.
    ...(opts.sourceWithholdResolver ? { sourceWithholdResolver: opts.sourceWithholdResolver } : {}),
  })
  const commands = opts.commandRegistry ?? createCommandRegistry()
  // The verb registry projects each verb into a CLI command on the shared
  // command registry; core's intrinsic verbs (query_sql) register here so
  // their command + MCP tool exist on every boot (LLP 0034 §verbs).
  const verbs = opts.verbRegistry ?? createVerbRegistry({ commandRegistry: commands })
  if (!opts.verbRegistry) registerCoreVerbs(verbs)
  return {
    ...(opts.configControl ? { configControl: opts.configControl } : {}),
    capabilities: opts.capabilityRegistry ?? createCapabilityRegistry(),
    commands,
    configRegistry: createConfigRegistry(),
    sources: opts.sourceRegistry ?? createSourceRegistry(),
    sinks: opts.sinkRegistry ?? createSinkRegistry(),
    query,
    verbs,
    storage,
    cacheRoot: storage.cacheRoot,
    skills: createSkillRegistry(),
    agents: createAgentRegistry(),
    initPresets: createInitPresetRegistry(),
    backfills: opts.backfillRegistry ?? createBackfillRegistry(),
    backfillMaterializers: opts.backfillMaterializerRegistry ?? createBackfillMaterializerRegistry(),
    clients: opts.clientRegistry ?? createClientRegistry(),
    activationContexts: new Map(),
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
 * @ref LLP 0004#the-activation-context [implements]: per-plugin ctx: config slice, registry facades, scoped logger, requireCapability
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
    sources: createSourcesFacade(pluginName, runtime.sources),
    sinks: runtime.sinks,
    query: runtime.query,
    verbs: runtime.verbs,
    storage: runtime.storage,
    skills: runtime.skills,
    agents: runtime.agents,
    initPresets: runtime.initPresets,
    backfills: runtime.backfills,
    backfillMaterializers: runtime.backfillMaterializers,
    clients: runtime.clients,
    // @ref LLP 0025#apply-engine-is-kernel-surface [implements]: plugins reach the apply engine only through this narrow facade; absent outside the daemon
    ...(runtime.configControl ? { configControl: runtime.configControl } : {}),
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
  runtime.activationContexts.set(pluginName, ctx)
  return ctx
}

/**
 * Per-plugin facade over the global source registry. `register` tells the
 * registry which plugin is calling, so a source is bound to its registrar
 * rather than to the `plugin` its own contribution declares: the daemon picks
 * the activation context a source starts under from that binding, and the
 * declared field is plugin-written (issue #1541).
 *
 * The rest of the registry is read through to. `ctx.sources` has always
 * carried the kernel-side lifecycle members too, and `@hypaware/otel` starts
 * its own listener through them from `activate()`.
 *
 * Forwarding those unchanged aimed the #1541 defect the other way. A plugin
 * could no longer take a neighbour's context by registering under its name,
 * but it could still hand a neighbour's already-registered source its own
 * context by starting it: `ctxB.sources.start('ai-gateway', ctxB)` ran the
 * victim's `start()` with the squatter's config slice, paths, scoped logger,
 * capability handles and permission context, and the boot walk that followed
 * reached `started(name)` first and reported the row as started under its real
 * owner, so nothing refused and nothing warned (issue #1947). `stop` and
 * `stopAll` were the same handle pointed at a neighbour's running source. So
 * those four are bracketed too, against the same `ownerOf` binding
 * `register` already writes: a plugin drives the lifecycle of the sources the
 * kernel recorded it as registering and of no others. The kernel is not on
 * this path - the daemon's boot walk holds `runtime.sources`, picks the
 * context from `ownerOf` itself, and never sees a facade - and the two
 * bundled plugins that do drive a lifecycle here (`@hypaware/otel` starting
 * `otlp` from `activate()`, `@hypaware/gascity` starting and reloading
 * `gascity` from its commands) are each driving their own source.
 *
 * `started` and `listStarted` are bracketed with them, because what they hand
 * back is the `StartedSource` the four above drive: `started(name).stop()` is
 * `stop(name)` reached through the handle, and it runs behind the registry, so
 * the source stays in its started map and its gauge stays ticked up while
 * nothing is running. Those two filter rather than refuse: each already has an
 * answer for a source that is not started, and a plugin reading its own reads
 * them unchanged.
 *
 * `status` stays forwarded. It takes no context, moves no source between
 * states, hands back a value rather than the handle, and leaves the started
 * set it reads exactly as it found it.
 *
 * A registry without `registeringAs` is called exactly as before, and so is
 * one without `ownerOf`: a host driving its own registry through
 * `hypaware/integration` records no registrar for anything, so there is no
 * binding to read, and refusing on its absence would stop every source such a
 * host runs. That is the rule the daemon's boot walk reads `ownerOf` under
 * too. The plugin doctor's stand-in delegates to the real registry, so it has
 * both.
 *
 * "The rest" is forwarded by reading through to the registry rather than by
 * copying it. A spread carries own enumerable properties and nothing else, so
 * a registry keeping `get`/`list`/the lifecycle members on a prototype reached
 * a plugin without them: `ctx.sources.list` was not a function, and
 * `@hypaware/otel` could not start its own listener from `activate()`. That is
 * not hypothetical. `hypaware/integration`'s `run()` takes `opts.kernel`,
 * dispatch uses that kernel verbatim, and both its activation seams
 * (`activateSeamCommandPlugins` and `activatePluginClosure`) hand it to
 * `activatePlugins`, so a host's own registry reaches this function without
 * `createKernelRuntime` being exported at all. Reading through also keeps
 * `this` pointing at the facade, so a registry whose members read their own
 * state off `this` still find it. It is the same own-versus-inherited trap
 * `neuter` documents in `src/core/plugin_doctor/dry_run.js`, and it answers it
 * the same way: read through to the original rather than flatten a copy of it.
 *
 * The read-through is a proxy rather than the registry on the facade's
 * prototype chain, because a prototype is reachable from the object that
 * inherits it: `Object.getPrototypeOf(ctx.sources).register(contribution)`
 * reached the registry's own unbracketed `register`, so no owner was recorded
 * and the `plugin !== registrar` refusal never ran, and a contribution that
 * took a key that way declared any plugin it liked and was started under that
 * plugin's context, config slice, paths and capability handles (issue #1944).
 * The proxy target holds the bracketed members below non-configurably and has
 * a null prototype, so nothing but this closure reaches the registry and no
 * shadow can be deleted out of the way. What the chain gave a plugin it still
 * gives: inherited members answer, `in` sees what the registry has, and a
 * write lands on the facade rather than on the shared registry. A lifecycle
 * member is shadowed only where the registry has one to shadow, so a registry
 * that never offered `stopAll` does not acquire one here.
 *
 * @param {PluginName} pluginName
 * @param {ExtendedSourceRegistry} registry
 * @returns {ExtendedSourceRegistry}
 * @ref LLP 0004#the-activation-context [implements]: `sources` is one of the per-plugin registry facades
 */
function createSourcesFacade(pluginName, registry) {
  const members = {
    /** @param {SourceContribution} contribution */
    register(contribution) {
      if (typeof registry.registeringAs !== 'function') {
        registry.register(contribution)
        return
      }
      // Through `register`, not around it: the doctor wraps that member to
      // neuter `start()` before the real registry stores it.
      registry.registeringAs(pluginName, () => { registry.register(contribution) })
    },
    /**
     * Always the activating plugin's name, whatever is passed, like
     * `provide` on the capabilities facade below. Delegation would
     * otherwise hand a plugin the kernel's own lever for saying who is
     * registering.
     *
     * @template T
     * @param {PluginName} _plugin
     * @param {() => T} fn
     * @returns {T}
     */
    registeringAs(_plugin, fn) {
      if (typeof registry.registeringAs !== 'function') return fn()
      return registry.registeringAs(pluginName, fn)
    },
  }
  /**
   * Refuse a lifecycle call aimed at a source this plugin is not recorded as
   * having registered, which includes one the registry recorded no registrar
   * for at all: a source that took its key out of band chose the `plugin` it
   * carries, and that claim is the one party the kernel must not ask.
   *
   * `name` is not validated the way `register` validates it, so it is quoted
   * only when it is already a string: a hostile `toString` must not throw out
   * of the refusal refusing it. A non-string keys no source, so it is refused
   * either way. The logger is resolved here rather than per facade, which
   * every activation builds and almost none of which ever refuse anything.
   *
   * @param {string} operation
   * @param {string} name
   */
  function refuseForeignSource(operation, name) {
    const owner = registry.ownerOf(name)
    if (owner === pluginName) return
    const shown = typeof name === 'string' ? name : '(non-string source name)'
    const held = owner === undefined ? 'no recorded plugin' : `'${owner}'`
    getLogger('sources').warn('source.lifecycle_owner_mismatch', {
      [Attr.COMPONENT]: 'sources',
      [Attr.OPERATION]: `source.${operation}`,
      [Attr.ERROR_KIND]: 'source_owner_mismatch',
      [Attr.PLUGIN]: pluginName,
      hyp_owner_plugin: owner ?? '',
      hyp_source: shown,
      status: 'failed',
    })
    throw new Error(
      `SourceRegistry.${operation}: source '${shown}' is registered by ${held}, not by '${pluginName}'`
    )
  }
  // The four that refuse are async so a refusal arrives as the rejection every
  // other lifecycle failure arrives as, rather than as a synchronous throw out
  // of an awaited call. The two that filter keep the registry's own synchronous
  // signatures, because a plugin reading its own reads them as it always did.
  // @ref LLP 0012#lifecycle-and-reload-context-invariant [constrained-by]: the kernel drives the lifecycle, so a plugin's own facade drives only what it registered
  const lifecycle = {
    /**
     * @param {string} name
     * @param {PluginActivationContext} ctx
     */
    async start(name, ctx) {
      refuseForeignSource('start', name)
      return registry.start(name, ctx)
    },
    /** @param {string} name */
    async stop(name) {
      refuseForeignSource('stop', name)
      return registry.stop(name)
    },
    /**
     * @param {string} name
     * @param {PluginActivationContext} ctx
     */
    async reload(name, ctx) {
      refuseForeignSource('reload', name)
      return registry.reload(name, ctx)
    },
    /**
     * This plugin's own started sources, not every source the daemon is
     * running. Names come from `listStarted`, so each is the key the registry
     * started the source under rather than a live `contribution.name`.
     */
    async stopAll() {
      for (const { name } of registry.listStarted()) {
        if (registry.ownerOf(name) === pluginName) await registry.stop(name)
      }
    },
    /**
     * The `StartedSource` itself, which is why these two are bracketed
     * alongside the four above rather than left forwarded with `status`:
     * `started(name).stop()` and `started(name).reload(ctx)` are the refusals
     * above reached through the handle instead of by name, and they run behind
     * the registry, which keeps the source in its started map and the
     * `hyp_sources_started` gauge ticked up, so the boot walk and `hyp status`
     * go on reporting a source nothing is running. `listStarted` handed the
     * whole set out without even needing the name.
     *
     * Filtered rather than refused: both members already answer "nothing
     * started under that name", so a plugin reading its own is unaffected and
     * one reading a neighbour's gets the answer it would get before the
     * neighbour started.
     *
     * @param {string} name
     */
    started(name) {
      return registry.ownerOf(name) === pluginName ? registry.started(name) : undefined
    },
    listStarted() {
      return registry.listStarted().filter(({ name }) => registry.ownerOf(name) === pluginName)
    },
  }
  // Non-writable and non-configurable, not merely assigned: `delete
  // ctx.sources.register` took the own property away and the miss below then
  // read through to the registry's own unbracketed `register`, which is the
  // whole of issue #1944 again in one statement; deleting `registeringAs` too
  // reached the registrar lever and recorded any plugin at all as the owner.
  // A property the target holds non-configurably is one neither a plugin nor a
  // later trap can take away, so the shadow over the members that carry the
  // binding cannot be lifted. `enumerable` so `Object.keys`, a spread and
  // `for...in` still see them, as the object this replaces answered.
  const facade = Object.create(null)
  /** @param {string} member @param {unknown} value */
  const pin = (member, value) => {
    Object.defineProperty(facade, member, { value, enumerable: true, writable: false, configurable: false })
  }
  for (const [member, value] of Object.entries(members)) pin(member, value)
  // Only where there is a binding to read, and only over a member the registry
  // actually has: a host registry carrying neither is left reading as it did.
  // `stopAll` is rebuilt out of `listStarted`, so it is shadowed only where
  // that is there to rebuild it from.
  if (typeof registry?.ownerOf === 'function') {
    const shadowable = {
      start: typeof registry.start === 'function',
      stop: typeof registry.stop === 'function',
      reload: typeof registry.reload === 'function',
      stopAll: typeof registry.stopAll === 'function' && typeof registry.listStarted === 'function',
      started: typeof registry.started === 'function',
      listStarted: typeof registry.listStarted === 'function',
    }
    for (const [member, value] of Object.entries(lifecycle)) {
      if (shadowable[/** @type {keyof typeof shadowable} */ (member)]) pin(member, value)
    }
  }
  return new Proxy(facade, {
    /**
     * @param {Record<string | symbol, unknown>} target
     * @param {string | symbol} prop
     * @param {unknown} receiver
     */
    get(target, prop, receiver) {
      // Own first, so the bracketed members above are the only `register`,
      // `registeringAs` and lifecycle members a plugin can reach, and none of
      // them can be deleted to uncover the registry's.
      if (Object.hasOwn(target, prop)) return Reflect.get(target, prop, receiver)
      // The facade as the receiver, so a registry member reading its own state
      // off `this` still finds it. A runtime with no source registry builds a
      // context and fails on the call, the way the spread this replaces did.
      return registry == null ? undefined : Reflect.get(registry, prop, receiver)
    },
    /**
     * @param {Record<string | symbol, unknown>} target
     * @param {string | symbol} prop
     */
    has(target, prop) {
      return Object.hasOwn(target, prop) || (registry != null && Reflect.has(registry, prop))
    },
  })
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
 * declared permissions. There is no interactive grant flow, so
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
 * @ref LLP 0006#resolution-rules [constrained-by]: facade pins the activating plugin's identity; can't impersonate a provider
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
    fromProvider(provider, name, range) { return registry.fromProvider(provider, name, range) },
  }
}

/**
 * Skill registry. Stores contributions from client-adapter plugins so
 * `hyp skills install`, client attach, and the walkthrough finale can
 * enumerate what each plugin wants materialized into the per-client
 * skill directories.
 *
 * @returns {SkillRegistry}
 */
function createSkillRegistry() {
  /** @type {SkillContribution[]} */
  const items = []
  return {
    register(skill) {
      // Read each field once and build the record out of what these lines
      // checked. `skill` is the plugin's own object, so every re-read is a
      // fresh question an accessor may answer differently: the `name` stored
      // below was the fourth read, three after `isSafeContributionName`
      // cleared one, so a traversal name could reach the record with nothing
      // having validated it (issue #1552, as #1555 in the preset registry).
      const name = skill?.name
      const plugin = skill?.plugin
      const clients = skill?.clients
      const sourceDir = skill?.sourceDir
      const projectLocal = skill?.projectLocal
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('skills.register: name is required')
      }
      // @ref LLP 0003#principle [constrained-by]: name is interpolated into
      // `<skill_dir>/<name>`; reject traversal before it reaches the filesystem.
      if (!isSafeContributionName(name)) {
        throw new TypeError(`skills.register '${name}': name must be a safe basename (no '/', '\\\\', '..', or absolute path)`)
      }
      if (typeof plugin !== 'string' || plugin.length === 0) {
        throw new TypeError(`skills.register '${name}': plugin is required`)
      }
      if (!Array.isArray(clients) || clients.length === 0) {
        throw new TypeError(`skills.register '${name}': clients must be a non-empty array`)
      }
      if (typeof sourceDir !== 'string' || sourceDir.length === 0) {
        throw new TypeError(`skills.register '${name}': sourceDir is required`)
      }
      items.push({
        name,
        plugin,
        clients: [...clients],
        sourceDir,
        ...(projectLocal !== undefined ? { projectLocal } : {}),
      })
    },
    // A copy per entry, and of the `clients` array inside it, the way
    // `capabilities.list()` already hands back fresh objects. `ctx.skills` is
    // on the activation context, so `items.slice()` - a copy of the array,
    // whose elements were the stored records - let a plugin calling `list()`
    // inside its own `activate()` rewrite the record every later reader then
    // read: the doctor's report, and the `<skill_dir>/<name>` an install
    // joins (issue #1552).
    list() { return items.map((item) => ({ ...item, clients: [...item.clients] })) },
  }
}

/**
 * Agent registry. The skill registry's twin, read by the same callers:
 * a subagent is the other shape of client asset, differing only in that
 * each contribution points at a single markdown definition file rather
 * than a directory (LLP 0138). Kept a separate registry because plugins
 * register two shapes; only the install surface is unified.
 *
 * @returns {AgentRegistry}
 */
function createAgentRegistry() {
  /** @type {AgentContribution[]} */
  const items = []
  return {
    register(agent) {
      // Read once and store what was checked, for the reason on the skill
      // registry above (issue #1552).
      const name = agent?.name
      const plugin = agent?.plugin
      const clients = agent?.clients
      const sourceFile = agent?.sourceFile
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('agents.register: name is required')
      }
      // @ref LLP 0003#principle [constrained-by]: name is interpolated into
      // `<agent_dir>/<name>.md`; reject traversal before it reaches the filesystem.
      if (!isSafeContributionName(name)) {
        throw new TypeError(`agents.register '${name}': name must be a safe basename (no '/', '\\\\', '..', or absolute path)`)
      }
      if (typeof plugin !== 'string' || plugin.length === 0) {
        throw new TypeError(`agents.register '${name}': plugin is required`)
      }
      if (!Array.isArray(clients) || clients.length === 0) {
        throw new TypeError(`agents.register '${name}': clients must be a non-empty array`)
      }
      if (typeof sourceFile !== 'string' || sourceFile.length === 0) {
        throw new TypeError(`agents.register '${name}': sourceFile is required`)
      }
      items.push({
        name,
        plugin,
        clients: [...clients],
        sourceFile,
      })
    },
    // Copies, for the reason on the skill registry above (issue #1552).
    list() { return items.map((item) => ({ ...item, clients: [...item.clients] })) },
  }
}

/**
 * Init-preset registry. Plugins contribute presets via
 * `ctx.initPresets.register({ name, plugin, summary, run })` during
 * activation. `hyp init <preset>` looks up the preset by name and
 * invokes its `run(argv, ctx)` with the command run context.
 *
 * The registry is intentionally non-validating beyond the basic shape
 * checks. Preset authors own their argv parsing and config writing
 * in `run()`.
 *
 * @returns {InitPresetRegistry}
 */
function createInitPresetRegistry() {
  /** @type {Map<string, InitPresetContribution>} */
  const presets = new Map()
  const log = getLogger('init-presets')

  return {
    register(preset) {
      if (!preset || typeof preset !== 'object') {
        throw new TypeError('initPresets.register: preset must be an object')
      }
      // Read once, and key the map on what this line validated. The
      // registration is stored by reference, so `preset.name` is a live
      // plugin property: reading it again put the duplicate check and the
      // `set` to an accessor free to answer them differently, and stored the
      // preset under a name nothing had checked, which is also the key `list`
      // orders by.
      const name = preset.name
      if (typeof name !== 'string' || name.length === 0) {
        throw new TypeError('initPresets.register: name is required')
      }
      if (typeof preset.plugin !== 'string' || preset.plugin.length === 0) {
        throw new TypeError(`initPresets.register '${name}': plugin is required`)
      }
      if (typeof preset.summary !== 'string') {
        throw new TypeError(`initPresets.register '${name}': summary is required`)
      }
      if (typeof preset.run !== 'function') {
        throw new TypeError(`initPresets.register '${name}': run() is required`)
      }
      if (presets.has(name)) {
        throw new Error(`initPresets.register: duplicate preset '${name}'`)
      }
      presets.set(name, preset)
      log.info('init.preset.register', {
        [Attr.PLUGIN]: preset.plugin,
        preset_name: name,
      })
    },
    get(name) {
      return presets.get(name)
    },
    /**
     * Every registered preset, ordered by name.
     *
     * The order comes from the keys, not from `a.name`: the key is the name
     * `register` validated, while `preset.name` is a live property of the
     * plugin's own object, which that function stores by reference. Reading
     * it here would run plugin code inside a comparator, where a throw
     * escapes into every caller of `list()` - `hyp init`'s preset picker and
     * its unknown-preset listing, and the plugin doctor's dry run - before a
     * single preset has been handed back, and where `compareStrings` refuses
     * a non-string, so an accessor that merely stops answering with a string
     * is the same outage (issue #1555, after #1524 in the dataset registry).
     */
    list() {
      return Array.from(presets.keys())
        .sort(compareStrings)
        .map((name) => /** @type {InitPresetContribution} */ (presets.get(name)))
    },
  }
}
