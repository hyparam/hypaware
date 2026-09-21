// @ts-check

import { isDeepStrictEqual } from 'node:util'

import { executeQuerySql } from '../../../../src/core/query/sql.js'

import { EDGE_DATASET, NODE_DATASET } from './datasets.js'

/**
 * @import { HypAwareV2Config, QueryRegistry } from '../../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedQueryStorageService } from '../../../../src/core/cache/types.js'
 * @import { LocalOnlyVisibilityReport } from '../../../../src/core/query/types.js'
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
  /** @type {Map<string, { to: string, edge_type: string, direction: 'out' | 'in', row: GraphEdge }[]>} */
  const adjacency = new Map()
  const link = (from, to, edge_type, dir, row) => {
    let list = adjacency.get(from)
    if (!list) adjacency.set(from, (list = []))
    list.push({ to, edge_type, direction: dir, row })
  }
  for (const e of edges) {
    if (typeFilter && !typeFilter.has(e.edge_type)) continue
    if (direction === 'out' || direction === 'both') link(e.src_id, e.dst_id, e.edge_type, 'out', e)
    if (direction === 'in' || direction === 'both') link(e.dst_id, e.src_id, e.edge_type, 'in', e)
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
        reached.push({ hop: hop + 1, edge_type: edge.edge_type, direction: edge.direction, from: id, node,
          ...(edge.row.edge_id ? { edge_id: edge.row.edge_id, props: edge.row.props,
            source_dataset: edge.row.source_dataset, source_keys: edge.row.source_keys } : {}) })
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
 * `callerCwd`/`includeLocalOnly` ride through to `executeQuerySql`, whose
 * shared LLP 0105 filter decides visibility: a restricted caller gets the
 * graph's structure with content columns (natural_key/label) suppressed, and
 * the traversal result carries the aggregate report so the verb can say so.
 *
 * @param {{ query: QueryRegistry, storage: ExtendedQueryStorageService, config?: HypAwareV2Config, seed: string, depth?: number, edgeTypes?: string[], direction?: Direction, limit?: number, type?: string, callerCwd?: string | null, includeLocalOnly?: boolean }} args
 * @returns {Promise<(TraversalOk | TraversalErr) & { localOnly: LocalOnlyVisibilityReport }>}
 * @ref LLP 0064#query-reads-the-published-surface [implements]: reads node/edge via the registry, not project.js state
 * @ref LLP 0105 [constrained-by]: hyp graph funnels through the same shared filter as hyp query; nothing is re-decided here
 */
export async function queryNeighbors({ query, storage, config, seed, depth, edgeTypes, direction, limit, type, callerCwd, includeLocalOnly }) {
  const visibility = { callerCwd: callerCwd ?? null, includeLocalOnly: includeLocalOnly === true, signal: AbortSignal.timeout(5000) }
  const edges_ = await loadRows(query, storage, config, `SELECT edge_id, src_id, dst_id, edge_type, props, source_dataset, source_keys FROM ${EDGE_DATASET} LIMIT 100001`, visibility)
  const nodes_ = await loadRows(query, storage, config, `SELECT node_id, node_type, natural_key, label FROM ${NODE_DATASET} LIMIT 100001`, visibility)
  const edgeRows = edges_.rows
  const nodeRows = nodes_.rows
  /** @type {LocalOnlyVisibilityReport} */
  const localOnly = {
    callerClass: nodes_.localOnly.callerClass,
    filtered: nodes_.localOnly.filtered || edges_.localOnly.filtered,
    withheldRows: nodes_.localOnly.withheldRows + edges_.localOnly.withheldRows,
    suppressedRows: nodes_.localOnly.suppressedRows + edges_.localOnly.suppressedRows,
  }

  if (nodeRows.length > 100_000 || edgeRows.length > 100_000) {
    return { ok: false, error: 'graph traversal exceeds the 100000-row read budget; use a narrower SQL query', localOnly }
  }

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
      // Suppressed content (a restricted caller under LLP 0105) arrives as
      // null even though the column is non-nullable on disk; keep it empty
      // rather than the string 'null' so seeds cannot falsely match it.
      natural_key: r.natural_key == null ? '' : String(r.natural_key),
      label: r.label == null ? null : String(r.label),
    })
  }
  /** @type {Map<string, GraphEdge>} */
  const edgeById = new Map()
  for (const r of edgeRows) {
    const edge = { edge_id: String(r.edge_id), src_id: String(r.src_id), dst_id: String(r.dst_id), edge_type: String(r.edge_type),
      props: jsonObject(r.props), source_dataset: String(r.source_dataset), source_keys: jsonObject(r.source_keys) }
    const id = `${edge.src_id}\0${edge.edge_type}\0${edge.dst_id}`
    if (!edgeById.has(id)) edgeById.set(id, edge)
  }

  const result = traverse({
    nodes: [...nodeById.values()],
    edges: [...edgeById.values()],
    seed, depth, edgeTypes, direction, limit, type,
  })
  // The report rides failures too: a seed that fails to resolve because its
  // natural_key was suppressed must be explainable, not a bare "no match".
  //
  // So does emptiness. A graph with no nodes fails every seed, and "no such
  // node" is the wrong answer to give someone whose graph has simply never
  // been projected: the fix is a command, not a different seed. The fact is
  // set here, on the shared operation result, so an MCP caller reads it as
  // data rather than the CLI inventing the distinction while rendering.
  // @ref LLP 0213#empty-is-shared [implements]: emptiness is an operation fact, not a rendering flourish
  const graphEmpty = nodeById.size === 0
  return { ...result, localOnly, ...(graphEmpty ? { graphEmpty } : {}) }
}

