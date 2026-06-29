// @ts-check

import path from 'node:path'

const DATASETS_SEGMENT = 'datasets'

/**
 * Standard kernel-managed cache root layout:
 *
 *   <cacheRoot>/datasets/<dataset>/<partition...>/
 *
 * Plugins that materialize rows ask `ctx.storage` for `tablePath`s
 * and never assemble paths themselves; but the storage and retention
 * layers need a stable on-disk convention so they can attribute spans
 * back to the originating dataset.
 *
 * @param {string} cacheRoot
 */
export function datasetsRoot(cacheRoot) {
  return path.join(cacheRoot, DATASETS_SEGMENT)
}

/**
 * Build the absolute `tablePath` for a dataset partition. The
 * directory is **not** created here: `appendRows` and Iceberg's
 * writer handle creation on first commit.
 *
 * @param {string} cacheRoot
 * @param {string} dataset
 * @param {string[]} [partitionSegments]
 */
export function cacheTablePath(cacheRoot, dataset, partitionSegments = ['all']) {
  if (!dataset) throw new Error('cacheTablePath: dataset is required')
  return path.join(datasetsRoot(cacheRoot), dataset, ...partitionSegments)
}

/**
 * Extract the dataset name from a `tablePath` rooted under the cache.
 * Used by the storage layer to populate `hyp_dataset` on observability
 * spans without forcing plugins to pass the dataset name again.
 *
 * Returns `undefined` for paths that do not look like a kernel cache
 * path; the caller should fall back to `'unknown'` so spans stay
 * queryable.
 *
 * @param {string} cacheRoot
 * @param {string} tablePath
 * @returns {string | undefined}
 */
export function datasetForTablePath(cacheRoot, tablePath) {
  const rel = path.relative(datasetsRoot(cacheRoot), tablePath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  const [dataset] = rel.split(path.sep)
  return dataset || undefined
}
