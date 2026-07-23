import type { CapabilityRegistry, CommandRunContext, HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.d.ts'
import type { CollectStatusOptions, HypAwareStatusReport } from '../../daemon/types.d.ts'
import type { PickerDescriptor, PluginCatalog } from '../../types.d.ts'
import type {
  AsyncBackfillConsentPrompt,
  AsyncPickPrompt,
  AsyncRetentionPrompt,
  FinaleSummary,
  PickerBackfillRunner,
  PickerExport,
  PickerExportOrigin,
  PickerFinaleActions,
  PickerPicks,
  PickerSource,
} from '../types.d.ts'

/**
 * The wizard's top-level pathway choice (LLP 0129 #fork). `quit` is the
 * safe default on a bare enter or a cancelled prompt.
 */
export type WizardForkChoice = 'team' | 'local' | 'quit'

export interface RunWizardForkOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
}

/**
 * `first-run` / `reconfigure`: no pathway preset, the caller falls
 * through to `runWizardFork`. `scoped-reconfigure`: a managed machine's
 * amended re-entry (LLP 0129 #returning-gate) - no fork, pathway presets
 * to `'scoped'`. `status` / `quit`: the gate's own terminal choices.
 */
export type ReturningGateAction = 'first-run' | 'quit' | 'status' | 'reconfigure' | 'scoped-reconfigure'

export interface ReturningGateResult {
  action: ReturningGateAction
  /** True when the merged config carries a central layer (LLP 0031). */
  managed: boolean
  report: HypAwareStatusReport
}

export interface EvaluateReturningGateOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /** Optional kernel runtime, forwarded to `collectStatus` unchanged. */
  runtime?: CollectStatusOptions['runtime']
  /**
   * Override status collection (tests inject a fixture report so the
   * gate branches don't depend on a real config file on disk). Defaults
   * to the real `collectHypAwareStatus`.
   */
  collectStatus?: (opts: CollectStatusOptions) => Promise<HypAwareStatusReport>
}

/**
 * The picker result the configure phase reads (LLP 0135 #configure). Only
 * `descriptors` is consumed here; the pick phase (LLP 0135 #pick) owns the
 * full result shape. `runConfigurePhase` loops the subset with
 * `needsSetup: true` and a `configureCommand`.
 */
export interface ConfigurePhasePicked {
  descriptors: PickerDescriptor[]
}

/**
 * In-process command dispatch seam (LLP 0130 #configure-command), the same
 * `CommandRunContext.commands` member the dispatcher populates. The
 * configure phase runs each `needs_setup` picker row's `configure_command`
 * through `run(name, argv)` and drops the source on a non-zero exit or a
 * throw (LLP 0131 #drop-on-failure).
 */
export interface ConfigureCommandContext {
  commands: { run(name: string, argv: string[]): Promise<number> }
}

export interface RunConfigurePhaseOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  /** The `ctx.commands.run` seam (LLP 0130). */
  ctx: ConfigureCommandContext
  /**
   * When true, `--print-commands` is threaded onto the invoked command's
   * own argv so its existing no-sudo escape hatch prints the privileged
   * commands instead of running them (LLP 0131 #idempotent-rerun). The
   * wizard adds no separate implementation.
   */
  printCommands?: boolean
  /**
   * Present only on the non-interactive callers (`--yes`, `--dry-run`,
   * presets, `--from-file`). The configure phase is attended-only
   * (LLP 0131 #attended-only): when this is set it runs nothing.
   */
  picks?: unknown
}

/** One picked `needs_setup` descriptor's configure outcome. */
export interface ConfigurePhaseEntryResult {
  /** The picker source id (`PickerDescriptor.id`). */
  id: string
  /** True on a zero exit code; false when dropped from this run. */
  ok: boolean
  /** The command's exit code, when it returned one (drop-on-nonzero). */
  exitCode?: number
  /** Stringified thrown error, when the command threw (drop-on-throw). */
  error?: string
}

export interface ConfigurePhaseResult {
  results: ConfigurePhaseEntryResult[]
}

/**
 * The join phase's verdict (LLP 0135 #join). `ok` is a completed sign-in
 * (with an org config that either converged or timed out); `failed` and
 * `abandoned` are the two ways an incomplete join returns to the fork
 * (LLP 0129 #failed-join-returns-to-fork). `failed` is a definitive org
 * membership/permission rejection (an admin must act); `abandoned` is a
 * transient/other failure the user can simply retry.
 */
export type WizardJoinStatus = 'ok' | 'failed' | 'abandoned'

/**
 * The two-layer config `classifyClientProvenance` reads (LLP 0031): the
 * server-owned central layer and the merged effective config. The join
 * phase resolves it from disk after convergence to compute the locked set.
 */
export interface LayeredProvenance {
  centralConfig?: HypAwareV2Config | null
  effective?: HypAwareV2Config | null
}

