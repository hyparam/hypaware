// @ts-check

import path from 'node:path'

import {
  Attr,
  getLogger,
  runRoot,
} from '../observability/index.js'
import { defaultConfigPath, loadConfigFile } from '../config/schema.js'
import { resolveCentralLayerPath } from '../config/apply.js'
import { resolveLayeredConfig } from '../config/merge.js'
import { collectConfigErrors } from '../config/validate.js'
import { buildPluginCatalog } from '../plugin_catalog.js'
import { readObservabilityEnv } from '../observability/env.js'
import { resolveDependencies } from '../dep_graph.js'
import { activatePlugins } from './loader.js'
import { createKernelRuntime } from './activation.js'
import { createCommandRegistry } from '../registry/commands.js'
import {
  V1_BUNDLED_PLUGIN_ALLOWLIST,
  V1_EXCLUDED_FROM_DEFAULT,
  defaultBundledWorkspaceDir,
  discoverBundledPlugins,
} from './bundled.js'
import { discoverInstalledPlugins } from './installed.js'

/**
 * @import { ActivePlugin, HypAwareV2Config, JsonObject, PluginName } from '../../../collectivus-plugin-kernel-types.js'
 * @import { LoadedManifest } from '../../../src/core/types.js'
 * @import { KernelRuntime } from '../../../src/core/runtime/types.js'
 * @import { ActivationResult } from '../../../src/core/runtime/types.js'
 * @import { BootKernelOptions, BootKernelResult, BootProfile } from '../../../src/core/runtime/types.js'
 * @import { ConfigLayerDrop, LoadConfigResult, PluginMetadata } from '../../../src/core/config/types.js'
 */

/**
 * Boot the kernel: load config, discover bundled plugin manifests,
 * resolve dependencies, and activate the selected plugins. All work
 * runs inside a `kernel.boot` root span; each plugin activation lands
 * as a `plugin.activate` child of that span.
 *
 * The boot path is deliberately the **only** way the kernel becomes
 * usable: the CLI dispatcher, the daemon, the walkthrough, and the V1
 * smokes all call `bootKernel(...)` so plugin contributions are
 * available before any command runs.
 *
 * Bundled plugins are *available* (their manifests are discovered) but
 * not implicitly *active*: activation is driven by the config or by
 * an explicit `bootProfile`. Plugins in the V1 allowlist that the
 * caller did not select are logged as `plugin.skipped` with
 * `status=skipped` and `hyp_reason=not_configured`.
 *
 * `bootKernel` never throws on a missing config file. It activates
 * nothing and returns `config=null` so help/init paths keep working.
 *
 * @param {BootKernelOptions} [opts]
 * @returns {Promise<BootKernelResult>}
 */
