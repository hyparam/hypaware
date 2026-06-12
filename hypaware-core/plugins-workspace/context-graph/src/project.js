// @ts-check

import { Attr, withSpan } from '../../../../src/core/observability/index.js'
import { executeQuerySql } from '../../../../src/core/query/sql.js'

import { CONTRACT_RULES } from './contract.js'
import {
  EDGE_COLUMNS,
  EDGE_DATASET,
  graphTablePath,
  NODE_COLUMNS,
  NODE_DATASET,
} from './datasets.js'

/**
 * @import { HypAwareV2Config, QueryRegistry } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'
 * @import { GraphRow } from './types.d.ts'
 */

/**
 * Run the T0 deterministic projection: read `ai_gateway_messages` through
 * each contract rule, materialize node/edge rows (deterministic ids +
 * inline provenance), dedup against already-committed rows, and append the
 * new ones. Idempotent: a second run with no new source data writes zero
 * rows.
 *
 * @param {{ query: QueryRegistry, storage: ExtendedQueryStorageService, config?: HypAwareV2Config, dryRun?: boolean }} args
 * @returns {Promise<{ nodes: number, edges: number, nodesWritten: number, edgesWritten: number }>}
 */
export async function projectGraph({ query, storage, config, dryRun = false }) {
  return withSpan(
    'graph.project',
    {
      [Attr.COMPONENT]: 'plugin',
      [Attr.OPERATION]: 'graph.project',
      dry_run: dryRun,
      status: 'ok',
    },
    async (span) => {
      /** @type {Map<string, GraphRow>} */
      const nodes = new Map()
      /** @type {Map<string, GraphRow>} */
      const edges = new Map()

      let sourceRows = 0
      for (const rule of CONTRACT_RULES) {
        const result = await executeQuerySql({
          query: rule.sql,
          registry: query,
          storage,
          config,
          refresh: 'always',
        })
        sourceRows += result.rows.length
        const target = rule.kind === 'node' ? nodes : edges
        const idKey = rule.kind === 'node' ? 'node_id' : 'edge_id'
        for (const row of result.rows) {
          const built = rule.toRow(row)
          if (!built) continue
          const id = /** @type {string} */ (built[idKey])
          const existing = target.get(id)
          if (existing) mergeRow(existing, built)
          else target.set(id, built)
        }
      }

      const nodeRows = [...nodes.values()]
      const edgeRows = [...edges.values()]
      span.setAttribute('source_row_count', sourceRows)
      span.setAttribute('node_count', nodeRows.length)
      span.setAttribute('edge_count', edgeRows.length)

      if (dryRun) {
        return { nodes: nodeRows.length, edges: edgeRows.length, nodesWritten: 0, edgesWritten: 0 }
      }

      const freshNodes = await dedupExisting(nodeRows, 'node_id', NODE_DATASET, query, storage, config)
      const freshEdges = await dedupExisting(edgeRows, 'edge_id', EDGE_DATASET, query, storage, config)

      if (freshNodes.length > 0) {
        await storage.appendRows(graphTablePath(storage, NODE_DATASET), [...NODE_COLUMNS], freshNodes)
      }
      if (freshEdges.length > 0) {
        await storage.appendRows(graphTablePath(storage, EDGE_DATASET), [...EDGE_COLUMNS], freshEdges)
      }

      span.setAttribute('nodes_written', freshNodes.length)
      span.setAttribute('edges_written', freshEdges.length)
      return {
        nodes: nodeRows.length,
        edges: edgeRows.length,
        nodesWritten: freshNodes.length,
        edgesWritten: freshEdges.length,
      }
    },
    { component: 'plugin' }
  )
}

/**
 * Filter out rows whose id is already committed in the dataset — the
 * pre-write dedup that keeps re-projection idempotent at query time.
 * Duplicates that slip past it (concurrent projections, partial
 * failures) are merged later by `compactGraphTables` (maintenance.js).
 *
 * @param {GraphRow[]} rows
 * @param {'node_id' | 'edge_id'} idCol
 * @param {string} dataset
 * @param {QueryRegistry} query
 * @param {ExtendedQueryStorageService} storage
 * @param {HypAwareV2Config | undefined} config
 * @returns {Promise<GraphRow[]>}
 */
async function dedupExisting(rows, idCol, dataset, query, storage, config) {
  if (rows.length === 0) return rows
  /** @type {Set<string>} */
  const seen = new Set()
  try {
    const res = await executeQuerySql({
      query: `SELECT ${idCol} FROM ${dataset}`,
      registry: query,
      storage,
      config,
      refresh: 'always',
    })
    for (const r of res.rows) {
      const v = r[idCol]
      if (typeof v === 'string') seen.add(v)
    }
  } catch {
    // Dataset has no committed partitions yet — nothing to dedup against.
  }
  return rows.filter((r) => !seen.has(/** @type {string} */ (r[idCol])))
}

/**
 * Merge a duplicate row into the accumulated one: keep the earliest
 * `first_seen` and union props. Order-independent so a re-run is stable.
 * Shared with the dedup compaction in maintenance.js so projection-time
 * and compaction-time merges agree.
 *
 * @param {GraphRow} existing
 * @param {GraphRow} incoming
 */
export function mergeRow(existing, incoming) {
  const a = firstSeenTime(existing.first_seen)
  const b = firstSeenTime(incoming.first_seen)
  if (b !== undefined && (a === undefined || b < a)) existing.first_seen = incoming.first_seen
  const ep = existing.props
  const ip = incoming.props
  if (ip && typeof ip === 'object') {
    const merged = { ...(ep && typeof ep === 'object' ? ep : {}), ...ip }
    existing.props = merged
  }
}

/**
 * Epoch millis for a `first_seen` value. Projection-time rows carry ISO
 * strings; rows scanned back from Iceberg carry `Date` objects — both
 * must compare the same way.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function firstSeenTime(value) {
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isNaN(t) ? undefined : t
  }
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}
