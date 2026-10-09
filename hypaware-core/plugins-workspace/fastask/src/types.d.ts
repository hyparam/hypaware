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
}