/**
 * What the login lane returns to the join wrapper: the `hyp remote login`
 * exit code plus its captured stderr. `classifyLoginFailure` maps the D7
 * taxonomy phrases in `stderr` to `'failed' | 'abandoned'` (LLP 0058 D7);
 * the query-only text is surfaced verbatim to the user by the login lane
 * itself, so the wrapper only classifies, never re-prints.
 */
export interface LoginLaneResult {
  exitCode: number
  stderr: string
}

export interface WizardJoinResult {
  status: WizardJoinStatus
  /**
   * Present on `'ok'`: the picker source ids owned by the central layer,
   * which the pick phase renders locked (LLP 0129 #join-before-picker).
   * Empty on a timeout or the no-org-config 404 steady state - nothing is
   * pinned, so the picker composes freely.
   */
  lockedSources?: string[]
  /**
   * True when the org config converged, i.e. the machine now carries a
   * central layer. Drives the pick phase's `managed` annotation
   * (LLP 0132 #never-silent). Absent on the timeout/404 fall-through:
   * nothing is pinned yet, so the picker renders unmanaged.
   */
  managed?: boolean
  /**
   * On a failure (`'failed' | 'abandoned'`): the login lane's own captured
   * explanation, so `runInitWizard`'s `printJoinFailure` can echo the D7
   * meaning without re-deriving it.
   */
  detail?: string
}

export interface RunWizardJoinOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /**
   * The plugin catalog. Its `pickerDescriptors` key space is the lock
   * candidate set, and both descriptor maps resolve a source id to its
   * owning plugin for `classifyClientProvenance`.
   */
  catalog: PluginCatalog
  /**
   * The command context `runRemoteLogin` runs against (production wiring,
   * supplied by `runInitWizard`). Optional so tests can inject `runLogin`
   * and never touch the real login lane.
   */
  ctx?: CommandRunContext
  /**
   * Override the login lane (tests). Defaults to `runRemoteLogin` over
   * `ctx` with its stderr captured for `classifyLoginFailure`.
   */
  runLogin?: () => Promise<LoginLaneResult>
  /**
   * Override the convergence wait (tests). Defaults to
   * `waitForCentralConverge`.
   */
  waitForConverge?: (
    opts: { env: NodeJS.ProcessEnv },
    waitOpts: { timeoutMs?: number, intervalMs?: number }
  ) => Promise<{ ok: boolean, attached: string[] }>
  /**
   * Override layered-config resolution (tests inject a fixture). Defaults
   * to `resolveLayeredConfigFromDisk` over the on-disk local + central
   * layers.
   */
  resolveLayered?: () => Promise<LayeredProvenance>
}

/**
 * The wizard pick phase (LLP 0135 #pick). Options come from
 * `catalog.pickerDescriptors` (LLP 0130), central-layer-locked rows render
 * checked and disabled (LLP 0031 provenance vocabulary) and are filtered
 * out of the returned picks before composition (LLP 0129
 * #join-before-picker). Non-interactive callers set `picks` and skip
 * prompting, matching today's `interactive = !opts.picks` split.
 */
export interface RunWizardPickOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /**
   * The plugin catalog (T2). Picker rows come from
   * `catalog.pickerDescriptors`; when omitted the phase loads the bundled
   * catalog itself, matching `runPickerWalkthrough`'s self-loading shape.
   */
  catalog?: Pick<PluginCatalog, 'pickerDescriptors'>
  /**
   * Central-layer-locked source ids from the join phase (LLP 0129
   * #join-before-picker). Each renders checked and disabled with the
   * `· managed by your fleet` label suffix, and is filtered out of the
   * returned `sourcesPicked` so composition never re-adds a source the
   * central layer already owns.
   */
  locked?: string[]
  /**
   * True when the machine carries a central layer (a completed join, or a
   * managed machine's re-entry). Every non-locked row then renders with
   * the `· stays on this machine` suffix: an addition beyond the org set
   * is collected but never forwarded (LLP 0132 #never-silent), and the
   * picker says so before the box is ticked. Distinct from `locked` being
   * non-empty - a managed org config may pin zero picker sources.
   */
  managed?: boolean
  /** True on a managed machine's scoped re-entry (LLP 0129 #returning-gate). */
  scoped?: boolean
  /** Pre-baked picks; non-interactive callers set this and skip prompting. */
  picks?: PickerPicks
  /** Provenance of `picks.exportChoice`, for telemetry only. */
  exportOrigin?: PickerExportOrigin
  /** Override the source prompt (tests pre-bake answers). */
  prompt?: AsyncPickPrompt
  /** Override the retention prompt (tests pre-bake answers). */
  retentionPrompt?: AsyncRetentionPrompt
  /** Override the system source detector (interactive only). */
  detect?: (opts: { env: NodeJS.ProcessEnv }) => Promise<Set<PickerSource>>
  /** Overwrite an existing local config non-interactively (`--force`). */
  force?: boolean
  /** Interactive overwrite confirm, consulted only when a config exists. */
  confirmOverwrite?: (targetPath: string) => Promise<boolean>
}

