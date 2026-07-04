// @ts-check

import { executeQuerySql } from '../../../../src/core/query/sql.js'

import { EDGE_DATASET, NODE_DATASET } from './datasets.js'

/**
 * @import { HypAwareV2Config, QueryRegistry } from '../../../../collectivus-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 * @import { GraphNode, GraphEdge, Direction, Neighbor, TraversalOk, TraversalErr } from './types.js'
 */

/**
 * Resolve a seed token to exactly one node, in tiers: exact `node_id`, then
 * exact `natural_key`, then `label`, each optionally narrowed by `type`. The
 * tiers exist because content-addressed ids are unguessable, so a human seed is
 * almost always a natural key or label. Multiple matches is an ambiguity error
 * carrying the candidates, never a silent pick.
 *
 * @param {GraphNode[]} nodes
 * @param {string} token
 * @param {string | undefined} type
 * @returns {{ ok: true, node: GraphNode } | TraversalErr}
 * @ref LLP 0064#seed-resolution [implements]: node_id → natural_key → label, ambiguity lists candidates
 */
export function resolveSeed(nodes, token, type) {
  const ofType = (n) => !type || n.node_type === type

  const byId = nodes.find((n) => n.node_id === token && ofType(n))
  if (byId) return { ok: true, node: byId }

  for (const field of /** @type {const} */ (['natural_key', 'label'])) {
    const matches = nodes.filter((n) => n[field] === token && ofType(n))
    if (matches.length === 1) return { ok: true, node: matches[0] }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `ambiguous seed ${JSON.stringify(token)} - ${matches.length} nodes match by ${field}; narrow with --type or pass an exact node_id/natural_key`,
        candidates: matches,
      }
    }
  }

  return { ok: false, error: `no node matches ${JSON.stringify(token)}${type ? ` of type ${type}` : ''}` }
}

/**
 * Breadth-first walk from a seed to `depth` hops over in-memory node/edge
 * arrays. Pure, no IO, so the traversal logic is unit-testable directly.
 *
 * `direction` 'out' follows src→dst, 'in' follows dst→src, 'both' follows
 * either (recording which way each neighbor was reached). A non-empty
 * `edgeTypes` restricts which edge types are traversable. The full reachable
 * set within `depth` is collected, then `limit` slices it in BFS order with
 * `truncated`/`reachable` reporting the drop: never a silent cap.
 *
 * @param {{ nodes: GraphNode[], edges: GraphEdge[], seed: string, depth?: number, edgeTypes?: string[], direction?: Direction, limit?: number, type?: string }} args
 * @returns {TraversalOk | TraversalErr}
 * @ref LLP 0064#thin-in-memory-traversal [implements]: whole-graph-in-RAM BFS is the deliberate basic tier; persisted index is the deferred fast path
 */
export function traverse({ nodes, edges, seed, depth = 1, edgeTypes = [], direction = 'both', limit = Infinity, type }) {
  const resolved = resolveSeed(nodes, seed, type)
  if (!resolved.ok) return resolved

  /** @type {Map<string, GraphNode>} */
  const byId = new Map(nodes.map((n) => [n.node_id, n]))
  const typeFilter = edgeTypes.length > 0 ? new Set(edgeTypes) : null

  // Forward (src→dst) and reverse (dst→src) adjacency, built only for the
  // directions we'll actually walk so a one-directional query does no extra work.
  /** @type {Map<string, { to: string, edge_type: string, direction: 'out' | 'in' }[]>} */
  const adjacency = new Map()
  const link = (from, to, edge_type, dir) => {
    let list = adjacency.get(from)
    if (!list) adjacency.set(from, (list = []))
    list.push({ to, edge_type, direction: dir })
  }
  for (const e of edges) {
    if (typeFilter && !typeFilter.has(e.edge_type)) continue
    if (direction === 'out' || direction === 'both') link(e.src_id, e.dst_id, e.edge_type, 'out')
    if (direction === 'in' || direction === 'both') link(e.dst_id, e.src_id, e.edge_type, 'in')
  }

  /** @type {Neighbor[]} */
  const reached = []
  const visited = new Set([resolved.node.node_id])
  /** @type {{ id: string, hop: number }[]} */
  let frontier = [{ id: resolved.node.node_id, hop: 0 }]

  while (frontier.length > 0) {
    /** @type {{ id: string, hop: number }[]} */
    const next = []
    for (const { id, hop } of frontier) {
      if (hop >= depth) continue
      for (const edge of adjacency.get(id) ?? []) {
        if (visited.has(edge.to)) continue
        visited.add(edge.to)
        const node = byId.get(edge.to) ?? { node_id: edge.to, node_type: '?', natural_key: edge.to, label: null }
        reached.push({ hop: hop + 1, edge_type: edge.edge_type, direction: edge.direction, from: id, node })
        next.push({ id: edge.to, hop: hop + 1 })
      }
    }
    frontier = next
  }

  const truncated = reached.length > limit
  return {
    ok: true,
    seed: resolved.node,
    neighbors: Number.isFinite(limit) ? reached.slice(0, limit) : reached,
    reachable: reached.length,
    truncated,
    totalNodes: nodes.length,
    totalEdges: edges.length,
  }
}

