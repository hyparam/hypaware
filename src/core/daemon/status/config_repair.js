// @ts-check

/**
 * Repairs `hyp status` suggests for config errors and unsatisfied plugin
 * requirements.
 *
 * @import { HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ConfigValidationError } from '../../../../src/core/config/types.js'
 */

import { sanitizeLabel } from '../../util/json_util.js'
import { MAX_ACTIVATION_MESSAGE_CHARS } from '../boot_failure.js'

/**
 * The config edit that repairs a `plugin_requires_unsatisfied` diagnostic,
 * routed to the layer that can actually make it.
 *
 * `mergeConfigLayers` drops a local `plugins[]` entry whose name collides
 * with a central one, so each half of the edit belongs to whoever owns the
 * name that half touches: withdrawing the request touches the eliminated
 * plugin's entry, supplying the dependency touches the dependency's. A half
 * whose name the central layer owns gives way to a step that does change
 * something, and the local file is named as the place that would not.
 *
 * A central name carrying `enabled: false` is central-owned by that same rule,
 * so the local enable stays inert - but installing the dependency here repairs
 * nothing either when it is already installed and the central layer is what
 * withholds it, so that sub-case names the central enable as well.
 *
 * A central edit is named only where it changes something, and always as a
 * change to the published fleet configuration through whoever owns it, never
 * as an edit to the downloaded central file: the next pull replaces that copy,
 * so an edit there is as inert as a local one. An already-enabled dependency
 * has nothing to enable, so when the central layer owns both names the only
 * step left for it is installing the dependency here (issue #1836).
 *
 * `dependency` is `undefined` for every reason that names no missing plugin
 * (a version mismatch, a capability require), and those keep the original
 * wording: the reason still names what is missing and the local file is still
 * where the operator's own entry lives.
 *
 * @param {object} args
 * @param {string} args.plugin The plugin the resolver eliminated.
 * @param {string | undefined} args.dependency The missing plugin its reason named.
 * @param {Set<string>} args.centralPluginNames Names the central layer owns.
 * @param {Set<string>} args.centralDisabledPluginNames The subset of those the central layer withholds (`enabled: false`).
 * @param {string} args.configPath The local config file.
 * @returns {string}
 * @ref LLP 0139#repair-must-be-runnable [constrained-by]: a repair has to be a step that changes something, so an edit the next merge discards is not one
 */
export function requiresUnsatisfiedConfigRepair({ plugin, dependency, centralPluginNames, centralDisabledPluginNames, configPath }) {
  const pluginIsCentral = centralPluginNames.has(plugin)
  if (dependency === undefined || !centralPluginNames.has(dependency)) {
    return pluginIsCentral
      ? `enable what the reason names in ${configPath}`
        + ` - '${plugin}' is enabled by the central config, so removing it from the local file changes nothing`
      : `enable what the reason names, or remove '${plugin}', in ${configPath}`
  }
  // The dependency is central-owned, so a local entry adding it is dropped at
  // merge. What still changes something: installing it here (the central layer
  // already asks for it), plus the fleet enable when the central layer is what
  // withholds it.
  if (pluginIsCentral) {
    const step = centralDisabledPluginNames.has(dependency)
      ? `enable '${dependency}' in the published fleet configuration and install it on this host`
      : `install '${dependency}' on this host`
    return step
      + ` - the central config names both '${plugin}' and '${dependency}', so no edit to ${configPath} survives the merge`
  }
  return centralDisabledPluginNames.has(dependency)
    ? `remove '${plugin}' from ${configPath}, or enable '${dependency}' in the central config and install it on this host`
      + ` - '${dependency}' is named by the central config but disabled there, so enabling it in the local file changes nothing`
    : `remove '${plugin}' from ${configPath}, or install '${dependency}' on this host`
      + ` - '${dependency}' is named by the central config, so enabling it in the local file changes nothing`
}

/**
 * Per-entry repairs for the config errors that have one, keyed by the
 * validator's own pointer so no message is parsed and no index is re-derived.
 * Today that is `plugin_installed_unloadable`: the validator can say the
 * install is the fault but not where it lives, so the directory is filled in
 * here from the same discovery pass that classified the name.
 *
 * `hyp plugin doctor` first because it prints the rejection the operator is
 * missing, then `hyp plugin update`, which re-fetches from the source the
 * lock recorded. Neither touches the config: the config entry is the one
 * thing about this install that is right (issue #1936).
 *
 * @param {HypAwareV2Config | null} config the merged config the pointers index
 * @param {Map<string, string>} unloadable plugin name -> install directory
 * @returns {Map<string, string[]>} pointer -> repair
 * @ref LLP 0139#repair-must-be-runnable [constrained-by]: a repair is a command that runs, so the directory is filled in rather than left a placeholder
 */
export function pluginRepairsByPointer(config, unloadable) {
  /** @type {Map<string, string[]>} */
  const out = new Map()
  if (unloadable.size === 0 || !config?.plugins) return out
  for (let i = 0; i < config.plugins.length; i += 1) {
    const name = config.plugins[i].name
    const dir = sanitizeLabel(unloadable.get(name), MAX_ACTIVATION_MESSAGE_CHARS)
    if (dir === undefined) continue
    out.set(`/plugins/${i}/name`, [`hyp plugin doctor ${dir}`, `hyp plugin update ${name}`])
  }
  return out
}

/**
 * Map config-validate `error_kind` values to the repair commands
 * status surfaces alongside them. Returning an empty array is
 * acceptable. The renderer just shows the diagnostic without a
 * "try this" line.
 *
 * @param {ConfigValidationError['errorKind']} kind
 * @returns {string[]}
 */
export function repairForConfigError(kind) {
  switch (kind) {
    case 'sink_pair_incompatible':
    case 'sink_plugin_unknown':
    case 'sink_schedule_invalid':
    case 'request_sink_invalid_keys':
      return ['hyp setup --from-file <config.json>']
    case 'capability_ambiguous':
      return ['# Add a disambiguate.<capability> entry to your config']
    case 'duplicate_plugin':
    case 'plugin_unknown':
      return ['hyp setup --from-file <config.json>']
    default:
      return []
  }
}
