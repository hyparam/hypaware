// @ts-check

/**
 * @import { HypAwareV2Config, PluginName } from '../../../hypaware-plugin-kernel-types.js'
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
 * A configured sink is the same question one level over. Its `config` is the
 * operator's settings for the plugins the instance names, which is where an
 * inline credential sits, and the kernel already hands it to exactly those
 * through `SinkCreateContext`. The instance itself stays visible: a command
 * that reported an empty sink list would be reporting something untrue.
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
 * @returns {HypAwareV2Config}
 * @ref LLP 0422#scope [implements]: a plugin-owned command body and a plugin's verb operation read the config through the plugin's own slice rule
 */
export function pluginScopedConfig(config, pluginName) {
  if (!config || typeof config !== 'object') return config
  /** @type {HypAwareV2Config} */
  const scoped = { ...config }

  /** @param {Record<string, unknown>} entry */
  const isOwnSection = (entry) => entry.name === pluginName
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
