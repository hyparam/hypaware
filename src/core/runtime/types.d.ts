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
   * Effective config the kernel booted: the merge of the central and
   * local layers (LLP 0031). Null when neither layer exists.
   */
  config: HypAwareV2Config | null
  /** Path probed for the user-owned local layer (`hypaware-config.json`). */
  configPath: string | null
  /** Path the central layer was resolved from (active slot / seed), or null. */
  centralConfigPath: string | null
  /** Local entries dropped at merge (collisions with a locked central key). */
  configDrops: ConfigLayerDrop[]
  /** True when the central layer carried a `query` block (ignored: local-only). */
  centralQueryIgnored: boolean
  mode: string
  runId: string
  /** Bundled plugins available but not activated this boot. */
  skipped: PluginName[]
  /**
   * Plugins whose manifest this boot discovered (bundled, excluded-bundled, or
   * installed) but whose boot profile did not select: the profile never gave
   * them a chance to activate. Wider than `skipped`, which only covers the V1
   * allowlist's bundled manifests and so omits the excluded opt-ins that
   * `all-bundled`/`all-available` drop even when the config names them.
   */
  withheldByProfile: PluginName[]
  /**
   * Static client→plugin map (`clientName -> { plugin, name, attachProbe? }`)
   * derived from the very manifests this boot discovered. The daemon threads
   * it onto the client-action reconcile context so the attach handler can
   * enumerate `desired()` and reach each descriptor's `attachProbe` for the
   * disk-driven undo (LLP 0045 §Part 1). Always present: empty when no plugin
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

// --- client assets (skills + subagents) ---

/**
 * The two shapes of plugin-contributed client asset. They differ in the
 * copy (a directory tree vs a single markdown file) and in the manifest
 * key naming the destination (`skill_dir` vs `agent_dir`); every other
 * step of materialization is common (LLP 0138).
 */
export type ClientAssetKind = 'skill' | 'agent'

/**
 * One skill or agent contribution flattened to the fields materialization
 * needs, so the copy loop is written once over both registries.
 */
export interface ResolvedClientAsset {
  kind: ClientAssetKind
  name: string
  /** Target client names; the literal `all` means every client in the run. */
  clients: string[]
  /** `sourceDir` for a skill, `sourceFile` for an agent. */
  source: string
}

/**
 * One copy an install would make: a contribution paired with the client it
 * lands in and where it lands. What the copy loop iterates, and what the
 * freshness digest is taken over.
 */
export interface PlannedClientAsset {
  asset: ResolvedClientAsset
  client: string
  /** Absolute destination path. */
  dest: string
}

/** One copy made (or, under `dryRun`, that would be made). */
export interface ClientAssetInstall {
  kind: ClientAssetKind
  name: string
  client: string
  /** Absolute destination path; the reversal record for org-driven installs. */
  dest: string
  dryRun: boolean
}

export interface MaterializeClientAssetsOptions {
  /**
   * Client names to install for; contributions targeting others are skipped.
   * `'all'` installs for every client the contributions name, so an unknown
   * one warns rather than being filtered out silently.
   */
  clients: string[] | 'all'
  /** Where each client's asset directories live, from its plugin manifest. */
  descriptors: Map<string, ClientDescriptor>
  /** Home directory the per-client relative asset dirs resolve against. */
  homeDir: string
  /**
   * Read structurally rather than as the kernel `SkillRegistry`/`AgentRegistry`
   * so the wizard finale (which threads a narrowed registry shape) and tests
   * (which pass fakes) can call this without constructing a full registry.
   */
  skills?: { list(): { name: string; clients: string[]; sourceDir: string }[] }
  agents?: { list(): { name: string; clients: string[]; sourceFile: string }[] }
  /**
   * State root (`<HYP_HOME>/hypaware`) holding the install ledger: the record
   * of which destinations HypAware itself wrote, which is what makes removing
   * a no-longer-contributed asset safe. Omitted, the install still copies but
   * records nothing and removes nothing, which is what every pre-LLP-0218
   * caller did. Resolve it with `clientAssetStateRoot(env, homeDir)` so it is
   * anchored on the same home the assets land in.
   */
  stateRoot?: string
  /** Report what would be copied without touching the filesystem. */
  dryRun?: boolean
  /** Progress lines, one per copy. Omitted on non-interactive callers. */
  stdout?: { write(chunk: string): unknown }
  /** Per-contribution warnings for the skips that are worth surfacing. */
  stderr?: { write(chunk: string): unknown }
}

/**
 * One line of the client-asset install ledger: a destination HypAware wrote,
 * and enough about it to answer, on a later upgrade, both "did we put this
 * here?" and "is what is there still what we put?".
 */
export interface ClientAssetLedgerRecord {
  kind: 'skill' | 'agent'
  /** Contribution name, for the line a removal prints. */
  name: string
  /** Client whose asset directories this destination belongs to. */
  client: string
  /** Absolute destination path. */
  dest: string
  /**
   * Content digest taken right after the copy. Absent on a record carried from
   * a failed write, which is why a missing digest never reads as a match.
   */
  digest?: string
}
