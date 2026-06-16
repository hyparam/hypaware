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
  PluginActivationContext,
  PluginLogger,
  QueryRegistry,
  VectorSearchCapability,
} from '../../../../collectivus-plugin-kernel-types.d.ts'
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
  max_rows_per_tick: number
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
  expand_depth: number
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
 * Propose watermark cursor: a keyset tuple over the part-level source. `ts`
 * is the source timestamp as **epoch milliseconds** (the query engine surfaces
 * a TIMESTAMP column as a Date and only compares it correctly against a
 * numeric literal — string/`=` comparisons match nothing), `id` the row-unique
 * tiebreak. "Rows processed up to (ts, id)"; the next tick reads strictly past
 * it. The same-`ts` boundary is handled in JS, not SQL (see propose.js).
 */
export interface ProposeCursor {
  ts: number
  id: string
}

/** The persisted propose watermark sidecar (see state.js). */
export interface EnrichStateFile {
  schema_version: 2
  propose_cursor: ProposeCursor | null
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
