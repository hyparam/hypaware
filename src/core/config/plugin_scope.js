// @ts-check

/**
 * @import { ActivePlugin, HypAwareV2Config, PluginName } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * The effective config as one plugin may read it: every section the operator
 * wrote for a *different* plugin removed, and nothing else changed.
 *
 * The rule is the one `activate()` already gets. `bootKernel` hands a plugin
 * `config.plugins[i].config` for its own `i` and nothing else, so "this
 * plugin's config" already has a definition and this reuses it: the owner's
 * own `plugins[]` entry is handed over untouched, and every other entry keeps
 * its identity (`name`, `enabled`, `version`, `artifact_hash`, `source`) and
 * loses its `config`.
 *
 * One widening, along the edge LLP 0006 already sanctions: the owner also
 * keeps the `plugins[]` `config` of every active plugin that provides a
 * capability the owner's manifest `requires.capabilities` names. A requirer
 * already holds that provider's live capability API, the coupling is declared
 * in the manifest and gated at activation (dep_graph eliminates a plugin
 * whose required capability is missing), and a bundled requirer reads its
 * provider's settings today: `@hypaware/claude-desktop` resolves the
 * gateway's pinned `listen` to render a Desktop profile, and to refuse an
 * ephemeral one (LLP 0115). The widening never reaches a `sinks{}` instance
 * `config`: that is where issue #1978's inline credential sits, and no
 * declared dependency names a sink instance.
 *
 * A configured sink is the same question one level over. Its `config` is the
 * operator's settings for the plugins the instance names at its top level
 * (`writer` + `destination`, or `plugin`). The instance itself stays visible:
 * a command that reported an empty sink list would be reporting something
 * untrue. The plugin a table-format instance's `config.encoder` names is
 * deliberately not matched: the same object can carry the destination's
 * inline credential, and the encoder is named as a codec choice, receiving no
 * `SinkCreateContext.config` today either (LLP 0422 #scope).
 *
 * `version`, `query`, `disambiguate` and `auto_update` are carried by
 * reference. They are core's sections, not any plugin's, and core code reads
 * this object too: `runVerbCommand` resolves `--remote` out of `query` before
 * the plugin's `operation` is called.
 *
 * One shallow object, one array of `plugins[]` length and one record of
 * `sinks{}` size, built once per narrowed invocation. Total on a malformed
 * config, because a hand-edited file that reached the dispatch path must not
 * turn a command into a crash.
 *
 * @param {HypAwareV2Config} config the whole effective config
 * @param {PluginName} pluginName the plugin whose view to build
 * @param {ActivePlugin[]} [activePlugins] the booted plugins, manifests included; the capability-provider widening reads their declared `requires`/`provides` and nothing else
 * @returns {HypAwareV2Config}
 * @ref LLP 0422#scope [implements]: a plugin-owned command body and a plugin's verb operation read the config through the plugin's own slice rule
 */
export function pluginScopedConfig(config, pluginName, activePlugins) {
  if (!config || typeof config !== 'object') return config
  /** @type {HypAwareV2Config} */
  const scoped = { ...config }

  const providers = requiredProviderNames(pluginName, activePlugins)
  /** @param {Record<string, unknown>} entry */
  const isOwnSection = (entry) => entry.name === pluginName
    || (typeof entry.name === 'string' && providers.has(entry.name))
  // Every naming key a sink instance can carry, asked at once rather than
  // discriminating the blob (`writer` + `destination`) and request (`plugin`)
  // shapes first: a hand-edited instance can carry neither or both, and the
  // question is only whether the operator named this plugin as one of its
  // parts.
  /** @param {Record<string, unknown>} entry */
  const composesInstance = (entry) => (
    entry.plugin === pluginName || entry.writer === pluginName || entry.destination === pluginName
  )

  if (Array.isArray(config.plugins)) {
    scoped.plugins = config.plugins.map((entry) => withoutForeignConfig(entry, isOwnSection))
  }
  const sinks = config.sinks
  if (sinks && typeof sinks === 'object' && !Array.isArray(sinks)) {
    /** @type {Record<string, unknown>} */
    const narrowed = {}
    for (const [instance, entry] of Object.entries(sinks)) {
      narrowed[instance] = withoutForeignConfig(entry, composesInstance)
    }
    scoped.sinks = /** @type {HypAwareV2Config['sinks']} */ (/** @type {unknown} */ (narrowed))
  }
  return scoped
}

/**
 * `entry` with its `config` removed, unless `owns` says this plugin is one the
 * operator wrote that `config` for. Handed back by reference whenever there is
 * nothing to remove, so an untouched section keeps its identity and costs no
 * allocation.
 *
 * @template {object} T
 * @param {T} entry
 * @param {(fields: Record<string, unknown>) => boolean} owns
 * @returns {T}
 */
function withoutForeignConfig(entry, owns) {
  const fields = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (entry))
  if (!fields || typeof fields !== 'object') return entry
  if (!('config' in fields) || owns(fields)) return entry
  const { config: _foreign, ...identity } = fields
  return /** @type {T} */ (/** @type {unknown} */ (identity))
}

/**
 * The active plugins that provide a capability `pluginName`'s manifest
 * requires, by name. Manifest-declared edges only: a runtime
 * `requireCapability` call with no declaration behind it widens nothing,
 * because the declaration is what an operator can audit and what dep_graph
 * gated activation on. Name match suffices: a plugin whose declared
 * requirement was not satisfied never activated, and duplicate providers of
 * one capability are a dep_graph rejection, so at most one active provider
 * answers per name.
 *
 * @param {PluginName} pluginName
 * @param {ActivePlugin[]} [activePlugins]
 * @returns {Set<string>}
 * @ref LLP 0422#scope [implements]: the slice keeps a declared capability provider's section, the one sanctioned cross-plugin edge (LLP 0006 #resolution-rules)
 */
function requiredProviderNames(pluginName, activePlugins) {
  /** @type {Set<string>} */
  const providers = new Set()
  if (!Array.isArray(activePlugins)) return providers
  const owner = activePlugins.find((p) => p && p.name === pluginName)
  const required = owner?.manifest?.requires?.capabilities
  if (!required || typeof required !== 'object') return providers
  const capNames = Object.keys(required)
  if (capNames.length === 0) return providers
  for (const plugin of activePlugins) {
    if (!plugin || plugin.name === pluginName) continue
    const provides = plugin.manifest?.provides?.capabilities
    if (!provides || typeof provides !== 'object') continue
    if (capNames.some((cap) => Object.hasOwn(provides, cap))) providers.add(plugin.name)
  }
  return providers
}
