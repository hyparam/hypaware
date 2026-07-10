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
  /** Caller-supplied cancellation; linked into the signal the engine and data sources observe. */
  signal?: AbortSignal
  /**
   * Execution memory budget: the query is refused (typed
   * QueryExecutionBudgetError) once its sampled process-heap growth exceeds
   * this many bytes. 0 disables the bound. Distinct from ContextControls,
   * which cap display/output bytes after materialization; this bounds the
   * execution itself. Defaults to the kernel ceiling (overridable with
   * HYP_QUERY_MAX_HEAP_MB).
   */
  maxHeapBytes?: number
}

export interface ExecuteSqlResult {
  columns: string[]
  rows: Record<string, unknown>[]
  datasets: string[]
  freshnessMessages: string[]
}
