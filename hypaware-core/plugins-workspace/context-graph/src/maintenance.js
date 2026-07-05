// @ts-check

import fsPromises from 'node:fs/promises'
import path from 'node:path'

import { loadLatestFileCatalogMetadata } from 'icebird'

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { createLocalIcebergIO, tableUrlForDir } from '../../../../src/core/cache/iceberg/resolver.js'
import { columnsFromIcebergSchema } from '../../../../src/core/cache/iceberg/schema.js'
import {
  appendRowsToTable,
  currentPartitionSpec,
  currentSchema,
  scanRowsFromTable,
  tableExists,
} from '../../../../src/core/cache/iceberg/store.js'
import { discoverCachePartitions, tryReadCursorSync, writeCursor } from '../../../../src/core/cache/partition.js'

import { EDGE_COLUMNS, EDGE_DATASET, NODE_COLUMNS, NODE_DATASET } from './datasets.js'
import { firstSeenTime, mergeRow } from './project.js'

/**
 * @import { ColumnSpec } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { AppendOptions, ExtendedQueryStorageService, PartitionCursor } from '../../../../src/core/cache/types.js'
 * @import { PartitionSpec } from 'icebird/src/types.js'
 * @import { GraphRow, SkippedPartition } from './types.js'
 */

/** Rows per append batch while rewriting; graph rows are skinny. */
const REWRITE_BATCH_ROWS = 10_000

/**
 * Write sort order declared on rewritten graph tables. icebird
 * (>= 0.8.9) sorts every appended data file by the table's default
 * sort order, so range scans by type and id-prefix lookups read
 * clustered data after the first compaction.
 */
const SORT_ORDERS = {
  [NODE_DATASET]: [{ column: 'node_type' }, { column: 'node_id' }],
  [EDGE_DATASET]: [{ column: 'edge_type' }, { column: 'src_id' }, { column: 'dst_id' }],
}

/** @type {{ node: 'node_id', edge: 'edge_id' }} */
const ID_COLUMNS = { [NODE_DATASET]: 'node_id', [EDGE_DATASET]: 'edge_id' }
const FALLBACK_COLUMNS = { [NODE_DATASET]: NODE_COLUMNS, [EDGE_DATASET]: EDGE_COLUMNS }

/** @type {('node' | 'edge')[]} */
const GRAPH_DATASETS = [NODE_DATASET, EDGE_DATASET]

/**
 * Compact the derived graph tables: merge duplicate node/edge rows
 * (same content-addressed id) across all committed partitions, and
 * rewrite affected partitions into sorted replacement tables.
 *
 * Duplicates are rare (projection dedups pre-write), but concurrent
 * projections or partial failures can land the same id twice, possibly
 * in different `source=` partitions. Each duplicate group folds into a
 * single row (earliest `first_seen`, unioned props, via the same
 * `mergeRow` projection uses) kept in the group's canonical partition:
 * the partition of the earliest-seen row.
 *
 * General file compaction (data-file count, snapshot expiry) stays the
 * kernel cache-maintenance's job; this pass only owns graph semantics.
 *
 * @param {{ storage: ExtendedQueryStorageService, dryRun?: boolean }} args
 * @returns {Promise<{ datasets: { dataset: string, duplicateIds: number, rowsMerged: number, partitionsRewritten: number, partitionsSkipped: SkippedPartition[] }[] }>}
 * @ref LLP 0023#graph-compaction [implements]: graph semantics only; file-count/snapshot compaction stays with the kernel
 */
export async function compactGraphTables({ storage, dryRun = false }) {
  return withSpan(
    'graph.compact',
    {
      [Attr.COMPONENT]: 'plugin',
      [Attr.OPERATION]: 'graph.compact',
      dry_run: dryRun,
      status: 'ok',
    },
    async (span) => {
      const datasets = []
      for (const dataset of GRAPH_DATASETS) {
        datasets.push(await compactGraphDataset({ storage, dataset, dryRun }))
      }
      span.setAttribute('duplicate_ids', datasets.reduce((n, d) => n + d.duplicateIds, 0))
      span.setAttribute('rows_merged', datasets.reduce((n, d) => n + d.rowsMerged, 0))
      span.setAttribute('partitions_rewritten', datasets.reduce((n, d) => n + d.partitionsRewritten, 0))
      const skipped = datasets.reduce((n, d) => n + d.partitionsSkipped.length, 0)
      span.setAttribute('partitions_skipped', skipped)
      if (skipped > 0) span.setAttribute('status', 'partial')
      return { datasets }
    },
    { component: 'plugin' }
  )
}

