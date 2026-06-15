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
  anchor_type: string
  anchor_key_column: string
  recall_index?: string
  propose: ProposeConfig
  curate: CurateConfig
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
}
