import type {
  ActivePlugin,
  AgentRegistry,
  BackfillMaterializerRegistry,
  BackfillRegistry,
  CommandRegistry,
  ConfigControlFacade,
  ConfigRegistry,
  HypAwareV2Config,
  InitPresetRegistry,
  JsonObject,
  PluginActivationContext,
  PluginLockEntry,
  PluginManifest,
  PluginName,
  PluginPaths,
  QueryRegistry,
  SkillRegistry,
  VerbRegistry,
} from '../../../hypaware-plugin-kernel-types.d.ts'
import type { createCommandRegistry } from '../registry/commands.js'
import type { ConfigLayerDrop } from '../config/types.d.ts'
import type { ExtendedQueryStorageService } from '../cache/types.d.ts'
import type { ClientDescriptor, LoadedManifest, FailedManifest } from '../types.d.ts'
import type {
  CapabilityRegistryHandle,
  ExtendedSinkRegistry,
  ExtendedSourceRegistry,
} from '../registry/types.d.ts'

/**
 * Boot profiles that drive plugin selection.
 *
 * - `config` (default): activate only plugins listed in the loaded
 *   config file (intersected with the V1 allowlist). When no config is
 *   present, no plugins activate. Used by ordinary commands.
 *
 * - `all-bundled`: activate the entire V1 allowlist. Used by `hyp init`
 *   so the walkthrough picker sees every bundled source, sink, and
 *   client even before the user has written a config.
 *
 * - `{ activate: [...] }`: explicit plugin set, intersected with the
 *   allowlist. Reserved for the daemon and future installer paths
 *   that resolve plugin names from a different source.
 */
export type BootProfile = 'config' | 'all-bundled' | 'all-available' | { activate: PluginName[] }

export interface BootKernelOptions {
  /** Override HYP_HOME (defaults from env). */
  hypHome?: string
  /** Explicit config file path. If omitted, falls back to env.HYP_CONFIG, then `<HYP_HOME>/hypaware-config.json`. */
  configPath?: string
  /** Caller identity (lands on `kernel.boot` span). */
  mode?: 'cli' | 'daemon' | 'smoke' | 'walkthrough' | 'init'
  /** Per-boot identifier; lands on `kernel.boot` as `dev_run_id`. */
  runId?: string
  /** Active plugin selection strategy. */
  bootProfile?: BootProfile
  /** Override bundled plugins workspace. */
  workspaceDir?: string
  /** Cache root for the kernel storage service. */
  cacheRoot?: string
  /** Pre-built command registry to inject into the kernel. */
  commandRegistry?: ReturnType<typeof createCommandRegistry>
  /** Override env (tests). */
  env?: NodeJS.ProcessEnv
  /** Override OS temp root (tests). */
  tmpRoot?: string
  /** Apply-engine facade to expose on activation contexts (daemon only). */
  configControl?: ConfigControlFacade
}

export interface BootKernelResult {
  runtime: KernelRuntime
  /** Plugins that activated successfully. */
  activePlugins: ActivePlugin[]
  /** Full per-plugin activation results. */
  activations: ActivationResult[]
  /**
   * Effective config the kernel booted — the merge of the central and
   * local layers (LLP 0031). Null when neither layer exists.
   */
  config: HypAwareV2Config | null
  /** Path probed for the user-owned local layer (`hypaware-config.json`). */
  configPath: string | null
  /** Path the central layer was resolved from (active slot / seed), or null. */
  centralConfigPath: string | null
  /** Local entries dropped at merge (collisions with a locked central key). */
  configDrops: ConfigLayerDrop[]
  /** True when the central layer carried a `query` block (ignored — local-only). */
  centralQueryIgnored: boolean
  mode: string
  runId: string
  /** Bundled plugins available but not activated this boot. */
  skipped: PluginName[]
  /**
   * Static client→plugin map (`clientName -> { plugin, name, attachProbe? }`)
   * derived from the very manifests this boot discovered. The daemon threads
   * it onto the client-action reconcile context so the attach handler can
   * enumerate `desired()` and reach each descriptor's `attachProbe` for the
   * disk-driven undo (LLP 0045 §Part 1). Always present — empty when no plugin
   * contributes a client.
   */
  clientDescriptors: Map<string, ClientDescriptor>
}

