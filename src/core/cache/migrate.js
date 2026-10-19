// @ts-check

import fsPromises from 'node:fs/promises'
import path from 'node:path'

import {
  appendRefusalReason,
  appendRowsToSourceTable,
  clearEscapeReport,
  discoverCachePartitions,
  isPartitionMutationBusy,
  resolveClientName,
  sanitizePathSegment,
  tryReadCursorSync,
  withPartitionMutationLock,
} from './partition.js'
import { cacheTablePath } from './paths.js'
import { readRowsFromTable } from './iceberg/store.js'
import { cacheCleanupId, readCacheCleanup } from './purge-cleanup.js'

/**
 * @import { ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitionMeta } from '../../../src/core/cache/types.js'
 */

/**
 * Scan for partitions not yet in the source-table layout and optionally
 * migrate their rows into `source=<x>/table/`.
 *
 * Legacy partitions include: direct Iceberg tables without cursors,
 * bare table names (`proxy_messages_v4`, `all`), and the old
 * `client=<x>/date=<y>` epoch layout.
 *
 * Migration is idempotent: rows are read from the legacy Iceberg table,
 * grouped by source (via `resolveClientName`), and written to the
 * source-table layout via `appendRowsToSourceTable`.  The legacy
 * directory is then moved to `.retired/` so subsequent runs are a no-op.
 *
 * `deferred` counts partitions a forced run left in place because a purge
 * cleanup is still outstanding for them, their cleanup state did not read,
 * or another writer held their mutation guard. The next run retries them.
 *
 * @param {{ cacheRoot: string, force: boolean }} opts
 * @returns {Promise<{ scanned: number, migrated: number, rowsMigrated: number, deferred: number }>}
 */
export async function migrateLegacyPartitions({ cacheRoot, force }) {
  const discovered = await discoverCachePartitions(cacheRoot)
  const legacy = discovered.filter(isLegacyPartition)

  let migrated = 0
  let rowsMigrated = 0
  let deferred = 0

  for (const partition of legacy) {
    if (!force) {
      rowsMigrated += (await readRowsFromTable(resolveIcebergDirForLegacy(partition))).length
      continue
    }
    // `null` is a deferral; a number is the rows moved.
    const moved = await withPartitionMutationLock(partition.path, async () => {
      // A purge's position deletes leave the erased bytes in the generations
      // its journal names until maintenance rewrites and reclaims them, and
      // that reclaimer walks only live partitions. Retiring the directory
      // first would carry those bytes into `.retired/` and let the journal
      // sweep drop the erasure as evicted. Checked under the guard every
      // admission holds, so no purge can admit between the check and the
      // move; an unreadable journal defers too.
      // @ref LLP 0417#cache-reclamation [constrained-by]: a pending purge cleanup keeps its partition reachable until its generations are gone
      const pending = await readCacheCleanup(cacheRoot, cacheCleanupId(cacheRoot, partition.path)).catch(() => true)
      if (pending) return null
      return migratePartition(cacheRoot, partition, await readRowsFromTable(resolveIcebergDirForLegacy(partition)))
    }).catch(error => {
      if (isPartitionMutationBusy(error)) return null
      throw error
    })
    if (moved === null) deferred++
    else if (moved > 0) {
      rowsMigrated += moved
      migrated++
    }
  }

  return { scanned: legacy.length, migrated, rowsMigrated, deferred }
}

/**
 * Move one legacy partition's rows into the source-table layout and retire
 * it. Caller holds the partition's mutation guard.
 *
 * @param {string} cacheRoot
 * @param {CachePartitionMeta} partition
 * @param {Record<string, unknown>[]} rows
 * @returns {Promise<number>} rows migrated; 0 when nothing moved
 */
