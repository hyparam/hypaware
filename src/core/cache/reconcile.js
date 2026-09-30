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
      /** @type {Set<string>} */
      const skipped = new Set()
      // Only a refusal ever asks which partitions are out of scope, and a
      // healthy cache never refuses, so the scan stays off the common path.
      /** @type {Set<string> | null} */
      let unreachable = null
      for (const part of paths) {
        const refusal = appendRefusalReason(part)
        if (!refusal) continue
        // A partition that could hold this scope's rows and cannot be read
        // still fails closed: its stale copies would survive the canonical
        // write and answer queries beside it. One that provably holds none of
        // them has no retirement to refuse, so this scope walks past it.
        unreachable ??= partitionsOutsideScope(parts, segments, scope.where, declaration)
        if (!unreachable.has(part)) throw new Error(refusal)
        skipped.add(part)
        getLogger('cache').warn('cache.retirement_skipped', { component: 'cache', dataset,
          ...scope.where, [Attr.OPERATION]: 'cache.reconcile', [Attr.STATUS]: 'degraded',
          [Attr.ERROR_KIND]: 'cursor_unreadable', partition_dir: part })
      }
      const rows = args.filterRows(args.rows)
      let rowsWritten = 0
      let rowsDeleted = 0
      for (const part of paths) {
        if (skipped.has(part)) continue
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
      span.setAttribute('retirement_skipped', skipped.size)
      getLogger('cache').info('cache.snapshot_reconciled', { component: 'cache', dataset,
        ...scope.where, rows_written: rowsWritten, rows_deleted: rowsDeleted,
        retirement_skipped: skipped.size, status: 'ok' })
      return rowsWritten
    })
  }, { component: 'cache' })
}

/**
 * The partitions among `parts` that provably hold none of the scope's rows.
 *
 * A partition's `<key>=<value>` segments are read back as a fact, not as a
 * naming convention: the two writers that ever label one both label it per
 * row from the row's own values, the spool flush through
 * `resolveSourceSegments` and `migrateLegacyPartitions` through
 * `resolveClientName`, and `isLegacyPartition` then leaves a partition
 * carrying a `source=` segment alone, so nothing ever relabels one.
 *
 * That is a proof only while the scope decides the resolution, and only while
 * those two writers agree. The resolver takes the first non-empty column of
 * the declaration's fallback chain while migration always takes
 * `client_name` first, so they answer alike exactly when the chain leads with
 * `client_name`; `reconcileCacheRows` rejects an empty scope value, so pinning
 * that column then pins the answer for every row the scope covers. Any other
 * chain, or a scope leaving the column free, proves nothing: such a row may
 * resolve anywhere, which is why the set is then empty rather than a subset.
 * Everything unproven is simply absent, and the caller fails closed on it.
 *
 * @ref LLP 0449#reconciliation [implements]: reconciliation never changes another client's rows, so a partition holding only another client's has no work here to refuse.
 * @param {{ path: string, partition: Record<string, string> }[]} parts
 * @param {string[]} segments  the scope's own resolved partition segments
 * @param {Record<string, string>} where
 * @param {CachePartitioningDeclaration} [declaration]
 * @returns {Set<string>}
 */
function partitionsOutsideScope(parts, segments, where, declaration) {
  // With no declaration the write path resolves through `resolveClientName`,
  // which is `client_name` first, and the scope requires that column non-empty.
  const first = declaration ? declaration.source.columns[0] : 'client_name'
  if (first !== 'client_name' || where[first] === undefined) return new Set()
  /** @type {Set<string>} */
  const outside = new Set()
  for (const part of parts) {
    for (const segment of segments) {
      const eq = segment.indexOf('=')
      const value = part.partition[segment.slice(0, eq)]
      if (value !== undefined && value !== segment.slice(eq + 1)) {
        outside.add(part.path)
        break
      }
    }
  }
  return outside
}
