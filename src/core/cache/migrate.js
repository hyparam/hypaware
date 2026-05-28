// @ts-check

import fsPromises from 'node:fs/promises'
import path from 'node:path'

import {
  appendRowsToSourceTable,
  discoverCachePartitions,
  resolveClientName,
  sanitizePathSegment,
} from './partition.js'
import { readRowsFromTable } from './iceberg/store.js'
import { datasetsRoot } from './paths.js'

/**
 * @import { ColumnSpec } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { CachePartitionMeta } from './types.d.ts'
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
 * @param {{ cacheRoot: string, force: boolean }} opts
 * @returns {Promise<{ scanned: number, migrated: number, rowsMigrated: number }>}
 */
export async function migrateLegacyPartitions({ cacheRoot, force }) {
  const discovered = await discoverCachePartitions(cacheRoot)
  const legacy = discovered.filter(isLegacyPartition)

  let migrated = 0
  let rowsMigrated = 0

  for (const partition of legacy) {
    const icebergDir = resolveIcebergDirForLegacy(partition)
    const rows = await readRowsFromTable(icebergDir)
    if (!force) {
      rowsMigrated += rows.length
      continue
    }
    if (rows.length > 0) {
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
      for (const { segments, rows: groupRows } of groups.values()) {
        await appendRowsToSourceTable(cacheRoot, partition.dataset, segments, columns, groupRows)
      }
      rowsMigrated += rows.length
      await retirePartition(partition.path)
      migrated++
    }
  }

  return { scanned: legacy.length, migrated, rowsMigrated }
}

/**
 * A partition needs migration unless it is already in the source-table
 * layout (`source=<x>` partition key).  Everything else — direct Iceberg
 * tables without cursors, bare table names (`proxy_messages_v4`, `all`),
 * and the old `client=<x>/date=<y>` epoch layout — is legacy.
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
 * under `epoch=<N>/` (with cursor).  Resolve the right path.
 *
 * @param {CachePartitionMeta} partition
 * @returns {string}
 */
function resolveIcebergDirForLegacy(partition) {
  if (partition.legacy) return partition.path
  return path.join(partition.path, `epoch=${partition.epoch}`)
}

/**
 * Move a legacy partition directory to `.retired/<name>` so it is no
 * longer discovered.
 *
 * @param {string} partitionPath
 */
async function retirePartition(partitionPath) {
  const parent = path.dirname(partitionPath)
  const name = path.basename(partitionPath)
  const retiredDir = path.join(parent, '.retired')
  await fsPromises.mkdir(retiredDir, { recursive: true })
  const dest = path.join(retiredDir, name)
  await fsPromises.rename(partitionPath, dest)
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
