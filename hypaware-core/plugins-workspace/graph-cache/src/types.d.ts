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
  /** Adds a line by its SHA-256, for a caller that hashed it in pieces. */
  addHash(digest: Buffer): void
  readonly rows: number
  hex(): string
}

export interface MeasuredFile {
  facts: SnapshotFileFacts
  problems: string[]
  /** Why reading stopped early, when it did: a line passed `maxLineBytes`. */
  refused: 'line_too_large' | null
}

/** How `measureFile` and `verifyManifest` read untrusted files. */
export interface MeasureOptions {
  /** Longest line accepted, in decompressed bytes; reading stops past it. */
  maxLineBytes?: number
  signal?: AbortSignal
  /** A work-budget tick, called per line and per decompressed chunk. */
  tick?: (rows?: number) => Promise<void> | undefined
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
  /** Set when a file was refused before it was read to the end. */
  refused: 'line_too_large' | null
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
  /** The node id at each dense index (the same strings as `nodeIds`' keys). */
  nodeIdOf: string[]
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

  /** Lowercased basename to File node indexes (`--file` resolution). */
  fileByBasename: Map<string, number | number[]>
  /** `owner/repo` (lowercased, as keyed) to the File nodes keyed under it. */
  fileByRepo: Map<string, number | number[]>
  /** Last three segments of absolute-path File keys, lowercased. */
  fileBySuffix: Map<string, number | number[]>
  /** Path tokens (LLP 0488#path-tokens): token to id, and id to token. */
  tokenIds: Map<string, number>
  tokenNames: string[]
  /** Postings of token t: `tokenPostings[tokenOffsets[t] .. tokenOffsets[t + 1])`, each `node * 2 + (basename ? 1 : 0)`, ascending. */
  tokenOffsets: Uint32Array
  tokenPostings: Uint32Array
  /** Token ids in token order, for prefix lookup. */
  sortedTokenIds: Uint32Array
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
  /** Process-CPU clock in ms for the work budget (tests); `process.cpuUsage` by default. */
  cpuNow?: () => number
}

export type TermKind = 'path' | 'identifier' | 'word'

export interface Term {
  text: string
  kind: TermKind
}

export type AnchorMatch = 'exact' | 'absolute' | 'suffix' | 'basename' | 'stem' | 'token' | 'token_prefix'

export interface Anchor {
  node: number
  /** The File's node id, which `query team-graph neighbors` takes. */
  node_id: string
  key: string
  term: string
  match: AnchorMatch
  /** Identity is proven: an `owner/repo:path` key matched exactly or by name, never by suffix or absolute path. */
  proven: boolean
  /** Keyed under the caller's repository. */
  in_repo: boolean
}

export interface DiscoveryInput {
  /** The question terms are extracted from, unless `terms` is given. */
  question: string
  /** Explicit terms, used as written (no extraction); at most 12 are used. */
  terms?: string[]
  /** Leads to skip, for paging; `leads` is the page size. */
  offset?: number
  /** The caller's `owner/repo`, when known. */
  repo?: string | null
  /** The caller's repository root, to turn an absolute `--file` into a repository path. */
  repoRoot?: string | null
  files?: string[]
  leads?: number
  maxAnchors?: number
  maxVisits?: number
  /** Token postings examined at most (60,000 unless a test lowers it). */
  maxPostings?: number
}

export interface LeadReason {
  anchor: { type: 'File', node_id: string, key: string, match: AnchorMatch, proven: boolean, in_repo: boolean }
  term: string
  edge: string
  touched_at: string | null
}

export interface Lead {
  session_id: string
  /** The Session's node id, which `query team-graph neighbors` takes. */
  node_id: string
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
  /** Which slice of the ranked sessions `leads` is; `next_offset` is null on the last page. */
  page: { offset: number, limit: number, next_offset: number | null }
  coverage: {
    visits: number
    truncated: boolean
    anchors_truncated: number
    unresolved_edges_met: number
    sessions_considered: number
    /** Token postings examined to find term anchors (at most 60,000). */
    postings_examined: number
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
  /** Fingerprint of the credential that last renewed the lease (LLP 0483); never leaves the daemon. */
  credential_fp?: string | null
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
  | { ok: false, kind: 'unsupported' | 'credential' | 'network' | 'capacity', message: string, session: EvidenceSessionRecord }
  | { ok: false, kind: 'rpc', code: number, message: string, session: EvidenceSessionRecord }

/** The caller's resolved remote, org and login, sent with every warm request (LLP 0483, review r1 F1). */
export interface WarmScope {
  target: string
  origin: string
  org: string | null
  credential_fp: string | null
}

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
  /** Parts the server left out as too large to return (server LLP 0566); 0 when none. */
  skipped_parts: number
}

export type EvidenceFailureCode = 'invalid_request' | 'server_busy' | 'deadline' | 'transport' | 'freshness_unavailable' | 'entries_failed'

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
  /** Entries sent again alone after a no-part `partial` (server LLP 0565#client). */
  resends: number
}

