// @ts-check

/**
 * @import { SourceWithholdResolver } from '../../../src/core/cache/types.js'
 */

/**
 * Build the `readRowsSince` source-scoped withhold resolver (LLP 0181).
 * Pure and catalog-agnostic: the caller has already reduced "which picker
 * source ids are withheld" and "which column attributes a row to a picker
 * source, per dataset" down to plain data (`src/core/runtime/source_withhold.js`
 * does that reduction at boot, from the opt-out store + provenance
 * classification + the plugin catalog), so this factory (and the
 * `readRowsSince` extension it feeds) stay free of any dependency on the
 * wizard/provenance layer.
 *
 * `withheldSourceIds` accepts a plain iterable (a fixed set, the test-fake
 * form) or a provider function returning the current set: the boot-glue
 * passes a provider backed by a TTL-cached store read so an opt-out
 * written while the daemon runs takes effect without a restart
 * (LLP 0181 #opt-out). A provider's throw (the corrupt-store fail-safe)
 * propagates from `shouldWithhold`/`shouldWithholdDataset` to the caller.
 *
 * @ref LLP 0181#opt-out [implements]: the resolver `readRowsSince` consults, threaded the same way `usagePolicyResolver` is
 * @param {{
 *   withheldSourceIds: Iterable<string> | (() => ReadonlySet<string>),
 *   datasetAttributionColumns: Map<string, string>,
 *   datasetOwnedSourceIds?: Map<string, string[]>,
 * }} args
 * @returns {SourceWithholdResolver}
 */
export function createSourceWithholdResolver({
  withheldSourceIds,
  datasetAttributionColumns,
  datasetOwnedSourceIds,
}) {
  /** @type {() => ReadonlySet<string>} */
  let resolveWithheld
  if (typeof withheldSourceIds === 'function') {
    resolveWithheld = withheldSourceIds
  } else {
    const fixed = new Set(withheldSourceIds)
    resolveWithheld = () => fixed
  }
  return {
    attributionColumnFor(dataset) {
      return datasetAttributionColumns.get(dataset)
    },
    shouldWithhold(attributionValue) {
      return (
        typeof attributionValue === 'string' &&
        attributionValue !== '' &&
        resolveWithheld().has(attributionValue)
      )
    },
    // @ref LLP 0181#enforcement-scope [implements]: a dataset with no attribution column is withheld wholesale only when every source that could have produced it is withheld
    shouldWithholdDataset(dataset) {
      if (!datasetOwnedSourceIds) return false
      if (datasetAttributionColumns.has(dataset)) return false
      const owners = datasetOwnedSourceIds.get(dataset)
      if (!owners || owners.length === 0) return false
      const withheld = resolveWithheld()
      return owners.every((id) => withheld.has(id))
    },
  }
}
