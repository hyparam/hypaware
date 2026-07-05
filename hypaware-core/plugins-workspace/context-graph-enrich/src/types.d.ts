/**
 * Plugin-local types for `@hypaware/context-graph-enrich`.
 *
 * The graph capability's surface is typed structurally here (a minimal
 * `GraphKit` / `ContextGraphCapabilityLike`) so this plugin does not import
 * from another plugin's sources — it depends on the capability by shape,
 * resolved at activation via `ctx.requireCapability`.
 */

import type {
  CompletionCapability,
  EmbedderCapability,
  PluginActivationContext,
  PluginLogger,
  QueryRegistry,
  VectorSearchCapability,
} from '../../../../hypaware-plugin-kernel-types.d.ts'
import type { ExtendedQueryStorageService } from '../../../../src/core/cache/types.d.ts'

export interface NodeSpec {
  type: string
  key: string
  label?: string | null
  props?: Record<string, unknown>
  firstSeen: unknown
  sourceKeys: Record<string, unknown>
}

export interface EdgeSpec {
  type: string
  srcType: string
  srcKey: string
  dstType: string
  dstKey: string
  firstSeen: unknown
  sourceKeys: Record<string, unknown>
}

export interface GraphKit {
  nodeId(type: string, naturalKey: string): string
  edgeId(srcId: string, type: string, dstId: string): string
  makeRowBuilders(meta: { sourceDataset: string, projector: string, projectorVersion: number }): {
    buildNode(spec: NodeSpec): Record<string, unknown>
    buildEdge(spec: EdgeSpec): Record<string, unknown>
  }
}

export interface ContractRuleLike {
  kind: 'node' | 'edge'
  type: string
  sql: string
  toRow(row: Record<string, unknown>): Record<string, unknown> | null
}

export interface ContractLike {
  name: string
  plugin: string
  sourceDataset: string
  projector: string
  projectorVersion: number
  rules: ContractRuleLike[]
}

export interface ContextGraphCapabilityLike {
  registerContract(contract: ContractLike): void
  kit: GraphKit
}

export interface ProposeConfig {
  enabled: boolean
  interval_minutes: number
  max_tick_ms: number
  /**
   * Bound how many settled sessions one ongoing tick extracts (the daemon
   * path). The batch/backfill paths process the whole eligible pool and ignore
   * this cap. @ref LLP 0028#two-regimes
   */
  max_sessions_per_tick: number
  /**
   * A session is "settled" once its latest source part is older than this many
   * minutes — the ongoing regime's selector. This is a run-time SQL/JS predicate
   * over the latest part, not a per-session idle timer. @ref LLP 0028#two-regimes
   */
  settle_cutoff_minutes: number
  t1_model: string
  max_candidates: number
  confidence_floor: number
}

export interface CurateConfig {
  enabled: boolean
  interval_minutes: number
  max_tick_ms: number
  max_prospects_per_tick: number
  t2_model: string
  salience_threshold: number
  recall_top_k: number
  /**
   * Min top-recall similarity for a prospect to be **recall-region** clustered
   * (curated against the committed region it hits) rather than treated as cold
   * and embedding-clustered. @ref LLP 0028#curate-clustering
   */
  recall_cluster_floor: number
  /**
   * Cosine-similarity threshold for greedily clustering the **no-recall**
   * remainder by their own embeddings, so near-duplicate proposals from
   * different sessions land in one curator call. @ref LLP 0028#curate-clustering
   */
  cluster_similarity: number
  /**
   * Upper bound on prospects per curator call — clusters are chunked to this
   * size so the decisions JSON stays inside the output-token budget.
   * @ref LLP 0028#curate-clustering
   */
  max_cluster_size: number
}

