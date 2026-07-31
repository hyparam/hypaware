// @ts-check

import path from 'node:path'

import { scopeGovernance } from '../usage-policy/matcher.js'
import { discoverCachePartitions, readCursorSync, writeCursor } from './partition.js'
import { deleteMatchingRows, scanRowsFromTable, tableExists } from './iceberg/store.js'
import { resolveIcebergDir } from './storage.js'

/**
 * @import { PurgeSummary, PurgeTarget } from '../../../src/core/cache/types.js'
 */

/**
 * Delete already-cached rows from the local query cache, cache-only: purge
 * never contacts a sink or the remote and never deletes exported copies
 * (LLP 0104 boundary, server-side deletion is out of scope, LLP 0069
 * §non-goals). The deletion mechanism is Iceberg position-deletes
 * ({@link deleteMatchingRows}), which preserve surviving rows' `part_id`
 * identity and every sink's `_hyp_ingest_seq` watermark (see that function).
 *
 * Four target shapes (LLP 0104 decision):
 *
 *  - `{ kind: 'subtree', path }`, rows whose `cwd` equals or descends from
 *    `path` (the LLP 0049 §scope ancestor rule via {@link scopeGovernance}, so a
 *    row recorded under one spelling of a directory is still purged when the
 *    target names the other), regardless of the path's usage class: an explicit
 *    purge may remove any data, `local-only` and synced included.
 *  - `{ kind: 'session', id }`, one session's rows. `session_id` is the
 *    partition key (LLP 0030); the predicate still scans every partition
 *    because the on-disk cache is partitioned by source, not session.
 *  - `{ kind: 'ignored', resolver }`, every row whose `cwd` currently
 *    resolves to `ignore` from either source (dotfile or machine-local entry,
 *    LLP 0103), the review skill's bulk step.
 *  - `{ kind: 'all' }`, every recorded row, wholesale.
 *
 * Returns aggregate counts plus the distinct set of purged `cwd`s, so the
 * caller can resolve each and emit the resurrection warning for any that
 * still resolves `full` (the next backfill would re-import it, LLP 0104
 * §resurrection), and (for `subtree`) the rows deliberately *not* purged
 * because this filesystem did not confirm their lookalike spelling is the
 * directory named: either it really is a different directory, or it could not
 * be `stat`ed at all, and only the first of those is a verdict the filesystem
 * actually gave (LLP 0104 §spellings).
 *
 * @ref LLP 0104 [implements]: the destructive verb's cache-only row removal, keyed off targets not marking events
 * @param {{ cacheRoot: string, target: PurgeTarget, deps?: { realpathSync?: (p: string) => string, statSync?: (p: string) => { dev: number, ino: number } } }} args
 *   `deps` injects the filesystem seam the subtree spelling predicate consults.
 *   No production caller passes it; it exists because whether two spellings of
 *   one name are one directory is a property of the *volume*, and a test host
 *   has only the one it is running on.
 * @returns {Promise<PurgeSummary>}
 */
export async function purgeCache({ cacheRoot, target, deps }) {
  /** @type {Set<string>} */
  const purgedCwds = new Set()
  /** @type {{ rows: number, cwds: Set<string> }} */
  const retainedAliases = { rows: 0, cwds: new Set() }
  const { predicate, columns } = buildPredicate(target, purgedCwds, retainedAliases, deps)

  const partitions = await discoverCachePartitions(cacheRoot)
  let rowsDeleted = 0
  let partitionsAffected = 0

  for (const part of partitions) {
    const tableDir = resolveIcebergDir(part.path)
    if (!tableExists(tableDir)) continue
    const result = await deleteMatchingRows(tableDir, predicate, { columns })
    if (result.rowsDeleted === 0) continue
    rowsDeleted += result.rowsDeleted
    partitionsAffected++
    await refreshCursorRowCount(part.path, tableDir)
  }

  return {
    rowsDeleted,
    partitionsAffected,
    purgedCwds: [...purgedCwds],
    retainedAliasRows: retainedAliases.rows,
    retainedAliasCwds: [...retainedAliases.cwds],
  }
}

/**
 * Build the row predicate and the columns it reads for a purge target. The
 * predicate has a side effect: every `cwd` it accepts is recorded into
 * `purgedCwds`, so the caller can drive the resurrection warning off the
 * directories actually removed (not the target shape).
 *
 * @param {PurgeTarget} target
 * @param {Set<string>} purgedCwds
 * @param {{ rows: number, cwds: Set<string> }} retainedAliases sink for the
 *   `subtree` near-misses: rows whose `cwd` is spelled as if it were inside the
 *   target without this filesystem confirming the two spellings are one
 *   directory, whether because they are two directories with two inodes,
 *   because a spelling is no longer on disk, or because the `stat` could not be
 *   taken at all (any errno, not only `ENOENT`)
 * @param {{ realpathSync?: (p: string) => string, statSync?: (p: string) => { dev: number, ino: number } }} [deps]
 * @returns {{ predicate: (row: Record<string, unknown>) => boolean, columns: string[] }}
 */
