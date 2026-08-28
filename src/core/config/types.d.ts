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
  BackfillRegistry,
  PluginLogger,
  JsonObject,
  ClientRegistry,
  AgentRegistry,
  SkillRegistry,
} from '../../../hypaware-plugin-kernel-types.d.ts'
import type { ClientDescriptor } from '../../../src/core/types.d.ts'

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
 * - `collides_with_central`: the entry named a key the central layer
 *   already locks (caught by the structural key merge).
 * - `invalid_merge`: the entry is valid in isolation but makes the
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
 * Phase 8 diagnostic kinds: internally inconsistent configurations
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
  /**
   * Confirmation-edge hook, fired by `confirmPoll()` exactly once on the
   * probation active→cleared transition (never on a no-probation poll).
   * `etag` is the revision whose probation just cleared. The daemon wires
   * this to schedule an action-reconciler pass; `apply.js` stays ignorant
   * of the reconciler and only emits the edge event (LLP 0041). Optional:
   * a plain CLI boot leaves it unset and the edge is a no-op.
   */
  onConfirmed?: (etag: string) => void
  now?: () => number
}

// =============================================================================
// Client-action reconciler (LLP 0036 / LLP 0041)
// =============================================================================

/**
 * Recorded state of a single reconciled action, persisted in
 * `config-control/client-actions.json`.
 *
 * - `done`: run-once terminal state; the action is never auto-run again
 *   (the marker is what makes every subsequent boot cheap). See LLP 0036
 *   §Idempotency.
 * - `failed`: not terminal; the next reconcile pass retries it.
 * - `refused`: terminal, but not the same short-circuit rule as `done` -
 *   the forward-gap loop skips it unconditionally, with no `markerIsCurrent()`
 *   consultation. Only an explicit `hyp attach` re-run clears it (LLP 0186).
 * - `applied`: current applied state of a reconciled/reversible handler
 *   (attach, future); `reverse()` runs on leave when the config stops
 *   naming the effect.
 */
export type ActionMarkerStatus = 'done' | 'failed' | 'refused' | 'applied'

/**
 * One persisted action marker, namespaced by handler `kind` then keyed by
 * `request_key` inside `config-control/client-actions.json`. The key is a
 * structured object (not a bare boolean) so a later refinement can add a
 * high-water input without a format break (LLP 0036 §request-key,
 * LLP 0041 §Idempotency-and-completion-state). Handlers may attach extra
 * fields via `ActionOutcome.detail`.
 *
 * A `refused` marker (LLP 0186) reuses `at` (the terminal-state time, the
 * same way `done` uses it) and `reason` (the same way `failed` uses it); it
 * carries no `attempts`, since a refusal is never re-`perform()`ed. Any
 * `installed_assets` carried from a prior marker at the same request key is
 * preserved across the rewrite to `refused`, the same way the `done` and
 * `failed` branches already preserve it.
 */
