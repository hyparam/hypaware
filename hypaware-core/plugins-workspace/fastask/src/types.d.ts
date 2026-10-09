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
  /** Real (non-placeholder) nodes per entry of `nodeTypes`. */
  nodeTypeCounts: number[]
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
  /** Edges per entry of `edgeTypes`. */
  edgeTypeCounts: number[]
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

/** The generation has File nodes but none of the edge kind discovery walks (LLP 0484#edge-kinds). */
export interface VocabularyMismatch {
  error_kind: 'vocabulary_mismatch'
  /** The edge types the generation does carry, with their counts. */
  edge_types: Record<string, number>
}

export interface DiscoveryResult {
  terms: Term[]
  anchors: Anchor[]
  leads: Lead[]
  ambiguous: boolean
  groups: DiscoveryGroup[]
  /** No term or `--file` matched a File: the caller falls back to text search. */
  no_anchor: boolean
  /** The graph cannot answer: the caller uses the `team_server` source with this reason. */
  fallback: { reason: 'vocabulary_mismatch', edge_types: Record<string, number> } | null
  coverage: {
    visits: number
    truncated: boolean
    anchors_truncated: number
    unresolved_edges_met: number
    sessions_considered: number
  }
}

/**
 * The six replica states (LLP 0480#sync), plus the rows of the status a
 * caller reads. `servable` says whether discovery may use the active
 * generation right now: present, within lease, not withdrawn.
 */
export type ReplicaState = 'synced' | 'stale' | 'expired' | 'withdrawn' | 'unsupported' | 'unavailable'

/** The default remote a replica belongs to, resolved fresh each pass. */
export interface ReplicaTarget {
  /** The remote target name (`query.remotes` key). */
  target: string
  /** The registered target URL (a base, or a full `/v1/mcp` URL). */
  url: string
  /** The org on the login, when the credential records one (oidc); null for static or env tokens. */
  org: string | null
  /** A bearer for the target; `forceRefresh` is the one retry after a 401. */
  token(forceRefresh?: boolean): Promise<ResolvedBearer>
}

export type ResolvedBearer =
  | { ok: true, token: string, source?: 'env' | 'file', kind?: 'static' | 'oidc' }
  | { ok: false, error: string }

/** `replica.json`: what this machine holds for one (origin, org). */
export interface ReplicaRecord {
  format: 1
  key: string
  target: string
  origin: string
  /** Org from the login, else from the last manifest. */
  org: string | null
  /** Active generation, or null when nothing is held (never downloaded, withdrawn, expired). */
  generation: string | null
  state: ReplicaState
  reason: string | null
  /** From the last activated manifest; kept after the files are deleted so status can still say how old the data was. */
  watermark: string | null
  watermark_kind: string | null
  published_at: string | null
  rows: { nodes: number, edges: number } | null
  /** Lease length the server last announced (header, else manifest), in seconds. */
  lease_seconds: number | null
  lease_expires_at: string | null
  poll: { interval_seconds: number, jitter_seconds: number } | null
  /** Static or env tokens only: first 16 hex of SHA-256 of the bearer last answered for, never the token. */
  credential_fp: string | null
  last_check: string | null
  last_success: string | null
  last_error: { code: string, status: number | null, at: string } | null
}

export interface ReplicaStatus {
  state: ReplicaState
  reason: string | null
  servable: boolean
  target: string | null
  origin: string | null
  org: string | null
  generation: string | null
  watermark: string | null
  watermark_age_s: number | null
  published_at: string | null
  last_check: string | null
  last_success: string | null
  lease_expires_at: string | null
  bytes_on_disk: number
  rows: { nodes: number, edges: number } | null
  refresh_in_progress: boolean
  /** Path of the active generation's directory, when servable. */
  generation_dir: string | null
}

/** One pass's outcome: the status after it and when the next pass is due. */
export interface ReplicaPassResult {
  status: ReplicaStatus
  delayMs: number
}

/** What the server said to a manifest check (server LLP 0554#responses). */
export type SnapshotAnswer =
  | { kind: 'not_modified', leaseSeconds: number | null }
  | { kind: 'manifest', manifest: any, leaseSeconds: number | null }
  | { kind: 'refused', status: number, code: string | null, retryAfterSeconds: number | undefined }
  | { kind: 'credential', error: string }
  | { kind: 'network', error: string }

export type DownloadOutcome =
  | { ok: true, bytes: number, sha256: string }
  | { ok: false, code: string, status: number | null, retryAfterSeconds?: number }

/** Hooks the daemon wiring (LLP 0481 T8) fills in; all optional. */
export interface ReplicaSyncHooks {
  /** Runs on the verified staging directory before it becomes active; a throw keeps the old generation. */
  beforeActivate?(stagedDir: string, manifest: any): Promise<void>
  /** Runs once the new generation is active, before the old one is deleted. */
  afterActivate?(generationDir: string, manifest: any): Promise<void>
  /** Runs after replica files were deleted, with the reason. */
  onDelete?(reason: string): Promise<void> | void
  /** Runs after every pass with the status it ended in, inside the coalesced pass. */
  afterPass?(status: ReplicaStatus): Promise<void> | void
}

