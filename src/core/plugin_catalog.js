// @ts-check

/**
 * @import { CapabilityName, PluginAttachProbeManifest, PluginContributionManifest, PluginManifest, PluginName } from '../../collectivus-plugin-kernel-types.d.ts'
 * @import { LoadedManifest } from './manifest.js'
 * @import { PluginMetadata } from './config/types.d.ts'
 */

/**
 * @typedef {object} PluginCatalogEntry
 * @property {PluginName} name
 * @property {string} version
 * @property {PluginMetadata} metadata
 * @property {PluginContributionManifest | undefined} contributes
 */

/**
 * @typedef {object} ClientDescriptor
 * @property {PluginName} plugin
 * @property {string} name
 * @property {string} skillDir
 * @property {PluginAttachProbeManifest} [attachProbe]
 * @property {string[]} [requiredUpstreams]
 */

/**
 * @typedef {object} PluginCatalog
 * @property {Map<PluginName, PluginCatalogEntry>} plugins
 * @property {Map<PluginName, PluginMetadata>} pluginMetadata
 * @property {Set<string>} knownDatasets
 * @property {Map<string, ClientDescriptor>} clientDescriptors
 */

/**
 * Build a plugin catalog from loaded manifests. The catalog derives
 * capability metadata, known datasets, client descriptors, and
 * contribution summaries from the manifest files themselves rather
 * than a hardcoded table.
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
          if (client.attach_probe) descriptor.attachProbe = client.attach_probe
          if (Array.isArray(client.required_upstreams)) {
            descriptor.requiredUpstreams = client.required_upstreams
          }
          clientDescriptors.set(client.name, descriptor)
        }
      }
    }
  }

  return { plugins, pluginMetadata, knownDatasets, clientDescriptors }
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