/** The minimal MCP client surface the evidence client uses (createHttpMcpClient or the daemon's forwarder). */
export interface EvidenceMcpClient {
  callTool(name: string, args?: Record<string, unknown>, opts?: { maxBytes?: number }): Promise<any>
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

/** One message a no-anchor text search found (a `grep_search` hit, LLP 0480#discovery). */
export interface FastaskTextHit {
  session_id: string
  message_id: string | null
  part_id: string | null
  message_created_at: string | null
  /** The question term that matched. */
  term: string
  column: string | null
  snippet: string | null
}

/** The text search run when no term anchored in the graph (LLP 0480#discovery step 5). */
export interface FastaskTextSearch {
  /** Always "found by text search, not the graph". */
  label: string
  /** `grep_search` on the remote, or local grep. */
  path: 'grep_search' | 'local_grep'
  terms: string[]
  hits: FastaskTextHit[]
  /** A limit cut the hits; more matches exist. */
  truncated: boolean
  /** Why the search could not run or finish, else null. */
  error: string | null
}

/** The `fastask/1` JSON document (LLP 0480#output). */
export interface FastaskOutput {
  contract: 'fastask/1'
  question: string
  source: FastaskSource
  leads: FastaskOutputLead[]
  ambiguous: boolean
  followups: FastaskFollowup[]
  /** Set only when no term anchored in the graph. */
  text_search: FastaskTextSearch | null
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

// ---------------------------------------------------------------------------
// Agent-callable traversal (LLP 0487#decision): one hop from given nodes.
// ---------------------------------------------------------------------------

export type NeighborDirection = 'in' | 'out' | 'both'

export interface NeighborsInput {
  /** Start nodes by node id. */
  ids?: string[]
  /** Start nodes by natural key (a File key, a session id, `owner/repo`, ...). */
  keys?: string[]
  direction?: NeighborDirection
  /** Only these edge types; all when absent or empty. */
  edgeTypes?: string[]
  /** Neighbors to return. */
  limit?: number
  maxVisits?: number
}

export interface NeighborNode {
  node_id: string
  type: string
  /** Null for a placeholder: an endpoint the node file does not carry. */
  key: string | null
  label: string | null
  placeholder: boolean
  /** Session props, for a Session neighbor. */
  session?: SessionProps & { first_seen: string | null }
}

export interface Neighbor {
  /** The start node's id. */
  from: string
  direction: 'in' | 'out'
  edge_type: string
  first_seen: string | null
  exemplar: Exemplar | null
  node: NeighborNode
}

export interface NeighborsStart {
  /** What the caller passed. */
  input: string
  by: 'id' | 'key'
  found: boolean
  node_id: string | null
  type: string | null
  key: string | null
}

export interface NeighborsResult {
  starts: NeighborsStart[]
  neighbors: Neighbor[]
  coverage: {
    visits: number
    /** The visit budget ended the walk before every edge was read. */
    truncated: boolean
    /** More neighbors matched than `limit`. */
    results_truncated: boolean
    /** Neighbors that are placeholders (absent from the node file). */
    unresolved_met: number
    starts_dropped: number
  }
}

// ---------------------------------------------------------------------------
// Agent-callable text search inside candidate sessions (LLP 0487#decision).
// ---------------------------------------------------------------------------

export interface SearchHit {
  message_id: string | null
  part_id: string | null
  role: string | null
  message_created_at: string | null
  /** The given terms this part contains. */
  matched_terms: string[]
  /** Up to the per-hit cap of text around the first match. */
  excerpt: string
  text_truncated: boolean
  /** A `query evidence` entry for the conversation around this hit. */
  read: { session_id: string, from: string, to: string, order: 'asc' } | { session_id: string, message_ids: string[] }
}

export interface SearchSession {
  session_id: string
  hits: SearchHit[]
  /** More parts matched than the per-session hit budget. */
  truncated: boolean
  /** The query for this session failed; other sessions still answered. */
  error: string | null
}

export interface SearchResult {
  terms: string[]
  sessions: SearchSession[]
  coverage: { sessions_asked: number, sessions_dropped: number, terms_dropped: number, hits: number }
}

/** The parsed arguments shared by the three `query team-graph` commands. */
export interface TeamGraphArgs {
  positional: string[]
  remote: string | null
  org: string | null
  json: boolean
  lists: Record<string, string[]>
  values: Record<string, string>
  numbers: Record<string, number>
}

/** One generation's isolated warm index. Graph objects never cross IPC. */
export interface IndexProcess {
  pid: number
  bytes: number
  buildRss: number
  verification?: SnapshotVerification
  readonly alive: boolean
  /** JSON encoded result for the warm HTTP response; the daemon does not parse it. */
  discover(input: DiscoveryInput): Promise<string>
  neighbors(input: NeighborsInput): Promise<string>
  close(): Promise<void>
}

export interface DirectoryVerificationInput {
  dir: string
  manifest: any
  maxLineBytes: number
  signal?: AbortSignal
  budget?: { sliceMs?: number, sliceRows?: number, duty?: number }
}
