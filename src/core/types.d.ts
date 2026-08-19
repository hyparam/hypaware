import type {
  PickerDetectProbe,
  PluginActivityProbeManifest,
  PluginAttachProbeManifest,
  PluginContributionManifest,
  PluginClientLaunchManifest,
  PluginManifest,
  PluginName,
  PluginPickerCompose,
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
  /**
   * Transcript `entrypoint` values whose sessions belong to this client,
   * from `contributes.client.transcript_entrypoints`. Read by
   * `resolveEntrypointOwners` to gate and attribute backfilled sessions
   * that live in another client's transcript tree.
   */
  transcriptEntrypoints?: string[]
  /**
   * Set when this client's capture route is withdrawn, from
   * `contributes.client.retired`. Read by `hyp status`, which skips the
   * setup-completeness prompt for a retired client and reports its
   * `residuePath` instead (LLP 0296#status-surface).
   */
  retired?: ClientRetiredDescriptor
  /**
   * How to start this client on a question, from
   * `contributes.client.launch`. Read by the wizard's first ask and
   * `hyp ask`; absent for a client that cannot be started on a prompt
   * (LLP 0198#split).
   */
  launch?: PluginClientLaunchManifest
  /**
   * Where this client's own activity leaves a file trail, from
   * `contributes.client.activity_probe`. Read by the `hyp status`
   * capture-health probe (LLP 0257#status-and-health); absent for a
   * client whose activity leaves no scannable trail.
   */
  activityProbe?: PluginActivityProbeManifest
}

/**
 * One `hyp init` wizard picker row, resolved from a plugin's
 * `contributes.picker` manifest entry. `id` is the picker source id
 * (`PluginPickerContribution.name`) keying the row; `plugin` is the
 * owning plugin, used by provenance checks to resolve a picker source
 * id to its central-vs-local membership.
 */
export interface PickerDescriptor {
  plugin: PluginName
  id: string
  label: string
  summary?: string
  detect?: PickerDetectProbe
  /**
   * True when the row is kept out of the interactive picker menu but
   * remains a picker source everywhere else (`--source`, read-back,
   * opt-out identity, dataset ownership). See
   * `PluginPickerContribution.hidden`.
   */
  hidden?: boolean
  needsSetup?: boolean
  configureCommand?: string
  /**
   * Composition contribution folded by `composePickerConfig` to build
   * the local-layer config for this pick (`PluginPickerContribution.compose`).
   */
  compose?: PluginPickerCompose
}

/**
 * A withdrawn capture route, folded from
 * `contributes.client.retired`. The client keeps its identity so its
 * transcript entrypoints stay claimed (LLP 0296#attribution-stub); this
 * only tells the status surface not to ask the user to finish a setup
 * that no longer exists.
 */
export interface ClientRetiredDescriptor {
  reason: string
  residuePath?: string
  repairCommand?: string
}

export interface PluginCatalog {
  plugins: Map<PluginName, PluginCatalogEntry>
  pluginMetadata: Map<PluginName, PluginMetadata>
  knownDatasets: Set<string>
  clientDescriptors: Map<string, ClientDescriptor>
  pickerDescriptors: Map<string, PickerDescriptor>
  /**
   * Plugins that ride other plugins into a composed config, keyed by the
   * rider and valued by the names it waits for (`compose_with`). Read by
   * `composePickerConfig` after the picked rows are folded.
   *
   * Optional so a hand-built catalog (tests, narrow call sites that only
   * want descriptors) stays valid; absent means "no riders", which
   * composes exactly what the picks name.
   */
  composeWith?: Map<PluginName, PluginName[]>
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
