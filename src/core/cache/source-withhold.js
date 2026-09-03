// @ts-check

/**
 * @import { SourceWithholdResolver } from '../../../src/core/cache/types.js'
 */

/**
 * The row column carrying a session's transcript `entrypoint`. Named here
 * rather than declared per dataset because it is the same field
 * `PluginClientManifest.transcript_entrypoints` is documented against and
 * the same one `src/core/backfill/entrypoint_owner.js` reads; a dataset
 * without the column simply yields `undefined` for it and the refinement
 * stays inert.
 */
const ROW_ENTRYPOINT_COLUMN = 'entrypoint'

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
 * `clientEntrypointOwners` carries the second attribution axis the rows
 * already have: transcript `entrypoint` value -> the picker source that
 * declares it (`contributes.client.transcript_entrypoints`, LLP 0140).
 * It exists because one shipped picker source, `claude-desktop`,
 * deliberately stamps another's `client_name` (LLP 0133 #attribution), so
 * its opt-out can never match on `client_name` alone (LLP 0346).
 *
 * @ref LLP 0188#opt-out [implements]: the resolver `readRowsSince` consults, threaded the same way `usagePolicyResolver` is
 * @param {{
 *   withheldSourceIds: Iterable<string> | (() => ReadonlySet<string>),
 *   datasetAttributionColumns: Map<string, string>,
 *   datasetOwnedSourceIds?: Map<string, string[]>,
 *   clientEntrypointOwners?: Map<string, string>,
 * }} args
 * @returns {SourceWithholdResolver}
 */
export function createSourceWithholdResolver({
  withheldSourceIds,
  datasetAttributionColumns,
  datasetOwnedSourceIds,
  clientEntrypointOwners,
}) {
  /** @type {() => ReadonlySet<string>} */
  let resolveWithheld
  if (typeof withheldSourceIds === 'function') {
    resolveWithheld = withheldSourceIds
  } else {
    const fixed = new Set(withheldSourceIds)
    resolveWithheld = () => fixed
  }
  // The set of picker sources that participate in entrypoint ownership at
  // all. It is the map's value side, not its key side, on purpose: the
  // `entrypoint` vocabulary is per-client, not global (hermes stamps its
  // channel source, and its interactive value is literally `cli`, which the
  // claude client also claims). Reinterpreting an entrypoint outside the
  // clients that declare ownership would withhold a hermes row because
  // `claude` is opted out - a different broken promise, not a fix.
  const entrypointNamespace = new Set(clientEntrypointOwners?.values() ?? [])
  return {
    attributionColumnFor(dataset) {
      return datasetAttributionColumns.get(dataset)
    },
    // @ref LLP 0346#entrypoint-refinement [implements]: the second column the seam forces in, offered only for datasets already subject to per-row withholding
    entrypointColumnFor(dataset) {
      if (entrypointNamespace.size === 0) return undefined
      if (!datasetAttributionColumns.has(dataset)) return undefined
      return ROW_ENTRYPOINT_COLUMN
    },
    shouldWithhold(attributionValue) {
      return (
        typeof attributionValue === 'string' &&
        attributionValue !== '' &&
        resolveWithheld().has(attributionValue)
      )
    },
    // Additive refinement, never a relaxation: a row this returns false for
    // is still subject to `shouldWithhold` on its own `client_name`, so
    // opting out `claude` keeps withholding every `client_name: "claude"`
    // row including Desktop's, exactly as before.
    // @ref LLP 0346#entrypoint-refinement [implements]: an aliased client's opt-out is enforced through the entrypoint its manifest claims, scoped to the clients that declare entrypoint ownership
    shouldWithholdEntrypoint(attributionValue, entrypointValue) {
      if (!clientEntrypointOwners || clientEntrypointOwners.size === 0) return false
      if (typeof entrypointValue !== 'string' || entrypointValue === '') return false
      // Scoping, not decoration: only a row already attributed to a client
      // that declares entrypoint ownership has its entrypoint read as an
      // ownership claim (see `entrypointNamespace` above).
      if (typeof attributionValue !== 'string' || !entrypointNamespace.has(attributionValue)) return false
      const owner = clientEntrypointOwners.get(entrypointValue)
      if (owner === undefined) return false
      return resolveWithheld().has(owner)
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
    // Only the withheld set is fingerprinted: the attribution and ownership
    // maps are reduced from the plugin catalog at boot and cannot change
    // within a process, while the withheld set is the TTL-re-read live input
    // an opt-out mutates. A provider throw (the corrupt-store fail-safe)
    // propagates, same as `shouldWithhold`.
    // @ref LLP 0367#policy-fingerprint [implements]: the client-opt-out half of the export-policy fingerprint
    fingerprint() {
      return [...resolveWithheld()].sort().join(',')
    },
  }
}
