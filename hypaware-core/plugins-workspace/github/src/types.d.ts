// Shared interfaces for the @hypaware/github plugin.
//
// Two kinds of types live here, kept apart deliberately:
//
//   1. Kernel types - re-exported from the host runtime's published
//      `hypaware-plugin-kernel-types.d.ts`. This file is the single place that
//      reaches the root kernel contract, so the rest of `src/` imports kernel
//      shapes from `./types.js`. The root-anchored path resolves from this
//      bundled source and from the generated declaration tree.
//
//   2. Capability + plugin-local types - declared here directly. Like
//      `@hypaware/ai-gateway-graph`, this plugin RE-DECLARES the
//      `hypaware.context-graph` capability shape rather than importing the
//      provider's internals: a contract author consumes only the kit's public
//      surface, so the id recipe + provenance columns stay owned by the graph
//      plugin (LLP 0023 §contract-contribution).

import type {
  AsyncDataSource,
  CachePartitionMeta,
  ColumnSpec,
  CommandRunContext,
  DatasetDataSourceContext,
  DatasetDiscoveryContext,
  DatasetRefreshResult,
  DatasetRegistration,
  HypError,
  JsonObject,
  PluginActivationContext,
  PluginLogger,
  QueryPartition,
  QueryStorageService,
  ScannableDataSource,
  SinkContinuation,
  SourceStatus,
  StartedSource,
  ValidationError,
  ValidationResult,
} from '../../../../hypaware-plugin-kernel-types.js'

export type {
  AsyncDataSource,
  CachePartitionMeta,
  ColumnSpec,
  CommandRunContext,
  DatasetDataSourceContext,
  DatasetDiscoveryContext,
  DatasetRefreshResult,
  DatasetRegistration,
  HypError,
  JsonObject,
  PluginActivationContext,
  PluginLogger,
  QueryPartition,
  QueryStorageService,
  ScannableDataSource,
  SinkContinuation,
  SourceStatus,
  StartedSource,
  ValidationError,
  ValidationResult,
}

// ---------------------------------------------------------------------------
// Storage: the extended cache surface the kernel hands plugins. `AsyncDataSource`
// is the kernel's own re-export of the `squirreling` type (so a dataset's
// `createDataSource` return matches `DatasetRegistration`); only the
// `dataSourceForTable` extension is added here.
// ---------------------------------------------------------------------------

/** `QueryStorageService` plus the `dataSourceForTable` extension used by datasets. */
export type ExtendedQueryStorageService = QueryStorageService & {
  dataSourceForTable(tablePath: string): Promise<ScannableDataSource | null>
}

// ---------------------------------------------------------------------------
// `hypaware.context-graph` capability shape (re-declared, not imported).
// ---------------------------------------------------------------------------

export type GraphRow = Record<string, unknown>

/** One T0 contract rule: a read-only SELECT plus a row mapper. */
export interface ContractRule {
  kind: 'node' | 'edge'
  type: string
  sql: string
  toRow(row: Record<string, unknown>): GraphRow | null
}

/** Per-node spec a `toRow` hands `buildNode` (identity + optional display + provenance keys). */
export interface NodeSpec {
  type: string
  key: string
  label?: string | null
  props?: Record<string, unknown>
  firstSeen: unknown
  sourceKeys: Record<string, unknown>
}

/** Per-edge spec a `toRow` hands `buildEdge` (endpoints + relation type + provenance keys). */
export interface EdgeSpec {
  type: string
  srcType: string
  srcKey: string
  dstType: string
  dstKey: string
  firstSeen: unknown
  sourceKeys: Record<string, unknown>
}