export async function bootKernel(opts = {}) {
  const env = opts.env ?? process.env
  const obsEnv = readObservabilityEnv(env)
  const hypHome = opts.hypHome ?? obsEnv.hypHome
  const stateRoot = path.join(hypHome, 'hypaware')
  const cacheRoot = opts.cacheRoot ?? path.join(stateRoot, 'cache')
  const mode = opts.mode ?? 'cli'
  const runId = opts.runId ?? obsEnv.devRunId ?? `boot-${process.pid}-${Date.now()}`
  const bootProfile = opts.bootProfile ?? 'config'

  const configPath = resolveConfigPath({ explicit: opts.configPath, env, hypHome })

  return runRoot(
    'kernel.boot',
    {
      [Attr.COMPONENT]: 'kernel',
      [Attr.OPERATION]: 'kernel.boot',
      mode,
      [Attr.DEV_RUN_ID]: runId,
      hyp_home: hypHome,
      ...(configPath ? { config_path: configPath } : {}),
      status: 'ok',
    },
    async (span) => {
      const commandRegistry = opts.commandRegistry ?? createCommandRegistry()
      const runtime = createKernelRuntime({
        commandRegistry,
        cacheRoot,
        ...(opts.configControl ? { configControl: opts.configControl } : {}),
      })

      const discovered = await discoverBundledPlugins({ workspaceDir: opts.workspaceDir })
      span.setAttribute('bundled_available', discovered.loaded.length)
      if (discovered.failed.length > 0) {
        span.setAttribute('bundled_failed', discovered.failed.length)
      }
      if (discovered.excluded.length > 0) {
        span.setAttribute('bundled_excluded_from_default', discovered.excluded.length)
      }

      const installed = await discoverInstalledPlugins({ stateDir: stateRoot })
      span.setAttribute('installed_available', installed.loaded.length)
      if (installed.failed.length > 0) {
        span.setAttribute('installed_failed', installed.failed.length)
      }

      // An installed plugin must not shadow a bundled first-party
      // plugin by name. The override policy is intentionally deferred
      // (see hy-gh-2 design): reject boot with a clear, telemetry-tagged
      // error so the operator removes the installed copy before booting.
      // The same detection feeds the shared `selectBootPlugins` so help
      // knows to advertise no commands when boot would reject.
      const shadowing = detectShadowedPlugins({ discovered, installed })
      if (shadowing.length > 0) {
        span.setAttribute('installed_shadow_collisions', shadowing.length)
        span.setAttribute('error_kind', 'installed_shadows_bundled')
        const log = getLogger('kernel')
        for (const name of shadowing) {
          log.error('plugin.shadow_collision', {
            [Attr.PLUGIN]: name,
            [Attr.ERROR_KIND]: 'installed_shadows_bundled',
            hyp_reason: 'installed_plugin_name_collides_with_bundled',
          })
        }
        const message =
          `installed plugin(s) shadow bundled first-party plugin(s): ${shadowing.sort().join(', ')}. ` +
          `Remove the installed copy with 'hyp plugin remove <name>' before booting.`
        const shadowErr = /** @type {Error & { hypErrorKind?: string }} */ (new Error(message))
        shadowErr.hypErrorKind = 'installed_shadows_bundled'
        throw shadowErr
      }

      // Two-layer config resolution (LLP 0031): the effective config is
      // the merge of a server-owned **central** layer (authoritative,
      // locked) and the user-owned **local** layer (`hypaware-config.json`,
      // additive-only). Both are read-only here. Only the daemon's apply
      // engine ever writes the central layer. A host that never joined has
      // no central layer, so `effective = local` (this whole block is a
      // no-op for it) and behaviour is byte-for-byte what it was before.
      // The catalog is built from the very manifests this boot discovered
      // so the merge validates local additions against the same plugin set
      // it will activate.
      // @ref LLP 0031#two-layers-merged-at-boot [implements]: effective = merge(central, local), computed at boot
      const catalog = buildPluginCatalog([...discovered.loaded, ...discovered.excluded], installed.loaded)
      const merged = await resolveLayeredConfigFromDisk({
        stateRoot,
        configPath,
        knownPlugins: catalog.pluginMetadata,
        knownDatasets: catalog.knownDatasets,
      })
      const centralConfig = merged.centralConfig
      const centralConfigPath = merged.centralConfigPath
      const config = merged.effective

      // The central layer is sacrosanct: a local entry that collides with a
      // locked central key, or that invalidates the merge, is dropped
      // (loudly): never failing boot. A garbage local edit can never take
      // down a centrally-managed gateway.
      // @ref LLP 0031#central-layer-is-sacrosanct [implements]: collisions / invalid additions drop the local entry with a loud log; central always boots
      if (centralConfig) {
        const cfgLog = getLogger('config')
        for (const drop of merged.drops) {
          cfgLog.warn('config.local_entry_dropped', {
            [Attr.COMPONENT]: 'config',
            [Attr.ERROR_KIND]: drop.reason,
            section: drop.section,
            key: drop.key,
            hyp_reason: drop.reason,
            ...(drop.detail ? { detail: drop.detail } : {}),
          })
        }
        if (merged.centralQueryIgnored) {
          cfgLog.warn('config.central_query_ignored', {
            [Attr.COMPONENT]: 'config',
            hyp_reason: 'query_is_local_only',
          })
        }
        span.setAttribute('config_layers', 'central+local')
        if (merged.drops.length > 0) span.setAttribute('local_entries_dropped', merged.drops.length)
      }

      // Full plugin pool + selection (shared with help so `hyp --help`
      // advertises exactly the command set this boot would activate and
      // dispatch): V1 allowlist + excluded-from-default set + installed
      // plugins, with an installed plugin replacing a same-named excluded
      // bundled skeleton. Excluded plugins are in the pool so they activate
      // when named in config or an init preset, the allowlist only governs
      // default activation, not discoverability.
      const { installedNames, selected, selectedManifests } = selectBootPlugins({
        discovered,
        installed,
        config,
        bootProfile,
      })

      const log = getLogger('kernel')
      /** @type {PluginName[]} */
      const skipped = []
      for (const entry of discovered.loaded) {
        const name = /** @type {PluginName} */ (entry.manifest.name)
        if (!selected.has(name)) {
          skipped.push(name)
          log.info('plugin.skipped', {
            [Attr.PLUGIN]: name,
            [Attr.COMPONENT]: 'kernel',
            status: 'skipped',
            hyp_reason: 'not_configured',
          })
        }
      }
      for (const name of installedNames) {
        if (selected.has(name)) {
          log.info('plugin.installed_active', {
            [Attr.PLUGIN]: name,
            [Attr.COMPONENT]: 'kernel',
            status: 'selected',
            hyp_source: 'installed',
          })
        }
      }

      span.setAttribute('plugins_selected', selected.size)
      span.setAttribute('plugins_skipped', skipped.length)
      const installedSelectedCount = [...installedNames].filter((n) => selected.has(n)).length
      if (installedSelectedCount > 0) {
        span.setAttribute('installed_selected', installedSelectedCount)
      }
      span.setAttribute('boot_profile', describeBootProfile(bootProfile))

      if (selected.size === 0) {
        return {
          runtime,
          activePlugins: /** @type {ActivePlugin[]} */ ([]),
          activations: /** @type {ActivationResult[]} */ ([]),
          config: config ?? null,
          configPath,
          centralConfigPath,
          configDrops: merged.drops,
          centralQueryIgnored: merged.centralQueryIgnored,
          mode,
          runId,
          skipped,
          clientDescriptors: catalog.clientDescriptors,
        }
      }

      const resolution = await resolveDependencies(selectedManifests.map((m) => m.manifest))
      span.setAttribute('resolve_order_hash', resolution.resolveOrderHash)
      span.setAttribute('plugins_resolved', resolution.order.length)
      if (resolution.unsatisfied.length > 0) {
        span.setAttribute('unsatisfied_count', resolution.unsatisfied.length)
      }

      const configByName = new Map(
        (config?.plugins ?? []).map((p) => /** @type {[PluginName, JsonObject]} */ ([p.name, p.config ?? {}]))
      )
      const byName = new Map(selectedManifests.map((m) => [m.manifest.name, m]))
      const activationEntries = resolution.order
        .map((name) => byName.get(name))
        .filter((entry) => entry !== undefined)
        .map((entry) => ({
          manifest: /** @type {LoadedManifest} */ (entry).manifest,
          rootDir: /** @type {LoadedManifest} */ (entry).rootDir,
          config: configByName.get(/** @type {PluginName} */ (/** @type {LoadedManifest} */ (entry).manifest.name)) ?? /** @type {JsonObject} */ ({}),
        }))

      const result = await activatePlugins({
        plugins: activationEntries,
        stateRoot,
        runId,
        runtime,
        tmpRoot: opts.tmpRoot,
      })

      const activePlugins = result.results
        .filter((r) => r.ok === true)
        .map((r) => r.plugin)
      span.setAttribute('plugins_activated', activePlugins.length)
      const failed = result.results.filter((r) => r.ok === false)
      if (failed.length > 0) span.setAttribute('plugins_failed', failed.length)

      return {
        runtime,
        activePlugins,
        activations: result.results,
        config: config ?? null,
        configPath,
        centralConfigPath,
        configDrops: merged.drops,
        centralQueryIgnored: merged.centralQueryIgnored,
        mode,
        runId,
        skipped,
        clientDescriptors: catalog.clientDescriptors,
      }
    },
    { component: 'kernel' }
  )
}