async function migratePartition(cacheRoot, partition, rows) {
  if (rows.length === 0) return 0
  const columns = inferColumnsFromRows(rows)
  /** @type {Map<string, { segments: string[], rows: Record<string, unknown>[] }>} */
  const groups = new Map()
  for (const row of rows) {
    const source = sanitizePathSegment(resolveClientName(row))
    const segments = [`source=${source}`]
    const key = source
    let group = groups.get(key)
    if (!group) {
      group = { segments, rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
  }
  // The same all-or-nothing rule the spool flush follows, for the same
  // reason: this loop commits one destination partition at a time and
  // `retirePartition` below is the only thing that stops the legacy
  // directory being read again. An append that refuses partway through
  // would leave the earlier destinations committed and the legacy
  // directory in place, and the next `hyp query maintain --force` would
  // re-read the same rows and commit them a second time. Nothing dedupes
  // rows that already carry their native identity.
  //
  // Skipped rather than thrown: migration is per-partition and
  // idempotent, the rows stay readable where they already are, and the
  // next run retries. Throwing would abort the whole maintain tick and
  // stop compaction and retention cache-wide over one broken cursor.
  // @ref LLP 0347#rows-wait [implements]: a migration that cannot finish leaves its rows where they are instead of half-committing them
  const refused = [...groups.values()].some(({ segments }) =>
    appendRefusalReason(cacheTablePath(cacheRoot, partition.dataset, segments)) !== null
  )
  if (refused) return 0
  for (const { segments, rows: groupRows } of groups.values()) {
    await appendRowsToSourceTable(cacheRoot, partition.dataset, segments, columns, groupRows)
  }
  await retirePartition(partition.path)
  return rows.length
}

/**
 * A partition needs migration unless it is already in the source-table
 * layout (`source=<x>` partition key). Everything else - direct Iceberg
 * tables without cursors, bare table names (`proxy_messages_v4`, `all`),
 * and the old `client=<x>/date=<y>` epoch layout - is legacy.
 *
 * @param {CachePartitionMeta} partition
 * @returns {boolean}
 */
function isLegacyPartition(partition) {
  if ('source' in partition.partition) return false
  return true
}

/**
 * Legacy partitions store Iceberg data either directly (no cursor) or
 * under the generation their cursor names.  Resolve the right path.
 *
 * The cursor is re-read rather than trusting the `epoch` discovery saw: a
 * purge rewrite publishes a `table-*` generation through `tableDir`, so the
 * discovered `epoch=N` can be the purged generation awaiting reclamation.
 *
 * @param {CachePartitionMeta} partition
 * @returns {string}
 */
function resolveIcebergDirForLegacy(partition) {
  if (partition.legacy) return partition.path
  const cursor = tryReadCursorSync(partition.path)
  const live = cursor?.tableDir ?? (cursor?.layout === 'source-table' ? 'table' : `epoch=${cursor?.epoch ?? partition.epoch}`)
  return path.join(partition.path, live)
}

/**
 * Move a legacy partition directory to `.retired/<name>` so it is no
 * longer discovered.
 *
 * The scan above this read every legacy cursor, so a poisoned one has
 * already armed a standing cursor refusal keyed on this path; the rename leaves
 * that path with nothing behind it to ever clear the entry. It is the third
 * site where a whole partition directory stops existing, and it clears for
 * the same reason the two in `retention.js` do (LLP 0334#eviction-clears):
 * a partition later recreated at this path must warn as the transition it
 * is, not be throttled against a window armed for a directory that is gone.
 *
 * @ref LLP 0334#eviction-clears [implements]: no standing cursor refusal outlives the partition directory it is keyed on.
 * @param {string} partitionPath
 */
async function retirePartition(partitionPath) {
  const parent = path.dirname(partitionPath)
  const name = path.basename(partitionPath)
  const retiredDir = path.join(parent, '.retired')
  await fsPromises.mkdir(retiredDir, { recursive: true })
  const dest = path.join(retiredDir, name)
  await fsPromises.rename(partitionPath, dest)
  clearEscapeReport(partitionPath)
}

/**
 * Infer ColumnSpec from rows.  Legacy tables don't carry the original
 * schema metadata through the migration path, so we derive types from
 * the first row.  All columns are nullable.
 *
 * @param {Record<string, unknown>[]} rows
 * @returns {ColumnSpec[]}
 */
function inferColumnsFromRows(rows) {
  if (rows.length === 0) return []
  const sample = rows[0]
  return Object.keys(sample).map((name) => ({
    name,
    type: inferColumnType(sample[name]),
    nullable: true,
  }))
}

/**
 * @param {unknown} value
 * @returns {'STRING' | 'INT32' | 'INT64' | 'DOUBLE' | 'BOOLEAN' | 'TIMESTAMP' | 'JSON'}
 */
export function inferColumnType(value) {
  if (typeof value === 'boolean') return 'BOOLEAN'
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value > 2_147_483_647 || value < -2_147_483_648 ? 'INT64' : 'INT32'
    return 'DOUBLE'
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return 'TIMESTAMP'
    return 'STRING'
  }
  if (typeof value === 'object' && value !== null) return 'JSON'
  return 'STRING'
}
