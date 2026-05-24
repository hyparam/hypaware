import type {
  ActivePlugin,
  CommandRegistry,
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
  initPresets: InitPresetRegistry
  activationContexts: Map<PluginName, PluginActivationContext>
}

export interface CreateKernelRuntimeArgs {
  capabilityRegistry?: CapabilityRegistryHandle
  commandRegistry?: CommandRegistry
  queryRegistry?: QueryRegistry
  sourceRegistry?: ExtendedSourceRegistry
  sinkRegistry?: ExtendedSinkRegistry
  storage?: ExtendedQueryStorageService
  cacheRoot?: string
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