/**
 * Resolve the effective two-layer config from disk (LLP 0031): load the
 * user-owned **local** layer (`configPath`) and the server-owned
 * **central** layer (active slot / join seed under `stateRoot`), then
 * merge + prune via {@link resolveLayeredConfig}. Both layers are read
 * read-only. Only the daemon's apply engine ever writes the central
 * layer. The single place `bootKernel` and the SIGHUP reload agree on
 * what "effective" means, so a reload can never silently drop the central
 * layer.
 *
 * @param {{ stateRoot: string, configPath: string | null, knownPlugins?: Map<PluginName, PluginMetadata>, knownDatasets?: Set<string> }} args
 * @returns {Promise<{
 *   centralConfig: HypAwareV2Config | null,
 *   localConfig: HypAwareV2Config | null,
 *   centralConfigPath: string | null,
 *   localLoaded: LoadConfigResult | null,
 *   effective: HypAwareV2Config | null,
 *   drops: ConfigLayerDrop[],
 *   centralQueryIgnored: boolean,
 * }>}
 */
export async function resolveLayeredConfigFromDisk({ stateRoot, configPath, knownPlugins, knownDatasets }) {
  const localLoaded = configPath ? await loadConfigFile(configPath) : null
  const localConfig = localLoaded?.ok ? localLoaded.config : null
  const centralConfigPath = resolveCentralLayerPath({ stateRoot })
  const centralLoaded = centralConfigPath ? await loadConfigFile(centralConfigPath) : null
  const centralConfig = centralLoaded?.ok ? centralLoaded.config : null

  const merged = resolveLayeredConfig({
    central: centralConfig,
    local: localConfig,
    // No `configRegistry` here on purpose. This merge-time validation runs
    // during config *resolution* (before `activatePlugins`), which is when
    // each plugin registers its `config_sections` validator. At this point in
    // boot the runtime's `configRegistry` exists but is *empty*, so threading
    // it would dispatch `runPerPluginSectionValidators` against zero
    // registered sections: a no-op that gives false confidence. Per-plugin
    // section validation is enforced where the registry is actually populated
    // in the daemon's apply path (`buildConfigApplyDeps`), which also discovers
    // validators for plugins a document introduces but that aren't active yet.
    // Boot's merge stays limited to the cross-plugin/structural checks.
    validate: (cfg) => collectConfigErrors(cfg, {
      ...(knownPlugins ? { knownPlugins } : {}),
      ...(knownDatasets ? { knownDatasets } : {}),
    }),
  })

  return {
    centralConfig,
    localConfig,
    centralConfigPath,
    localLoaded,
    effective: (centralConfig || localConfig) ? merged.effective : null,
    drops: merged.drops,
    centralQueryIgnored: merged.centralQueryIgnored,
  }
}

