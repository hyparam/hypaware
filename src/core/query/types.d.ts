import type {
  HypAwareV2Config,
  PluginLogger,
  QueryRegistry,
  QueryScope,
} from '../../../hypaware-plugin-kernel-types.d.ts'
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
  /**
   * Caller-supplied abort signal. Composed with `timeoutMs` (if set) into the
   * single signal the engine reads via `context.signal`, so the caller can tear
   * down a long or runaway query mid-scan. Enabler only; bounds nothing on its
   * own (the execution budget is separate). See LLP 0054 #signal-threading.
   */
  signal?: AbortSignal
  /**
   * Optional execution deadline as a relative timeout in milliseconds. When set
   * and positive, an `AbortSignal.timeout(timeoutMs)` is composed with `signal`
   * to bound how long the engine may run before it is aborted.
   */
  timeoutMs?: number
}

export interface ExecuteSqlResult {
  columns: string[]
  rows: Record<string, unknown>[]
  datasets: string[]
  freshnessMessages: string[]
}
