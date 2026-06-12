import type {
  ActivePlugin,
  AgentRegistry,
  BackfillMaterializerRegistry,
  BackfillRegistry,
  CommandRegistry,
  ConfigControlFacade,
  ConfigRegistry,
  InitPresetRegistry,
  JsonObject,
  PluginActivationContext,
  PluginName,
  PluginPaths,
  QueryRegistry,
  SkillRegistry,
} from '../../../collectivus-plugin-kernel-types.d.ts'
import type { CapabilityRegistryHandle } from '../registry/capabilities'
import type { ExtendedSinkRegistry, ExtendedSourceRegistry } from '../registry/types.d.ts'
import type { ExtendedQueryStorageService } from '../cache/types.d.ts'

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

export function createKernelRuntime(opts?: CreateKernelRuntimeArgs): KernelRuntime
export function createActivationContext(args: CreateActivationContextArgs): PluginActivationContext