export interface ActionMarker {
  status: ActionMarkerStatus
  /** The reconciled unit's request key (echoed for self-describing files). */
  request_key: string
  /** ISO time the action reached `done`. */
  at?: string
  /** Rows written by a run-once import (recorded on `done`). */
  rows?: number
  /** Human-readable failure reason (recorded on `failed`). */
  reason?: string
  /** ISO time of the most recent attempt (recorded on `failed`). */
  last_attempt?: string
  /** Attempts so far; bumped each `failed` pass (recorded on `failed`). */
  attempts?: number
  /**
   * The gateway base URL an attach was applied at (recorded on a `done` attach
   * marker via `ActionOutcome.detail`). A later pass compares it against the
   * live endpoint through {@link ActionHandler.isCurrent} so a rebind to a new
   * ephemeral port re-attaches instead of short-circuiting on `done`
   * (issue #277 / LLP 0086). Absent on non-attach markers and on pre-LLP-0086
   * attach markers (treated as stale → re-attach once).
   */
  endpoint?: string
  /**
   * Absolute paths of the skills and subagents this org-driven attach copied
   * into the client's directories (recorded on a `done` attach marker). It is
   * the undo record `reverse()` replays on leave: exactly these paths are
   * removed, so a user's own `hyp skills install` copies - which record no
   * marker - survive (LLP 0107 §reversal, LLP 0138).
   */
  installed_assets?: string[]
  /**
   * Digest of the client asset set this attach installed (recorded on a `done`
   * attach marker). The freshness key beside `endpoint`: a later pass compares
   * it against what the live registries would contribute now, so a plugin the
   * org adds months after enrollment re-materializes even though the gateway
   * endpoint never moved (LLP 0107 §currency). Absent on pre-LLP-0138 attach
   * markers (treated as stale → re-attach once, which records one).
   */
  assets_key?: string
  /**
   * The attach mode the adapter reported (recorded on a `done` attach marker
   * from its `--json` payload). The third freshness key beside `endpoint` and
   * `assets_key`, and the only one that can see a `claude` machine still
   * carrying a proxy attach: it sits at the same gateway endpoint with the
   * same asset set, so re-performing on a mode other than `otel` is what
   * migrates it (LLP 0262 §Migration). Absent on pre-LLP-0262 attach markers
   * and on markers whose adapter payload did not parse.
   */
  mode?: string
  /**
   * `true` when an earlier pass at this request key reached `done`, i.e. the
   * handler applied an effect that is still on disk. Recorded only on a
   * `failed`/`refused` marker rewritten over such a pass; a `done` marker says
   * the same thing with its `status`.
   *
   * `installed_assets` is the same evidence for the half of an attach that
   * copies files, and it is the only half a client whose attach writes settings
   * and copies nothing ever produces. Without this bit such a rewrite was
   * indistinguishable from a terminal marker whose attach never applied
   * anything, and the reconciler's reverse gap dropped it, stranding the
   * settings write with nothing naming it (LLP 0250, extending LLP 0138
   * §marker-undo and LLP 0186). Absent on pre-LLP-0250 markers, which read as
   * "no prior done" and keep master's behaviour.
   */
  prior_done?: boolean
  /** Handler-specific extra fields merged from `ActionOutcome.detail`. */
  [extra: string]: unknown
}

/**
 * Persisted marker store: the whole `client-actions.json` document,
 * namespaced by handler `kind` (e.g. `backfill`) then keyed by request key
 * (e.g. the owning plugin name).
 */
export type ActionMarkerStore = Record<string, Record<string, ActionMarker>>

/**
 * A unit the reconciler should converge, emitted by `ActionHandler.desired()`.
 * `params` is handler-specific and not persisted: it is passed straight to
 * `perform()` (e.g. backfill carries `{ plugin, windowDays }`).
 */
export interface DesiredAction {
  requestKey: string
  params?: Record<string, unknown>
}

/**
 * Result of an `ActionHandler.perform()` / `reverse()` call. The reconciler
 * turns this into the persisted {@link ActionMarker} (adding timestamps and
 * the attempt counter); `detail` is merged onto the marker verbatim.
 */
export interface ActionOutcome {
  /**
   * `done` = the effect applied/reversed cleanly; `failed` = retry next
   * pass; `refused` = a permanent precondition failure only the user can
   * fix, never retried until an explicit `hyp attach` re-run (LLP 0186).
   */
  status: 'done' | 'failed' | 'refused'
  /** Rows written (run-once import); recorded on the `done` marker. */
  rows?: number
  /** Failure reason; recorded on the `failed` marker. */
  reason?: string
  /** Extra handler-specific fields merged into the persisted marker. */
  detail?: JsonObject
}

/**
 * A thrown Error marked as a permanent refusal by `markActionRefused`
 * (`src/core/config/action_refusal.js`), so it survives the kernel's
 * throw-only `attach(): Promise<void>` seam and `action_attach.js`'s
 * `perform()` catch can tell it apart from an environmental failure that
 * might succeed on retry. `isActionRefused` reads the marker back
 * defensively (LLP 0186).
 */
export interface ActionRefusalError extends Error {
  hypActionRefused: true
}

/**
 * Context handed to every handler hook on each pass. It is the
 * {@link ReconcileInput} (effective config + kernel registries) augmented
 * with the reconciler's injected clock and logger so a handler need not
 * close over them itself.
 */
