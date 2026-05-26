// @ts-check

/**
 * @import { CapabilityName, PluginContributionManifest, PluginManifest, PluginName } from '../../collectivus-plugin-kernel-types.d.ts'
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
 * @typedef {object} PluginCatalog
 * @property {Map<PluginName, PluginCatalogEntry>} plugins
 * @property {Map<PluginName, PluginMetadata>} pluginMetadata
 * @property {Set<string>} knownDatasets
 */

/**
 * Build a plugin catalog from loaded manifests. The catalog derives
 * capability metadata, known datasets, and contribution summaries
 * from the manifest files themselves rather than a hardcoded table.
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
    }
  }

  return { plugins, pluginMetadata, knownDatasets }
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
