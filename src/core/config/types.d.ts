import type {
  ConfigApplyErrorKind,
  ConfigControlFacade,
  ConfigStageResult,
  HypAwareV2Config,
  PluginConfigInstance,
  PluginName,
  CapabilityName,
  ConfigRegistry,
  ValidationError,
} from '../../../collectivus-plugin-kernel-types.d.ts'

/**
 * Outcome of the `init` overwrite guard (LLP 0031). `proceed` is true
 * when the write may continue; `backupPath` is set when an existing
 * local config was copied aside first. When `proceed` is false the
 * caller surfaces `message` and aborts (either a non-interactive refusal
 * or an interactive decline).
 */
export interface LocalConfigWriteGuard {
  proceed: boolean
  backupPath?: string
  message?: string
}

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

// =============================================================================
// Layered config merge (LLP 0031)
// =============================================================================

/**
 * Why a local-layer entry was dropped during the boot-time merge.
 *
 * - `collides_with_central` — the entry named a key the central layer
 *   already locks (caught by the structural key merge).
 * - `invalid_merge` — the entry is valid in isolation but makes the
 *   merged config invalid once layered onto the central document (e.g. a
 *   capability tie a local plugin introduces, an additive sink that
 *   references an unknown/incompatible plugin). `detail` carries the
 *   triggering `error_kind`.
 */
export type ConfigLayerDropReason = 'collides_with_central' | 'invalid_merge'

/** A local-layer entry dropped while merging central ⊕ local at boot. */
export interface ConfigLayerDrop {
  /** Section the dropped entry came from. */
  section: 'plugins' | 'sinks' | 'disambiguate'
  /** The entry's natural merge key (plugin name / sink instance / capability). */
  key: string
  reason: ConfigLayerDropReason
  /** For `invalid_merge`, the `error_kind` of the validation error the entry triggered. */
  detail?: string
}

/**
 * Result of merging the server-owned central (authoritative) layer with
 * the user-owned local (additive-only) layer. `effective` is what the
 * kernel boots; `drops` are the local entries that lost a collision with
 * a locked central key; `centralQueryIgnored` flags a `query` block in
 * the central document (query is structurally local-only).
 * @see LLP 0031 #merge-model
 */
export interface ConfigMergeResult {
  effective: HypAwareV2Config
  drops: ConfigLayerDrop[]
  centralQueryIgnored: boolean
}

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

// =============================================================================
// Config apply engine (LLP 0025)
// =============================================================================

/** Structured rollback reason recorded by the apply engine. */
export type ConfigRollbackReason =
  | 'validation_failed'
  | 'plugin_install_failed'
  | 'artifact_hash_mismatch'
  | 'bundled_version_mismatch'
  | 'probation_expired'

/** A/B slot identifier for persisted config documents. */
export type ConfigSlot = 'a' | 'b'

/**
 * Probation marker persisted before the staged restart and read back at
 * the next boot. `slot` is the slot the apply flipped to; rollback
 * flips to `previousSlot` (or back to the pre-apply regular file
 * content preserved in that slot).
 */
export interface ProbationMarker {
  /** ETag of the applied revision under probation. */
  etag: string
  applied_at: string
  /** ISO time after which an unconfirmed apply rolls back. */
  until: string
  slot: ConfigSlot
  previous_slot: ConfigSlot | null
}

export interface ConfigRollbackRecord {
  etag: string
  reason: ConfigRollbackReason
  at: string
  detail?: string
}

export interface RememberedBadEtag {
  etag: string
  reason: ConfigRollbackReason
  recorded_at: string
}

/**
 * Kernel-managed apply bookkeeping, persisted atomically as one file
 * under `<stateRoot>/config-control/state.json`.
 */
export interface ConfigControlState {
  probation?: ProbationMarker
  bad_etag?: RememberedBadEtag
  last_rollback?: ConfigRollbackRecord
}

/** Result of installing one pinned plugin entry during apply. */
export type PinnedInstallResult =
  | { ok: true }
  | { ok: false, errorKind: ConfigApplyErrorKind, message: string }

/**
 * Apply-time dependencies the daemon attaches once the kernel has
 * booted (the validator needs the plugin catalog; the installer needs
 * the bundled manifest set). Both are injectable so the engine state
 * machine is testable without HTTP, git, or a real kernel boot.
 */
export interface ConfigApplyDeps {
  /** Full document validation: shape + cross-plugin. */
  validateDocument(document: unknown): Promise<{ ok: boolean, errors: ValidationError[] }>
  /** Install every pinned plugin the config names; verify pins. */
  installPinnedPlugins(entries: PluginConfigInstance[]): Promise<PinnedInstallResult>
}

/** Public status surface for `hypaware status`. */
export interface ConfigControlStatus {
  probation: ProbationMarker | null
  lastRollback: ConfigRollbackRecord | null
  badEtag: RememberedBadEtag | null
  runningEtag: string | null
}

/**
 * Kernel-internal handle to the apply engine. The plugin-facing subset
 * is `ConfigControlFacade`; everything else is daemon-only.
 */
export interface ConfigControl extends ConfigControlFacade {
  /**
   * Evaluate probation state before plugin activation: recover a wedged
   * active slot whose etag is marked bad (#141), discard orphaned markers
   * (apply never committed), roll back expired ones (flips the operative
   * config in place; no restart needed since the kernel has not loaded it
   * yet). `rollback_no_target` reports an expired probation with no
   * distinct slot to roll back to; `recovered_bad_active` reports the
   * consistency guard firing, with `recovery` naming how it recovered.
   */
  evaluateAtBoot(): Promise<{
    action: 'none' | 'cleared_orphan' | 'rolled_back' | 'rollback_no_target' | 'recovered_bad_active'
    recovery?: 'seed' | 'repull'
  }>
  /** Attach post-boot apply dependencies; `stage()` fails before this. */
  attachApplyDeps(deps: ConfigApplyDeps): void
  /** Arm the in-process probation watchdog timer when a marker is active. */
  armProbationWatchdog(): void
  /** Cancel the watchdog timer (daemon shutdown). */
  disarmProbationWatchdog(): void
  status(): Promise<ConfigControlStatus>
}

export interface CreateConfigControlOptions {
  /**
   * Kernel state root (`<HYP_HOME>/hypaware`). The central-layer slots,
   * the active-slot pointer, the join seed, and the apply state all live
   * under `<stateRoot>/config-control/` (LLP 0031).
   */
  stateRoot: string
  /** Staged restart hook; the daemon exits with the restart code. */
  requestRestart(reason: string): void
  now?: () => number
}

export type { ConfigStageResult, ConfigApplyErrorKind }
