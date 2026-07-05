import type {
  PluginAttachProbeManifest,
  PluginContributionManifest,
  PluginManifest,
  PluginName,
} from '../../hypaware-plugin-kernel-types.d.ts'
import type { CapabilityRegistryHandle } from './registry/types.d.ts'
import type { PluginMetadata } from './config/types.d.ts'

// --- plugin_catalog ---

export interface PluginCatalogEntry {
  name: PluginName
  version: string
  metadata: PluginMetadata
  contributes: PluginContributionManifest | undefined
}

export interface ClientDescriptor {
  plugin: PluginName
  name: string
  skillDir: string
  agentDir?: string
  attachProbe?: PluginAttachProbeManifest
  requiredUpstreams?: string[]
}

export interface PluginCatalog {
  plugins: Map<PluginName, PluginCatalogEntry>
  pluginMetadata: Map<PluginName, PluginMetadata>
  knownDatasets: Set<string>
  clientDescriptors: Map<string, ClientDescriptor>
}

// --- dep_graph ---

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

// --- manifest ---

export type ManifestErrorKind = 'manifest_invalid'

export interface LoadedManifest {
  ok: true
  manifest: PluginManifest
  manifestPath: string
  rootDir: string
}

export interface FailedManifest {
  ok: false
  errorKind: ManifestErrorKind
  message: string
  manifestPath: string
  rootDir: string
}

export type ManifestLoadResult = LoadedManifest | FailedManifest
