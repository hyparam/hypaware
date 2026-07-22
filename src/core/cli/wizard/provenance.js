// @ts-check

/**
 * @import { HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { PluginCatalog } from '../../../../src/core/types.js'
 */

/**
 * Classify where a picker source (a picker source id or a client name)
 * lives in the two-layer config (LLP 0031): `'central'` when its owning
 * plugin is declared by the server-owned central layer, `'local'` when
 * the plugin is in the effective config but not the central layer (a
 * user-added local-layer source), and `'absent'` when the plugin is not
 * in the effective config at all.
 *
 * This generalizes the single-case central-vs-local read
 * `classifyInactiveState` does for a disabled plugin
 * (`src/core/cli/dispatch.js`) into a source-id-keyed three-way check any
 * picker-descriptor consumer can share: the pick phase's row locking, the
 * `hyp status` syncing/local-only split, and the export seam's
 * source-scoped withhold set (LLP 0132) all derive their behavior from
 * this one classification, so it is defined once and unit-tested directly.
 *
 * The source id is resolved to its owning plugin via the catalog's
 * descriptor maps: `pickerDescriptors` first (the wizard's own key space),
 * then `clientDescriptors` (a bare client name that never contributed a
 * picker row still classifies). A source id that resolves to no plugin is
 * `'absent'` - the conservative default, matching the export seam's
 * "withhold nothing we cannot attribute" rule.
 *
 * `'local'` here is a pure membership fact (in effective, not in central);
 * it does not itself mean "withheld". The managed-machine gate (there is a
 * central layer at all) is applied by each consumer, so a solo machine's
 * sources classify `'local'` and are still forwarded - there is no central
 * layer to withhold from.
 *
 * @ref LLP 0132#rule [implements]: the shared client/source provenance helper the split line and export-seam withholding both read
 * @param {string} clientName - a picker source id or a client name
 * @param {{ centralConfig?: HypAwareV2Config | null, effective?: HypAwareV2Config | null }} layered
 * @param {Pick<PluginCatalog, 'pickerDescriptors' | 'clientDescriptors'>} catalog
 * @returns {'central' | 'local' | 'absent'}
 */
export function classifyClientProvenance(clientName, layered, catalog) {
  const plugin = resolveOwningPlugin(clientName, catalog)
  if (!plugin) return 'absent'

  const inEffective = (layered.effective?.plugins ?? []).some((p) => p.name === plugin)
  if (!inEffective) return 'absent'

  const inCentral = (layered.centralConfig?.plugins ?? []).some((p) => p.name === plugin)
  return inCentral ? 'central' : 'local'
}

/**
 * Resolve a picker source id / client name to the plugin that owns it.
 * The picker descriptor map is authoritative (it is the wizard's key
 * space); a source with no picker row falls back to a client descriptor
 * of the same name. Returns `undefined` when neither map knows the id.
 *
 * @param {string} clientName
 * @param {Pick<PluginCatalog, 'pickerDescriptors' | 'clientDescriptors'>} catalog
 * @returns {string | undefined}
 */
function resolveOwningPlugin(clientName, catalog) {
  const picker = catalog.pickerDescriptors?.get(clientName)
  if (picker) return picker.plugin
  const client = catalog.clientDescriptors?.get(clientName)
  if (client) return client.plugin
  return undefined
}
