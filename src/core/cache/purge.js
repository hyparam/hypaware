// @ts-check

import path from 'node:path'

import { isEqualOrDescendant } from '../usage-policy/matcher.js'
import { discoverCachePartitions, readCursorSync, writeCursor } from './partition.js'
import { deleteMatchingRows, scanRowsFromTable, tableExists } from './iceberg/store.js'
import { resolveIcebergDir } from './storage.js'

/**
 * @import { UsagePolicyResolver } from '../../../src/core/usage-policy/types.js'
 * @import { PurgeSummary, PurgeTarget } from '../../../src/core/cache/types.js'
 */

/**
 * Delete already-cached rows from the local query cache, cache-only: purge
 * never contacts a sink or the remote and never deletes exported copies
 * (LLP 0104 boundary — server-side deletion is out of scope, LLP 0069
 * §non-goals). The deletion mechanism is Iceberg position-deletes
 * ({@link deleteMatchingRows}), which preserve surviving rows' `part_id`
 * identity and every sink's `_hyp_ingest_seq` watermark (see that function).
 *
 * Four target shapes (LLP 0104 decision):
 *
 *  - `{ kind: 'subtree', path }` — rows whose `cwd` equals or descends from
 *    `path` (the LLP 0049 §scope ancestor rule via {@link isEqualOrDescendant}),
 *    regardless of the path's usage class: an explicit purge may remove any
 *    data, `local-only` and synced included.
 *  - `{ kind: 'session', id }` — one session's rows. `session_id` is the
 *    partition key (LLP 0030); the predicate still scans every partition
 *    because the on-disk cache is partitioned by source, not session.
 *  - `{ kind: 'ignored', resolver }` — every row whose `cwd` currently
 *    resolves to `ignore` from either source (dotfile or machine-local entry,
 *    LLP 0103), the review skill's bulk step.
 *  - `{ kind: 'all' }` — every recorded row, wholesale.
 *
 * Returns aggregate counts plus the distinct set of purged `cwd`s, so the
 * caller can resolve each and emit the resurrection warning for any that
 * still resolves `full` (the next backfill would re-import it, LLP 0104
 * §resurrection).
 *
 * @ref LLP 0104 [implements]: the destructive verb's cache-only row removal, keyed off targets not marking events
 * @param {{ cacheRoot: string, target: PurgeTarget }} args
 * @returns {Promise<PurgeSummary>}
 */
export async function purgeCache({ cacheRoot, target }) {
  /** @type {Set<string>} */
  const purgedCwds = new Set()
  const { predicate, columns } = buildPredicate(target, purgedCwds)

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
 * @returns {{ predicate: (row: Record<string, unknown>) => boolean, columns: string[] }}
 */
function buildPredicate(target, purgedCwds) {
  /** @param {Record<string, unknown>} row */
  const noteCwd = (row) => {
    if (typeof row.cwd === 'string' && row.cwd !== '') purgedCwds.add(path.resolve(row.cwd))
  }

  switch (target.kind) {
    case 'subtree': {
      const base = path.resolve(target.path)
      return {
        columns: ['cwd'],
        predicate: (row) => {
          if (typeof row.cwd !== 'string' || row.cwd === '') return false
          if (!isEqualOrDescendant(path.resolve(row.cwd), base)) return false
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
