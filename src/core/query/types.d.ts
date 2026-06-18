import type {
  HypAwareV2Config,
  PluginLogger,
  QueryRegistry,
  QueryScope,
} from '../../../collectivus-plugin-kernel-types.d.ts'
import type { ExtendedQueryStorageService } from '../cache/types.d.ts'

export type QueryFormat = 'table' | 'json' | 'jsonl' | 'markdown'

export type RefreshMode = 'never' | 'auto' | 'always'

export interface QueryResultSet {
  columns: string[]
  rows: Record<string, unknown>[]
}

export interface ContextControls {
  /** Per-string-cell code-point cap; 0 disables cell truncation. */
  maxCell: number
  /** Cumulative serialized-row byte budget for stdout; 0 disables the row budget. */
  maxBytes: number
}

export interface ContextControlsResult {
  result: QueryResultSet
  /** One-line message for stderr when rows were dropped; undefined otherwise. */
  notice: string | undefined
}

export interface ExecuteSqlOptions {
  query: string
  registry: QueryRegistry
  storage: ExtendedQueryStorageService
  config?: HypAwareV2Config
  scope?: QueryScope
  refresh?: RefreshMode
  log?: PluginLogger
}

export interface ExecuteSqlResult {
  columns: string[]
  rows: Record<string, unknown>[]
  datasets: string[]
  freshnessMessages: string[]
}

/** The machine-local remote query target saved by `hyp query connect`. */
export interface RemoteTarget {
  /** Base URL of the central server's admin query endpoint host. */
  serverUrl: string
}

export interface RemoteQueryOptions {
  /** Base URL of the central server (scheme + host + optional port). */
  serverUrl: string
  /** Operator admin bearer token (from HYP_ADMIN_TOKEN / --token-file). */
  token: string
  /** SQL string to execute on the server. */
  query: string
  /** Injectable fetch, for tests. Defaults to the global `fetch`. */
  fetchFn?: typeof fetch
  /** External abort signal (e.g. Ctrl-C). Combined with the timeout. */
  signal?: AbortSignal
  /** Fail-fast timeout in ms. Defaults to 30s. */
  timeoutMs?: number
}

export type PingVerdict = 'connected' | 'unauthorized' | 'unreachable'

export interface PingResult {
  kind: PingVerdict
  /** True only for 'connected'. */
  ok: boolean
  /** Extra context for the failure (e.g. the connection error message). */
  detail?: string
}
