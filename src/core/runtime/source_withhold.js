// @ts-check

import { classifyClientProvenance } from '../cli/wizard/provenance.js'
import { createSourceWithholdResolver } from '../cache/source-withhold.js'

/**
 * @import { HypAwareV2Config } from '../../../hypaware-plugin-kernel-types.js'
 * @import { PluginCatalog } from '../../../src/core/types.js'
 * @import { SourceWithholdResolver } from '../../../src/core/cache/types.js'
 */

/**
 * Build the boot-time `readRowsSince` source-scoped withhold resolver
 * (LLP 0132 #source-scoped-withholding) from the plugin catalog and the
 * two-layer config `bootKernel` already resolved. This is the boot-glue
 * `createKernelRuntime` itself can't do: it runs before the catalog and
 * layered config are known, and classifying provenance needs both.
 *
 * Returns `undefined` when there is nothing to withhold from: a machine
 * with no central layer (`classifyClientProvenance`'s own "the
 * managed-machine gate is applied by each consumer" contract: a solo
 * machine's sources classify `'local'` too, but there is no central layer
 * to withhold them from), or a central layer with no `'local'`-classified
 * picker source.
 *
 * @ref LLP 0132#source-scoped-withholding [implements]: the boot-time reduction of `classifyClientProvenance` + the catalog's `attribution_column` declarations into the resolver `readRowsSince` consults
 * @param {{
 *   catalog: Pick<PluginCatalog, 'plugins' | 'pickerDescriptors' | 'clientDescriptors'>,
 *   layered: { centralConfig?: HypAwareV2Config | null, effective?: HypAwareV2Config | null },
 * }} args
 * @returns {SourceWithholdResolver | undefined}
 */
export function buildSourceWithholdResolver({ catalog, layered }) {
  if (!layered.centralConfig) return undefined

  const withheldSourceIds = [...catalog.pickerDescriptors.keys()].filter(
    (id) => classifyClientProvenance(id, layered, catalog) === 'local'
  )
  if (withheldSourceIds.length === 0) return undefined

  return createSourceWithholdResolver({
    withheldSourceIds,
    datasetAttributionColumns: datasetAttributionColumnsFromCatalog(catalog),
  })
}

/**
 * Fold every plugin's `contributes.datasets[].attribution_column`
 * (LLP 0132, `PluginDatasetManifest.attribution_column`) into one
 * dataset-name-keyed map. First-writer-wins on a name collision, matching
 * `buildPluginCatalog`'s own first-manifest-wins convention. A dataset
 * with no declared `attribution_column` is simply absent from the map:
 * `readRowsSince` treats an absent entry as "never subject to
 * source-scoped withholding" (the conservative default).
 *
 * @param {Pick<PluginCatalog, 'plugins'>} catalog
 * @returns {Map<string, string>}
 */
export function datasetAttributionColumnsFromCatalog(catalog) {
  /** @type {Map<string, string>} */
  const out = new Map()
  for (const entry of catalog.plugins.values()) {
    const datasets = entry.contributes?.datasets
    if (!Array.isArray(datasets)) continue
    for (const ds of datasets) {
      if (
        ds &&
        typeof ds.name === 'string' &&
        typeof ds.attribution_column === 'string' &&
        ds.attribution_column !== '' &&
        !out.has(ds.name)
      ) {
        out.set(ds.name, ds.attribution_column)
      }
    }
  }
  return out
}