/**
 * @param {QueryRegistry} query
 * @param {ExtendedQueryStorageService} storage
 * @param {HypAwareV2Config | undefined} config
 * @param {string} sql
 * @param {{ callerCwd: string | null, includeLocalOnly: boolean, signal?: AbortSignal }} visibility
 * @returns {Promise<{ rows: Record<string, unknown>[], localOnly: LocalOnlyVisibilityReport }>}
 */
async function loadRows(query, storage, config, sql, visibility) {
  const res = await executeQuerySql({
    query: sql,
    registry: query,
    storage,
    config,
    refresh: 'always',
    callerCwd: visibility.callerCwd,
    includeLocalOnly: visibility.includeLocalOnly,
    signal: visibility.signal,
    maxHeapBytes: 128 * 1024 * 1024,
  })
  return { rows: res.rows, localOnly: res.localOnly }
}

/**
 * Dereference the published exemplar through at most two provenance hops.
 * Visibility is applied at every hop; suppressed keys stop the walk. This is
 * intentionally limited to the two built-in evidence contracts, not arbitrary
 * SQL from source_keys. Return source rows, never a synthesized assertion.
 * @param {{ query: QueryRegistry, storage: ExtendedQueryStorageService, config?: HypAwareV2Config, kind: 'node' | 'edge', id: string, callerCwd?: string | null, includeLocalOnly?: boolean }} args
 * @returns {Promise<Record<string, unknown>[]>}
 * @ref LLP 0428#visibility [implements]: no implicit visibility override during evidence retrieval.
 */
export async function queryEvidence({ query, storage, config, kind, id, callerCwd, includeLocalOnly }) {
  if (!['node', 'edge'].includes(kind) || id.length > 4096) throw new Error('invalid graph evidence identity')
  const quote = value => `'${String(value).replace(/'/g, "''")}'`
  const visibility = { callerCwd: callerCwd ?? null, includeLocalOnly: includeLocalOnly === true, signal: AbortSignal.timeout(5000) }
  const read = sql => loadRows(query, storage, config, sql, visibility)
  let rows = (await read(`SELECT source_dataset, source_keys FROM ${kind} WHERE ${kind}_id = ${quote(id)} LIMIT 2`)).rows
  if (rows.length !== 1) return [] // stale duplicate exemplars need compaction
  for (let hop = 0; hop < 2; hop++) {
    const row = rows[0]
    let keys = row.source_keys
    if (typeof keys === 'string') {
      if (keys.length > 16_384) return []
      try { keys = JSON.parse(keys) } catch { return [] }
    }
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) return []
    const sourceKeys = /** @type {Record<string, unknown>} */ (keys)
    const dataset = row.source_dataset
    let fields
    if (dataset === 'enrichment_committed') fields = ['item_id', 'item_type', 'anchor_type', 'anchor_key', 'committed_at']
    else if (dataset === 'ai_gateway_messages') fields = ['message_id', 'part_id']
    else return []
    const clauses = []
    for (const field of fields) {
      const raw = sourceKeys[field]
      const value = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw
      if (typeof value !== 'string' || !value || value.length > 4096) return []
      clauses.push(`${field} = ${quote(value)}`)
    }
    const columns = dataset === 'enrichment_committed' ? 'source_dataset, source_keys'
      : 'session_id, message_id, part_id, message_created_at, role, part_type, content_text, tool_name, tool_args'
    const committedKeys = dataset === 'enrichment_committed' ? jsonObject(sourceKeys.source_keys) : null
    const maxRows = committedKeys ? 17 : 2
    rows = (await read(`SELECT ${columns} FROM ${dataset} WHERE ${clauses.join(' AND ')} LIMIT ${maxRows}`)).rows
    if (committedKeys) {
      // A curator batch shares its commit time; original source keys distinguish
      // up to 16 claims for the same item and anchor. Overflow stays ambiguous.
      if (rows.length >= maxRows) return []
      rows = rows.filter(candidate => candidate.source_dataset === sourceKeys.source_dataset
        && isDeepStrictEqual(jsonObject(candidate.source_keys), committedKeys))
      // Repeated commits to the same visible source resolve to one next hop.
      rows = rows.slice(0, 1)
    }
    if (rows.length !== 1) return []
    if (dataset === 'ai_gateway_messages') return rows
  }
  return []
}

/** @param {unknown} value @returns {Record<string, unknown> | null} */
function jsonObject(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return null }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null
}
