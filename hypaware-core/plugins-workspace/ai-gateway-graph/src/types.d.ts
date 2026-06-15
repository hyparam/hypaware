// @ts-check

/** A materialized graph row (node or edge), keyed by column name. */
export type GraphRow = Record<string, unknown>

/** One T0 contract rule: a read-only SELECT plus a row mapper. */
export interface ContractRule {
  kind: 'node' | 'edge'
  type: string
  sql: string
  toRow(row: Record<string, unknown>): GraphRow | null
}

/** The row builders the kit hands a contract author (id recipe + provenance live in the graph plugin). */
export interface GraphRowBuilders {
  buildNode(spec: Record<string, unknown>): GraphRow
  buildEdge(spec: Record<string, unknown>): GraphRow
}

/** The shared authoring kit exposed on the `hypaware.context-graph` capability. */
export interface GraphKit {
  nodeId(type: string, naturalKey: string): string
  edgeId(srcId: string, type: string, dstId: string): string
  makeRowBuilders(meta: {
    sourceDataset: string
    projector: string
    projectorVersion: number
  }): GraphRowBuilders
}

/** The `hypaware.context-graph` capability value, as this connector consumes it. */
export interface ContextGraphCapability {
  registerContract(contract: unknown): void
  kit: GraphKit
}