// ---------------------------------------------------------------------------
// The daemon source (LLP 0481 T8): warm evidence forwarding and control routes.
// ---------------------------------------------------------------------------

/** What the daemon knows about one remote's MCP session, as status shows it. */
export interface EvidenceSessionRecord {
  endpoint: string
  /** `'present'` while a session id is held; the id itself is not shown. */
  session_id: string | null
  server_version: string | null
  /** Whether `tools/list` offered `session_evidence` with the v1 contract; null before the first handshake. */
  supports_evidence: boolean | null
  contracts: string[]
  /** The server refused session reuse, so every call initializes first. */
  per_call: boolean
  initializes: number
  /** The last call's round trip minus the server's own `elapsed_ms`. */
  last_round_trip_ms: number | null
}

export type EvidenceForwardResult =
  | { ok: true, result: any, round_trip_ms: number, reused: boolean, session: EvidenceSessionRecord }
  | { ok: false, kind: 'unsupported' | 'credential' | 'network', message: string, session: EvidenceSessionRecord }
  | { ok: false, kind: 'rpc', code: number, message: string, session: EvidenceSessionRecord }

/** One `sessions` entry of a session_evidence request, before JSON encoding (server LLP 0557). */
export interface EvidenceEntry {
  session_id: string
  from?: string
  to?: string
  message_ids?: string[]
  order: 'asc' | 'desc'
  max_parts: number
  cursor?: string
}

/** A planned entry and the lead it serves. */
export interface PlannedEntry {
  lead: number
  kind: 'window' | 'message'
  entry: EvidenceEntry
}

/** One part as fastask keeps it: the fields its output shows. */
export interface EvidencePart {
  message_id: string
  part_id: string
  role: string
  message_created_at: string | null
  content_text: string | null
  text_truncated: boolean
}

export type EvidenceStatus = 'ok' | 'partial' | 'deadline' | 'not_found' | 'invalid_cursor' | 'error' | 'not_requested'

/** A lead's evidence after its entries are merged. */
export interface LeadEvidence {
  status: EvidenceStatus
  parts: EvidencePart[]
  /** The entry to send again for the next page, with its cursor; null when complete. */
  continuation: EvidenceEntry | null
  /** Human note for the status, e.g. the not_found wording. */
  note: string | null
}

export type EvidenceFailureCode = 'invalid_request' | 'server_busy' | 'deadline' | 'transport'

export interface EvidenceResult {
  /** How the evidence was read: the verb, or per-session query_sql on a server without it. */
  path: 'session_evidence' | 'query_sql'
  /** "server without evidence index support" on the fallback path, else null. */
  label: string | null
  leads: LeadEvidence[]
  /** Every lead read in full (no partial, deadline or error). */
  complete: boolean
  deadline_reached: boolean
  received_through: string | null
  read_path: string | null
  /** A whole-request failure; leads then carry no parts. */
  failure: { code: EvidenceFailureCode, message: string } | null
  /** Capacity retries spent (at most one). */
  retries: number
}

/** The minimal MCP client surface the evidence client uses (createHttpMcpClient or the daemon's forwarder). */
export interface EvidenceMcpClient {
  callTool(name: string, args?: Record<string, unknown>): Promise<any>
}

export interface FastaskTimings {
  load: number
  connect: number
  discovery: number
  evidence: number
  total: number
}

export interface FastaskSource {
  kind: 'team_replica' | 'team_server' | 'local'
  path: 'warm' | 'cold' | 'team_server' | 'local'
  remote: string | null
  org: string | null
  generation: string | null
  watermark: string | null
  watermark_age_s: number | null
  replica_state: string | null
  note: string | null
}

export interface FastaskOutputLead {
  session_id: string
  rank: number
  group: string
  why: Array<{ anchor: { type: 'File', key: string, match: string, proven: boolean }, edge: string, touched_at: string | null }>
  session: SessionProps & { first_seen: string | null }
  evidence: (Omit<LeadEvidence, 'continuation'> & { continuation: string | null }) | null
}

export interface FastaskFollowup {
  why: string
  command: string
}

/** The `fastask/1` JSON document (LLP 0480#output). */
export interface FastaskOutput {
  contract: 'fastask/1'
  question: string
  source: FastaskSource
  leads: FastaskOutputLead[]
  ambiguous: boolean
  followups: FastaskFollowup[]
  coverage: {
    graph_visits: number
    graph_truncated: boolean
    unresolved_edges_met: number
    evidence_received_through: string | null
    evidence_read_path: string | null
    evidence_path: 'session_evidence' | 'query_sql' | null
    evidence_label: string | null
    evidence_failure: { code: EvidenceFailureCode, message: string } | null
    partial: boolean
  }
  timings_ms: FastaskTimings
}
