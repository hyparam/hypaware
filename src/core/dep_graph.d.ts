import type {
  PluginManifest,
  PluginName,
} from '../../collectivus-plugin-kernel-types'
import type { CapabilityRegistryHandle } from './registry/capabilities'

export type DepGraphErrorKind =
  | 'cycle'
  | 'plugin_missing'
  | 'cap_missing'
  | 'cap_version_clash'

export interface UnsatisfiedRequirement {
  plugin: PluginName
  errorKind: DepGraphErrorKind
  detail?: string
}

export interface DepGraphResolution {
  /** Topo-sorted activation order; eliminated plugins are not included. */
  order: PluginName[]
  unsatisfied: UnsatisfiedRequirement[]
  /** Short stable hash of `order.join('\n')` for boot-to-boot drift checks. */
  resolveOrderHash: string
  pluginCount: number
  capabilityCount: number
  registry: CapabilityRegistryHandle
}

export interface ResolveDependenciesOptions {
  registry?: CapabilityRegistryHandle
}

/**
 * Resolve a topological activation order over manifests' `requires.plugins`
 * and `requires.capabilities`. Emits `dep_graph.resolve` (span) and
 * `dep_graph.reject` (log) per rejection. Capability requires drain
 * through the registry, which is what emits `cap.require_satisfied`
 * and `cap.require_missing`.
 */
export function resolveDependencies(
  manifests: PluginManifest[],
  opts?: ResolveDependenciesOptions,
): Promise<DepGraphResolution>
