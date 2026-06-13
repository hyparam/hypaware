// @ts-check

/**
 * @import { HypvectorLoadResult } from './types.d.ts'
 */

/** @type {HypvectorLoadResult | null} */
let cached = null

/**
 * Lazily load the optional `hypvector` dependency (and the
 * `hyparquet-writer` file writer it pairs with for shard writes).
 * Activation never touches this, so the plugin activates cleanly on an
 * install without optional dependencies; refresh and search report the
 * missing dependency instead.
 *
 * @returns {Promise<HypvectorLoadResult>}
 * @ref LLP 0024#packaging [implements] — root optionalDependency, graceful degradation when absent
 */
export async function loadHypvector() {
  if (cached) return cached
  try {
    const [hv, hw] = await Promise.all([import('hypvector'), import('hyparquet-writer')])
    cached = {
      ok: true,
      searchVectors: hv.searchVectors,
      writeVectors: hv.writeVectors,
      fileWriter: hw.fileWriter,
    }
  } catch {
    cached = {
      ok: false,
      message:
        "optional dependency 'hypvector' is not installed — reinstall hypaware without --omit=optional to enable vector search",
    }
  }
  return cached
}
