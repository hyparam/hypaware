// @ts-check

import { executeQuerySql } from '../../../../src/core/query/sql.js'

/**
 * @import { EnrichConfig, EnrichRuntime } from './types.js'
 */

/**
 * Run read-only SQL over the registered datasets.
 *
 * Missing-dataset tolerance is **opt-in** via `allowMissing`, mirroring the
 * graph projector's pre-write dedup (LLP 0023#pre-write-dedup): a not-yet-written
 * plugin-owned enrichment table (or the published `node`/`edge` surface before
 * its first projection) is benign, so those callers pass `allowMissing: true`
 * and get `[]`. The configured *source* dataset is read **fail-fast** (the
 * default): a missing or misspelled `source_dataset` must surface as an
 * actionable error, never silently make `enrich propose` a no-op forever.
 *
 * @ref LLP 0028#operability: tolerate own tables, fail-fast on the source.
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
    // Kernel-internal pipeline read (propose/curate over the local cache):
    // the enrichment writes back into local plugin-owned tables, never into
    // a transcript, so the LLP 0105 visibility filter is bypassed like the
    // graph projection's cache-to-cache scans.
    const res = await executeQuerySql({
      query,
      registry: runtime.query,
      storage: runtime.storage,
      refresh: 'always',
      includeLocalOnly: true,
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

/**
 * Source-scan content filters shared by the T1 session scans
 * ({@link buildSessionAggregateQuery} /
 * {@link buildSessionPartsQuery}) and the T2 source deref
 * (`curate.js`'s `safeDeref`), so both skip the same
 * low-signal rows. Returns SQL predicate fragments to AND into a WHERE clause;
 * an empty array means no content filter.
 *
 * Applying the filter in *both* places matters: T1 extracts a whole session and
 * only proposes from rows it scanned, but T2 re-derefs the source by `id_column`
 * (message id), so a message whose kept text part shares its id with an
 * excluded part (e.g. a `tool_result`) would otherwise re-admit that part into
 * the expensive curator call. Filtering the deref keeps T2 consistent with T1.
 *
 * `require_text` drops rows whose text column is null/empty: they contribute
 * nothing to the model yet consume the per-tick row budget, and they include
 * the signature-only thinking/reasoning parts a proxy does not persist.
 * `exclude_part_types` drops whole part kinds: default `tool_result`, i.e. raw
 * tool/file/command output, the bulk of the corpus but not durable knowledge.
 *
 * The column names are validated SQL identifiers and the part-type values are
 * `sqlQuote`'d literals, so this introduces no injection surface.
 *
 * @ref LLP 0028#row-selection: enrichment scans signal, not plumbing.
 *
 * @param {EnrichConfig} cfg
 * @returns {string[]}
 */
export function contentFilterClauses(cfg) {
  /** @type {string[]} */
  const clauses = []
  if (cfg.require_text) {
    clauses.push(`(${cfg.text_column} IS NOT NULL AND ${cfg.text_column} <> '')`)
  }
  if (cfg.exclude_part_types.length > 0) {
    const list = cfg.exclude_part_types.map((t) => `'${sqlQuote(t)}'`).join(', ')
    clauses.push(`${cfg.part_type_column} NOT IN (${list})`)
  }
  return clauses
}