/**
 * Options for `runInitWizard`, the fork -> join -> pick -> configure ->
 * privacy -> finale orchestrator (LLP 0135 #orchestration). Non-interactive
 * callers (`--yes`, `--dry-run`, presets, `--from-file`) set `picks` and the
 * orchestrator short-circuits straight to the pick phase + finale, matching
 * the walkthrough's `interactive = !opts.picks` split.
 *
 * The phase overrides (`gate`, `fork`, `join`, `pick`, `configure`,
 * `finaleRunner`) exist for tests, which drive the state machine with
 * scripted phases; production callers pass none of them.
 */
export interface RunInitWizardOptions {
  stdout: NodeJS.WritableStream | { write(chunk: string): unknown }
  stderr: NodeJS.WritableStream | { write(chunk: string): unknown }
  stdin?: NodeJS.ReadableStream
  env: NodeJS.ProcessEnv
  /**
   * The command context: the join phase's login lane runs against it and
   * the configure phase invokes `ctx.commands.run` through it. Its
   * registries also back the returning gate's status collection.
   */
  ctx: CommandRunContext
  /** Finale registries, identical to the walkthrough's. */
  capabilities: CapabilityRegistry
  sources?: { stopAll?: () => Promise<void> }
  skills?: { list(): { name: string; clients: ('claude' | 'codex')[]; sourceDir: string }[] }
  agents?: { list(): { name: string; clients: ('claude' | 'codex')[]; sourceFile: string }[] }
  backfill?: PickerBackfillRunner
  finale?: PickerFinaleActions
  /** Pre-baked picks: the non-interactive short-circuit. */
  picks?: PickerPicks
  exportOrigin?: PickerExportOrigin
  force?: boolean
  /** Threaded to the configure phase's `--print-commands` passthrough. */
  printCommands?: boolean
  /**
   * Runs the full `hyp status` report when the returning gate's
   * "See full status" is chosen. Supplied by `runInit` so the wizard
   * module does not import command modules.
   */
  runStatus?: () => Promise<number>
  /** Pre-built catalog (tests); defaults to the bundled-plugin catalog. */
  catalog?: PluginCatalog
  /** Phase overrides (tests). */
  gate?: (opts: EvaluateReturningGateOptions) => Promise<ReturningGateResult>
  fork?: (opts: RunWizardForkOptions) => Promise<WizardForkChoice>
  join?: (opts: RunWizardJoinOptions) => Promise<WizardJoinResult>
  pick?: (opts: RunWizardPickOptions) => Promise<WizardPickResult>
  configure?: (picked: ConfigurePhasePicked, opts: RunConfigurePhaseOptions) => Promise<ConfigurePhaseResult>
  finaleRunner?: (args: Record<string, unknown>) => Promise<FinaleSummary>
  /** Pick-phase prompt seams, threaded through unchanged (tests). */
  prompt?: AsyncPickPrompt
  retentionPrompt?: AsyncRetentionPrompt
  detect?: (opts: { env: NodeJS.ProcessEnv }) => Promise<Set<PickerSource>>
  confirmOverwrite?: (targetPath: string) => Promise<boolean>
  backfillConsentPrompt?: AsyncBackfillConsentPrompt
}

/**
 * The wizard's overall outcome. `exitCode` is what `hyp init` returns:
 * 0 on success or a deliberate quit, 1 on an overwrite refusal, 130 on a
 * cancelled prompt. The remaining fields mirror the pick result for
 * callers that want them; absent when the run ended before the pick
 * phase (gate quit, fork quit).
 */
export interface InitWizardResult {
  exitCode: number
  /** The pathway the run took; absent when it ended at the gate/fork. */
  pathway?: 'team' | 'local' | 'scoped'
  cancelled?: boolean
  configPath?: string
  config?: HypAwareV2Config
  sourcesPicked?: PickerSource[]
  clientsPicked?: ('claude' | 'codex')[]
  lockedSources?: string[]
  configureResults?: ConfigurePhaseEntryResult[]
  finale?: FinaleSummary
}

/**
 * The pick phase result. A superset of the fields the configure phase
 * (`descriptors`) and the finale (`config`, `configPath`, `sourcesPicked`,
 * ...) read. `cancelled` short-circuits the orchestrator; `exitCode` is 130
 * on a cancel, 1 on an overwrite refusal, else 0.
 */
export interface WizardPickResult {
  exitCode: number
  /** True when the user cancelled at a prompt (exitCode 130). */
  cancelled?: boolean
  configPath: string
  config: HypAwareV2Config
  /** Picked source ids, with locked (central-layer) ids removed. */
  sourcesPicked: PickerSource[]
  exportPicked: PickerExport
  clientsPicked: ('claude' | 'codex')[]
  retentionDays: number
  /** The picked, locked-filtered descriptors, for the configure phase. */
  descriptors: PickerDescriptor[]
  /** Source ids rendered locked in this run (central-layer, LLP 0031). */
  lockedSources: string[]
}