/**
 * Like {@link resolveLayeredConfigFromDisk}, but discovers the plugin
 * catalog itself (for callers outside `bootKernel` that don't already
 * hold the discovered manifest set (the daemon's SIGHUP reload). The
 * catalog drives the validation pass, so it must reflect the same
 * bundled + installed plugin set the kernel runs.
 *
 * @param {{ stateRoot: string, configPath: string | null, workspaceDir?: string }} args
 */
export async function resolveLayeredConfigForDaemon({ stateRoot, configPath, workspaceDir }) {
  const discovered = await discoverBundledPlugins(workspaceDir !== undefined ? { workspaceDir } : {})
  const installed = await discoverInstalledPlugins({ stateDir: stateRoot })
  const catalog = buildPluginCatalog([...discovered.loaded, ...discovered.excluded], installed.loaded)
  return resolveLayeredConfigFromDisk({
    stateRoot,
    configPath,
    knownPlugins: catalog.pluginMetadata,
    knownDatasets: catalog.knownDatasets,
  })
}

/**
 * Resolve which config path the boot should probe. Precedence:
 *  1. Explicit `opts.configPath`
 *  2. `env.HYP_CONFIG`
 *  3. `<HYP_HOME>/hypaware-config.json`
 *
 * Exported so the daemon can resolve the same operative path for the
 * config apply engine before `bootKernel` runs.
 *
 * @param {{ explicit?: string, env: NodeJS.ProcessEnv, hypHome: string }} args
 * @returns {string}
 */
