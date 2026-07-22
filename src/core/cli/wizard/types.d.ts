import type { CommandRunContext, HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.d.ts'
import type { CollectStatusOptions, HypAwareStatusReport } from '../../daemon/types.d.ts'
import type { PickerDescriptor, PluginCatalog } from '../../types.d.ts'

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