/**
 * @param {{ storage: ExtendedQueryStorageService, dataset: 'node' | 'edge', dryRun: boolean }} args
 * @returns {Promise<{ dataset: string, duplicateIds: number, rowsMerged: number, partitionsRewritten: number, partitionsSkipped: SkippedPartition[] }>}
 */
async function compactGraphDataset({ storage, dataset, dryRun }) {
  const idCol = ID_COLUMNS[dataset]
  const partitions = await discoverCachePartitions(storage.cacheRoot, { datasets: [dataset] })

  /** @type {SkippedPartition[]} */
  const partitionsSkipped = []

  // Pass 1: count id occurrences and remember which partitions hold them.
  // Only ids and partition paths are kept in memory, not rows. The cursor
  // read here is positive (tryReadCursorSync) and remembered per partition:
  // the eventual generation swap is conditional on the cursor still
  // matching it, and a partition whose cursor cannot be positively read is
  // never rewritten. A corrupt cursor.json must not be mistaken for the
  // epoch-0 default when the old generation is about to be retired.
  /** @type {Map<string, { count: number, parts: Set<string> }>} */
  const occurrences = new Map()
  /** @type {Map<string, { cursor: PartitionCursor, tableDir: string }>} */
  const liveByPart = new Map()
  for (const part of partitions) {
    if (part.legacy) continue // bare table without a cursor; not a graph source-table
    const cursor = tryReadCursorSync(part.path)
    if (!cursor) {
      partitionsSkipped.push({ path: part.path, reason: 'unreadable-cursor' })
      continue
    }
    if (cursor.layout !== 'source-table') {
      partitionsSkipped.push({ path: part.path, reason: 'unexpected-layout' })
      continue
    }
    const tableDir = path.join(part.path, cursor.tableDir ?? 'table')
    if (!tableExists(tableDir)) continue
    liveByPart.set(part.path, { cursor, tableDir })
    for await (const row of scanRowsFromTable(tableDir, [idCol])) {
      const id = row[idCol]
      if (typeof id !== 'string') continue
      let entry = occurrences.get(id)
      if (!entry) {
        entry = { count: 0, parts: new Set() }
        occurrences.set(id, entry)
      }
      entry.count += 1
      entry.parts.add(part.path)
    }
  }

  /** @type {Set<string>} */
  const duplicateIds = new Set()
  /** @type {Set<string>} */
  const affectedParts = new Set()
  for (const [id, entry] of occurrences) {
    if (entry.count <= 1) continue
    duplicateIds.add(id)
    for (const p of entry.parts) affectedParts.add(p)
  }

  if (duplicateIds.size === 0 || dryRun) {
    return {
      dataset,
      duplicateIds: duplicateIds.size,
      rowsMerged: 0,
      partitionsRewritten: dryRun ? affectedParts.size : 0,
      partitionsSkipped,
    }
  }

  // Pass 2a: collect only the duplicate rows (small by construction).
  /** @type {Map<string, { row: GraphRow, part: string }[]>} */
  const dupRows = new Map()
  for (const part of affectedParts) {
    const live = liveByPart.get(part)
    if (!live) continue
    for await (const row of scanRowsFromTable(live.tableDir)) {
      const id = row[idCol]
      if (typeof id !== 'string' || !duplicateIds.has(id)) continue
      const group = dupRows.get(id) ?? []
      group.push({ row: /** @type {GraphRow} */ (row), part })
      dupRows.set(id, group)
    }
  }

  // Fold each group into one merged row, in a deterministic order so a
  // re-run (or a different partition visit order) produces the same row.
  // The canonical partition is the earliest-seen row's home.
  /** @type {Map<string, GraphRow[]>} */
  const mergedByPart = new Map()
  /** @type {Map<string, string>} */
  const homeById = new Map()
  for (const [id, group] of dupRows) {
    group.sort(compareDupRows)
    const canonical = { ...group[0].row }
    for (let i = 1; i < group.length; i++) mergeRow(canonical, group[i].row)
    const home = group[0].part
    homeById.set(id, home)
    const rows = mergedByPart.get(home) ?? []
    rows.push(canonical)
    mergedByPart.set(home, rows)
  }

  // Pass 2b: rewrite each affected partition (duplicate rows dropped):
  // this partition's merged rows appended, sorted replacement table.
  //
  // Home partitions (the ones that receive merged rows) go first, and a
  // duplicate's copies are only dropped from other partitions once its
  // merged row verifiably landed: if the home rewrite is skipped, dropping
  // the copies elsewhere would lose the props that were folded into the
  // never-written merged row. A skipped partition just leaves duplicates
  // in place for the next run.
  /** @type {Set<string>} */
  const landedIds = new Set()
  let rowsMerged = 0
  let partitionsRewritten = 0
  const ordered = [...affectedParts].sort((a, b) => {
    const ha = mergedByPart.has(a) ? 0 : 1
    const hb = mergedByPart.has(b) ? 0 : 1
    return ha !== hb ? ha - hb : a < b ? -1 : a > b ? 1 : 0
  })
  for (const part of ordered) {
    const live = liveByPart.get(part)
    if (!live) continue
    const extraRows = mergedByPart.get(part) ?? []
    /** @type {Set<string>} */
    const dropIds = new Set()
    for (const id of duplicateIds) {
      const home = homeById.get(id)
      if (home === part || (home !== undefined && landedIds.has(id))) dropIds.add(id)
    }
    if (dropIds.size === 0 && extraRows.length === 0) continue
    const result = await rewritePartition({
      partitionDir: part,
      idCol,
      dropIds,
      extraRows,
      expectedCursor: live.cursor,
      fallbackColumns: FALLBACK_COLUMNS[dataset],
      sortOrder: SORT_ORDERS[dataset],
    })
    if (result.status === 'skipped') {
      partitionsSkipped.push({ path: part, reason: result.reason })
      continue
    }
    partitionsRewritten += 1
    rowsMerged += result.dropped - extraRows.length
    for (const row of extraRows) {
      const id = row[idCol]
      if (typeof id === 'string') landedIds.add(id)
    }
  }

  return {
    dataset,
    duplicateIds: duplicateIds.size,
    rowsMerged,
    partitionsRewritten,
    partitionsSkipped,
  }
}