export interface ActionContext {
  /** Effective (merged) config the daemon booted (LLP 0031). */
  config: HypAwareV2Config
  /** Kernel backfill registry: `list()` yields enabled-or-not providers. */
  backfills: BackfillRegistry
  /**
   * The daemon's resolved environment, threaded down to any spawned child
   * (notably `hyp backfill`). The daemon forces `HYP_HOME=hypHome` so the
   * child imports into the *same* cache the daemon resolved, not whatever
   * `process.env.HYP_HOME` happened to be (LLP 0041 §Run-once flow step 2).
   */
  env: NodeJS.ProcessEnv
  /**
   * Static client→plugin map (`clientName -> { plugin, name, attachProbe? }`)
   * derived from manifests by `buildPluginCatalog`. The attach handler
   * enumerates `desired()` off this map: the runtime `clients` registry
   * carries no owning-plugin field, so descriptors are the source of truth
   * for "is this client's plugin enabled?" and hand the disk-driven undo the
   * `attachProbe` it replays from (LLP 0045 §Part 1, §Part 3). Daemon-only:
   * a plain CLI boot leaves it unset and any client handler stays inert.
   */
  clientDescriptors?: Map<string, ClientDescriptor>
  /**
   * Runtime client registry used to invoke attach effects. Gateway-backed and
   * endpoint-free adapters share it; `desired()` still guards on
   * `getClient(name)` before naming an action (LLP 0045 §Part 1).
   */
  clients?: ClientRegistry
  /**
   * Kernel skill / subagent registries, threaded so an org-driven attach
   * materializes the same client assets a manual attach does rather than
   * leaving an enrolled machine with capture but no helpers
   * (LLP 0107 §every-attach). Daemon-only, like the rest of the client seam.
   */
  skills?: SkillRegistry
  agents?: AgentRegistry
  /**
   * Plugins the daemon's boot failed to activate. The attach handler threads it
   * to the client-asset materializer, which then copies but prunes nothing: a
   * partial activation leaves the failed plugin's assets missing from the plan
   * in exactly the way a retired asset is
   * (LLP 0219 #incomplete-activation-prunes-nothing).
   */
  failedPlugins?: string[]
  /**
   * The local gateway base URL clients attach to, resolved from
   * `gateway.localEndpoint()` with the configured-`listen` fallback the CLI
   * uses. Set whenever `clients` is (LLP 0045 §Part 1).
   */
  endpoint?: string
  /** Injectable clock (test seam). */
  now: () => number
  log: PluginLogger
}

/**
 * A registered detect / perform / (optional) reverse triple: the unit the
 * reconciler drives. The reconciler is generic: it knows nothing about
 * Claude vs Codex, only this interface (LLP 0036 §Options-3, LLP 0041).
 */
export interface ActionHandler {
  /** Marker namespace + status section key (e.g. `backfill`). */
  kind: string
  /**
   * Enumerate the units this handler wants reconciled, given the effective
   * config + registries. Pure: no effects.
   */
  desired(ctx: ActionContext): DesiredAction[]
  /** Run the effect for one desired action (subprocess or in-proc). */
  perform(action: DesiredAction, ctx: ActionContext): Promise<ActionOutcome>
  /**
   * Undo a previously-applied effect whose request key the config no longer
   * names (leave/detach). Run-once handlers (backfill) omit this: imported
   * data stays and the marker is kept. Reversible handlers (attach, future)
   * implement it.
   *
   * `marker` is the persisted record about to be dropped - the self-describing
   * undo record `perform()` wrote (LLP 0045 §Part 3). A handler whose effect
   * cannot be re-derived from disk alone reads what it did from here: the
   * attach handler replays `installed_assets` to remove exactly the skills and
   * subagents its own install copied.
   */
  reverse?(requestKey: string, ctx: ActionContext, marker?: ActionMarker): Promise<ActionOutcome>
  /**
   * Optional freshness predicate for a still-desired action whose marker is
   * already `done`. Return `false` to treat the `done` marker as a forward gap
   * (re-`perform()` this pass), `true` (or omit the hook) to keep the
   * level-triggered short-circuit. Handlers with no moving input (backfill:
   * imported data never goes stale) omit it, so a `done` marker is permanently
   * done. The attach handler implements it to re-attach after the gateway
   * rebinds to a new ephemeral port (issue #277 / LLP 0086). Pure: no effects.
   */
  isCurrent?(marker: ActionMarker, action: DesiredAction, ctx: ActionContext): boolean
}

