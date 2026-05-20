import type {
  PluginManifest,
  PluginName,
  CapabilityName,
  SemverRange,
} from '../../collectivus-plugin-kernel-types'

/**
 * Phase 1 contract: resolve a topological activation order over the
 * supplied manifests, taking `requires.plugins` and
 * `requires.capabilities` into account. Errors on cycles and missing
 * providers. Concrete implementation in dep_graph.js (Phase 1).
 */
export interface DepGraphResolver {
  resolve(manifests: PluginManifest[]): DepGraphResolution
}

export interface DepGraphResolution {
  order: PluginName[]
  resolveOrderHash: string
  unsatisfied: UnsatisfiedRequirement[]
}

export interface UnsatisfiedRequirement {
  requester: PluginName
  kind: 'plugin' | 'capability'
  name: PluginName | CapabilityName
  range?: SemverRange
  errorKind: 'cycle' | 'cap_missing' | 'cap_version_clash' | 'manifest_invalid'
}
