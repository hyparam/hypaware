// @ts-check

import { isDeepStrictEqual } from 'node:util'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

import { executeQuerySql } from '../../../../src/core/query/sql.js'
import { Attr, markSpanStatus, withSpan } from '../../../../src/core/observability/index.js'

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
 * Walk the published datasets by frontier, not by loading the whole graph.
 * Labels and evidence are fetched only for the returned neighbors. The output
 * cap still leaves reachable exact: a walk exceeding the work budget refuses
 * rather than presenting a partial reachable count as complete.
 *
 * `callerCwd`/`includeLocalOnly` ride through to `executeQuerySql`, whose
 * shared LLP 0105 filter decides visibility: a restricted caller gets the
 * graph's structure with content columns (natural_key/label) suppressed, and
 * the traversal result carries the aggregate report so the verb can say so.
 *
 * @param {{ query: QueryRegistry, storage: ExtendedQueryStorageService, config?: HypAwareV2Config, seed: string, depth?: number, edgeTypes?: string[], direction?: Direction, limit?: number, type?: string, callerCwd?: string | null, includeLocalOnly?: boolean }} args
 * @returns {Promise<(TraversalOk | TraversalErr) & { localOnly: LocalOnlyVisibilityReport }>}
 * @ref LLP 0431#bounded-frontiers [implements]: query only each frontier, sharing row, payload and time budgets across the walk
 * @ref LLP 0105 [constrained-by]: hyp graph funnels through the same shared filter as hyp query; nothing is re-decided here
 */