export function resolveConfigPath({ explicit, env, hypHome }) {
  if (explicit) return path.resolve(explicit)
  if (env.HYP_CONFIG) return path.resolve(env.HYP_CONFIG)
  return defaultConfigPath(hypHome)
}

/**
 * Detect installed plugins that shadow a bundled first-party plugin by
 * name. Pure (manifests only: no I/O, telemetry, or throw). Shared
 * between `bootKernel`'s hard reject guard and `selectBootPlugins` so the
 * shadow rule has a single definition.
 *
 * @param {{ discovered: { loaded: LoadedManifest[] }, installed: { loaded: LoadedManifest[] } }} args
 * @returns {PluginName[]}
 */
export function detectShadowedPlugins({ discovered, installed }) {
  const bundledNames = new Set(discovered.loaded.map((m) => m.manifest.name))
  /** @type {PluginName[]} */
  const shadowing = []
  for (const m of installed.loaded) {
    if (bundledNames.has(m.manifest.name)) {
      shadowing.push(/** @type {PluginName} */ (m.manifest.name))
    }
  }
  return shadowing
}

/**
 * Compute the boot-equivalent plugin selection from the cheap discovery
 * inputs boot already reads (bundled + installed plugin manifests) and
 * the effective config. Pure: no I/O, no activation, no telemetry, no
 * throw.
 *
 * This is the single source of truth for *which* plugins boot would
 * activate, *from which manifest pool*. Both `bootKernel` (which then
 * activates `selectedManifests`) and `collectPluginHelpCommands` (which
 * lists the commands those manifests declare) call it, so `hyp --help`
 * advertises exactly the command set dispatch would run. In particular it
 * encodes the two selection rules help must not skip:
 *
 *  - `shadowing`: installed plugins whose name collides with a bundled
 *    first-party plugin. Boot rejects on these; help advertises no plugin
 *    commands rather than phantoms that will never dispatch.
 *  - excluded-bundled-vs-installed: an installed plugin replaces a
 *    same-named excluded bundled skeleton in the pool, so its commands
 *    (not the skeleton's) are what dispatch sees.
 *
 * @param {{
 *   discovered: { loaded: LoadedManifest[], excluded: LoadedManifest[] },
 *   installed: { loaded: LoadedManifest[] },
 *   config: HypAwareV2Config | null,
 *   bootProfile?: BootProfile,
 * }} args
 * @returns {{
 *   shadowing: PluginName[],
 *   installedNames: Set<PluginName>,
 *   pool: LoadedManifest[],
 *   selected: Set<PluginName>,
 *   selectedManifests: LoadedManifest[],
 * }}
 */
export function selectBootPlugins({ discovered, installed, config, bootProfile = 'config' }) {
  const shadowing = detectShadowedPlugins({ discovered, installed })
  const installedNames = new Set(
    installed.loaded.map((m) => /** @type {PluginName} */ (m.manifest.name))
  )
  const excludedAvailable = discovered.excluded.filter(
    (m) => !installedNames.has(/** @type {PluginName} */ (m.manifest.name))
  )
  const pool = [...discovered.loaded, ...excludedAvailable, ...installed.loaded]
  const selected = computeSelectedPlugins({
    bootProfile,
    config,
    discovered: pool,
    installedNames,
  })
  const selectedManifests = pool.filter((m) =>
    selected.has(/** @type {PluginName} */ (m.manifest.name))
  )
  return { shadowing, installedNames, pool, selected, selectedManifests }
}

