// @ts-check

import { executeQuerySql } from '../../../../src/core/query/sql.js'

/**
 * @import { EnrichRuntime } from './types.d.ts'
 */

/**
 * Run read-only SQL over the registered datasets.
 *
 * Missing-dataset tolerance is **opt-in** via `allowMissing`, mirroring the
 * graph projector's pre-write dedup (LLP 0023#pre-write-dedup): a not-yet-written
 * plugin-owned enrichment table — or the published `node`/`edge` surface before
 * its first projection — is benign, so those callers pass `allowMissing: true`
 * and get `[]`. The configured *source* dataset is read **fail-fast** (the
 * default): a missing or misspelled `source_dataset` must surface as an
 * actionable error, never silently make `enrich propose` a no-op forever.
 *
 * @ref LLP 0028#operability — tolerate own tables, fail-fast on the source.
 *
 * @param {EnrichRuntime} runtime
 * @param {string} query
 * @param {{ allowMissing?: boolean }} [opts]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function runSql(runtime, query, opts = {}) {
  const allowMissing = opts.allowMissing ?? false
  try {
    // `execSql` is an injected test seam (like the completion providers'
    // `fetch`); production leaves it unset and runs the real query engine.
    if (runtime.execSql) {
      const res = await runtime.execSql({ query })
      return res.rows
    }
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
    if (allowMissing && isMissingDatasetError(err)) return []
    throw err
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isMissingDatasetError(err) {
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
