import type { HypAwareV2Config } from '../../../../hypaware-plugin-kernel-types.d.ts'
import type { CollectStatusOptions, HypAwareStatusReport } from '../../daemon/types.d.ts'
import type { PickerDescriptor, PluginCatalog } from '../../types.d.ts'
import type {
  AsyncPickPrompt,
  AsyncRetentionPrompt,
  PickerExport,
  PickerExportOrigin,
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
