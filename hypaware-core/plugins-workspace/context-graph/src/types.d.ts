// @ts-check

/** A materialized graph row (node or edge), keyed by column name. */
export type GraphRow = Record<string, unknown>

/**
 * A partition the dedup compaction refused to rewrite, with the reason:
 * `unreadable-cursor` (cursor.json missing/corrupt — never treat as a
 * synthetic default when about to retire a generation), `unexpected-layout`
 * (not the source-table layout graph tables use), or `concurrent-write`
 * (the cursor changed between scan and swap; retiring the old generation
 * would lose rows appended during the rewrite window).
 */
export interface SkippedPartition {
  path: string
  reason: 'unreadable-cursor' | 'unexpected-layout' | 'concurrent-write'
}

/** One T0 contract rule: a read-only SELECT plus a row mapper. */
export interface ContractRule {
  kind: 'node' | 'edge'
  type: string
  sql: string
  toRow(row: Record<string, unknown>): GraphRow | null
}

/** A node as the traversal reads it — graph identity plus display fields. */
export interface GraphNode {
  node_id: string
  node_type: string
  natural_key: string
  label: string | null
}

/** An edge as the traversal reads it — endpoints and relation type. */
export interface GraphEdge {
  src_id: string
  dst_id: string
  edge_type: string
}

/** Which way the walk follows the Session-rooted edges. */
export type Direction = 'out' | 'in' | 'both'

/** One reached node, tagged with how (and from where) the walk arrived. */
export interface Neighbor {
  hop: number
  edge_type: string
  direction: 'out' | 'in'
  from: string
  node: GraphNode
}

/** A successful traversal: resolved seed, reached neighbors in BFS order, honest totals. */
export interface TraversalOk {
  ok: true
  seed: GraphNode
  neighbors: Neighbor[]
  reachable: number
  truncated: boolean
  totalNodes: number
  totalEdges: number
}

/** A failed traversal: not-found, or ambiguity carrying the candidate nodes. */
export interface TraversalErr {
  ok: false
  error: string
  candidates?: GraphNode[]
}

/** Parsed `graph neighbors` argv: one positional seed plus flags. */
export interface ParsedNeighbors {
  seed: string
  depth: number
  type: string | undefined
  edgeTypes: string[]
  direction: Direction
  limit: number
  json: boolean
}