function buildPredicate(target, purgedCwds, retainedAliases, deps) {
  /** @param {Record<string, unknown>} row */
  const noteCwd = (row) => {
    if (typeof row.cwd === 'string' && row.cwd !== '') purgedCwds.add(path.resolve(row.cwd))
  }

  switch (target.kind) {
    case 'subtree': {
      const base = path.resolve(target.path)
      // `proveAliases` is what makes this purge reach a row recorded under a
      // *respelling* of the target (NFD where the argument is NFC, or a case
      // variant) rather than only under a symlink spelling of it. It is opt-in
      // per call site because it is the deletion predicate that can afford it:
      // the widening is granted only for a pair of spellings the filesystem
      // reports as one `dev`/`ino`, never for a pair the fold merely folds
      // together, so it cannot delete rows for a directory the user did not
      // name. The unfolded default stays put at the CLI membership sites, whose
      // wrong direction is the harmless one.
      // @ref LLP 0104#spellings [implements]: purge asks the filesystem which spellings are one directory, and reports the ones it cannot prove
      const scopeDeps = { ...deps, component: 'cache-purge', proveAliases: true }
      // `scopeGovernance` canonicalizes both sides, which costs a `realpath`;
      // the predicate runs per row, and a cache holds many rows per distinct
      // `cwd`, so memoize the verdict per `cwd` for the lifetime of this one
      // purge run (short-lived by construction, so staleness is not a concern).
      // @ref LLP 0050#canonicalization [implements]: canonical-aware subtree purge, one `realpath` per distinct row `cwd`
      /** @type {Map<string, 'governs' | 'aliased' | 'outside'>} */
      const inScope = new Map()
      return {
        columns: ['cwd'],
        predicate: (row) => {
          if (typeof row.cwd !== 'string' || row.cwd === '') return false
          const cwd = path.resolve(row.cwd)
          let governed = inScope.get(cwd)
          if (governed === undefined) {
            governed = scopeGovernance(cwd, base, scopeDeps)
            inScope.set(cwd, governed)
          }
          if (governed === 'aliased') {
            // Deliberately retained, and counted so the caller can say so: a
            // silent non-deletion is indistinguishable from an empty cache.
            retainedAliases.rows++
            retainedAliases.cwds.add(cwd)
          }
          if (governed !== 'governs') return false
          noteCwd(row)
          return true
        },
      }
    }
    case 'session': {
      return {
        columns: ['session_id', 'cwd'],
        predicate: (row) => {
          if (row.session_id == null || String(row.session_id) !== target.id) return false
          noteCwd(row)
          return true
        },
      }
    }
    case 'ignored': {
      const resolver = target.resolver
      return {
        columns: ['cwd'],
        predicate: (row) => {
          if (typeof row.cwd !== 'string' || row.cwd === '') return false
          if (resolver.resolve(row.cwd).class !== 'ignore') return false
          noteCwd(row)
          return true
        },
      }
    }
    case 'all': {
      return {
        columns: ['cwd'],
        predicate: (row) => {
          noteCwd(row)
          return true
        },
      }
    }
    default: {
      // Exhaustiveness guard: an unhandled target kind must never silently
      // delete nothing (a false "purged 0 rows" success). Fail loud instead.
      throw new Error(`purgeCache: unknown target kind '${/** @type {{ kind: string }} */ (target).kind}'`)
    }
  }
}

/**
 * Recompute a partition's `cursor.rowCount` from the live (post-delete) row
 * count, preserving every other cursor field. A stale `rowCount` is only a
 * status/telemetry number, not a correctness input for reads, but keeping it
 * honest after a purge avoids a partition that reports more rows than it can
 * yield. Mirrors retention.js's post-delete recount.
 *
 * @param {string} partitionDir
 * @param {string} tableDir
 * @returns {Promise<void>}
 */
async function refreshCursorRowCount(partitionDir, tableDir) {
  const cursor = readCursorSync(partitionDir)
  let count = 0
  try {
    for await (const _row of scanRowsFromTable(tableDir)) count++
  } catch {
    return // leave the cursor as-is rather than write a guessed count
  }
  await writeCursor(partitionDir, { ...cursor, rowCount: count })
}