/** The row builders the kit hands a contract author (id recipe + provenance live in the graph plugin). */
export interface GraphRowBuilders {
  buildNode(spec: NodeSpec): GraphRow
  buildEdge(spec: EdgeSpec): GraphRow
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

/** The `hypaware.context-graph` capability value, as this plugin consumes it. */
export interface ContextGraphCapabilityLike {
  registerContract(contract: unknown): void
  kit: GraphKit
}

/** The contract object `registerContract` accepts. */
export interface GraphContract {
  name: string
  plugin: string
  sourceDataset: string
  projector: string
  projectorVersion: number
  rules: ContractRule[]
}

// ---------------------------------------------------------------------------
// Plugin-local config.
// ---------------------------------------------------------------------------

export interface GithubConfig {
  ignore: string[]
  poll_interval: string
  inventory: 'session_repos' | 'all_visible'
  token_env: string
}

export interface GithubConfigError {
  pointer: string
  message: string
  errorKind: 'github_config_invalid'
}

export type GithubConfigResult =
  | { ok: true; config: GithubConfig }
  | { ok: false; errors: GithubConfigError[] }

export interface ObservedReposIndex {
  list(): Promise<string[]>
}

export interface GithubRuntime {
  ctx: PluginActivationContext
  config: GithubConfig
  log: PluginLogger
  stateDir: string
  storage: ExtendedQueryStorageService
  env: NodeJS.ProcessEnv
  observedRepos: ObservedReposIndex
  /** Test seam; production defaults to the real fetch client. */
  clientFactory?: () => GithubClient
}

export interface LocalObservedRepoState {
  schema_version: 1
  repos: string[]
  partitions: Record<string, SinkContinuation>
  partition_versions: Record<string, string>
}

// ---------------------------------------------------------------------------
// Per-repo capture cursor (sidecar state - see LLP 0360 §cursoring).
// ---------------------------------------------------------------------------

/**
 * One repo's poll cursor: `since` high-water marks for the time-windowed
 * endpoints (issues/commits/comments) and an ETag map for the listing
 * endpoints that lack `since`. Shared by backfill + poll so a backfilled repo's
 * poller resumes past history rather than re-fetching it.
 */
export interface RepoCursor {
  since?: { issues?: string; commits?: string; comments?: string; pulls?: string }
  etag?: Record<string, string>
}

export interface CursorState {
  schema_version: number
  repos: Record<string, RepoCursor>
}

// ---------------------------------------------------------------------------
// GitHub API client surface (capture.js depends on this, not on `fetch`, so
// tests inject a fake).
// ---------------------------------------------------------------------------

/** A normalized GitHub actor (the `user`/`author` object subset we keep). */
export interface GithubActor {
  login: string
  type?: string
}

export interface GithubClient {
  /** Enumerate every repository visible to the authenticated local identity. */
  listViewerRepos(): Promise<string[]>
  /** Issues (state=all). PRs are filtered out by the caller via `isPullRequest`. */
  listIssues(owner: string, repo: string, cursor: RepoCursor): Promise<GithubIssue[]>
  listPullRequests(owner: string, repo: string, cursor: RepoCursor): Promise<GithubPull[]>
  listPullRequestFiles(owner: string, repo: string, number: number): Promise<string[]>
  listPullRequestReviews(owner: string, repo: string, number: number): Promise<GithubReview[]>
  listPullRequestCommits(owner: string, repo: string, number: number): Promise<GithubCommit[]>
  listCommits(owner: string, repo: string, cursor: RepoCursor): Promise<GithubCommit[]>
  listCommitFiles(owner: string, repo: string, sha: string): Promise<string[]>
  listIssueComments(owner: string, repo: string, cursor: RepoCursor): Promise<GithubComment[]>
}

export interface GithubIssue {
  number: number
  state?: string
  created_at?: string
  user?: GithubActor | null
  pull_request?: unknown
}

export interface GithubPull {
  number: number
  state?: string
  merged_at?: string | null
  draft?: boolean
  created_at?: string
  updated_at?: string
  user?: GithubActor | null
}

export interface GithubReview {
  id: number
  state?: string
  submitted_at?: string
  user?: GithubActor | null
}

export interface GithubCommit {
  sha: string
  author?: GithubActor | null
  commit?: { author?: { date?: string } | null } | null
}

export interface GithubComment {
  id: number
  created_at?: string
  user?: GithubActor | null
  /** `.../issues/{number}` - the subject the comment is attached to. */
  issue_url?: string
}