/**
 * Load the published `node`/`edge` datasets through the query surface and walk
 * them. Reads only the registered datasets, never the projection's internals,
 * so an alternate query path stays possible.
 *
 * @param {{ query: QueryRegistry, storage: ExtendedQueryStorageService, config?: HypAwareV2Config, seed: string, depth?: number, edgeTypes?: string[], direction?: Direction, limit?: number, type?: string }} args
 * @returns {Promise<TraversalOk | TraversalErr>}
 * @ref LLP 0064#query-reads-the-published-surface [implements]: reads node/edge via the registry, not project.js state
 */
export async function queryNeighbors({ query, storage, config, seed, depth, edgeTypes, direction, limit, type }) {
  const edgeRows = await loadRows(query, storage, config, `SELECT src_id, dst_id, edge_type FROM ${EDGE_DATASET}`)
  const nodeRows = await loadRows(query, storage, config, `SELECT node_id, node_type, natural_key, label FROM ${NODE_DATASET}`)

  // Fold by graph identity before handing clean arrays to the pure traversal.
  // The published surface can carry pre-compaction duplicates: the same
  // content-addressed id committed twice by concurrent projections or a
  // partial failure. `hyp graph compact` merges them, but a read must not
  // depend on it having run: two physical copies of one node must resolve as
  // a single seed (not a false "ambiguous"), and a doubled edge must not be
  // walked twice. Node identity is `node_id`; edge identity is
  // `(src_id, edge_type, dst_id)`: exactly the digest `edgeId()` hashes.
  /** @type {Map<string, GraphNode>} */
  const nodeById = new Map()
  for (const r of nodeRows) {
    const node_id = String(r.node_id)
    if (nodeById.has(node_id)) continue
    nodeById.set(node_id, {
      node_id,
      node_type: String(r.node_type),
      natural_key: String(r.natural_key),
      label: r.label == null ? null : String(r.label),
    })
  }
  /** @type {Map<string, GraphEdge>} */
  const edgeById = new Map()
  for (const r of edgeRows) {
    const edge = { src_id: String(r.src_id), dst_id: String(r.dst_id), edge_type: String(r.edge_type) }
    const id = `${edge.src_id}\0${edge.edge_type}\0${edge.dst_id}`
    if (!edgeById.has(id)) edgeById.set(id, edge)
  }

  return traverse({
    nodes: [...nodeById.values()],
    edges: [...edgeById.values()],
    seed, depth, edgeTypes, direction, limit, type,
  })
}

/**
 * @param {QueryRegistry} query
 * @param {ExtendedQueryStorageService} storage
 * @param {HypAwareV2Config | undefined} config
 * @param {string} sql
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function loadRows(query, storage, config, sql) {
  const res = await executeQuerySql({ query: sql, registry: query, storage, config, refresh: 'always' })
  return res.rows
}
