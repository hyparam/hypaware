import type { CollectStatusOptions, HypAwareStatusReport } from '../../daemon/types.d.ts'
import type { PickerDescriptor } from '../../types.d.ts'

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