/**
 * Resolve the active plugin set from the boot profile.
 *
 * - `all-bundled`: only the V1 default surface. Excluded plugins
 *   (`@hypaware/central`, `@hypaware/gascity`) and installed third-party
 *   plugins are intentionally dropped so the walkthrough picker
 *   doesn't surface them. Instead, naming an installed plugin in the config is
 *   the only way to activate one.
 *
 * - `all-available`: the default bundled surface plus every installed
 *   plugin. Excluded bundled developer fixtures stay out of this profile
 *   unless they are installed externally, which lets `hyp init <preset>`
 *   see installed plugin presets without surfacing V1-excluded skeletons.
 *
 * - `{ activate: [...] }`: explicit plugin set, intersected with what
 *   the workspace can resolve. Excluded plugins MAY appear here when
 *   a developer-built profile names them; this is the documented
 *   "loadable for developers" escape hatch. Installed plugins may
 *   appear here too, as the daemon path uses this profile and shares
 *   the merged pool.
 *
 * - `config` (default): activate the plugins listed in the user's
 *   config (`enabled !== false`). Excluded and installed plugins are
 *   honoured when they appear in the config: typing the name is the
 *   explicit opt-in. The installed plugin is never preferred over a
 *   bundled one (shadow collisions are rejected before this point).
 *
 * Plugins in the config that aren't bundled (or aren't installed)
 * are skipped silently here. The cross-plugin validator surfaces
 * `plugin_unknown` diagnostics for those, separate from boot.
 *
 * @param {{
 *   bootProfile: BootProfile,
 *   config: HypAwareV2Config|null,
 *   discovered: LoadedManifest[],
 *   installedNames: Set<PluginName>,
 * }} args
 * @returns {Set<PluginName>}
 */
function computeSelectedPlugins({ bootProfile, config, discovered, installedNames }) {
  const available = new Set(discovered.map((m) => /** @type {PluginName} */ (m.manifest.name)))

  if (bootProfile === 'all-bundled') {
    return new Set(
      [...available].filter((name) =>
        V1_BUNDLED_PLUGIN_ALLOWLIST.has(name) &&
        !V1_EXCLUDED_FROM_DEFAULT.has(name) &&
        !installedNames.has(name)
      )
    )
  }

  if (bootProfile === 'all-available') {
    return new Set(
      [...available].filter((name) =>
        (
          V1_BUNDLED_PLUGIN_ALLOWLIST.has(name) &&
          !V1_EXCLUDED_FROM_DEFAULT.has(name) &&
          !installedNames.has(name)
        ) ||
        installedNames.has(name)
      )
    )
  }

  if (typeof bootProfile === 'object' && bootProfile !== null && Array.isArray(bootProfile.activate)) {
    /** @type {Set<PluginName>} */
    const out = new Set()
    for (const name of bootProfile.activate) {
      if (available.has(name)) out.add(name)
    }
    return out
  }

  // 'config' (default): activate what the config asked for.
  if (!config?.plugins) return new Set()
  /** @type {Set<PluginName>} */
  const out = new Set()
  for (const entry of config.plugins) {
    if (entry.enabled === false) continue
    const name = /** @type {PluginName} */ (entry.name)
    if (available.has(name)) out.add(name)
  }
  return out
}

/**
 * @param {BootProfile} profile
 * @returns {string}
 */
function describeBootProfile(profile) {
  if (profile === 'config') return 'config'
  if (profile === 'all-bundled') return 'all-bundled'
  if (profile === 'all-available') return 'all-available'
  if (typeof profile === 'object' && profile !== null) return `explicit:${profile.activate.length}`
  return String(profile)
}