export async function queryNeighbors({ query, storage, config, seed, depth = 1, edgeTypes = [], direction = 'both', limit = Infinity, type, callerCwd, includeLocalOnly }) {
  return withSpan('graph.neighbors', { [Attr.COMPONENT]: 'query', [Attr.OPERATION]: 'graph.neighbors', depth, direction, status: 'ok' }, async span => {
    const visibility = { callerCwd: callerCwd ?? null, includeLocalOnly: includeLocalOnly === true, signal: AbortSignal.timeout(5000) }
    const deadline = Date.now() + 5000
    const counts = { node: 0, edge: 0 }
    let payloadBytes = 0
    let queries = 0
    /** @type {Error | undefined} */
    let refusal
    /** @param {string} message @returns {never} */
    const refuse = message => {
      refusal = new Error(message)
      throw refusal
    }
    /** @type {LocalOnlyVisibilityReport} */
    const localOnly = { callerClass: 'unknown', filtered: false, withheldRows: 0, suppressedRows: 0 }
    const checkTime = () => {
      visibility.signal.throwIfAborted()
      // A warm in-memory source can keep the event loop busy beyond a timer's
      // deadline. Check elapsed time too, including while processing results.
      if (Date.now() >= deadline) throw new Error('graph traversal exceeded its five-second time budget')
    }
    /** @param {string} value */
    const quote = value => `'${value.replace(/'/g, "''")}'`
    /** @param {string[]} values */
    const literals = values => values.map(quote).join(', ')
    const nodeColumns = 'node_id, node_type, natural_key, label'

    /**
     * Count physical result rows, including duplicates and repeated reads,
     * cumulatively. LIMIT's extra row detects overflow; no partial success.
     * @param {'node' | 'edge'} dataset
     * @param {string} columns
     * @param {string} where
     * @param {number} [maxRows]
     */
    const read = async (dataset, columns, where, maxRows = 100_001 - counts[dataset]) => {
      await yieldToEventLoop()
      checkTime()
      queries++
      const result = await loadRows(query, storage, config,
        `SELECT ${columns} FROM ${dataset}${where ? ` WHERE ${where}` : ''} LIMIT ${maxRows}`, visibility)
      checkTime()
      localOnly.callerClass = result.localOnly.callerClass
      localOnly.filtered ||= result.localOnly.filtered
      localOnly.withheldRows += result.localOnly.withheldRows
      localOnly.suppressedRows += result.localOnly.suppressedRows
      counts[dataset] += result.rows.length
      if (counts[dataset] > 100_000) refuse('graph traversal exceeds the 100000-row read budget for its neighborhood; reduce depth or narrow --edge-type')
      // Budget retained payload across queries as well as the SQL engine's
      // per-query heap growth. Topology reads contain only scalar ids/types;
      // JSON evidence is fetched solely for neighbors actually returned.
      for (const row of result.rows) {
        checkTime()
        for (const key in row) {
          const value = row[key]
          payloadBytes += 16 + (typeof value === 'string' ? value.length * 2
            : value && typeof value === 'object' ? JSON.stringify(value).length * 2 : 0)
        }
        if (payloadBytes > 128 * 1024 * 1024) refuse('graph traversal exceeds its 128 MiB payload budget; reduce depth or limit')
      }
      return result.rows
    }

    try {
      let resolved = resolveSeed([], seed, type)
      // Preserve tier priority and identity folding, even before compaction.
      for (const field of ['node_id', 'natural_key', 'label']) {
        const rows = await read('node', nodeColumns, `${field} = ${quote(seed)}${type ? ` AND node_type = ${quote(type)}` : ''}`)
        const nodes = new Map()
        for (const row of rows) if (!nodes.has(String(row.node_id))) nodes.set(String(row.node_id), graphNode(row))
        resolved = resolveSeed([...nodes.values()], seed, type)
        if (resolved.ok || resolved.candidates) break
      }
      if (!resolved.ok) {
        // @ref LLP 0213#empty-is-shared [implements]: distinguish empty storage from a filtered or missing seed without loading the graph
        const exists = await read('node', 'node_id', '', 1)
        markSpanStatus(span, 'error')
        return { ...resolved, localOnly, ...(exists.length === 0 ? { graphEmpty: true } : {}) }
      }

      const visited = new Set([resolved.node.node_id])
      const seenEdges = new Set()
      /** @type {Neighbor[]} */
      const neighbors = []
      let frontier = [resolved.node.node_id]
      const edgeFilter = edgeTypes.length ? ` AND edge_type IN (${literals(edgeTypes)})` : ''
      for (let hop = 1; hop <= depth && frontier.length; hop++) {
        const next = []
        // Keep SQL predicates and temporary adjacency bounded even on broad
        // frontiers. Nodes at the final hop need no adjacency read at all.
        for (let offset = 0; offset < frontier.length; offset += 256) {
          const batch = frontier.slice(offset, offset + 256)
          const batchIds = new Set(batch)
          const ids = literals(batch)
          const endpoints = direction === 'out' ? `src_id IN (${ids})`
            : direction === 'in' ? `dst_id IN (${ids})` : `(src_id IN (${ids}) OR dst_id IN (${ids}))`
          const rows = await read('edge', 'edge_id, src_id, dst_id, edge_type', endpoints + edgeFilter)
          /** @type {Map<string, { to: string, direction: 'in' | 'out', row: Record<string, unknown> }[]>} */
          const adjacency = new Map()
          /** @param {string} from @param {string} to @param {'in' | 'out'} dir @param {Record<string, unknown>} row */
          const link = (from, to, dir, row) => {
            if (!batchIds.has(from)) return
            let edges = adjacency.get(from)
            if (!edges) adjacency.set(from, edges = [])
            edges.push({ to, direction: dir, row })
          }
          for (const row of rows) {
            checkTime()
            const src = String(row.src_id), dst = String(row.dst_id)
            seenEdges.add(`${src}\0${row.edge_type}\0${dst}`)
            if (direction !== 'in') link(src, dst, 'out', row)
            if (direction !== 'out') link(dst, src, 'in', row)
          }
          for (const from of batch) {
            for (const edge of adjacency.get(from) ?? []) {
              checkTime()
              if (visited.has(edge.to)) continue
              visited.add(edge.to)
              next.push(edge.to)
              if (neighbors.length < limit) neighbors.push({ hop, from, direction: edge.direction,
                edge_type: String(edge.row.edge_type),
                ...(edge.row.edge_id != null ? { edge_id: String(edge.row.edge_id) } : {}),
                node: { node_id: edge.to, node_type: '?', natural_key: edge.to, label: null } })
            }
          }
        }
        frontier = next
      }

      // Fetch content only for returned nodes/edges, through the same shared
      // visibility filter as seed resolution. Missing endpoints keep the
      // established dangling-node placeholder; discovery still follows ids.
      for (let offset = 0; offset < neighbors.length; offset += 256) {
        const batch = neighbors.slice(offset, offset + 256)
        const nodes = await read('node', nodeColumns, `node_id IN (${literals(batch.map(n => n.node.node_id))})`)
        const byId = new Map()
        for (const row of nodes) if (!byId.has(String(row.node_id))) byId.set(String(row.node_id), graphNode(row))
        const edgeIds = [...new Set(batch.flatMap(n => n.edge_id ? [n.edge_id] : []))]
        const edges = edgeIds.length ? await read('edge', 'edge_id, props, source_dataset, source_keys', `edge_id IN (${literals(edgeIds)})`) : []
        const evidence = new Map()
        for (const row of edges) if (!evidence.has(String(row.edge_id))) evidence.set(String(row.edge_id), row)
        for (const neighbor of batch) {
          neighbor.node = byId.get(neighbor.node.node_id) ?? neighbor.node
          const row = evidence.get(neighbor.edge_id)
          if (row) {
            neighbor.props = jsonObject(row.props)
            neighbor.source_dataset = String(row.source_dataset)
            neighbor.source_keys = jsonObject(row.source_keys)
          }
        }
      }
      checkTime()
      const reachable = visited.size - 1
      return { ok: /** @type {const} */ (true), seed: resolved.node, neighbors, reachable, truncated: reachable > neighbors.length,
        totalNodes: visited.size, totalEdges: seenEdges.size, localOnly }
    } catch (err) {
      markSpanStatus(span, 'error')
      if (refusal && err === refusal) return { ok: /** @type {const} */ (false), error: refusal.message, localOnly }
      throw err
    } finally {
      span.setAttribute('query_count', queries)
      span.setAttribute('node_rows', counts.node)
      span.setAttribute('edge_rows', counts.edge)
      span.setAttribute('payload_bytes', payloadBytes)
    }
  })
}

/** @param {Record<string, unknown>} row @returns {GraphNode} */
function graphNode(row) {
  return { node_id: String(row.node_id), node_type: String(row.node_type),
    natural_key: row.natural_key == null ? '' : String(row.natural_key),
    label: row.label == null ? null : String(row.label) }
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
