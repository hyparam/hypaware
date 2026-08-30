// @ts-check

import fs from 'node:fs'
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

/**
 * Is `p` a symlink the filesystem confirms?
 *
 * `lstat`, so the link itself is measured rather than what it points at,
 * and only the component named: every component above it is a path the
 * cache did not choose and may legitimately reach through a link (a
 * `$HYP_HOME` on another volume, `/tmp` on macOS). `realpath` is the same
 * question with that cost attached, and it invites the spelling that
 * compares `realpath(p)` to `p`, which rejects a working cache for the
 * shape of the path it lives at.
 *
 * Rejection needs positive evidence. A stat that cannot answer - the
 * directory does not exist yet, it was removed under the read, the process
 * cannot traverse to it - says nothing about the name, and a caller that
 * read silence as an escape would stop reclaiming on an ordinary transient.
 *
 * Lives here rather than in any one caller because three of them now ask it
 * (the cursor gate, the maintenance sweeps, and the spool flush) and the
 * asymmetry above is the whole content of the check: a second copy that
 * drifted toward `realpath`, or toward reading a throw as an escape, would
 * be a defect nothing beside it makes visible.
 *
 * @ref LLP 0326#positive-evidence [implements]: only a symlink the filesystem confirms refuses anything.
 * @param {string} p
 * @returns {boolean}
 */
export function isConfirmedSymlink(p) {
  try {
    return fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true
  } catch {
    return false
  }
}
