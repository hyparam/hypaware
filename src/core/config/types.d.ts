import type {
  HypAwareV2Config,
  PluginName,
  CapabilityName,
  ConfigRegistry,
  ValidationError,
} from '../../../collectivus-plugin-kernel-types.d.ts'

export interface LoadConfigSuccess {
  ok: true
  config: HypAwareV2Config
  configPath: string
}

export interface LoadConfigFailure {
  ok: false
  errorKind: ConfigLoadErrorKind
  message: string
  configPath: string
  errors?: ValidationError[]
}

export type LoadConfigResult = LoadConfigSuccess | LoadConfigFailure

export type ConfigLoadErrorKind =
  | 'config_missing'
  | 'config_unreadable'
  | 'config_invalid_json'
  | 'config_invalid_shape'

export type ConfigValidationErrorKind =
  | 'sink_pair_incompatible'
  | 'sink_writer_invalid'
  | 'sink_destination_invalid'
  | 'request_sink_invalid_keys'
  | 'sink_schedule_invalid'
  | 'sink_plugin_unknown'
  | 'sink_encoder_invalid'
  | 'dataset_unknown'
  | 'capability_ambiguous'
  | 'config_section_invalid'
  | 'plugin_unknown'
  | 'duplicate_plugin'

export type ConfigValidationError = ValidationError & { errorKind: ConfigValidationErrorKind }

/**
 * Phase 8 diagnostic kinds — internally inconsistent configurations
 * that are not catastrophic enough to fail `hyp config validate` but
 * which `hyp status` surfaces with concrete repair suggestions.
 *
 * - `client_without_gateway`: a client plugin (`@hypaware/claude` or
 *   `@hypaware/codex`) is enabled but `@hypaware/ai-gateway` is not.
 * - `gateway_missing_*_upstream`: a client plugin is enabled but the
 *   gateway config does not include one of its required upstream
 *   providers.
 * - `sink_missing_encoder`: a local-fs sink is configured but no
 *   encoder plugin (`@hypaware/format-parquet` /
 *   `@hypaware/format-jsonl`) is enabled.
 */
export type V1DiagnosticKind =
  | 'client_without_gateway'
  | `gateway_missing_${string}_upstream`
  | 'sink_missing_encoder'

export interface V1Diagnostic {
  kind: V1DiagnosticKind
  pointer: string
  message: string
  /** Suggested repair commands. */
  repair: string[]
}

export interface PluginMetadata {
  provides?: Partial<Record<CapabilityName, string>>
  requires?: Partial<Record<CapabilityName, string>>
}

export interface ValidateContext {
  knownPlugins?: Map<PluginName, PluginMetadata>
  knownDatasets?: Set<string>
  configRegistry?: ConfigRegistry
}

export interface ValidateResult {
  ok: boolean
  errors: ConfigValidationError[]
  pluginCount: number
  sinkCount: number
}