export interface EnrichConfig {
  source_dataset: string
  text_column: string
  timestamp_column: string
  id_column: string
  /** Per-row unique column; the propose watermark is (timestamp_column, this). */
  tiebreak_column: string
  anchor_type: string
  anchor_key_column: string
  /** Column naming the content kind (text / reasoning / tool_call / tool_result …). */
  part_type_column: string
  /** Part kinds dropped before the model scans them (default `['tool_result']`). */
  exclude_part_types: string[]
  /** Drop rows whose `text_column` is null/empty before scanning (default true). */
  require_text: boolean
  recall_index?: string
  propose: ProposeConfig
  curate: CurateConfig
}

/**
 * Per-session high-water mark: the latest source part a session has been
 * enriched through. `ts` is the source timestamp as **epoch milliseconds** (the
 * query engine surfaces a TIMESTAMP column as a Date), `id` the row-unique
 * tiebreak (`part_id`). A session re-qualifies for the ongoing regime when its
 * latest part is strictly past this tuple. @ref LLP 0028#per-session-watermark
 */
export interface SessionMark {
  ts: number
  id: string
}

/**
 * An in-flight curate batch job (submit-and-collect). The cluster→prospect
 * mapping is persisted so a later tick (ongoing) or a re-run (backfill) can route
 * the job's results without rebuilding clusters against a moved-on pending pool.
 *
 * `source` tags which driver owns the job, because both share this one sidecar
 * slot: the daemon's **ongoing** regime and the **backfill** command. Each driver
 * resumes/collects/clears only its own job and leaves the other's alone, so a
 * concurrent backfill and daemon-curate source never collect/clear or clobber
 * each other's batch. A legacy job persisted before this field existed is read as
 * `daemon` (the original owner). @ref LLP 0028#two-regimes
 */
export interface CurateJob {
  id: string
  submitted_at: string
  source: 'backfill' | 'daemon'
  clusters: Array<{ customId: string, prospectIds: string[] }>
}

/**
 * The persisted enrichment watermark sidecar (see state.js). Holds one
 * {@link SessionMark} per session keyed by its anchor key (session_id) — the
 * per-session model that **replaces** the single global keyset cursor — plus the
 * in-flight ongoing curate batch job, if any.
 * @ref LLP 0028#per-session-watermark
 */
export interface EnrichStateFile {
  schema_version: 4
  session_marks: Record<string, SessionMark>
  curate_job: CurateJob | null
}

/** One parsed T2 decision for a prospect, keyed by its 1-based `index`. */
export interface CurateDecision {
  index: number
  decision: string
  item_type?: string
  item_key?: string
  label?: string
  summary?: string
  confidence?: number
  merge_into?: string
  note?: string
}

export interface EnrichConfigError {
  pointer: string
  message: string
  errorKind: 'enrich_config_invalid'
}

export type EnrichConfigResult =
  | { ok: true, config: EnrichConfig }
  | { ok: false, errors: EnrichConfigError[] }

export interface EnrichRuntime {
  ctx: PluginActivationContext
  config: EnrichConfig
  /** Eagerly resolved at activation (context-graph is ordered first). */
  graph: ContextGraphCapabilityLike
  /**
   * vector-search + completion are resolved LAZILY (see runtime.js
   * getVector/getCompletion). The dependency resolver orders by
   * `requires.plugins`, not `requires.capabilities`, so their providers can
   * activate after this plugin — and the completion provider is swappable,
   * so it can't be named in `requires.plugins`. Resolving on first use
   * (tick/command time, after boot completes) sidesteps both.
   */
  _vector?: VectorSearchCapability
  _completion?: CompletionCapability
  /** Embedder, resolved lazily + best-effort for cold-remainder clustering (see runtime.getEmbedder). */
  _embedder?: EmbedderCapability
  storage: ExtendedQueryStorageService
  query: QueryRegistry
  log: PluginLogger
  stateDir: string
  /**
   * Test seam for {@link runSql}: when set, `runSql` calls this instead of the
   * real `executeQuerySql` over `query` + `storage`. Production leaves it
   * unset (mirrors the completion providers' injected `fetch` seam) so the
   * tick functions can be driven by a fake runtime in unit tests.
   */
  execSql?: (args: { query: string }) => Promise<{ rows: Record<string, unknown>[] }>
}
