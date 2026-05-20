import type {
  ActivePlugin,
  CommandRegistry,
  ConfigRegistry,
  InitPresetRegistry,
  JsonObject,
  PluginActivationContext,
  PluginPaths,
  QueryRegistry,
  SinkRegistry,
  SkillRegistry,
  SourceRegistry,
} from '../../../collectivus-plugin-kernel-types'
import type { CapabilityRegistryHandle } from '../registry/capabilities'

export interface KernelRuntime {
  capabilities: CapabilityRegistryHandle
  commands: CommandRegistry
  configRegistry: ConfigRegistry
  sources: SourceRegistry
  sinks: SinkRegistry
  query: QueryRegistry
  skills: SkillRegistry
  initPresets: InitPresetRegistry
}

export interface CreateKernelRuntimeArgs {
  capabilityRegistry?: CapabilityRegistryHandle
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
