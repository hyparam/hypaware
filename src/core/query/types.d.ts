import type {
  HypAwareV2Config,
  PluginLogger,
  QueryRegistry,
  QueryScope,
} from '../../../hypaware-plugin-kernel-types.d.ts'
import type { ExtendedQueryStorageService } from '../cache/types.d.ts'
import type { UsageClass, UsagePolicyResolver } from '../usage-policy/types.d.ts'

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
  /**
   * The querying context's working directory: the terminal's cwd for the
   * CLI, the spawn directory for a stdio MCP host. Resolved through the
   * shared usage-policy resolver to the caller's class; rows whose own class
   * outranks it on the restrictiveness lattice are withheld (LLP 0105).
   * Absent or null means "no derivable caller", which fails closed: anything
   * above `full` is withheld (LLP 0105 #unknown).
   */
  callerCwd?: string | null
  /**
   * Informed-consent override (LLP 0105 #override): skip the visibility
   * filter entirely and return local-only rows regardless of the caller's
   * context. Surfaced as `--include-local-only` on the query verbs; also set
   * by kernel-internal cache-to-cache reads (projection, enumeration) whose
   * results never enter a transcript.
   */
  includeLocalOnly?: boolean
  /**
   * Test seam: the resolver consulted for both the caller's and each row's
   * class. Defaults to the same two-source resolver the export seam uses,
   * built beside `storage.cacheRoot`.
   */
  usagePolicyResolver?: UsagePolicyResolver
}

/**
 * What the LLP 0105 visibility filter did during one query: the caller's
 * resolved class, whether filtering was active, and counts (never content)
 * of what was withheld or suppressed, so callers can keep the never-silent
 * ethos. Counts reflect the rows actually scanned: a query the engine
 * terminates early (a satisfied LIMIT) reports what the scan observed.
 */
export interface LocalOnlyVisibilityReport {
  /** 'unknown' when no caller cwd was derivable (fail-closed). */
  callerClass: UsageClass | 'unknown'
  /** False when `includeLocalOnly` bypassed the filter or the caller's class sees everything. */
  filtered: boolean
  /** Rows dropped because their cwd's class outranks the caller's. */
  withheldRows: number
  /** Unprovenanced rows whose declared content columns were nulled. */
  suppressedRows: number
}

export interface ExecuteSqlResult {
  columns: string[]
  rows: Record<string, unknown>[]
  datasets: string[]
  freshnessMessages: string[]
  localOnly: LocalOnlyVisibilityReport
}
