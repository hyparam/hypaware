import type {
  ColumnSpec, CommandRunContext, DatasetDataSourceContext, DatasetDiscoveryContext,
  DatasetRegistration, PluginActivationContext, PluginLogger, QueryPartition,
  QueryStorageService, ScannableDataSource, StartedSource,
} from '../../../../hypaware-plugin-kernel-types.js'

export type {
  ColumnSpec, CommandRunContext, DatasetDataSourceContext, DatasetDiscoveryContext,
  DatasetRegistration, PluginActivationContext, PluginLogger, QueryPartition,
  ScannableDataSource, StartedSource,
}

export interface LinearConfig {
  teams: string[]
  poll_interval: string
  token_env: string
  client_id: string
  redirect_uri: string
}

export interface LinearError extends Error { hypErrorKind: string }
export interface RequestOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  now?: () => number
}
export interface LoginOptions extends RequestOptions {
  clientId: string
  redirectUri: string
  onUrl: (url: string) => void | Promise<void>
  timeoutMs?: number
}
export interface LinearIdentity {
  user_id: string
  workspace_id: string
  workspace: string
}
export interface LinearAuth {
  generation: string
  status: 'pending' | 'active' | 'logged_out'
  client_id?: string
  access_token?: string
  refresh_token?: string
  expires_at?: number
  account?: LinearIdentity
}
export interface LinearTokens {
  access_token: string
  refresh_token: string
  expires_at: number
}
export interface LinearIssue {
  id: string
  identifier: string
  createdAt: string
  updatedAt: string
  team: { id: string; key: string }
  state: { id: string; type: string }
  assignee?: { id: string } | null
  creator?: { id: string } | null
}
export interface LinearAttachment {
  id: string
  url: string
  createdAt: string
  updatedAt: string
  issue: LinearIssue
}
export interface LinearPage {
  nodes: Array<LinearIssue | LinearAttachment>
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}
export interface LinearClient {
  identity(): Promise<LinearIdentity>
  page(stream: 'issues' | 'attachments', work: LinearWork, workspace: string): Promise<LinearPage>
}
export interface LinearWork {
  stream: 'issues' | 'attachments'
  since: string | null
  until: string
  after: string | null
}
export interface LinearCursor {
  version: 1
  generation: string
  scope: string
  since: string | null
  work: LinearWork | null
}
export interface GraphRule {
  kind: 'node' | 'edge'
  type: string
  columns: string[]
  where?: { eq: Record<string, string> }
  toRow(row: Record<string, unknown>): Record<string, unknown> | null
}
export interface GraphNode {
  type: string
  key: string
  label?: string | null
  firstSeen: unknown
  sourceKeys: Record<string, unknown>
}
export interface GraphEdge {
  type: string
  srcType: string
  srcKey: string
  dstType: string
  dstKey: string
  firstSeen: unknown
  sourceKeys: Record<string, unknown>
}
export interface GraphKit {
  makeRowBuilders(meta: { sourceDataset: string; projector: string; projectorVersion: number }): {
    buildNode(spec: GraphNode): Record<string, unknown>
    buildEdge(spec: GraphEdge): Record<string, unknown>
  }
}
export interface LinearGraph {
  kit: GraphKit
  registerContract(contract: unknown): void
  project(dataset: string): Promise<{ nodesWritten: number; edgesWritten: number }>
}
export interface LinearStorage extends QueryStorageService {
  dataSourceForTable(path: string): Promise<ScannableDataSource | null>
}
export interface LinearRuntime {
  config: LinearConfig
  stateDir: string
  env: NodeJS.ProcessEnv
  log: PluginLogger
  storage: LinearStorage
  graph: LinearGraph
  projectionNeeded?: boolean
  clientFactory?: (signal?: AbortSignal) => LinearClient
}
