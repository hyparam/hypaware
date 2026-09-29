// @ts-check

import path from 'node:path'
import { reconcileRowsInTable } from './iceberg/store.js'
import { appendRefusalReason, discoverCachePartitions, readCursorSync, resolveSourceSegments,
  sanitizePathSegment, withPartitionMutationLocks, writeCursor } from './partition.js'
import { cacheTablePath } from './paths.js'
import { resolveIcebergDir } from './storage.js'
import { Attr, getLogger, withSpan } from '../observability/index.js'

/**
 * @import { ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration } from '../../../src/core/cache/types.js'
 */

/**
 * @ref LLP 0449#reconciliation [implements]: one canonical source partition;
 * older poll/backfill partitions are retired for this scope only, after commit.
 * @param {{ cacheRoot: string, dataset: string, columns: ColumnSpec[], rows: Record<string, unknown>[],
 * scope: { where: Record<string, string>, key: string }, declaration?: CachePartitioningDeclaration,
 * filterRows: (rows: Record<string, unknown>[]) => Record<string, unknown>[], nextSeq: () => Promise<bigint> }} args
 */
export async function reconcileCacheRows(args) {
  const { cacheRoot, dataset, columns, scope, declaration } = args
  const entries = Object.entries(scope.where)
  if (!entries.length || !scope.where.client_name || !scope.where.session_id ||
      entries.some(([key, value]) => !columns.some(column => column.name === key) || !value) ||
      !columns.some(column => column.name === scope.key)) throw new Error('Invalid snapshot scope')
  if (args.rows.some(row => !entries.every(([key, value]) => row[key] === value) || !row[scope.key])) {
    throw new Error('Snapshot row outside its declared scope or missing identity')
  }
  const segments = declaration ? resolveSourceSegments(scope.where, declaration)
    : [`source=${sanitizePathSegment(scope.where.client_name)}`]
  const target = cacheTablePath(cacheRoot, dataset, segments)
  const parts = await discoverCachePartitions(cacheRoot, { datasets: [dataset] })
  const knownPaths = new Set(parts.map(part => part.path))
  const paths = [target, ...[...knownPaths].filter(part => part !== target)]
  // A reconciliation rewrites recorded history, so its record names the exact
  // scope it rewrote: "rows_deleted: 4" is only actionable with the session it
  // removed them from.
  return withSpan('cache.reconcile', { [Attr.COMPONENT]: 'cache', [Attr.DATASET]: dataset,
    [Attr.OPERATION]: 'cache.reconcile', ...scope.where, status: 'ok' }, async span => {
    return withPartitionMutationLocks(paths, async () => {
      for (const part of paths) {
        const refusal = appendRefusalReason(part)
        if (refusal) throw new Error(refusal)
      }
      const rows = args.filterRows(args.rows)
      let rowsWritten = 0
      let rowsDeleted = 0
      for (const part of paths) {
        const cursor = readCursorSync(part)
        const table = part === target && !knownPaths.has(part)
          ? path.join(part, 'table') : resolveIcebergDir(part)
        const result = await reconcileRowsInTable(table, columns, part === target ? rows : [], scope, args.nextSeq, part === target && declaration ? { declaration } : undefined)
        rowsWritten += result.rowsWritten
        rowsDeleted += result.rowsDeleted
        if (result.rowsWritten || result.rowsDeleted || result.rowCount !== cursor.rowCount ||
            (part === target && !knownPaths.has(part) && result.rowCount > 0)) {
          // A transaction can commit before its cursor write fails. Even an
          // idempotent retry repairs that cursor from the live manifest counts.
          await writeCursor(part, { ...cursor, rowCount: result.rowCount,
            ...(part === target && !knownPaths.has(part) ? { layout: 'source-table', tableDir: 'table' } : {}) })
        }
      }
      span.setAttribute('rows_written', rowsWritten)
      span.setAttribute('rows_deleted', rowsDeleted)
      getLogger('cache').info('cache.snapshot_reconciled', { component: 'cache', dataset,
        ...scope.where, rows_written: rowsWritten, rows_deleted: rowsDeleted, status: 'ok' })
      return rowsWritten
    })
  }, { component: 'cache' })
}
