// @ts-check

import { createHash } from 'node:crypto'
import path from 'node:path'
import { reconcileSnapshotsInTable } from './iceberg/store.js'
import { appendRefusalReason, discoverCachePartitions, readCursorSync, resolveSourceSegments,
  sanitizePathSegment, withPartitionMutationLocks, writeCursor } from './partition.js'
import { cacheTablePath } from './paths.js'
import { resolveIcebergDir } from './storage.js'
import { Attr, getLogger, withSpan } from '../observability/index.js'
import { compareStrings } from '../util/compare_strings.js'
import { claimPartitionMutation } from '../util/mutation_guard.js'

/**
 * @import { ColumnSpec } from '../../../hypaware-plugin-kernel-types.js'
 * @import { CachePartitioningDeclaration } from '../../../src/core/cache/types.js'
 */

/**
 * Claim the cross-process guard for one reconcile scope of `dataset`, keyed on
 * the cache root, the dataset and the scope's exact `where`. A writer holds it
 * from its authoritative read through its reconcile commit, so a snapshot read
 * before a rewind cannot commit after one. Fail-fast like the partition guard
 * it reuses: a busy scope throws `cache_partition_mutation_busy` and the
 * caller decides whether to defer or retry. Distinct scopes never contend.
 *
 * Holders of a partition guard never take a scope guard, so taking this one
 * first and the partition guards inside `reconcileCacheRows` cannot deadlock.
 * The lock is a transient `.session-<hash>.mutation-lock` directory beside the
 * dataset's partitions, removed on release; partition discovery finds no
 * table in it.
 * @ref LLP 0449#read-commit-guard [implements]: one guard spans read, fingerprint and commit.
 * @param {string} cacheRoot
 * @param {string} dataset
 * @param {Record<string, string>} where
 * @returns {() => void} sync release
 */
export function claimReconcileScope(cacheRoot, dataset, where) {
  if (!where.client_name || !where.session_id ||
      Object.values(where).some(value => typeof value !== 'string' || !value)) throw new Error('Invalid snapshot scope')
  const key = createHash('sha256').update(JSON.stringify(Object.entries(where).sort(([a], [b]) => compareStrings(a, b))))
    .digest('hex').slice(0, 32)
  return claimPartitionMutation(cacheTablePath(cacheRoot, dataset, [`session-${key}`]))
}

/**
 * @ref LLP 0449#reconciliation [implements]: one canonical source partition;
 * older poll/backfill partitions are retired for this scope only, after commit.
 * @param {{ cacheRoot: string, dataset: string, columns: ColumnSpec[], rows: Record<string, unknown>[],
 * scope: { where: Record<string, string>, key: string }, declaration?: CachePartitioningDeclaration,
 * filterRows: (rows: Record<string, unknown>[]) => Record<string, unknown>[], reserveSeq: (count: number) => Promise<bigint> }} args
 */
export async function reconcileCacheRows(args) {
  const { rows, scope, ...rest } = args
  return reconcileCacheSnapshots({ ...rest, snapshots: [{ rows, scope }] })
}

/**
 * Reconcile a batch of scoped snapshots under one set of partition guards:
 * partitions are discovered once and each one is reconciled for the whole
 * batch in one metadata load and one commit. Each scope is settled, and
 * recorded, exactly as `reconcileCacheRows` settles a lone one.
 * @ref LLP 0527#batched-reconcile [implements]: one discovery, one guard set and one commit per partition per batch
 * @param {{ cacheRoot: string, dataset: string, columns: ColumnSpec[],
 * snapshots: { rows: Record<string, unknown>[], scope: { where: Record<string, string>, key: string } }[],
 * declaration?: CachePartitioningDeclaration,
 * filterRows: (rows: Record<string, unknown>[]) => Record<string, unknown>[], reserveSeq: (count: number) => Promise<bigint> }} args
 * @returns {Promise<number>} rows written across the batch
 */
