// @ts-check

import { executeQuerySql } from '../../../../src/core/query/sql.js'

/**
 * @import { EnrichRuntime } from './types.d.ts'
 */

/**
 * Run read-only SQL over the registered datasets, tolerating "the dataset
 * isn't there yet" (returns []) the same way the graph projector's dedup
 * does — a not-yet-written enrichment table is benign, a real query failure
 * is not.
 *
 * @param {EnrichRuntime} runtime
 * @param {string} query
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function runSql(runtime, query) {
  try {
    // `config` is omitted: executeQuerySql defaults it to `{ version: 2 }`.
    // A daemon source has only the plugin's config slice, not the global
    // HypAwareV2Config, and the default is correct for reads over our
    // registered datasets.
    const res = await executeQuerySql({
      query,
      registry: runtime.query,
      storage: runtime.storage,
      refresh: 'always',
    })
    return res.rows
  } catch (err) {
    if (isMissingDatasetError(err)) return []
    throw err
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissingDatasetError(err) {
  if (!err || typeof err !== 'object') return false
  if (/** @type {Record<string, unknown>} */ (err).code === 'ENOENT') return true
  return err instanceof Error && err.message.includes('unknown dataset')
}

/**
 * Escape a value for embedding inside a single-quoted SQL literal.
 *
 * @param {string} v
 * @returns {string}
 */
export function sqlQuote(v) {
  return v.replace(/'/g, "''")
}