/**
 * Rewrite one partition's live table into a fresh table directory,
 * mirroring the kernel cache-maintenance generation swap: Iceberg
 * metadata stores absolute URLs, so the rewrite lands in a new
 * `table-<seq>` dir, the cursor repoints, and the old generation gets a
 * `.retired` marker for the kernel's grace-period sweep to reclaim.
 *
 * The swap is conditional: writers (`appendRowsToSourceTable`) keep
 * appending to the old generation while it is being scanned, so before
 * repointing, the cursor is re-read and compared against the one the
 * compaction scan started from. Any change (a bumped rowCount from a
 * concurrent append, a different tableDir from another compactor, or a
 * cursor that can no longer be positively read) aborts the swap: the
 * staged replacement table is removed and the partition is reported
 * skipped, because retiring the old generation at that point would lose
 * the rows appended during the rewrite window. (A small write window
 * between the re-read and the cursor write remains; closing it needs a
 * partition-level lock, which graph compaction doesn't take. Reruns are
 * cheap and duplicates are benign.)
 *
 * @param {{
 *   partitionDir: string
 *   idCol: 'node_id' | 'edge_id'
 *   dropIds: Set<string>
 *   extraRows: GraphRow[]
 *   expectedCursor: PartitionCursor
 *   fallbackColumns: readonly ColumnSpec[]
 *   sortOrder: readonly { column: string, direction?: 'asc' | 'desc' }[]
 * }} args
 * @returns {Promise<{ status: 'rewritten', dropped: number } | { status: 'skipped', reason: 'unreadable-cursor' | 'concurrent-write' }>}
 * @ref LLP 0023#graph-compaction [constrained-by]: conditional swap: on any cursor change, skip and report; never retire
 */
