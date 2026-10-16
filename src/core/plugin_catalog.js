// @ts-check

/**
 * @import { CapabilityName, PluginManifest, PluginName } from '../../hypaware-plugin-kernel-types.js'
 * @import { ClientDescriptor, LoadedManifest, PickerDescriptor, PluginCatalog, PluginCatalogEntry } from '../../src/core/types.js'
 * @import { PluginMetadata } from '../../src/core/config/types.js'
 */

/**
 * Build a plugin catalog from loaded manifests. The catalog derives
 * capability metadata, known datasets, client descriptors, `hyp init`
 * picker descriptors, and contribution summaries from the manifest
 * files themselves rather than a hardcoded table.
 *
 * @ref LLP 0130#picker-block [implements]: pickerDescriptors is read
 * in the same pass as clientDescriptors, first-manifest-wins, keyed by
 * each row's own `name` (a manifest may contribute more than one row).
 *
 * Callers should pass both `bundled.loaded` and `bundled.excluded`
 * manifests so excluded plugins (like `@hypaware/gascity`) remain
 * visible for config validation and descriptor resolution even though
 * they are not activated by default.
 *
 * Duplicate plugin names are resolved by first-writer-wins: the first
 * manifest array is treated as authoritative (bundled plugins), so
 * installed manifests that collide with a bundled name are skipped.
 *
 * @param {LoadedManifest[]} bundledManifests
 * @param {LoadedManifest[]} [installedManifests]
 * @returns {PluginCatalog}
 */
export function buildPluginCatalog(bundledManifests, installedManifests = []) {
  /** @type {Map<PluginName, PluginCatalogEntry>} */
  const plugins = new Map()
  /** @type {Map<PluginName, PluginMetadata>} */
  const pluginMetadata = new Map()
  /** @type {Set<string>} */
  const knownDatasets = new Set()
  /** @type {Map<string, ClientDescriptor>} */
  const clientDescriptors = new Map()
  /** @type {Map<string, PickerDescriptor>} */
  const pickerDescriptors = new Map()
  /** @type {Map<PluginName, PluginName[]>} */
  const composeWith = new Map()

  for (const source of [bundledManifests, installedManifests]) {
    for (const entry of source) {
      const name = /** @type {PluginName} */ (entry.manifest.name)
      if (plugins.has(name)) continue

      const meta = metadataFromManifest(entry.manifest)
      plugins.set(name, {
        name,
        version: entry.manifest.version,
        metadata: meta,
        contributes: entry.manifest.contributes,
      })
      pluginMetadata.set(name, meta)

      // @ref LLP 0213#d1 [implements]: a rider names the plugins whose composition pulls it in
      const riders = entry.manifest.compose_with
      if (Array.isArray(riders) && riders.length > 0) composeWith.set(name, [...riders])

      const datasets = entry.manifest.contributes?.datasets
      if (Array.isArray(datasets)) {
        for (const ds of datasets) {
          if (ds && typeof ds.name === 'string') {
            knownDatasets.add(ds.name)
          }
        }
      }

      const client = entry.manifest.contributes?.client
      if (client && typeof client.name === 'string' && typeof client.skill_dir === 'string') {
        if (!clientDescriptors.has(client.name)) {
          /** @type {ClientDescriptor} */
          const descriptor = {
            plugin: name,
            name: client.name,
            skillDir: client.skill_dir,
          }
          if (typeof client.agent_dir === 'string') descriptor.agentDir = client.agent_dir
          if (client.attach_probe) descriptor.attachProbe = client.attach_probe
          // Only the explicit opt-out is carried: absent stays absent, so a
          // reader cannot mistake "not declared" for "declared true".
          // @ref LLP 0379#manifest-declares-no-provider [implements]: the opt-out flag rides the client block into the descriptor
          if (client.backfill_provider === false) descriptor.backfillProvider = false
          if (Array.isArray(client.required_upstreams)) {
            descriptor.requiredUpstreams = client.required_upstreams
          }
          if (Array.isArray(client.transcript_entrypoints)) {
            descriptor.transcriptEntrypoints = client.transcript_entrypoints.filter(
              (v) => typeof v === 'string' && v.length > 0
            )
          }
          // A probe with no readable `dir` is dropped here rather than
          // downstream: an accepted-but-empty probe would report "no
          // activity" for a client that is active, which reads as
          // capture health it never measured.
          const activity = client.activity_probe
          if (activity && typeof activity.dir === 'string' && activity.dir.length > 0) {
            descriptor.activityProbe = {
              dir: activity.dir,
              ...(typeof activity.file_suffix === 'string' && activity.file_suffix.length > 0
                ? { file_suffix: activity.file_suffix }
                : {}),
            }
          }
          // A launch spec that cannot carry the question is dropped here
          // rather than downstream: an accepted-but-mute spec starts the
          // client with no prompt, which reads as the feature working.
          // @ref LLP 0198#split [implements]: the manifest owns how to start a client; a spec missing `{prompt}` is not a launch spec
          const launch = client.launch
          if (
            launch && typeof launch.bin === 'string' && launch.bin.length > 0 &&
            Array.isArray(launch.args) &&
            launch.args.every((a) => typeof a === 'string') &&
            launch.args.some((a) => a.includes('{prompt}'))
          ) {
            descriptor.launch = {
              bin: launch.bin,
              args: [...launch.args],
              ...(typeof launch.label === 'string' && launch.label.length > 0 ? { label: launch.label } : {}),
            }
          }
          clientDescriptors.set(client.name, descriptor)
        }
      }

      const pickerRows = entry.manifest.contributes?.picker
      if (Array.isArray(pickerRows)) {
        for (const row of pickerRows) {
          if (!row || typeof row.name !== 'string' || typeof row.label !== 'string') continue
          if (pickerDescriptors.has(row.name)) continue
          /** @type {PickerDescriptor} */
          const descriptor = {
            plugin: name,
            id: row.name,
            label: row.label,
          }
          if (typeof row.summary === 'string') descriptor.summary = row.summary
          if (row.detect) descriptor.detect = row.detect
          if (typeof row.hidden === 'boolean') descriptor.hidden = row.hidden
          if (Array.isArray(row.platforms)) descriptor.platforms = row.platforms
          if (typeof row.needs_setup === 'boolean') descriptor.needsSetup = row.needs_setup
          if (typeof row.configure_command === 'string') descriptor.configureCommand = row.configure_command
          if (row.compose && typeof row.compose === 'object') descriptor.compose = row.compose
          pickerDescriptors.set(row.name, descriptor)
        }
      }
    }
  }

  return { plugins, pluginMetadata, knownDatasets, clientDescriptors, pickerDescriptors, composeWith }
}

/**
 * @param {PluginManifest} manifest
 * @returns {PluginMetadata}
 */
function metadataFromManifest(manifest) {
  /** @type {PluginMetadata} */
  const meta = {}
  const provides = manifest.provides?.capabilities
  if (provides && Object.keys(provides).length > 0) {
    meta.provides = /** @type {Partial<Record<CapabilityName, string>>} */ ({ ...provides })
  }
  const requires = manifest.requires?.capabilities
  if (requires && Object.keys(requires).length > 0) {
    meta.requires = /** @type {Partial<Record<CapabilityName, string>>} */ ({ ...requires })
  }
  return meta
}
