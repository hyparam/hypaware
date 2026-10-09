// Types for the fastask plugin's port of the server's graph snapshot
// contract (`hypaware.graph-snapshot/1`, server LLP 0554#contract).

/** What a served data file measures as: the manifest's per-file facts. */
export interface SnapshotFileFacts {
  rows: number
  bytes: number
  uncompressed_bytes: number
  sha256: string
  set_digest: string
}

/** Compressed bytes as served: one buffer, or a stream of chunks. */
export type CompressedSource = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>

export interface SetDigest {
  add(line: string | Uint8Array): void
  readonly rows: number
  hex(): string
}

export interface MeasuredFile {
  facts: SnapshotFileFacts
  problems: string[]
}

export interface SnapshotFiles {
  manifest: any
  nodes: CompressedSource
  edges: CompressedSource
}

export interface SnapshotVerification {
  ok: boolean
  problems: string[]
  observed: Partial<Record<'nodes' | 'edges', SnapshotFileFacts>>
}

// ---------------------------------------------------------------------------
// The warm index (LLP 0480#index) and discovery over it (LLP 0480#discovery).
// ---------------------------------------------------------------------------

/** The Session props fastask shows; other props stay on disk. */
export interface SessionProps {
  cwd: string | null
  git_branch: string | null
  client_name: string | null
  user_id: string | null
}

/** An exemplar message an edge's `source_keys` carried. */
export interface Exemplar {
  message_id: string | null
  part_id: string | null
}

/** One graph row as parsed from a contract line, or handed over by a local loader. */
export interface GraphNodeRow {
  node_id?: unknown
  node_type?: unknown
  natural_key?: unknown
  label?: unknown
  props?: unknown
  first_seen?: unknown
}

export interface GraphEdgeRow {
  edge_type?: unknown
  src_id?: unknown
  dst_id?: unknown
  src_type?: unknown
  dst_type?: unknown
  first_seen?: unknown
  source_keys?: unknown
}

export interface IndexBuilderOptions {
  /** Refuse with `replica_too_large` once the running estimate passes this. */
  maxBytes?: number
  /** Row counts known up front (the manifest's), so arrays are sized once. */
  expectedNodes?: number
  expectedEdges?: number
}

/** Something that reports progress into a cooperative work budget. */
export interface WorkTicker {
  tick(rows?: number): Promise<void> | undefined
}

export interface IndexBuilder {
  addNode(row: GraphNodeRow): void
  addEdge(row: GraphEdgeRow): void
  /** The running estimate of resident bytes, including the build's own arrays. */
  readonly estimatedBytes: number
  finish(budget?: WorkTicker): Promise<GraphIndex>
}

/**
 * One generation's graph, compact and read-only once built. Node and edge
 * attributes live in parallel arrays indexed by a dense node index or edge
 * ordinal; adjacency is CSR in both directions over edge ordinals.
 */
export interface GraphIndex {
  nodeCount: number
  edgeCount: number
  /** Nodes minted for edge endpoints absent from the node file. */
  placeholderCount: number
  /** Edges with at least one placeholder endpoint. */
  unresolvedEdges: number
  /** Estimated resident bytes of this index. */
  bytes: number

  nodeIds: Map<string, number>
  /** Interned node type names; `nodeType[i]` indexes this. */
  nodeTypes: string[]
  nodeType: Uint8Array
  /** Bit 1: placeholder. */
  nodeFlags: Uint8Array
  naturalKey: Array<string | null>
  /** `null` when equal to the natural key. */
  label: Array<string | null>
  /** Milliseconds since the epoch, NaN when absent. */
  nodeFirstSeen: Float64Array
  sessionProps: Map<number, SessionProps>

  edgeTypes: string[]
  edgeType: Uint8Array
  edgeSrc: Uint32Array
  edgeDst: Uint32Array
  edgeFirstSeen: Float64Array
  exemplars: Map<number, Exemplar>

  /** `outEdges[outOffsets[i] .. outOffsets[i + 1])` are node i's outgoing edge ordinals, newest first. */
  outOffsets: Uint32Array
  outEdges: Uint32Array
  inOffsets: Uint32Array
  inEdges: Uint32Array

  /** Lowercased basename and stem to File node indexes. */
  fileByBasename: Map<string, number | number[]>
  fileByStem: Map<string, number | number[]>
  /** `owner/repo` (lowercased, as keyed) to the File nodes keyed under it. */
  fileByRepo: Map<string, number | number[]>
  /** Last three segments of absolute-path File keys, lowercased. */
  fileBySuffix: Map<string, number | number[]>
}

export interface SnapshotIndexInput {
  /** The verified manifest; its row counts size the arrays and gate the pre-check. */
  manifest?: any
  nodes: CompressedSource
  edges: CompressedSource
  signal?: AbortSignal
  /** Work-budget duty cycle: the daemon's default, or 1 on a command's cold path. */
  duty?: number
  maxBytes?: number
  now?: () => number
}

export type TermKind = 'path' | 'identifier' | 'word'

export interface Term {
  text: string
  kind: TermKind
}

export type AnchorMatch = 'exact' | 'absolute' | 'suffix' | 'basename' | 'stem'

export interface Anchor {
  node: number
  key: string
  term: string
  match: AnchorMatch
  /** Identity is proven: an `owner/repo:path` key matched exactly or by name, never by suffix or absolute path. */
  proven: boolean
  /** Keyed under the caller's repository. */
  in_repo: boolean
}

export interface DiscoveryInput {
  question: string
  /** The caller's `owner/repo`, when known. */
  repo?: string | null
  /** The caller's repository root, to turn an absolute `--file` into a repository path. */
  repoRoot?: string | null
  files?: string[]
  leads?: number
  maxAnchors?: number
  maxVisits?: number
}

export interface LeadReason {
  anchor: { type: 'File', key: string, match: AnchorMatch, proven: boolean, in_repo: boolean }
  term: string
  edge: string
  touched_at: string | null
}

export interface Lead {
  session_id: string
  rank: number
  score: number
  group: string
  why: LeadReason[]
  touched_at: string | null
  exemplar: Exemplar | null
  session: SessionProps & { first_seen: string | null }
}

export interface DiscoveryGroup {
  key: string
  term: string
  files: string[]
  sessions: number
}

export interface DiscoveryResult {
  terms: Term[]
  anchors: Anchor[]
  leads: Lead[]
  ambiguous: boolean
  groups: DiscoveryGroup[]
  /** No term or `--file` matched a File: the caller falls back to text search. */
  no_anchor: boolean
  coverage: {
    visits: number
    truncated: boolean
    anchors_truncated: number
    unresolved_edges_met: number
    sessions_considered: number
  }
}
