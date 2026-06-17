// @ts-check

/**
 * @import { HypAwareV2Config } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ConfigLayerDrop, ConfigMergeResult } from './types.d.ts'
 */

/**
 * Merge the two config layers a joined gateway boots:
 *
 * - **central** — server-owned, authoritative/locked (the applied slot,
 *   or the join seed before the first pull).
 * - **local** — user-owned, additive-only (`hypaware-config.json`).
 *
 * The whole central document wins: it contributes every key it names and
 * **locks** it; the local layer may only contribute keys central omits.
 * A local entry that collides with a central-named key is **dropped**
 * (recorded in `drops`), never merged in — the central layer is
 * sacrosanct and always boots. With no central layer, `effective = local`
 * verbatim, so a host that never joined is completely unaffected.
 *
 * `query{}` is structurally **local-only** (machine-specific storage —
 * cache dir, maintenance, retention): the local layer always owns it, and
 * a `query` block appearing in the central document is ignored
 * (`centralQueryIgnored`), surfaced in `hyp status`, never merged.
 *
 * @param {HypAwareV2Config | null} central
 * @param {HypAwareV2Config | null} local
 * @returns {ConfigMergeResult}
 * @ref LLP 0031#merge-model [implements] — union keyed per section; central wins and locks; local contributes only the keys central omits
 */
export function mergeConfigLayers(central, local) {
  /** @type {ConfigLayerDrop[]} */
  const drops = []

  // No central layer: the local file *is* the effective config. Nothing
  // is authoritative, nothing can collide, query stays where it is.
  if (!central) {
    return { effective: local ?? { version: 2 }, drops, centralQueryIgnored: false }
  }

  /** @type {HypAwareV2Config} */
  const effective = { version: 2 }

  // plugins[] — keyed by plugin name.
  const centralPlugins = central.plugins ?? []
  const centralPluginNames = new Set(centralPlugins.map((p) => p.name))
  const plugins = [...centralPlugins]
  for (const entry of local?.plugins ?? []) {
    if (centralPluginNames.has(entry.name)) {
      drops.push({ section: 'plugins', key: entry.name, reason: 'collides_with_central' })
      continue
    }
    plugins.push(entry)
  }
  if (plugins.length > 0) effective.plugins = plugins

  // sinks{} — keyed by instance name.
  const centralSinks = central.sinks ?? {}
  /** @type {NonNullable<HypAwareV2Config['sinks']>} */
  const sinks = { ...centralSinks }
  for (const [name, sink] of Object.entries(local?.sinks ?? {})) {
    if (Object.prototype.hasOwnProperty.call(centralSinks, name)) {
      drops.push({ section: 'sinks', key: name, reason: 'collides_with_central' })
      continue
    }
    sinks[name] = sink
  }
  if (Object.keys(sinks).length > 0) effective.sinks = sinks

  // disambiguate{} — keyed by capability name; central wins per capability.
  const centralDisambiguate = central.disambiguate ?? {}
  /** @type {Record<string, string>} */
  const disambiguate = { ...centralDisambiguate }
  for (const [capability, plugin] of Object.entries(local?.disambiguate ?? {})) {
    if (Object.prototype.hasOwnProperty.call(centralDisambiguate, capability)) {
      drops.push({ section: 'disambiguate', key: capability, reason: 'collides_with_central' })
      continue
    }
    disambiguate[capability] = plugin
  }
  if (Object.keys(disambiguate).length > 0) effective.disambiguate = disambiguate

  // query{} — local-only. A central query block is ignored + flagged.
  const centralQueryIgnored = central.query !== undefined
  if (local?.query !== undefined) effective.query = local.query

  return { effective, drops, centralQueryIgnored }
}