export interface DiscoverBundledResult {
  /** Manifests inside the V1 allowlist. */
  loaded: LoadedManifest[]
  /** Manifests that failed to parse. */
  failed: FailedManifest[]
  /** Loadable but excluded from V1 default surface. */
  excluded: LoadedManifest[]
  /** Directories with manifests not in the allowlist or excluded set. */
  unknownDirs: string[]
}

export interface DiscoverInstalledResult {
  /** Manifests that parsed cleanly from each lock entry. */
  loaded: LoadedManifest[]
  /** Lock entries whose `install_dir` manifest failed to load. */
  failed: FailedManifest[]
  /** All lock entries that were considered (loaded + failed). */
  lockEntries: PluginLockEntry[]
}

// --- activation ---

/**
 * The kernel-side aggregate that activation contexts facade over.
 * Registries beyond `capabilities`, `commands`, `sources`, `sinks`,
 * `query`, and `storage` are still Phase-2 placeholders; later phases
 * promote each one in place without touching this surface.
 *
 * `activationContexts` is the per-plugin `PluginActivationContext`
 * map populated by `createActivationContext`. The daemon reads from
 * it to drive `sources.start(name, ctx)` and `sources.reload(name,
 * ctx)` for plugins that don't auto-start in their `activate()`.
 */
export interface KernelRuntime {
  capabilities: CapabilityRegistryHandle
  commands: CommandRegistry
  configRegistry: ConfigRegistry
  sources: ExtendedSourceRegistry
  sinks: ExtendedSinkRegistry
  query: QueryRegistry
  verbs: VerbRegistry
  storage: ExtendedQueryStorageService
  cacheRoot: string
  skills: SkillRegistry
  agents: AgentRegistry
  initPresets: InitPresetRegistry
  backfills: BackfillRegistry
  backfillMaterializers: BackfillMaterializerRegistry
  activationContexts: Map<PluginName, PluginActivationContext>
  /**
   * Plugin-facing facade of the daemon's config apply engine. Set only
   * when the host process runs one (daemon mode); CLI boots leave it
   * undefined so transport plugins skip their pull loops.
   */
  configControl?: ConfigControlFacade
}

export interface CreateKernelRuntimeArgs {
  capabilityRegistry?: CapabilityRegistryHandle
  commandRegistry?: CommandRegistry
  queryRegistry?: QueryRegistry
  verbRegistry?: VerbRegistry
  sourceRegistry?: ExtendedSourceRegistry
  sinkRegistry?: ExtendedSinkRegistry
  backfillRegistry?: BackfillRegistry
  backfillMaterializerRegistry?: BackfillMaterializerRegistry
  storage?: ExtendedQueryStorageService
  cacheRoot?: string
  configControl?: ConfigControlFacade
}

export interface CreateActivationContextArgs {
  runtime: KernelRuntime
  plugin: ActivePlugin
  paths: PluginPaths
  config?: JsonObject
  env?: NodeJS.ProcessEnv
}

// --- paths ---

export interface CreatePluginPathsArgs {
  pluginName: PluginName
  rootDir: string
  stateRoot: string
  runId: string
  tmpRoot?: string
}

// --- loader ---

export interface PluginActivationEntry {
  manifest: PluginManifest
  rootDir: string
  config?: JsonObject
}

export interface ActivationSuccess {
  ok: true
  plugin: ActivePlugin
}

export interface ActivationFailure {
  ok: false
  plugin: ActivePlugin
  errorKind: string
  message: string
}

export type ActivationResult = ActivationSuccess | ActivationFailure

export interface ActivatePluginsArgs {
  plugins: PluginActivationEntry[]
  stateRoot: string
  runId: string
  runtime?: KernelRuntime
  tmpRoot?: string
}

export interface ActivatePluginsResult {
  runtime: KernelRuntime
  results: ActivationResult[]
}
