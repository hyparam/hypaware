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

/**
 * Execution budget: ceilings on the in-memory state the engine's blocking
 * operators (`ORDER BY`, high-card `GROUP BY`, the scalar-aggregate slow
 * path, `COUNT(DISTINCT)`) may accumulate before refusing with a
 * `QueryBudgetExceededError`, whichever ceiling trips first. An undefined
 * ceiling (or an undefined budget entirely) is unbounded for that dimension.
 *
 * This bounds the intermediate buffer **during execution** and is a distinct
 * concept from `ContextControls` (`maxCell` / `maxBytes`), which bound
 * **display** bytes after the result already materialized: a query can be
 * cheap to display yet ruinous to execute (`COUNT(DISTINCT content_text)`
 * returns one number). The two caps compose; neither subsumes the other.
 * See LLP 0054 #execution-budget.
 */
export interface ExecutionBudget {
  /** Max rows (or, for hash/dedup structures, max distinct entries) a single buffering operator may hold before refusing. */
  maxBufferedRows?: number
  /** Max estimated bytes of buffered cell values a single buffering operator may hold before refusing. */
  maxBufferedBytes?: number
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
  /**
   * Execution budget bounding the buffered-row/buffered-byte state the
   * engine's blocking operators may accumulate in this run, whichever
   * ceiling trips first. When omitted, the kernel applies a conservative
   * default so an un-configured caller is still bounded; pass an explicit
   * budget to raise or (per-field) relax the ceiling. See LLP 0054
   * #execution-budget; distinct from the display-only `ContextControls`.
   */
  budget?: ExecutionBudget
}

export interface ExecuteSqlResult {
  columns: string[]
  rows: Record<string, unknown>[]
  datasets: string[]
  freshnessMessages: string[]
}
