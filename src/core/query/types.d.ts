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

/**
 * The read seam the gateway overview runs through (LLP 0135 #first-look).
 * Production wiring is `overviewRunnerFromCtx`, which routes to
 * `executeQuerySql`; tests inject fixed rows.
 */
export interface OverviewQueryRunner {
  /** False when no plugin registered the dataset, so there is nothing to show. */
  hasDataset(name: string): boolean
  run(sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[] }>
  /**
   * True once the LLP 0105 filter withheld a row from any statement this
   * runner issued. An empty result then means "withheld", not "nothing
   * recorded" - two different sentences for the reader. Optional so test
   * runners need not implement it.
   */
  sawWithholding?(): boolean
}

/**
 * The period the overview's numbers describe, chosen by walking days
 * newest-first until the scan would exceed the row target. Always stated
 * in the rendered block: a total whose period is unstated is not an answer.
 */
export interface OverviewWindow {
  /** Inclusive `YYYY-MM-DD` bounds of the window actually queried. */
  since: string
  until: string
  /** Days included, and rows they hold. */
  days: number
  rows: number
  /** Days and rows available in the cache, whether or not included. */
  totalDays: number
  totalRows: number
  /** True when the cache holds more than the window covers. */
  narrowed: boolean
  /**
   * Which cap decided the window: `time` (the measured per-row rate from
   * the probe), `rows` (the memory backstop), or `requested` (`--days`).
   * Telemetry only - the rendered line reports the scope and the lever,
   * never the reason, because the reason is the tool's business.
   */
  boundBy: 'time' | 'rows' | 'requested'
}

/**
 * The overview's result sets, in display order. A section not requested
 * from `collectOverview` comes back empty, which renders as absent rather
 * than as an empty table. `window` and `sql` are absent only when nothing
 * has been recorded at all.
 */
export interface OverviewRows {
  providerRows: Record<string, unknown>[]
  dailyRows: Record<string, unknown>[]
  repoRows: Record<string, unknown>[]
  toolRows: Record<string, unknown>[]
  window?: OverviewWindow
  sql?: { models: string; daily: string; repos: string; tools: string }
  /**
   * The sections this run set out to fill, stamped by `collectOverview`
   * before it runs anything. It is what tells an empty section that was
   * never requested from one that did not finish, which is the difference
   * between the two sentences LLP 0135 #overrun insists on. Absent on a
   * result nobody collected into, where all four are assumed.
   */
  sections?: readonly ('models' | 'daily' | 'repos' | 'tools')[]
}

/**
 * Something the overview must say alongside its numbers, tagged by kind so
 * each caller can route it. `local-only` is required disclosure (LLP 0105);
 * `freshness` is advisory. `line` is preformatted and newline-terminated.
 */
export interface OverviewNotice {
  kind: 'local-only' | 'freshness'
  line: string
}

/**
 * How a select resolves a column reference to a declared TIMESTAMP, for the
 * LLP 0272 literal rewrite. `agreed` answers an unqualified reference (the
 * names every named base table in scope types the same way); `byRelation`
 * answers a qualified one, keyed by lower-cased table name and alias.
 * `bound` holds every relation this select binds including the ones whose
 * schema the registry cannot supply (a CTE, a derived table, a table
 * function), so a qualifier resolved through `outer` can be stopped here
 * rather than borrowing an enclosing relation's types.
 */
export interface TimestampScope {
  agreed: Set<string>
  byRelation: Map<string, Set<string>>
  bound: Set<string>
  /** The enclosing select's scope, for a correlated reference; absent at the top level. */
  outer?: TimestampScope
}
