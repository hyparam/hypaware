// @ts-check

/**
 * @import { SourceWithholdResolver } from '../../../src/core/cache/types.js'
 */

/**
 * Build the `readRowsSince` source-scoped withhold resolver (LLP 0188).
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
 * (LLP 0188 #opt-out). A provider's throw (the corrupt-store fail-safe)
 * propagates from `shouldWithhold`/`shouldWithholdDataset` to the caller.
 *
 * @ref LLP 0188#opt-out [implements]: the resolver `readRowsSince` consults, threaded the same way `usagePolicyResolver` is
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
    // @ref LLP 0188#enforcement-scope [implements]: a dataset with no attribution column is withheld wholesale only when every picker source whose plugin declares it is withheld
    shouldWithholdDataset(dataset) {
      if (!datasetOwnedSourceIds) return false
      if (datasetAttributionColumns.has(dataset)) return false
      const owners = datasetOwnedSourceIds.get(dataset)
      if (!owners || owners.length === 0) return false
      const withheld = resolveWithheld()
      return owners.every((id) => withheld.has(id))
    },
    // `some`, not `every`: an unlabeled row cannot be proven to belong to a
    // synced source, so one standing opt-out among the dataset's declared
    // owners is enough to withhold it. `owners` is the same manifest-declared
    // set `shouldWithholdDataset` reads, never "everything that writes rows
    // here": a plugin whose projector fills the dataset but whose manifest
    // declares no `datasets` is absent from it, so a client-only opt-out
    // leaves this rule inert. Deliberately over-withholds within that set;
    // the capture-side attribution fix that retires it is LLP 0192 #deferred.
    // @ref LLP 0192#fail-closed [implements]: an unattributed row in an attributed dataset is withheld once any picker source whose plugin declares that dataset is opted out
    shouldWithholdUnattributed(dataset) {
      if (!datasetOwnedSourceIds) return false
      if (!datasetAttributionColumns.has(dataset)) return false
      const owners = datasetOwnedSourceIds.get(dataset)
      if (!owners || owners.length === 0) return false
      const withheld = resolveWithheld()
      return owners.some((id) => withheld.has(id))
    },
  }
}
