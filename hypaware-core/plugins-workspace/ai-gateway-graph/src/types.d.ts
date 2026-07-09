// @ts-check

/** A materialized graph row (node or edge), keyed by column name. */
export type GraphRow = Record<string, unknown>

/** A declarative rule filter (LLP 0096): AND of eq / in / likePrefix, SQL null semantics. */
export interface RulePredicate {
  eq?: Record<string, string>
  in?: Record<string, string[]>
  likePrefix?: Record<string, string>
}

/**
 * One T0 contract rule: a source read plus a row mapper. Declarative
 * `columns` (+ optional `where`) joins the contract's shared scan; raw `sql`
 * runs standalone (LLP 0096). Exactly one of the two.
 */
export interface ContractRule {
  kind: 'node' | 'edge'
  type: string
  sql?: string
  columns?: string[]
  where?: RulePredicate
  toRow(row: Record<string, unknown>): GraphRow | null
}

/**
 * The per-node spec a contract's `toRow` hands `buildNode` (graph identity +
 * optional display + provenance keys). Mirrors `context-graph`'s `NodeSpec`
 * structurally — like the rest of this file, the connector re-declares the
 * capability's shape rather than importing the provider's internal types.
 */
export interface NodeSpec {
  type: string
  key: string
  label?: string | null
  props?: Record<string, unknown>
  firstSeen: unknown
  sourceKeys: Record<string, unknown>
}

/** The per-edge spec a contract's `toRow` hands `buildEdge` (endpoints + relation type + optional display props + provenance keys). */
export interface EdgeSpec {
  type: string
  srcType: string
  srcKey: string
  dstType: string
  dstKey: string
  props?: Record<string, unknown>
  firstSeen: unknown
  sourceKeys: Record<string, unknown>
}

/** The row builders the kit hands a contract author (id recipe + provenance live in the graph plugin). */
export interface GraphRowBuilders {
  buildNode(spec: NodeSpec): GraphRow
  buildEdge(spec: EdgeSpec): GraphRow
}

/**
 * The bridge-key vocabulary this connector owns (`./graph-keys.js`). The
 * `Repo`/`Commit`/`File` recipes are byte-identical to
 * `github-hyp-plugin/src/keys.js`; the remote-URL / absolute-path
 * reconciliation is host-only. A null return means "not bridgeable" (non-github
 * remote, abbreviated sha, path outside the repo) — the contract keeps its own
 * fallback key.
 */
export interface GraphKeys {
  repoKey(ownerOrFull: unknown, repo?: unknown): string | null
  repoKeyFromRemote(remote: unknown): string | null
  ownerRepoFromRemote(remote: unknown): string | null
  commitKey(sha: unknown): string | null
  fileKey(repoFull: unknown, relpath: unknown): string | null
  fileKeyFromParts(remote: unknown, repoRoot: unknown, absPath: unknown): string | null
  relativizePath(repoRoot: unknown, absPath: unknown): string | null
  normalizeRelpath(value: unknown): string | null
}

/** The generic authoring kit exposed on the `hypaware.context-graph` capability (type-blind; node-type recipes live in the connector). */
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