/** Arguments to one {@link ActionReconciler.reconcile} pass. */
export interface ReconcileInput {
  config: HypAwareV2Config
  backfills: BackfillRegistry
  /**
   * The daemon's resolved environment for any child a handler spawns. The
   * daemon forces `HYP_HOME=hypHome` so a spawned `hyp backfill` writes the
   * same cache the daemon resolved, even when `opts.env`/`opts.hypHome`
   * diverge from `process.env` (the direct-`runDaemon`/hermetic-smoke path).
   */
  env: NodeJS.ProcessEnv
  /**
   * Static client→plugin map the daemon resolves from the plugin catalog and
   * threads onto {@link ActionContext} so a client handler can enumerate
   * `desired()` and read each descriptor's `attachProbe` (LLP 0045 §Part 1).
   * Absent on a plain CLI boot.
   */
  clientDescriptors?: Map<string, ClientDescriptor>
  /** Runtime registry for gateway-backed and endpoint-free client attaches. */
  clients?: ClientRegistry
  /**
   * Kernel skill / subagent registries, so an org-driven attach materializes
   * the client's helper assets (LLP 0107 §every-attach). Absent on a plain
   * CLI boot, which leaves the install half of attach inert.
   */
  skills?: SkillRegistry
  agents?: AgentRegistry
  /**
   * Plugins the daemon's boot failed to activate, threaded onto
   * {@link ActionContext} so an org-driven attach installs a partial asset set
   * without reading the hole as a set of retirements
   * (LLP 0219 #incomplete-activation-prunes-nothing).
   */
  failedPlugins?: string[]
  /**
   * The local gateway base URL clients attach to; set whenever `clients` is
   * (LLP 0045 §Part 1).
   */
  endpoint?: string
}

/** What the reconciler did with one (handler, requestKey) unit on a pass. */
export interface ReconcileActionResult {
  kind: string
  requestKey: string
  /**
   * - `done`: `perform()` succeeded this pass; marker advanced to `done`.
   * - `skipped`: a `done` marker already existed (run-once short-circuit).
   * - `failed`: `perform()`/`reverse()` failed; marker recorded `failed`.
   * - `refused`: `perform()` reported a permanent refusal; marker recorded
   *   `refused` (LLP 0186).
   * - `reversed`: `reverse()` succeeded; marker removed.
   */
  outcome: 'done' | 'skipped' | 'failed' | 'refused' | 'reversed'
  rows?: number
  reason?: string
  attempts?: number
}

/** Summary of one reconcile pass. */
export interface ReconcileReport {
  results: ReconcileActionResult[]
}

/**
 * Read-only client-action status for `hyp status`, usable from any process
 * (it never constructs the reconciler). Mirrors `ConfigControlStatus`.
 */
export interface ClientActionStatus {
  /** Persisted markers, namespaced by handler kind. Empty when none ran. */
  byKind: ActionMarkerStore
}

/**
 * Daemon-only handle to the action reconciler. Constructed like
 * `createConfigControl`; the daemon wires its `reconcile()` to the
 * config-confirmation edge and the after-activation already-confirmed pass.
 */
export interface ActionReconciler {
  /**
   * Level-triggered: for each handler, diff `desired()` against the
   * persisted markers and act only on the gap (a missed run is recovered on
   * the next pass). Safe to call repeatedly; a `done` marker short-circuits.
   */
  reconcile(input: ReconcileInput): Promise<ReconcileReport>
  /** Current persisted markers (same shape as `readClientActionStatus`). */
  readStatus(): ClientActionStatus
}

export interface CreateActionReconcilerOptions {
  /**
   * Kernel state root (`<HYP_HOME>/hypaware`). The marker file lives at
   * `<stateRoot>/config-control/client-actions.json`, alongside the apply
   * engine's `state.json` (LLP 0041: the reconciler is kernel surface).
   */
  stateRoot: string
  /** Ordered handlers; v1 ships `[backfillHandler]`. */
  handlers: ActionHandler[]
  /** Injectable clock (test seam); defaults to `Date.now`. */
  now?: () => number
  log?: PluginLogger
}

// =============================================================================
// Backfill action handler (LLP 0037 / LLP 0041 Part 2)
// =============================================================================

/**
 * Result of one spawned `hyp backfill` child. `status` is the exit code
 * (`null` when the child was killed by a signal); `stdout` is the captured
 * `--json` payload; `error` is set when the spawn itself failed (ENOENT,
 * etc.). The reconciler turns a non-zero / errored result into a `failed`
 * marker that the next pass retries (LLP 0041 §failure is surfaced).
 */
export interface BackfillSpawnResult {
  status: number | null
  stdout: string
  error?: Error
}

/** Arguments handed to the injectable backfill spawn seam. */
export interface BackfillSpawnArgs {
  /**
   * The `hyp` argv after the bin path: e.g.
   * `['backfill', 'claude', '--since', '<iso>', '--json']`. The default
   * implementation prepends `process.execPath` and the resolved
   * `bin/hypaware.js` path (the `runSmoke` spawn pattern).
   */
  args: string[]
  /** Environment for the child; the daemon's own env (notably `HYP_HOME`). */
  env: NodeJS.ProcessEnv
}

