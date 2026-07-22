// @ts-check

/**
 * @import { SourceWithholdResolver } from '../../../src/core/cache/types.js'
 */

/**
 * Build the `readRowsSince` source-scoped withhold resolver
 * (LLP 0132 #source-scoped-withholding). Pure and catalog-agnostic: the
 * caller has already reduced "which picker source ids are withheld" and
 * "which column attributes a row to a picker source, per dataset" down to
 * plain data (`src/core/runtime/source_withhold.js` does that reduction at
 * boot, from `classifyClientProvenance` + the plugin catalog), so this
 * factory (and the `readRowsSince` extension it feeds) stay free of any
 * dependency on the wizard/provenance layer.
 *
 * @ref LLP 0132#source-scoped-withholding [implements]: the resolver `readRowsSince` consults, threaded the same way `usagePolicyResolver` is
 * @param {{
 *   withheldSourceIds: Iterable<string>,
 *   datasetAttributionColumns: Map<string, string>,
 * }} args
 * @returns {SourceWithholdResolver}
 */
export function createSourceWithholdResolver({ withheldSourceIds, datasetAttributionColumns }) {
  const withheld = new Set(withheldSourceIds)
  return {
    attributionColumnFor(dataset) {
      return datasetAttributionColumns.get(dataset)
    },
    shouldWithhold(attributionValue) {
      return typeof attributionValue === 'string' && attributionValue !== '' && withheld.has(attributionValue)
    },
  }
}
