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

/**
 * The per-node spec a contract's `toRow` hands the kit's `buildNode`. The
 * source supplies graph identity (`type` + natural `key`), optional display
 * (`label`, `props`), and provenance keys; the kit stamps id + provenance.
 */
export interface NodeSpec {
  type: string
  key: string
  label?: string | null
  props?: Record<string, unknown>
  firstSeen: unknown
  sourceKeys: Record<string, unknown>
}

/**
 * The per-edge spec a contract's `toRow` hands the kit's `buildEdge`: the two
 * endpoints (by type + natural key), the relation `type`, and provenance keys.
 */
export interface EdgeSpec {
  type: string
  srcType: string
  srcKey: string
  dstType: string
  dstKey: string
  firstSeen: unknown
  sourceKeys: Record<string, unknown>
}

/**
 * A projection contract contributed by a source plugin through the
 * `hypaware.context-graph` capability. Carries the source's rules plus the
 * provenance metadata the kit stamps onto every row it produces. The engine
 * runs every registered contract; the stable core lexicon and the id recipe
 * stay owned by the graph plugin (a contract maps *into* them, never forks them).
 */
export interface Contract {
  /** Stable identifier (kebab-case), unique within the owning plugin. */
  name: string
  /** Owning plugin (e.g. `@hypaware/ai-gateway-graph`). */
  plugin: string
  /** The source dataset this contract reads (e.g. `ai_gateway_messages`). */
  sourceDataset: string
  /** Projector id stamped into provenance (e.g. `ai-gateway.t0`). */
  projector: string
  /**
   * Projector version, stamped into every row's provenance — a marker for
   * which generation of this source's projector minted the row, not a
   * re-projection trigger. Ids are content-addressed (LLP 0023
   * §content-addressed-ids), so a bump alone rewrites nothing: committed rows
   * keep their old version and the pre-write dedup skips them. Re-deriving a
   * source after a logic change is a deliberate migration, not a side effect
   * of bumping this.
   */
  projectorVersion: number
  /** The node/edge rules the engine runs for this source. */
  rules: ContractRule[]
}

/** The in-plugin registry source plugins contribute contracts into. */
export interface ContractRegistry {
  register(contract: Contract): void
  list(): Contract[]
}

/**
 * The `hypaware.context-graph` capability value. `registerContract` lets a
 * source plugin (or a connector) contribute its contract; `kit` is the shared
 * id + provenance authoring kit a contract's rules build rows with.
 */
export interface ContextGraphCapability {
  registerContract(contract: Contract): void
  kit: {
    nodeId(type: string, naturalKey: string): string
    edgeId(srcId: string, type: string, dstId: string): string
    makeRowBuilders(meta: { sourceDataset: string; projector: string; projectorVersion: number }): {
      buildNode(spec: NodeSpec): GraphRow
      buildEdge(spec: EdgeSpec): GraphRow
    }
  }
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