/**
 * The subprocess seam the backfill handler launches `hyp backfill` through.
 * Injected in tests so the spawned argv + marker writes can be asserted
 * without a real child (LLP 0041: "testable with the spawn injected").
 */
export type BackfillSpawn = (args: BackfillSpawnArgs) => Promise<BackfillSpawnResult>

export interface CreateBackfillHandlerOptions {
  /** Subprocess seam; defaults to a real async `hyp backfill` spawn. */
  spawn?: BackfillSpawn
  log?: PluginLogger
}

// =============================================================================
// Attach action handler (LLP 0044 / LLP 0045 Part 2)
// =============================================================================

/**
 * The disk-driven undo seam the attach handler's `reverse()` invokes: the
 * single core detach (`detachClientFromDisk`, LLP 0045 §Part 3). Injected in
 * tests so `reverse()` can be exercised against a fixture / fake without a live
 * gateway; the default is the real `detachClientFromDisk`. The seam only needs
 * the fields the handler passes (`descriptor` + the daemon-resolved `env`); the
 * real implementation accepts more (an injectable `fs` / `homeDir`), so it is
 * assignable to this narrower type.
 */
/**
 * Outcome of the single core disk-driven undo (`detachClientFromDisk`, LLP 0045
 * §Part 3). Defined here (not as a `@typedef` in the implementation) so it is a
 * shared `interface` other modules import via `@import`.
 */
export interface DetachFromDiskResult {
  /** True when the settings file was rewritten. */
  changed: boolean
  /** The resolved settings path (when one exists). */
  settingsPath?: string
  /** The managed value deleted (e.g. the gateway base URL) when there was no prior to restore. */
  removed?: string
  /**
   * The prior value restored from the undo record.
   *
   * **Single-primary only.** An undo whose replay restores more than one
   * prior (a record with two still-ours `set` entries that each carry a
   * `prev`) restores them all on disk but reports only one of them
   * here, and *which* one is unspecified. Unlike `warning` there is no fold
   * available: both consumers render this as a bare scalar
   * (`src/core/commands/clients.js` puts it in the `hyp detach --json`
   * payload as `restored_value` and prints `  Restored <v>` on stdout), so
   * joining two values would be wrong rather than merely ugly.
   *
   * No shipped producer emits a multi-restore record, and the multi-entry
   * semantics are deliberately unstated rather than pinned by a guard (LLP
   * 0109 §restoredValue is single-primary only). A caller that needs every
   * restored value should get a new `restoredValues: string[]` field, not
   * read meaning into this one.
   */
  restoredValue?: string
  /**
   * Dotted paths whose `prev_malformed` backup the undo put back - the blocks
   * attach had to rebuild because they were present on disk with the wrong JSON
   * type (LLP 0163). Absent when the replay restored nothing.
   *
   * **Paths, never values.** A malformed `env` block is exactly where an API key
   * ends up, and this list is printed to the terminal and echoed into
   * `hyp detach --json`; LLP 0163 already forbids the attach-side warnings from
   * echoing the displaced value, and the same rule applies on the way back.
   * That is also why this cannot ride on `restoredValue`, which both consumers
   * render as a bare value.
   *
   * It is a list rather than a joined string because the failure half of the
   * same replay is already unsplittable prose in `warning`: a successful restore
   * has nothing to say but the path, so there is no reason to hand callers
   * something they would have to parse. Without it a restore that fired was
   * completely silent - `hyp detach` printed only `✓ Detached claude` while it
   * rewrote a block (#500 finding 3).
   */
  restoredPaths?: string[]
  /**
   * Set when a managed value was overridden externally and left in place. The
   * `json` undo emits one notice per overridden key and joins them with
   * ` | ` when the undo left more than one behind (LLP 0045
   * §never-clobber-a-user-edit).
   *
   * **Display only: do not parse or split this field.** No separator is safe.
   * Each notice carries its own `; `, and the `toml` undo interpolates the
   * user's live `model_provider` value into a single unjoined notice, so a
   * `~/.codex/config.toml` reading `model_provider = "acme | prod"` puts ` | `
   * inside one notice. Nothing in-tree parses it: `action_attach.js` logs it as
   * a span `detail` and `hyp detach` prints it and echoes it verbatim into
   * `--json`. A caller that needs the keys individually should get a new
   * `warnings: string[]` field, not a split of this one.
   */
  warning?: string
}

