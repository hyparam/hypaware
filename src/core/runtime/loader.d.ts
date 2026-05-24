import type {
  ActivePlugin,
  JsonObject,
  PluginManifest,
} from '../../../collectivus-plugin-kernel-types.d.ts'
import type { KernelRuntime } from './activation'

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

/**
 * Activate every plugin in order. The caller is responsible for the
 * surrounding `kernel.boot` root span; each `plugin.activate` lands
 * as a child of whatever context is active when this is invoked.
 */
export function activatePlugins(args: ActivatePluginsArgs): Promise<ActivatePluginsResult>