export async function reconcileCacheSnapshots(args) {
  const { cacheRoot, dataset, columns, snapshots, declaration } = args
  if (!snapshots.length) return 0
  const plans = snapshots.map(({ rows, scope }) => {
    const entries = Object.entries(scope.where)
    if (!entries.length || !scope.where.client_name || !scope.where.session_id ||
        entries.some(([key, value]) => !columns.some(column => column.name === key) || !value) ||
        !columns.some(column => column.name === scope.key)) throw new Error('Invalid snapshot scope')
    if (rows.some(row => !entries.every(([key, value]) => row[key] === value) || !row[scope.key])) {
      throw new Error('Snapshot row outside its declared scope or missing identity')
    }
    const segments = declaration ? resolveSourceSegments(scope.where, declaration)
      : [`source=${sanitizePathSegment(scope.where.client_name)}`]
    return { rows, scope, segments, target: cacheTablePath(cacheRoot, dataset, segments) }
  })
  const targets = new Set(plans.map(plan => plan.target))
  const parts = await discoverCachePartitions(cacheRoot, { datasets: [dataset] })
  const knownPaths = new Set(parts.map(part => part.path))
  const paths = [...targets, ...[...knownPaths].filter(part => !targets.has(part))]
  // A reconciliation rewrites recorded history, so its record names the exact
  // scope it rewrote: "rows_deleted: 4" is only actionable with the session it
  // removed them from. A batch names its size and records each scope below.
  const spanScope = plans.length === 1 ? plans[0].scope.where : { scopes: plans.length }
  return withSpan('cache.reconcile', { [Attr.COMPONENT]: 'cache', [Attr.DATASET]: dataset,
    [Attr.OPERATION]: 'cache.reconcile', ...spanScope, status: 'ok' }, async span => {
    return withPartitionMutationLocks(paths, async () => {
      /** @type {Set<string>} */
      const skipped = new Set()
      // Only a refusal ever asks which partitions are out of scope, and a
      // healthy cache never refuses, so the scan stays off the common path.
      /** @type {Set<string>[] | null} */
      let unreachable = null
      for (const part of paths) {
        const refusal = appendRefusalReason(part)
        if (!refusal) continue
        // A partition that could hold any batched scope's rows and cannot be
        // read still fails closed: its stale copies would survive the
        // canonical write and answer queries beside it. One that provably
        // holds none of them has no retirement to refuse, so the batch walks
        // past it.
        unreachable ??= plans.map(plan => partitionsOutsideScope(parts, plan.segments, plan.scope.where, declaration))
        if (!unreachable.every(outside => outside.has(part))) throw new Error(refusal)
        skipped.add(part)
        for (const plan of plans) {
          getLogger('cache').warn('cache.retirement_skipped', { [Attr.DATASET]: dataset,
            ...plan.scope.where, [Attr.OPERATION]: 'cache.reconcile', [Attr.STATUS]: 'degraded',
            [Attr.ERROR_KIND]: 'cursor_unreadable', partition_dir: part })
        }
      }
      const kept = plans.map(plan => args.filterRows(plan.rows))
      const counts = plans.map(() => ({ rowsWritten: 0, rowsDeleted: 0 }))
      let rowsWritten = 0
      let rowsDeleted = 0
      for (const part of paths) {
        if (skipped.has(part)) continue
        const cursor = readCursorSync(part)
        const fresh = targets.has(part) && !knownPaths.has(part)
        const table = fresh ? path.join(part, 'table') : resolveIcebergDir(part)
        const result = await reconcileSnapshotsInTable(table, columns,
          plans.map((plan, index) => ({ rows: plan.target === part ? kept[index] : [], scope: plan.scope })),
          args.reserveSeq, targets.has(part) && declaration ? { declaration } : undefined)
        rowsWritten += result.rowsWritten
        rowsDeleted += result.rowsDeleted
        result.perSnapshot.forEach((count, index) => {
          counts[index].rowsWritten += count.rowsWritten
          counts[index].rowsDeleted += count.rowsDeleted
        })
        if (result.rowsWritten || result.rowsDeleted || result.rowCount !== cursor.rowCount ||
            (fresh && result.rowCount > 0)) {
          // A transaction can commit before its cursor write fails. Even an
          // idempotent retry repairs that cursor from the live manifest counts.
          await writeCursor(part, { ...cursor, rowCount: result.rowCount,
            ...(fresh ? { layout: 'source-table', tableDir: 'table' } : {}) })
        }
      }
      span.setAttribute('rows_written', rowsWritten)
      span.setAttribute('rows_deleted', rowsDeleted)
      span.setAttribute('retirement_skipped', skipped.size)
      plans.forEach((plan, index) => {
        getLogger('cache').info('cache.snapshot_reconciled', { [Attr.DATASET]: dataset,
          ...plan.scope.where, rows_written: counts[index].rowsWritten, rows_deleted: counts[index].rowsDeleted,
          retirement_skipped: skipped.size, status: 'ok' })
      })
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
 * One precondition this cannot check, and does not hold by construction: the
 * chain that decides a label is the one in force when the partition was
 * written, and nothing on disk records it. The guard reads the chain in force
 * now. So a dataset whose chain once led with another column keeps partitions
 * labelled by that column, and a scope resolving through `client_name` today
 * reads those labels as foreign and skips rows that are in fact its own. The
 * trap is that correcting a chain to lead with `client_name` is what opens
 * the gap on the rows already written under the old one. The cursor cannot
 * carry the missing fact either, being the file this path has already found
 * unreadable. Every declaration here has only ever led with `client_name`,
 * so nothing on disk can carry a disagreeing label (issue #2332).
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