export type ClientDetachFromDisk = (args: {
  descriptor: ClientDescriptor
  homeDir?: string
  env?: NodeJS.ProcessEnv
}) => Promise<DetachFromDiskResult>

export interface CreateAttachHandlerOptions {
  /**
   * The disk-driven undo seam `reverse()` calls; defaults to the real
   * `detachClientFromDisk`. Injected in tests to assert the undo runs without
   * touching `ctx.clients` (which lacks the dropped client at reverse time).
   */
  detach?: ClientDetachFromDisk
  log?: PluginLogger
}

// =============================================================================
// Client adapter enablement (LLP 0174)
// =============================================================================

/**
 * Per-step outcome of `enableClientAdapter`. `'n/a'` is not a degraded `'ok'`:
 * it means the step never applied on this machine (no daemon service is
 * installed, so there is nothing to restart and no gateway that will bind),
 * which the caller reports differently from a step that ran and failed.
 */
export type ClientEnableStepStatus = 'ok' | 'failed' | 'n/a'

/**
 * Outcome of the enable half of the LLP 0174 attach prompt, reported per step
 * so the caller can say exactly which one broke and what survived it: a write
 * that landed before a failed restart persists, and the `backupPath` it names
 * is the user's undo.
 */
export interface ClientEnableResult {
  ok: boolean
  /** The client the enablement was resolved for (`claude`, `openclaw`, ...). */
  name: string
  /** The local config layer the write targeted. */
  configPath: string
  /** Set when the guard copied an existing config aside before replacing it. */
  backupPath?: string
  /**
   * The plugins actually appended to the local layer. Empty when every entry
   * was already present in the effective merged config, which is a successful
   * no-op write, not a failure.
   */
  addedPlugins: PluginName[]
  /** Whether a daemon service exists to restart at all. */
  daemonInstalled: boolean
  /** Whether the gateway published a bound port within the wait budget. */
  bound: boolean
  /** The endpoint the bind wait observed, when it observed one. */
  endpoint?: string
  steps: {
    write: ClientEnableStepStatus
    restart: ClientEnableStepStatus
    wait: ClientEnableStepStatus
  }
  /** The furthest step that completed; `'n/a'` when only the write applied. */
  completed: 'write' | 'restart' | 'wait' | 'n/a'
  /** The step that broke, when one did. */
  failedStep?: 'write' | 'restart' | 'wait'
  /** Human-readable detail for the failed (or timed-out) step. */
  message?: string
}

/**
 * Outcome of `enableGatewayProxyMode` (LLP 0244): the consented switch of an
 * existing install's gateway to proxy mode. Same per-step reporting contract
 * as `ClientEnableResult`, plus the CA wait that proxy attach preflights on.
 */
export interface GatewayProxyEnableResult {
  ok: boolean
  /**
   * `enabled`: the key was written and every step that applied succeeded.
   * `already`: the effective config has the key, nothing to do.
   * `central_managed`: the gateway block comes from the central layer, so
   * the local CLI declines to write. `no_gateway`: no layer has a gateway
   * entry. `failed`: a step broke (see `failedStep`/`message`); when
   * `steps.write` is `ok` the key nonetheless persisted on disk, with
   * `backupPath` naming the pre-write copy.
   */
  outcome: 'enabled' | 'already' | 'central_managed' | 'no_gateway' | 'failed'
  /** The local config layer the write targeted. */
  configPath: string
  /** Set when the guard copied the existing config aside before replacing it. */
  backupPath?: string
  /** Whether a daemon service exists to restart at all. */
  daemonInstalled: boolean
  /** Whether the gateway published a bound port within the wait budget. */
  bound: boolean
  /** Whether the restarted gateway minted the local CA within the wait budget. */
  caReady: boolean
  /** The CA certificate path, once minted. */
  caCertPath?: string
  /** The endpoint the bind wait observed, when it observed one. */
  endpoint?: string
  steps: {
    write: ClientEnableStepStatus
    restart: ClientEnableStepStatus
    wait: ClientEnableStepStatus
    ca: ClientEnableStepStatus
  }
  /** The step that broke, when one did. */
  failedStep?: 'write' | 'restart' | 'wait' | 'ca'
  /** Human-readable detail for the failed (or timed-out) step. */
  message?: string
}

export type { ConfigStageResult, ConfigApplyErrorKind }
