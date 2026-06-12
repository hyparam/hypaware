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
import { discoverCachePartitions, readCursorSync, writeCursor } from '../../../../src/core/cache/partition.js'

import { EDGE_COLUMNS, EDGE_DATASET, NODE_COLUMNS, NODE_DATASET } from './datasets.js'
import { firstSeenTime, mergeRow } from './project.js'

/**
 * @import { ColumnSpec } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { AppendOptions, ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'
 * @import { PartitionSpec } from 'icebird/src/types.js'
 * @import { GraphRow } from './types.d.ts'
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
 * Duplicates are rare — projection dedups pre-write — but concurrent
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
 * @returns {Promise<{ datasets: { dataset: string, duplicateIds: number, rowsMerged: number, partitionsRewritten: number }[] }>}
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
      return { datasets }
    },
    { component: 'plugin' }
  )
}

/**
 * @param {{ storage: ExtendedQueryStorageService, dataset: 'node' | 'edge', dryRun: boolean }} args
 * @returns {Promise<{ dataset: string, duplicateIds: number, rowsMerged: number, partitionsRewritten: number }>}
 */
async function compactGraphDataset({ storage, dataset, dryRun }) {
  const idCol = ID_COLUMNS[dataset]
  const partitions = await discoverCachePartitions(storage.cacheRoot, { datasets: [dataset] })

  // Pass 1: count id occurrences and remember which partitions hold them.
  // Only ids and partition paths are kept in memory, not rows.
  /** @type {Map<string, { count: number, parts: Set<string> }>} */
  const occurrences = new Map()
  for (const part of partitions) {
    const tableDir = liveTableDir(part.path)
    if (!tableExists(tableDir)) continue
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
    }
  }

  // Pass 2a: collect only the duplicate rows (small by construction).
  /** @type {Map<string, { row: GraphRow, part: string }[]>} */
  const dupRows = new Map()
  for (const part of affectedParts) {
    const tableDir = liveTableDir(part)
    for await (const row of scanRowsFromTable(tableDir)) {
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
  let rowsMerged = 0
  for (const [, group] of dupRows) {
    group.sort(compareDupRows)
    const canonical = { ...group[0].row }
    for (let i = 1; i < group.length; i++) mergeRow(canonical, group[i].row)
    const home = group[0].part
    const rows = mergedByPart.get(home) ?? []
    rows.push(canonical)
    mergedByPart.set(home, rows)
    rowsMerged += group.length - 1
  }

  // Pass 2b: rewrite each affected partition — duplicate rows dropped,
  // this partition's merged rows appended, sorted replacement table.
  for (const part of affectedParts) {
    await rewritePartition({
      partitionDir: part,
      idCol,
      duplicateIds,
      extraRows: mergedByPart.get(part) ?? [],
      fallbackColumns: FALLBACK_COLUMNS[dataset],
      sortOrder: SORT_ORDERS[dataset],
    })
  }

  return {
    dataset,
    duplicateIds: duplicateIds.size,
    rowsMerged,
    partitionsRewritten: affectedParts.size,
  }
}

/**
 * Rewrite one partition's live table into a fresh table directory,
 * mirroring the kernel cache-maintenance generation swap: Iceberg
 * metadata stores absolute URLs, so the rewrite lands in a new
 * `table-<seq>` dir, the cursor repoints, and the old generation gets a
 * `.retired` marker for the kernel's grace-period sweep to reclaim.
 *
 * @param {{
 *   partitionDir: string
 *   idCol: 'node_id' | 'edge_id'
 *   duplicateIds: Set<string>
 *   extraRows: GraphRow[]
 *   fallbackColumns: readonly ColumnSpec[]
 *   sortOrder: readonly { column: string, direction?: 'asc' | 'desc' }[]
 * }} args
 */
async function rewritePartition({ partitionDir, idCol, duplicateIds, extraRows, fallbackColumns, sortOrder }) {
  const cursor = readCursorSync(partitionDir)
  const oldTableDirName = cursor.tableDir ?? 'table'
  const oldTableDir = path.join(partitionDir, oldTableDirName)
  if (!tableExists(oldTableDir)) return

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
  const flush = async () => {
    if (batch.length === 0) return
    await appendRowsToTable(newTableDir, columns, batch, appendOpts)
    totalRows += batch.length
    batch = []
  }

  for await (const row of scanRowsFromTable(oldTableDir)) {
    const id = row[idCol]
    if (typeof id === 'string' && duplicateIds.has(id)) continue
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

  await writeCursor(partitionDir, {
    epoch: cursor.epoch,
    rowCount: totalRows,
    compaction: {
      previousTableDir: oldTableDirName,
      compactedAt: new Date().toISOString(),
    },
    layout: 'source-table',
    tableDir: newTableDirName,
    retention: cursor.retention,
  })
  await fsPromises.writeFile(path.join(oldTableDir, '.retired'), new Date().toISOString(), 'utf8')
}

/**
 * @param {string} partitionDir
 */
function liveTableDir(partitionDir) {
  const cursor = readCursorSync(partitionDir)
  return path.join(partitionDir, cursor.tableDir ?? 'table')
}

/**
 * Deterministic duplicate ordering: earliest `first_seen` first (the
 * canonical row), then partition path, then the kernel row id — so the
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