export async function rewritePartition({ partitionDir, idCol, dropIds, extraRows, expectedCursor, fallbackColumns, sortOrder }) {
  const oldTableDirName = expectedCursor.tableDir ?? 'table'
  const oldTableDir = path.join(partitionDir, oldTableDirName)

  /** @type {ColumnSpec[]} */
  let columns = [...fallbackColumns]
  /** @type {PartitionSpec | undefined} */
  let existingSpec
  try {
    const { resolver, lister } = await createLocalIcebergIO()
    const { metadata } = await loadLatestFileCatalogMetadata({
      tableUrl: tableUrlForDir(oldTableDir), resolver, lister,
    })
    const schema = currentSchema(metadata)
    // Use the table's own schema so kernel-internal columns
    // (e.g. _hyp_cache_row_id) survive the rewrite.
    if (schema) columns = columnsFromIcebergSchema(schema)
    existingSpec = currentPartitionSpec(metadata)
  } catch {
    // Fall back to the declared dataset columns.
  }
  const sortableColumns = new Set(columns.map((c) => c.name))
  const effectiveSortOrder = sortOrder.filter((s) => sortableColumns.has(s.column))

  const newTableDirName = `table-${Date.now()}`
  const newTableDir = path.join(partitionDir, newTableDirName)
  /** @type {AppendOptions} */
  const appendOpts = {
    partitionSpec: existingSpec,
    sortOrder: effectiveSortOrder.length > 0 ? effectiveSortOrder : undefined,
  }

  /** @type {Record<string, unknown>[]} */
  let batch = []
  let totalRows = 0
  let dropped = 0
  const flush = async () => {
    if (batch.length === 0) return
    await appendRowsToTable(newTableDir, columns, batch, appendOpts)
    totalRows += batch.length
    batch = []
  }

  for await (const row of scanRowsFromTable(oldTableDir)) {
    const id = row[idCol]
    if (typeof id === 'string' && dropIds.has(id)) {
      dropped += 1
      continue
    }
    batch.push(row)
    if (batch.length >= REWRITE_BATCH_ROWS) await flush()
  }
  for (const row of extraRows) {
    batch.push(row)
    if (batch.length >= REWRITE_BATCH_ROWS) await flush()
  }
  await flush()
  if (totalRows === 0) {
    // Keep the generation swap deterministic even when every row moved out.
    await appendRowsToTable(newTableDir, columns, [], appendOpts)
  }

  const current = tryReadCursorSync(partitionDir)
  if (!current) {
    await removeStagedTable(newTableDir)
    return { status: 'skipped', reason: 'unreadable-cursor' }
  }
  if (
    current.epoch !== expectedCursor.epoch ||
    current.rowCount !== expectedCursor.rowCount ||
    (current.tableDir ?? 'table') !== oldTableDirName ||
    current.layout !== 'source-table'
  ) {
    await removeStagedTable(newTableDir)
    return { status: 'skipped', reason: 'concurrent-write' }
  }

  await writeCursor(partitionDir, {
    epoch: current.epoch,
    rowCount: totalRows,
    compaction: {
      previousTableDir: oldTableDirName,
      compactedAt: new Date().toISOString(),
    },
    layout: 'source-table',
    tableDir: newTableDirName,
    retention: current.retention,
  })
  await fsPromises.writeFile(path.join(oldTableDir, '.retired'), new Date().toISOString(), 'utf8')
  return { status: 'rewritten', dropped }
}

/**
 * Remove a staged replacement table whose swap was aborted. Best-effort:
 * nothing references the directory, so a leftover is only wasted disk,
 * and the caller is already on a skip path.
 *
 * @param {string} tableDir
 */
async function removeStagedTable(tableDir) {
  try {
    await fsPromises.rm(tableDir, { recursive: true, force: true })
  } catch {
    // Leave the unreferenced directory behind rather than mask the skip.
  }
}

/**
 * Deterministic duplicate ordering: earliest `first_seen` first (the
 * canonical row), then partition path, then the kernel row id: so the
 * fold result does not depend on scan order.
 *
 * @param {{ row: GraphRow, part: string }} a
 * @param {{ row: GraphRow, part: string }} b
 */
function compareDupRows(a, b) {
  const fa = firstSeenTime(a.row.first_seen) ?? Infinity
  const fb = firstSeenTime(b.row.first_seen) ?? Infinity
  if (fa !== fb) return fa < fb ? -1 : 1
  if (a.part !== b.part) return a.part < b.part ? -1 : 1
  const ra = typeof a.row._hyp_cache_row_id === 'string' ? a.row._hyp_cache_row_id : ''
  const rb = typeof b.row._hyp_cache_row_id === 'string' ? b.row._hyp_cache_row_id : ''
  return ra < rb ? -1 : ra > rb ? 1 : 0
}
